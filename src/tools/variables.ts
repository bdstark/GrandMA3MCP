/**
 * SU-15: console variables (global and user), through the bridge's vars.get / vars.set / vars.delete ops (0.31.0).
 *
 *   gma3_variables      read variables by name, or every $variable the show's macros reference, with their values
 *   gma3_set_variable   set (with its type) or delete a variable and read it back; a list form sets several
 *
 * Console facts (onPC 2.5.1, docs/probes/su-15-console-variables-macos-2.5.1.md):
 *   - Variables cannot be enumerated: the Variables objects have no children, an export holds no values, and
 *     GetGlobalVariable "*" only prints into the command-line history. They are read by name.
 *   - $variables expand in commands sent through the bridge (SU-14 probe), outside quotes only. A user variable shadows
 *     a global one of the same name. A command with a missing $variable does nothing.
 *   - SetVar keeps the type (integer, double, text); user variables are the bridge's user's (the plugin runs as a user
 *     profile, "Admin" on the dev console), not necessarily the operator's.
 */
import { z } from "zod";
import { BridgeError, type Gma3Bridge } from "../bridge.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { BATCH_NOTE, batchOptionShape, duplicates, runBatchCall } from "../batch.js";
import { asRead, buildResult, requestStep, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, ValidationError, describe } from "../validate.js";
import { readMacro } from "./macros.js";

export type VarScope = "global" | "user";
export type VarType = "integer" | "double" | "text";

export interface VarItem {
  name: string;
  exists: boolean;
  value?: number | string;
  type?: VarType | string;
}

export const NEEDS_BRIDGE = "the console runs an older bridge plugin without the variable ops (bridge 0.31.0); update the plugin";
const unknownOp = (err: unknown) => err instanceof BridgeError && /unknown op/.test(err.message);
const MAX_NAMES = 500;
const MAX_MACROS = 300;

/** A variable name: non-empty, at most 256 characters, no control characters (names are case-sensitive). */
export function variableName(field: string, value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidationError(`${field} must be a variable name: 1-256 characters, no control characters (got ${describe(value)})`, field);
  return value;
}

/** The statements of a command line (split at ; outside quotes), each with the parts outside quotes. */
function statements(command: string): Array<{ text: string; outside: string }> {
  const out: Array<{ text: string; outside: string }> = [];
  let text = "";
  let outside = "";
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      text += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      text += ch;
      outside += " ";
      continue;
    }
    if (ch === ";") {
      out.push({ text, outside });
      text = "";
      outside = "";
      continue;
    }
    text += ch;
    outside += ch;
  }
  out.push({ text, outside });
  return out;
}

/** The $variable references of a command line, outside quotes (where the console expands them), with their statement. */
export function variableRefs(command: string): Array<{ name: string; statement: number }> {
  const out: Array<{ name: string; statement: number }> = [];
  statements(command).forEach((st, i) => {
    for (const m of st.outside.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) out.push({ name: m[1], statement: i });
  });
  return out;
}

export interface VarEffect {
  name: string;
  statement: number;
  scope: VarScope;
  action: "set" | "delete";
}

/**
 * What the statements of a command line do to variables, in order (review round 1): `SetGlobalVariable "x" <value>`
 * (or `At ...`) sets x; `SetGlobalVariable "x"` with no value and `DeleteGlobalVariable "x"` delete it; the same for
 * user variables.
 */
export function variableEffects(command: string): VarEffect[] {
  const out: VarEffect[] = [];
  statements(command).forEach((st, i) => {
    const m = st.text.trim().match(/^(Set|Delete)(Global|User)Variable\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(.*)$/i);
    if (!m) return;
    const scope: VarScope = m[2].toLowerCase() === "global" ? "global" : "user";
    const action = m[1].toLowerCase() === "delete" || m[6].trim() === "" ? "delete" : "set";
    out.push({ name: m[3] ?? m[4] ?? m[5], statement: i, scope, action });
  });
  return out;
}

