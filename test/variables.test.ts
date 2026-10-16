import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { registerVariableTools, variableRefs, variablesSet } from "../src/tools/variables.ts";

/** Global and user variables as the bridge's vars.* ops (0.31.0) answer, with an optional write the console ignores. */
class Vars {
  sets: Record<string, Map<string, number | string>> = { global: new Map(), user: new Map() };
  ignoreWrites = false;
  oldBridge = false;
  macros = new Map<number, string[]>();
  item(scope: string, name: string) {
    const v = this.sets[scope].get(name);
    return v === undefined ? { name, exists: false } : { name, exists: true, value: v, type: typeof v === "string" ? "text" : Number.isInteger(v) && !this.doubles.has(`${scope}/${name}`) ? "integer" : "double" };
  }
  doubles = new Set<string>();
  install(h: Harness) {
    h.fake.reset();
    const guard = () => {
      if (this.oldBridge) throw new Error("unknown op 'vars.get'");
    };
    h.fake.on("vars.get", (a) => {
      guard();
      return { scope: a.scope, user: a.scope === "user" ? "Admin" : undefined, items: (a.names as string[]).map((n) => this.item(String(a.scope), n)) };
    });
    h.fake.on("vars.set", (a) => {
      guard();
      const scope = String(a.scope);
      const before = this.item(scope, String(a.name));
      if (!this.ignoreWrites) {
        this.sets[scope].set(String(a.name), a.value as number | string);
        if (a.type === "double") this.doubles.add(`${scope}/${a.name}`);
        else this.doubles.delete(`${scope}/${a.name}`);
      }
      return { scope, before, after: this.item(scope, String(a.name)) };
    });
    h.fake.on("vars.delete", (a) => {
      guard();
      const scope = String(a.scope);
      const before = this.item(scope, String(a.name));
      if (!this.ignoreWrites) this.sets[scope].delete(String(a.name));
      return { scope, before, after: this.item(scope, String(a.name)) };
    });
    h.fake.on("children", (a) => {
      if (a.ref === "DataPool.Macros") return { total: this.macros.size, items: [...this.macros.keys()].map((n) => ({ index: n, name: `Macro ${n}`, class: "Macro" })) };
      const n = Number(String(a.ref).replace(/^Macro /, ""));
      return { total: this.macros.get(n)?.length ?? 0, items: (this.macros.get(n) ?? []).map((c, i) => ({ index: i + 1, class: "MacroLine", fields: { Command: c, Name: "", Wait: "Follow", Enabled: "Yes", Execute: "Yes", AddToCmdline: "No" } })) };
    });
    h.fake.on("objects", (a) => {
      const n = Number(String(a.ref).replace(/^Macro /, ""));
      return this.macros.has(n) ? { total: 1, items: [{ name: `Macro ${n}`, class: "Macro", fields: { Name: `Macro ${n}`, Lock: "", LineNo: "" } }] } : { total: 0, items: [] };
    });
  }
}

let h: Harness;
let vars: Vars;
before(async () => {
  h = await startHarness(registerVariableTools);
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  vars = new Vars();
  vars.install(h);
});

test("$variable references are found outside quotes, per statement; SetGlobalVariable / SetUserVariable name what they set", () => {
  assert.deepEqual(variableRefs("Goto Sequence $HexCol Cue $HexCue; Label Sequence 9 \"$notExpanded\""), [{ name: "HexCol", statement: 0 }, { name: "HexCue", statement: 0 }]);
  assert.deepEqual(variableRefs('Echo "a;b"; Go+ Macro $M'), [{ name: "M", statement: 1 }]);
  assert.deepEqual(variablesSet('SetGlobalVariable "HexCol" 11; SetUserVariable Mode "x"; Go+ Macro 3'), [{ name: "HexCol", statement: 0, scope: "global" }, { name: "Mode", statement: 1, scope: "user" }]);
});