/** The variables a command line sets (not the ones it deletes), with their statement. */
export function variablesSet(command: string): Array<{ name: string; statement: number; scope: VarScope }> {
  return variableEffects(command).filter((e) => e.action === "set").map(({ name, statement, scope }) => ({ name, statement, scope }));
}

/** A variable's existence per scope on the console: true, false, or null when it could not be read. */
export type VarPresence = { user: boolean | null; global: boolean | null; error?: string };

/**
 * Follows a sequence of command lines (macro lines, cue commands) and says, for each $reference in order, whether it
 * resolves when it runs: a user or a global variable exists at that point, by the earlier statements' set/delete
 * effects or else as on the console. A user variable shadows a global one; deleting it uncovers the global one.
 * Within a statement the references are read before its own effects apply.
 */
export class VarTracker {
  private effects = new Map<string, { user?: boolean; global?: boolean }>();
  constructor(private consoleState: Map<string, VarPresence>) {}
  /** Apply the effects of statements (e.g. of an earlier line that runs). */
  apply(effects: VarEffect[]): void {
    for (const e of effects) {
      const cur = this.effects.get(e.name) ?? {};
      cur[e.scope] = e.action === "set";
      this.effects.set(e.name, cur);
    }
  }
  /** Whether `name` resolves now: from an earlier effect (created_earlier), on the console (exists), missing or unknown. */
  resolve(name: string): { status: "created_earlier" | "exists" | "missing" | "unknown"; error?: string } {
    const eff = this.effects.get(name) ?? {};
    const con = this.consoleState.get(name);
    const scopeState = (sc: VarScope): boolean | null => (eff[sc] !== undefined ? (eff[sc] as boolean) : con ? con[sc] : null);
    const [u, g] = [scopeState("user"), scopeState("global")];
    if (u === true || g === true) return { status: eff.user === true || (u !== true && eff.global === true) ? "created_earlier" : "exists" };
    if (u === null || g === null) return { status: "unknown", error: con?.error ?? "not checked" };
    return { status: "missing" };
  }
  /** Check every line in order; each line's references are judged statement by statement, before its effects. */
  check(lines: Array<{ command: string; runs: boolean; checked: boolean }>): Array<Array<{ name: string; status: "created_earlier" | "exists" | "missing" | "unknown"; error?: string }>> {
    return lines.map((l) => {
      const refs = variableRefs(l.command);
      const effects = variableEffects(l.command);
      const out: Array<{ name: string; status: "created_earlier" | "exists" | "missing" | "unknown"; error?: string }> = [];
      const stmts = new Set([...refs.map((r) => r.statement), ...effects.map((e) => e.statement)]);
      for (const si of [...stmts].sort((a, b) => a - b)) {
        if (l.checked) for (const r of refs.filter((x) => x.statement === si)) out.push({ name: r.name, ...this.resolve(r.name) });
        if (l.runs) this.apply(effects.filter((e) => e.statement === si));
      }
      return out;
    });
  }
}

/** Each name's existence per scope on the console (null when it could not be read). */
export async function variablePresence(bridge: Gma3Bridge, names: string[], t?: number): Promise<Map<string, VarPresence>> {
  const out = new Map<string, VarPresence>();
  const uniq = [...new Set(names)];
  if (!uniq.length) return out;
  try {
    const [u, g] = [await readVariables(bridge, "user", uniq, t), await readVariables(bridge, "global", uniq, t)];
    uniq.forEach((n, i) => out.set(n, { user: u.items[i]?.exists === true, global: g.items[i]?.exists === true }));
  } catch (err) {
    const error = unknownOp(err) ? NEEDS_BRIDGE : err instanceof Error ? err.message : String(err);
    for (const n of uniq) out.set(n, { user: null, global: null, error });
  }
  return out;
}

/** Read variables of one scope by name (one request per 500 names). Throws BridgeError on an old bridge. */
export async function readVariables(bridge: Gma3Bridge, scope: VarScope, names: string[], t?: number): Promise<{ items: VarItem[]; user?: string | null }> {
  const items: VarItem[] = [];
  let user: string | null | undefined;
  for (let i = 0; i < names.length; i += MAX_NAMES) {
    const r = (await bridge.request("vars.get", { scope, names: names.slice(i, i + MAX_NAMES) }, t)) as { items?: VarItem[]; user?: string | null };
    items.push(...(r.items ?? []));
    user = r.user ?? user;
  }
  return { items, user };
}

// ---------------------------------------------------------------------------
// gma3_variables (read-only)
// ---------------------------------------------------------------------------

/** Every $variable the macros of the pool reference, with where (Macro n line l); bounded. */
async function macroReferences(bridge: Gma3Bridge, t: number): Promise<{ refs: Map<string, string[]>; macros: number; truncated: boolean }> {
  const list = (await bridge.request("children", { ref: "DataPool.Macros", fields: ["Name"], limit: MAX_MACROS + 1 }, t)) as { total?: number; items?: Array<{ index?: number; name?: string }> };
  const items = (list.items ?? []).slice(0, MAX_MACROS);
  const refs = new Map<string, string[]>();
  for (const [i, it] of items.entries()) {
    const n = typeof it.index === "number" ? it.index : i + 1;
    const m = await readMacro(bridge, n, t);
    for (const l of m.lines ?? []) for (const r of variableRefs(l.command)) refs.set(r.name, [...(refs.get(r.name) ?? []), `Macro ${n} line ${l.line}`]);
  }
  return { refs, macros: items.length, truncated: (list.total ?? items.length) > MAX_MACROS };
}

export async function readVariablesTool(ctx: ToolContext, raw: { names?: unknown; scope?: unknown; referenced?: unknown }): Promise<unknown> {
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  const v = new Validator();
  const scope = raw.scope ?? "both";
  if (scope !== "global" && scope !== "user" && scope !== "both") v.fail("scope must be global, user or both");
  let names: string[] = [];
  if (raw.names !== undefined) {
    if (!Array.isArray(raw.names) || raw.names.length === 0 || raw.names.length > MAX_NAMES) v.fail(`names must list 1-${MAX_NAMES} variable names`);
    else names = raw.names.map((n, i) => v.check(() => variableName(`names[${i}]`, n)) ?? "");
  }
  const referenced = raw.referenced === undefined ? raw.names === undefined : raw.referenced === true;
  if (!v.ok) throw new Error(v.errors.join("; "));
  let usedBy = new Map<string, string[]>();
  let scan: Record<string, unknown> | undefined;
  if (referenced) {
    const r = await macroReferences(bridge, t);
    usedBy = r.refs;
    scan = { macros: r.macros, truncated: r.truncated };
    names = [...new Set([...names, ...r.refs.keys()])];
  }
  const scopes: VarScope[] = scope === "both" ? ["user", "global"] : [scope as VarScope];
  const reads = new Map<VarScope, { items: VarItem[]; user?: string | null }>();
  try {
    for (const s of scopes) reads.set(s, names.length ? await readVariables(bridge, s, names, t) : { items: [] });
  } catch (err) {
    if (unknownOp(err)) throw new Error(NEEDS_BRIDGE);
    throw err;
  }
  const variables = names.map((name, i) => {
    const u = reads.get("user")?.items[i];
    const g = reads.get("global")?.items[i];
    const strip = (x?: VarItem) => (x ? (x.exists ? { exists: true, value: x.value, type: x.type } : { exists: false }) : undefined);
    return {
      name,
      ...(u ? { user: strip(u) } : {}),
      ...(g ? { global: strip(g) } : {}),
      ...(scope === "both" ? { resolvesTo: u?.exists ? "user" : g?.exists ? "global" : null } : {}),
      ...(usedBy.has(name) ? { usedBy: usedBy.get(name) } : {}),
    };
  });
  return {
    scope,
    user: reads.get("user")?.user ?? null,
    variables,
    ...(scan ? { referencedIn: scan } : {}),
    note: "Variables cannot be listed on grandMA3 2.5.1 (no API enumerates them); these are the names asked for and the $variables the macros reference. A user variable shadows a global one of the same name in $references; user variables are the bridge's user's.",
  };
}