test("gma3_variables reads names in both scopes, says which one a $reference resolves to, and the macros' references", async () => {
  vars.sets.global.set("HexCol", 11);
  vars.sets.global.set("Mode", "clock");
  vars.sets.user.set("HexCol", 12);
  vars.macros.set(20, ["Goto Sequence $HexCol Cue $HexCue", 'Echo "$quoted"']);
  const r = await h.callJson("gma3_variables", {});
  assert.equal(r.isError, false, JSON.stringify(r.result));
  const by = Object.fromEntries(r.result.variables.map((x: any) => [x.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ["HexCol", "HexCue"], "the macro's $references, not the quoted one");
  assert.equal(by.HexCol.resolvesTo, "user", "a user variable shadows a global one");
  assert.deepEqual(by.HexCol.global, { exists: true, value: 11, type: "integer" });
  assert.deepEqual(by.HexCue.usedBy, ["Macro 20 line 1"]);
  assert.equal(by.HexCue.resolvesTo, null);
  assert.match(r.result.note, /cannot be listed/);
  const named = await h.callJson("gma3_variables", { names: ["Mode"], scope: "global" });
  assert.deepEqual(named.result.variables, [{ name: "Mode", global: { exists: true, value: "clock", type: "text" } }]);
});

test("gma3_set_variable sets with the type inferred or given, reads back, and deletes", async () => {
  let r = await h.callJson("gma3_set_variable", { scope: "global", name: "HexCol", value: 11 });
  assert.equal(r.isError, false, JSON.stringify(r.result));
  assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(r.result.after, { name: "HexCol", exists: true, value: 11, type: "integer" });
  r = await h.callJson("gma3_set_variable", { scope: "global", name: "Ratio", value: 2, type: "double" });
  assert.equal(r.result.after.type, "double");
  r = await h.callJson("gma3_set_variable", { scope: "user", name: "Label", value: 'a "b" c' });
  assert.equal(r.result.verification.status, "matched");
  assert.ok(r.result.warnings.some((w: string) => /bridge's user's \(Admin\)/.test(w)));
  r = await h.callJson("gma3_set_variable", { scope: "global", name: "HexCol", delete: true });
  assert.equal(r.result.verification.status, "matched");
  assert.equal(vars.sets.global.has("HexCol"), false);
});

test("gma3_set_variable: a write the console ignores is a mismatch; bad values are refused before anything is sent", async () => {
  vars.ignoreWrites = true;
  const r = await h.callJson("gma3_set_variable", { scope: "global", name: "X", value: "on" });
  assert.equal(r.isError, true);
  assert.equal(r.result.verification.status, "mismatched");
  assert.match(r.result.verification.detail, /X reads missing/);
  for (const [args, re] of [
    [{ scope: "global", name: "X", value: 1.5, type: "integer" }, /whole number/],
    [{ scope: "global", name: "X", value: 9, type: "text" }, /type text needs a string/],
    [{ scope: "global", name: "X", value: "9", type: "integer" }, /type integer needs a number/],
    [{ scope: "global", name: "bad\nname", value: 1 }, /variable name/],
    [{ scope: "global", name: "X", delete: true, value: 1 }, /delete takes no value/],
    [{ name: "X", value: 1 }, /scope must be global or user/],
  ] as const) {
    const bad = await h.callJson("gma3_set_variable", args as Record<string, unknown>);
    assert.equal(bad.isError, true, JSON.stringify(args));
    assert.match((bad.result.validationErrors ?? []).join(" "), re, JSON.stringify(bad.result));
  }
  assert.equal(h.fake.requests.filter((q) => q.op === "vars.set").length, 1, "only the first, valid call wrote");
});

test("gma3_set_variable batch: several variables, one read-back each; an old bridge says what to update", async () => {
  const r = await h.callJson("gma3_set_variable", { scope: "global", variables: [{ name: "HexCol", value: 11 }, { name: "HexCue", value: 3 }, { name: "Mode", value: "clock", scope: "user" }] });
  assert.equal(r.isError, false, JSON.stringify(r.result));
  assert.deepEqual(r.result.items.map((i: any) => `${i.target}:${i.verification}`), ["global HexCol:matched", "global HexCue:matched", "user Mode:matched"]);
  vars.oldBridge = true;
  const old = await h.callJson("gma3_set_variable", { scope: "global", name: "X", value: 1 });
  assert.equal(old.isError, true);
  assert.match(JSON.stringify(old.result), /bridge 0\.31\.0/);
});