// ---------------------------------------------------------------------------
// gma3_set_variable
// ---------------------------------------------------------------------------

interface SetArgs {
  scope?: unknown;
  name?: unknown;
  value?: unknown;
  type?: unknown;
  delete?: unknown;
  verify?: unknown;
}

/** Variables are typed values, not measurements: the read-back must be exactly the value sent (review round 1). */
const sameValue = (a: unknown, b: unknown) => a === b;

export async function setVariable(ctx: ToolContext, raw: SetArgs): Promise<OperationResult> {
  const op = raw.delete === true ? "delete_variable" : "set_variable";
  const v = new Validator();
  const scope = raw.scope === "global" || raw.scope === "user" ? (raw.scope as VarScope) : undefined;
  if (!scope) v.fail("scope must be global or user");
  const name = v.check(() => variableName("name", raw.name));
  const del = raw.delete === true;
  let type: VarType | undefined;
  if (del) {
    if (raw.value !== undefined || raw.type !== undefined) v.fail("delete takes no value or type");
  } else {
    if (raw.value === undefined) v.fail("value is required (or delete: true)");
    else if (typeof raw.value === "number") {
      if (!Number.isFinite(raw.value)) v.fail("value must be a finite number or a text");
      type = (raw.type as VarType | undefined) ?? (Number.isInteger(raw.value) ? "integer" : "double");
      if (type === "integer" && !Number.isInteger(raw.value)) v.fail("type integer needs a whole number");
      if (type === "text") v.fail('type text needs a string value (pass "9" for the text 9)');
    } else if (typeof raw.value === "string") {
      type = (raw.type as VarType | undefined) ?? "text";
      if (type !== "text") v.fail(`type ${type} needs a number value`);
      if (raw.value.length > 4096) v.fail("value is longer than 4096 characters");
    } else v.fail("value must be a number or a string");
    if (raw.type !== undefined && !["integer", "double", "text"].includes(String(raw.type))) v.fail("type must be integer, double or text");
  }
  const verify = raw.verify !== false;
  const target: Record<string, unknown> = { scope: raw.scope, name: raw.name, ...(del ? { delete: true } : { value: raw.value, type }) };
  if (!v.ok || !scope || name === undefined) return validationFailure(op, target, v.errors);
  const { bridge } = ctx;
  const t = ctx.requestTimeoutMs;
  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    let before: VarItem | undefined;
    let user: string | null | undefined;
    const write = await requestStep(bridge, del ? "delete" : "set", del ? "vars.delete" : "vars.set", del ? { scope, name } : { scope, name, value: raw.value, type }, (res) => {
      const r = res as { before?: VarItem; user?: string | null };
      before = r.before;
      user = r.user;
      return { name: del ? "delete" : "set", status: "succeeded", op: del ? "vars.delete" : "vars.set", detail: { before: r.before } };
    }, t);
    if (write.status === "failed" && /unknown op/.test(write.error ?? "")) write.error = `${write.error}: ${NEEDS_BRIDGE}`;
    steps.push(write);
    let verification: Verification = { status: "not_requested" };
    let after: VarItem | undefined;
    if (verify && write.status !== "failed") {
      const checked = del ? `${scope} variable ${name} no longer exists` : `${scope} variable ${name} = ${JSON.stringify(raw.value)} (${type})`;
      try {
        const r = await readVariables(bridge, scope, [name], t);
        after = r.items[0];
        user = r.user ?? user;
        steps.push(asRead({ name: "read_back", status: "succeeded", op: "vars.get" }));
        const ok = del ? after?.exists === false : after?.exists === true && after.type === type && sameValue(after.value, raw.value);
        verification = ok ? { status: "matched", checked } : { status: "mismatched", checked, actual: after, detail: del ? `${name} still exists (${JSON.stringify(after?.value)})` : `${name} reads ${after?.exists ? `${JSON.stringify(after.value)} (${after.type})` : "missing"}` };
      } catch (err) {
        steps.push(asRead(stepFromError("read_back", err, { op: "vars.get" })));
        verification = { status: "unavailable", checked, detail: err instanceof Error ? err.message : String(err) };
      }
    }
    const warnings = scope === "user" ? [`user variables are the bridge's user's (${user ?? "the plugin's user profile"}); another user on the console has its own`] : [];
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { before: before ?? null, after: after ?? null, ...(scope === "user" ? { user: user ?? null } : {}) } });
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const setShape = {
  scope: z.enum(["global", "user"]).optional().describe("global (every user) or user (the bridge's user profile). Required unless variables is given (it may then be a default)."),
  name: z.string().optional().describe("Variable name (case-sensitive). Required unless variables is given."),
  value: z.union([z.number(), z.string()]).optional().describe('The value: a number (integer or double) or a text ("9" is the text 9).'),
  type: z.enum(["integer", "double", "text"]).optional().describe("The type (default: from the value: whole number integer, other number double, string text)."),
  delete: z.boolean().optional().describe("Delete the variable instead of setting it."),
  verify: z.boolean().optional().describe("Read the variable back and compare (default true)."),
};

export const registerVariableTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_variables",
    {
      title: "Read console variables (global and user)",
      description:
        "Read-only. The values and types (integer, double, text) of global and user variables, by name, and every $variable the macros reference (referenced, default when no names are given: each with the macro lines that use it). " +
        "Variables cannot be listed on grandMA3 2.5.1 (no API enumerates them), so a variable that no macro references is read by its name. With scope both (default), resolvesTo says which one a $reference uses: a user variable shadows a global one. User variables are the bridge's user's. $variables expand in commands sent through gma3_command (outside quotes). Needs bridge 0.31.0.",
      inputSchema: {
        names: z.array(z.string()).optional().describe("Variable names to read (case-sensitive)."),
        scope: z.enum(["global", "user", "both"]).optional().describe("Which variables (default both)."),
        referenced: z.boolean().optional().describe("Also read every $variable the macros reference (default: true when no names are given)."),
      },
    },
    async (args) => {
      try {
        return json(await readVariablesTool(ctx, args as { names?: unknown; scope?: unknown; referenced?: unknown }));
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_set_variable",
    {
      title: "Set or delete a console variable",
      description:
        "Set a global or user variable to a value with its type (integer, double or text, as SetGlobalVariable / SetUserVariable do; a text keeps quotes exactly), or delete it, then read it back (value and type). User variables are the bridge's user's (another user profile has its own). Macros and cue commands use them as $name (outside quotes); a user variable shadows a global one. Needs bridge 0.31.0. " +
        BATCH_NOTE,
      inputSchema: {
        ...setShape,
        variables: z
          .array(z.object({ scope: z.enum(["global", "user"]).optional(), name: z.string(), value: z.union([z.number(), z.string()]).optional(), type: z.enum(["integer", "double", "text"]).optional(), delete: z.boolean().optional() }))
          .optional()
          .describe("Batch form: several variables, each {scope, name, value, type} or {scope, name, delete: true}; scope may be given once for all."),
        ...batchOptionShape,
      },
    },
    async (args) =>
      operation(() =>
        (args as Record<string, unknown>).variables !== undefined
          ? runBatchCall(args as Record<string, unknown>, {
              ctx,
              operation: "set_variable",
              listKey: "variables",
              identityKeys: ["name", "value", "type", "delete"],
              label: (it) => `${String(it.scope)} ${String(it.name)}`,
              key: (it) => `${String(it.scope)} ${String(it.name)}`,
              check: (items) => duplicates(items.map((it) => `${String(it.scope)} ${String(it.name)}`)).map((x) => `${x} appears more than once in variables`),
              run: (it, c) => setVariable(c, it as SetArgs),
            })
          : setVariable(ctx, args as SetArgs),
      ),
  );
};
