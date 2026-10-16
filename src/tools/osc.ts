/**
 * SU-18: OSC input and output (SETUP.md SU-18, docs/probes/su-18-osc-config-macos-2.5.1.md).
 *
 *   gma3_osc              read-only: input and output switches, interface and preferred IP, every OSC line, the
 *                         console's network interfaces, and what that means (who can send commands, where output goes)
 *   gma3_configure_osc    switches input and output, sets the preferred IP, adds / edits / removes lines; preview,
 *                         read back per property; network: true when the change opens command input or output to a
 *                         network beyond loopback
 *   gma3_test_osc_input   sends a loopback /cmd that sets a marker variable and reads the variable back: proof that the
 *                         console received and ran it
 *
 * Bridge ops osc.read / osc.set / osc.addLine / osc.removeLine (0.33.0). Console facts (onPC 2.5.1, macOS, live
 * 2026-10-16):
 *   - The input socket listens on every interface (UDP *:port) whatever Interface and PreferredIP say: a command sent
 *     to the LAN address was run with PreferredIP 127.0.0.0/8, and with PreferredIP 10.0.0.0/8 (Interface 0.0, none).
 *     So command input that is on is reachable from every network the machine is on.
 *   - PreferredIP picks Interface (192.168.0.0/16 -> en0, 127.0.0.0/8 -> lo0).
 *   - EnableInput off closes the socket and on opens it. A line's port change takes effect only when input goes off
 *     and on again, so the tool re-enables input after such a change.
 *   - ReceiveCommand runs /cmd; Receive (faders, keys) is not needed for commands. A prefix makes the address
 *     /<prefix>/cmd and the plain /cmd is then ignored.
 *   - Send on a line with EnableOutput sends playback changes (e.g. /14.14.1.7.1 FaderMaster) to DestinationIP:Port.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { OscSender } from "../osc.js";
import { asRead, buildResult, notRequested, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, finiteNumber } from "../validate.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";

export interface OscLine {
  index: number;
  name?: string;
  mode?: string | null;
  port?: number | null;
  prefix?: string | null;
  destinationIp?: string | null;
  receive?: boolean | null;
  receiveCommand?: boolean | null;
  send?: boolean | null;
  sendCommand?: boolean | null;
  echoInput?: boolean | null;
  echoOutput?: boolean | null;
  note?: string | null;
  [k: string]: unknown;
}
export interface OscState {
  enableInput?: boolean | null;
  enableOutput?: boolean | null;
  interface?: string | null;
  interfaceResolved?: { name?: string; ip?: string; mask?: string } | null;
  preferredIp?: string | null;
  lines: OscLine[];
  interfaces: Array<{ index: number; name: string; ips: Array<{ address: string; ip?: string; mask?: string }> }>;
}

const NEEDS_BRIDGE = "the console runs an older bridge plugin without the OSC ops (bridge 0.33.0); update the plugin";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Time between input off and on so the console closes and re-opens its socket (live: 400 ms is enough). */
const REBIND_MS = 400;
const MARKER = "McpOscTest";

export async function readOsc(bridge: Gma3Bridge, t: number): Promise<OscState> {
  try {
    const r = (await bridge.request("osc.read", {}, t)) as OscState;
    return { ...r, lines: Array.isArray(r.lines) ? r.lines : [], interfaces: Array.isArray(r.interfaces) ? r.interfaces : [] };
  } catch (err) {
    if (err instanceof Error && /unknown op/i.test(err.message)) throw new Error(NEEDS_BRIDGE);
    throw err;
  }
}

const isLoopback = (ip: string | null | undefined) => typeof ip === "string" && /^127\./.test(ip);
/** The machine's addresses outside loopback (the networks command input is reachable from). */
const networkIps = (s: OscState) => s.interfaces.flatMap((n) => n.ips.filter((ip) => ip.ip && !isLoopback(ip.ip)).map((ip) => `${n.name} ${ip.ip}`));
const commandLines = (s: OscState) => (s.enableInput ? s.lines.filter((l) => l.receiveCommand) : []);
const sendingLines = (s: OscState) => (s.enableOutput ? s.lines.filter((l) => l.send || l.sendCommand) : []);
const address = (l: OscLine) => `${l.prefix ? `/${l.prefix}` : ""}/cmd`;

/** What the configuration means, in words and flags. */
export function explainOsc(s: OscState, sender?: { host: string; port: number; prefix?: string }) {
  const cmd = commandLines(s);
  const nets = networkIps(s);
  const out = sendingLines(s);
  const matching = sender ? cmd.find((l) => l.port === sender.port && (l.prefix || "") === (sender.prefix || "")) : undefined;
  return {
    input: {
      enabled: s.enableInput ?? null,
      acceptsCommands: cmd.length > 0,
      commandLines: cmd.map((l) => ({ line: l.index, name: l.name, port: l.port, address: address(l) })),
      reachableFrom: cmd.length ? ["loopback", ...nets] : [],
      explanation: !s.enableInput
        ? "input is off: the console accepts no OSC"
        : !cmd.length
          ? "input is on, but no line has Receive Command: OSC commands are ignored"
          : `the console runs OSC commands sent to UDP port ${[...new Set(cmd.map((l) => l.port))].join(", ")} (${cmd.map((l) => address(l)).join(", ")}). It listens on every interface whatever Interface and PreferredIP say${nets.length ? `, so anyone who can reach ${nets.join(", ")} can run commands on this console` : "; this machine has no address outside loopback right now"}.`,
    },
    output: {
      enabled: s.enableOutput ?? null,
      sending: out.map((l) => ({ line: l.index, name: l.name, destination: `${l.destinationIp}:${l.port}`, loopback: isLoopback(l.destinationIp), send: l.send ?? null, sendCommand: l.sendCommand ?? null })),
      explanation: !s.enableOutput ? "output is off" : out.length ? `output goes to ${out.map((l) => `${l.destinationIp}:${l.port}`).join(", ")}` : "output is on, but no line has Send or Send Command",
    },
    ...(sender
      ? {
          serverSender: {
            ...sender,
            matchingLine: matching?.index ?? null,
            note: matching
              ? `gma3_command via osc and gma3_start_bridge reach the console through line ${matching.index}`
              : `no line runs commands sent to port ${sender.port}${sender.prefix ? ` with prefix ${sender.prefix}` : ""}: gma3_command via osc and gma3_start_bridge cannot reach the console`,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Configure
// ---------------------------------------------------------------------------

interface LineSpec {
  line?: number;
  add?: boolean;
  remove?: boolean;
  name?: string;
  port?: number;
  prefix?: string;
  destination_ip?: string;
  receive?: boolean;
  receive_command?: boolean;
  send?: boolean;
  send_command?: boolean;
  echo_input?: boolean;
  echo_output?: boolean;
  note?: string;
}
/** Spec field -> console property, and how its value is written and displayed. */
const LINE_PROPS: Array<{ key: keyof LineSpec; property: string; state: keyof OscLine; kind: "bool" | "int" | "text" }> = [
  { key: "name", property: "Name", state: "name", kind: "text" },
  { key: "port", property: "Port", state: "port", kind: "int" },
  { key: "prefix", property: "Prefix", state: "prefix", kind: "text" },
  { key: "destination_ip", property: "DestinationIP", state: "destinationIp", kind: "text" },
  { key: "receive", property: "Receive", state: "receive", kind: "bool" },
  { key: "receive_command", property: "ReceiveCommand", state: "receiveCommand", kind: "bool" },
  { key: "send", property: "Send", state: "send", kind: "bool" },
  { key: "send_command", property: "SendCommand", state: "sendCommand", kind: "bool" },
  { key: "echo_input", property: "EchoInput", state: "echoInput", kind: "bool" },
  { key: "echo_output", property: "EchoOutput", state: "echoOutput", kind: "bool" },
  { key: "note", property: "Note", state: "note", kind: "text" },
];
const yn = (b: boolean) => (b ? "Yes" : "No");
const display = (kind: string, v: unknown) => (kind === "bool" ? yn(v === true) : String(v));
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** A new line as the console creates it (live): UDP, port 8000, destination 127.255.255.255, nothing on. */
const NEW_LINE: OscLine = { index: 0, port: 8000, prefix: "", destinationIp: "127.255.255.255", receive: false, receiveCommand: false, send: false, sendCommand: false };

type Step =
  | { kind: "set"; name: string; target: "base" | "line"; index?: number; add?: number; property: string; value: string }
  | { kind: "add"; name: string; add: number }
  | { kind: "remove"; name: string; index: number }
  | { kind: "wait"; name: string; ms: number };

export async function configureOsc(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "configure_osc";
  const v = new Validator();
  const bool = (k: string) => (raw[k] === undefined ? undefined : typeof raw[k] === "boolean" ? (raw[k] as boolean) : (v.fail(`${k} must be true or false`), undefined));
  const enableInput = bool("enable_input");
  const enableOutput = bool("enable_output");
  let preferredIp: string | undefined;
  if (raw.preferred_ip !== undefined) {
    const m = typeof raw.preferred_ip === "string" ? raw.preferred_ip.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/) : null;
    if (!m || !IPV4.test(m[1]) || Number(m[2]) > 32) v.fail('preferred_ip must be an IPv4 network such as "127.0.0.0/8" or "192.168.0.0/16"');
    else preferredIp = raw.preferred_ip as string;
  }
  const specs: LineSpec[] = Array.isArray(raw.lines) ? (raw.lines as LineSpec[]) : raw.lines === undefined ? [] : (v.fail("lines must be a list"), []);
  const seen = new Set<number>();
  specs.forEach((l, i) => {
    const p = `lines[${i}]`;
    if (!l || typeof l !== "object") return v.fail(`${p} must be an object`);
    if (l.add && l.line !== undefined) v.fail(`${p}: add or line, not both`);
    if (!l.add && l.line === undefined) v.fail(`${p}: give line (the line number) or add: true`);
    if (l.remove && Object.keys(l).some((k) => !["line", "remove"].includes(k))) v.fail(`${p}: remove takes only line`);
    if (l.line !== undefined) {
      v.check(() => finiteNumber(`${p}.line`, l.line, { integer: true, min: 1, max: 1000 }));
      if (seen.has(l.line)) v.fail(`${p}: line ${l.line} appears more than once; give one change per line`);
      seen.add(l.line);
    }
    if (l.port !== undefined) v.check(() => finiteNumber(`${p}.port`, l.port, { integer: true, min: 1, max: 65535 }));
    if (l.prefix !== undefined && (typeof l.prefix !== "string" || !/^[A-Za-z0-9_-]{0,64}$/.test(l.prefix))) v.fail(`${p}.prefix must be letters, digits, _ or - (at most 64; no slashes), or "" for none`);
    if (l.destination_ip !== undefined && (typeof l.destination_ip !== "string" || !IPV4.test(l.destination_ip))) v.fail(`${p}.destination_ip must be an IPv4 address`);
    for (const k of ["name", "note"] as const) if (l[k] !== undefined && (typeof l[k] !== "string" || /[\u0000-\u001f"]/.test(l[k] as string) || (l[k] as string).length > 128)) v.fail(`${p}.${k} must be text of at most 128 characters without control characters or double quotes`);
    if (l.name !== undefined && !l.name) v.fail(`${p}.name must not be empty`);
    for (const k of ["receive", "receive_command", "send", "send_command", "echo_input", "echo_output"] as const) if (l[k] !== undefined && typeof l[k] !== "boolean") v.fail(`${p}.${k} must be true or false`);
    const known = new Set(["line", "add", "remove", ...LINE_PROPS.map((x) => x.key)]);
    for (const k of Object.keys(l)) if (!known.has(k)) v.fail(`${p}: unknown field ${k} (mode is not configurable: lines are UDP)`);
  });
  if (enableInput === undefined && enableOutput === undefined && preferredIp === undefined && !specs.length) v.fail("nothing to change: give enable_input, enable_output, preferred_ip and/or lines");
  const preview = raw.preview === true;
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true: the console's OSC configuration is changed (no undo; the result carries the previous values). preview: true needs no acknowledgement");
  const target = { enable_input: enableInput, enable_output: enableOutput, preferred_ip: preferredIp, lines: raw.lines };
  if (!v.ok) return validationFailure(op, target, v.errors);

  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    let before: OscState;
    try {
      before = await readOsc(ctx.bridge, t);
      steps.push(asRead({ name: "read_osc", status: "succeeded", op: "osc.read" }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_osc", err, { op: "osc.read" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was sent") });
    }
    const refuse = (why: string, extra: Record<string, unknown> = {}) => {
      steps.push(asRead({ name: "check", status: "failed", error: `${why}; nothing was changed` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was changed"), extra });
    };

    // The configuration after the change, from the console's values plus the request.
    const after: OscState = { ...before, lines: before.lines.map((l) => ({ ...l })) };
    if (enableInput !== undefined) after.enableInput = enableInput;
    if (enableOutput !== undefined) after.enableOutput = enableOutput;
    const effective: Array<{ label: string; index?: number; add?: number; before?: OscLine; after: OscLine; spec: LineSpec; changed: typeof LINE_PROPS }> = [];
    let adds = 0;
    for (const s of specs) {
      if (s.remove) continue;
      const cur = s.add ? undefined : before.lines.find((l) => l.index === s.line);
      if (!s.add && !cur) return refuse(`OSC line ${s.line} does not exist (lines: ${before.lines.map((l) => l.index).join(", ") || "none"})`);
      const base = cur ?? { ...NEW_LINE, index: before.lines.length + adds + 1 };
      const next: OscLine = { ...base };
      for (const p of LINE_PROPS) if (s[p.key] !== undefined) (next as Record<string, unknown>)[p.state] = s[p.key];
      const changed = LINE_PROPS.filter((p) => s[p.key] !== undefined && (s.add || display(p.kind, s[p.key]) !== display(p.kind, (cur as Record<string, unknown>)[p.state])));
      const e = { label: s.add ? `new ${adds + 1}` : String(s.line), ...(s.add ? { add: adds++ } : { index: s.line }), before: cur, after: next, spec: s, changed };
      effective.push(e);
      if (cur) after.lines[after.lines.indexOf(after.lines.find((l) => l.index === cur.index)!)] = next;
      else after.lines.push(next);
    }
    const removes = specs.filter((s) => s.remove).map((s) => s.line as number);
    for (const r of removes) if (!before.lines.some((l) => l.index === r)) return refuse(`OSC line ${r} does not exist`);
    after.lines = after.lines.filter((l) => !removes.includes(l.index));

    // Ports: two command lines on one port with the same prefix would be ambiguous.
    const cmdAfter = commandLines(after);
    const clash = cmdAfter.find((l, i) => cmdAfter.some((m, j) => j < i && m.port === l.port && (m.prefix || "") === (l.prefix || "")));
    if (clash) return refuse(`two lines would run commands on port ${clash.port} with the same prefix`);

    // The network: command input that is reachable beyond loopback after the change and was not before, or output to a
    // destination outside loopback that was not sent to before.
    const nets = networkIps(before);
    const cmdBefore = commandLines(before);
    // A port is what the network reaches: a prefix or name change on a port that already runs commands opens nothing.
    const opensInput = nets.length > 0 && cmdAfter.some((l) => !cmdBefore.some((b) => b.port === l.port));
    const destBefore = new Set(sendingLines(before).map((l) => `${l.destinationIp}:${l.port}`));
    const opensOutput = sendingLines(after).filter((l) => !isLoopback(l.destinationIp) && !destBefore.has(`${l.destinationIp}:${l.port}`));
    const networkNotes = [
      ...(opensInput
        ? [`the console would run OSC commands sent to UDP port ${[...new Set(cmdAfter.map((l) => l.port))].join(", ")} from anyone who can reach this machine (${nets.join(", ")}): it listens on every interface whatever Interface and PreferredIP say`]
        : []),
      ...(opensOutput.length ? [`the console would send OSC onto the network to ${opensOutput.map((l) => `${l.destinationIp}:${l.port}`).join(", ")}`] : []),
    ];

    // The plan: input off first when it goes off; line edits (adds, writes, removes from the highest number); the
    // preferred IP; input on last; a re-bind (off, wait, on) when input stays on and a command line's port changed or a
    // receiving line was added; output on last.
    const plan: Step[] = [];
    if (enableInput === false && before.enableInput) plan.push({ kind: "set", name: "EnableInput", target: "base", property: "EnableInput", value: "No" });
    if (enableOutput === false && before.enableOutput) plan.push({ kind: "set", name: "EnableOutput", target: "base", property: "EnableOutput", value: "No" });
    for (const e of effective) {
      if (e.add !== undefined) plan.push({ kind: "add", name: `add line ${e.label}`, add: e.add });
      for (const p of e.changed) {
        const where = e.index !== undefined ? { index: e.index } : { add: e.add };
        plan.push({ kind: "set", name: `line ${e.label} ${p.property}`, target: "line", ...where, property: p.property, value: display(p.kind, e.spec[p.key]) });
      }
    }
    for (const r of [...removes].sort((a, b) => b - a)) plan.push({ kind: "remove", name: `remove line ${r}`, index: r });
    if (preferredIp !== undefined && preferredIp !== before.preferredIp) plan.push({ kind: "set", name: "PreferredIP", target: "base", property: "PreferredIP", value: preferredIp });
    const inputOnBefore = before.enableInput === true;
    const inputOnAfter = after.enableInput === true;
    // A port change on an existing line, or a new line that receives; a send-only line needs no input socket.
    const rebind = inputOnBefore && inputOnAfter && effective.some((e) => (e.add === undefined && e.changed.some((p) => p.key === "port")) || (e.add !== undefined && (e.after.receive || e.after.receiveCommand)));
    if (rebind) {
      plan.push({ kind: "set", name: "EnableInput off (re-bind)", target: "base", property: "EnableInput", value: "No" });
      plan.push({ kind: "wait", name: "wait for the socket to close", ms: REBIND_MS });
      plan.push({ kind: "set", name: "EnableInput on (re-bind)", target: "base", property: "EnableInput", value: "Yes" });
    }
    if (enableInput === true && !inputOnBefore) plan.push({ kind: "set", name: "EnableInput", target: "base", property: "EnableInput", value: "Yes" });
    if (enableOutput === true && !before.enableOutput) plan.push({ kind: "set", name: "EnableOutput", target: "base", property: "EnableOutput", value: "Yes" });

    const previewOut = {
      plan: plan.map((s) => ({ step: s.name, ...(s.kind === "set" ? { value: s.value } : {}) })),
      ...(networkNotes.length ? { networkNote: networkNotes.join("; ") } : {}),
      ...(rebind ? { rebindNote: "a line's port only takes effect when input goes off and on: input is switched off for about 0.4 s and on again" } : {}),
    };
    if (!plan.length) return buildResult({ operation: op, target, steps, verification: { status: "matched", checked: "the configuration already reads as requested" }, summary: "Nothing to change: the OSC configuration already reads as requested.", extra: { ...previewOut, current: explainOsc(before, ctx.osc) } });
    if (preview) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: `Preview only; nothing was sent. ${plan.length} step(s).${previewOut.networkNote ? ` ${previewOut.networkNote}.` : ""}`, extra: { ...previewOut, wouldBe: explainOsc(after, ctx.osc) } });
    if (networkNotes.length && raw.network !== true) return refuse(`${previewOut.networkNote}; pass network: true to confirm`, previewOut);

    // Apply: every write is judged by the value the console answers; a write it did not take stops the call.
    const addIndex: number[] = [];
    let stopped: string | undefined;
    let sentUpTo = 0;
    for (const s of plan) {
      if (stopped) break;
      sentUpTo++;
      try {
        if (s.kind === "wait") {
          await sleep(s.ms);
          continue;
        }
        if (s.kind === "add") {
          const r = (await ctx.bridge.request("osc.addLine", { exclusive: true }, t)) as { index?: number };
          if (typeof r.index !== "number") throw new Error("the console did not report the new line's number");
          addIndex[s.add] = r.index;
          steps.push({ name: `add line ${r.index}`, status: "succeeded", op: "osc.addLine", detail: r });
        } else if (s.kind === "remove") {
          const r = await ctx.bridge.request("osc.removeLine", { index: s.index, exclusive: true }, t);
          steps.push({ name: s.name, status: "succeeded", op: "osc.removeLine", detail: r });
        } else {
          const index = s.add !== undefined ? addIndex[s.add] : s.index;
          const name = s.add !== undefined ? s.name.replace(/line new \d+/, `line ${index}`) : s.name;
          const r = (await ctx.bridge.request("osc.set", { target: s.target, index, property: s.property, value: s.value, exclusive: true }, t)) as { value?: unknown };
          const got = r?.value === undefined || r?.value === null ? undefined : String(r.value);
          if (got !== s.value) {
            steps.push({ name, status: got === undefined ? "unknown" : "failed", op: "osc.set", error: got === undefined ? `the console's answer for ${s.property} could not be read; the read-back decides` : `the console kept ${s.property} ${JSON.stringify(got)} (expected ${JSON.stringify(s.value)})`, detail: r });
            stopped = name;
            continue;
          }
          steps.push({ name, status: "succeeded", op: "osc.set", detail: r });
        }
      } catch (err) {
        steps.push(stepFromError(s.name, err, { op: s.kind === "add" ? "osc.addLine" : s.kind === "remove" ? "osc.removeLine" : "osc.set" }));
        stopped = s.name;
      }
    }
    // A stop between the two halves of a re-bind leaves input off: put it back on, since nothing else depends on it.
    const inputLeftOff = stopped && rebind && steps.some((x) => x.name === "EnableInput off (re-bind)" && x.status === "succeeded") && !steps.some((x) => x.name === "EnableInput on (re-bind)" && x.status === "succeeded");
    if (inputLeftOff) {
      try {
        await ctx.bridge.request("osc.set", { target: "base", property: "EnableInput", value: "Yes", exclusive: true }, t);
        steps.push({ name: "EnableInput on (restore after stop)", status: "succeeded", op: "osc.set" });
      } catch (err) {
        steps.push(stepFromError("EnableInput on (restore after stop)", err, { op: "osc.set" }));
      }
    }

    // Read back and compare everything the request named.
    let verification: Verification = notRequested();
    const readBack: StepResult[] = [];
    let now: OscState | undefined;
    if (raw.verify !== false || stopped) {
      try {
        now = await readOsc(ctx.bridge, t);
        readBack.push(asRead({ name: "read_back", status: "succeeded", op: "osc.read" }));
        const mism: string[] = [];
        if (enableInput !== undefined && now.enableInput !== enableInput) mism.push(`input reads ${now.enableInput ? "on" : "off"}`);
        if (enableOutput !== undefined && now.enableOutput !== enableOutput) mism.push(`output reads ${now.enableOutput ? "on" : "off"}`);
        if (preferredIp !== undefined && now.preferredIp !== preferredIp) mism.push(`PreferredIP reads ${now.preferredIp}`);
        const removedBelow = (i: number) => removes.filter((r) => r < i).length;
        for (const e of effective) {
          const idx = e.add !== undefined ? addIndex[e.add] : (e.index as number);
          if (idx === undefined) {
            mism.push(`line ${e.label} was not added`);
            continue;
          }
          const got = now.lines.find((l) => l.index === idx - removedBelow(idx));
          if (!got) {
            mism.push(`line ${e.label} is missing`);
            continue;
          }
          for (const p of LINE_PROPS) {
            if (e.spec[p.key] === undefined) continue;
            const want = display(p.kind, e.spec[p.key]);
            const have = got[p.state] === undefined || got[p.state] === null ? "(unreadable)" : display(p.kind, got[p.state]);
            if (want !== have) mism.push(`line ${e.label} ${p.property} reads ${have}, expected ${want}`);
          }
        }
        const expectCount = before.lines.length + addIndex.filter((x) => x !== undefined).length - steps.filter((x) => x.op === "osc.removeLine" && x.status === "succeeded").length;
        if (now.lines.length !== expectCount) mism.push(`${now.lines.length} line(s), expected ${expectCount}`);
        const checked = "the input and output switches, the preferred IP, every named line property and the line count, read back";
        verification = mism.length ? { status: "mismatched", checked, detail: mism.join("; ") } : { status: "matched", checked };
      } catch (err) {
        readBack.push(asRead(stepFromError("read_back", err, { op: "osc.read" })));
        verification = unavailable("the configuration could not be read back");
      }
    }
    for (const s of plan.slice(sentUpTo)) if (s.kind !== "wait") steps.push({ name: s.name, status: "skipped", error: `not sent: the call stopped at ${stopped}` });
    const result = buildResult({
      operation: op,
      target,
      steps,
      verification,
      warnings: [
        "the OSC configuration has no undo; previous holds the values before this call",
        ...(networkNotes.length && !stopped ? networkNotes.map((n) => n.replace(/would /g, "now ")) : []),
        ...(stopped ? [`stopped at ${stopped}: nothing after it was sent${inputLeftOff ? "; input, switched off for the re-bind, was switched on again" : ""}`] : []),
      ],
      extra: { ...previewOut, previous: before, ...(now ? { now: { ...now, meaning: explainOsc(now, ctx.osc) } } : {}), testWith: "gma3_test_osc_input proves that a command line receives" },
    });
    result.steps.push(...readBack);
    // outcomeOf ignores skipped steps; an unfinished plan is never a success.
    if (plan.length > sentUpTo && result.outcome === "succeeded") result.outcome = steps.some((x) => x.status === "succeeded" && x.kind !== "read") ? "partial" : "failed";
    return result;
  });
}

// ---------------------------------------------------------------------------
// Loopback test
// ---------------------------------------------------------------------------

/**
 * Sends `/[prefix/]cmd SetUserVariable "McpOscTest" "<nonce>"` to 127.0.0.1:<port> of each command line and reads the
 * variable back through the bridge (the bridge's user, who also runs OSC commands: live). Seeing the nonce proves that
 * the console received and ran the command. The variable is deleted afterwards.
 */
export async function testOscInput(ctx: ToolContext, raw: Record<string, unknown>, send: (port: number, prefix: string | undefined, command: string) => Promise<void> = defaultSend): Promise<OperationResult> {
  const op = "test_osc_input";
  const v = new Validator();
  const line = raw.line === undefined ? undefined : v.check(() => finiteNumber("line", raw.line, { integer: true, min: 1, max: 1000 }));
  const timeoutMs = v.check(() => finiteNumber("timeout_ms", raw.timeout_ms, { integer: true, min: 200, max: 5000, optional: true })) ?? 1500;
  const target = { line: line ?? "every line that receives commands" };
  if (!v.ok) return validationFailure(op, target, v.errors);
  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    let s: OscState;
    try {
      s = await readOsc(ctx.bridge, t);
      steps.push(asRead({ name: "read_osc", status: "succeeded", op: "osc.read" }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_osc", err, { op: "osc.read" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was sent") });
    }
    const refuse = (why: string) => {
      steps.push(asRead({ name: "check", status: "failed", error: `${why}; nothing was sent` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was sent"), extra: { meaning: explainOsc(s, ctx.osc) } });
    };
    if (!s.enableInput) return refuse("OSC input is off (gma3_configure_osc enable_input: true)");
    const lines = line !== undefined ? s.lines.filter((l) => l.index === line) : commandLines(s);
    if (line !== undefined && !lines.length) return refuse(`OSC line ${line} does not exist`);
    if (line !== undefined && !lines[0].receiveCommand) return refuse(`OSC line ${line} does not have Receive Command`);
    if (!lines.length) return refuse("no OSC line has Receive Command");
    const bad = lines.find((l) => typeof l.port !== "number");
    if (bad) return refuse(`line ${bad.index}'s port cannot be read`);
    try {
      const pre = (await ctx.bridge.request("vars.get", { scope: "user", names: [MARKER] }, t)) as { items?: Array<{ exists?: boolean }> };
      if (pre.items?.[0]?.exists) return refuse(`the user variable ${MARKER} already exists (another test or a show variable); delete it first`);
      steps.push(asRead({ name: "check_marker", status: "succeeded", op: "vars.get" }));
    } catch (err) {
      steps.push(asRead(stepFromError("check_marker", err, { op: "vars.get" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("the marker variable cannot be read (needs bridge 0.31.0); nothing was sent") });
    }

    const results: Array<{ line: number; name?: string; port: number; address: string; received: boolean; latencyMs?: number }> = [];
    for (const l of lines) {
      const nonce = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const name = `line ${l.index}: ${address(l)} to 127.0.0.1:${l.port}`;
      const t0 = Date.now();
      try {
        await send(l.port as number, l.prefix || undefined, `SetUserVariable "${MARKER}" "${nonce}"`);
      } catch (err) {
        steps.push(stepFromError(name, err, { op: "osc" }));
        results.push({ line: l.index, name: l.name, port: l.port as number, address: address(l), received: false });
        continue;
      }
      let received = false;
      while (Date.now() - t0 < timeoutMs) {
        await sleep(100);
        const r = (await ctx.bridge.request("vars.get", { scope: "user", names: [MARKER] }, t).catch(() => null)) as { items?: Array<{ value?: unknown }> } | null;
        if (r?.items?.[0]?.value === nonce) {
          received = true;
          break;
        }
      }
      const latencyMs = Date.now() - t0;
      steps.push({ name, status: "succeeded", op: "osc", detail: { received, ...(received ? { latencyMs } : {}) } });
      results.push({ line: l.index, name: l.name, port: l.port as number, address: address(l), received, ...(received ? { latencyMs } : {}) });
    }
    try {
      await ctx.bridge.request("vars.delete", { scope: "user", name: MARKER }, t);
      steps.push({ name: "delete_marker", status: "succeeded", op: "vars.delete" });
    } catch (err) {
      steps.push(stepFromError("delete_marker", err, { op: "vars.delete" }));
    }
    const missed = results.filter((r) => !r.received);
    const verification: Verification = missed.length
      ? { status: "mismatched", checked: `the marker variable ${MARKER} holds each test's nonce within ${timeoutMs} ms`, detail: `not received on ${missed.map((r) => `line ${r.line} (port ${r.port})`).join(", ")}: the console did not run the command (input socket not re-bound after a port change, a firewall, or another program on the port)` }
      : { status: "matched", checked: `the marker variable ${MARKER} held each test's nonce: the console received and ran the command` };
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      summary: missed.length ? `OSC input test: ${results.length - missed.length} of ${results.length} line(s) received.` : `OSC input works: the console ran the loopback test command on ${results.map((r) => `line ${r.line} (port ${r.port})`).join(", ")}.`,
      extra: { results, meaning: explainOsc(s, ctx.osc), note: "loopback proves the console receives; it listens on every interface, so a sender on the network reaches the same port unless a firewall stops it" },
    });
  });
}

function defaultSend(port: number, prefix: string | undefined, command: string): Promise<void> {
  return new OscSender({ host: "127.0.0.1", port, prefix }).send("/cmd", [command]);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerOscTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_osc",
    {
      title: "Read the OSC input and output configuration",
      description:
        "Read-only. The console's OSC input and output: EnableInput / EnableOutput, Interface and PreferredIP, every OSC line (port, prefix, Receive, Receive Command, Send, Send Command, destination IP), the network interfaces, and what it means: whether commands are accepted and from where (the console listens on every interface whatever Interface and PreferredIP say), where output goes, and whether this server's own OSC sender (gma3_command via osc, gma3_start_bridge) reaches a line. Needs bridge 0.33.0.",
      inputSchema: {},
    },
    async () => {
      try {
        const s = await readOsc(ctx.bridge, ctx.requestTimeoutMs);
        return json({ tool: "gma3_osc", meaning: explainOsc(s, ctx.osc), ...s, notes: ["a line's port change takes effect only when input goes off and on (gma3_configure_osc does this)", "gma3_test_osc_input proves that input works"] });
      } catch (err) {
        return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_configure_osc",
    {
      title: "Configure OSC input and output",
      description:
        "Switch OSC input / output, set the preferred IP, and add, edit or remove OSC lines (name, port, prefix, destination_ip, receive, receive_command, send, send_command, echo_input, echo_output, note). Lines are UDP. Validated first; every write is read back. A port change on a receiving line re-binds input (input off for about 0.4 s and on). " +
        "network: true is required when the change opens a port that runs OSC commands while this machine has an address beyond loopback: the console listens on every interface, so anyone who can reach this machine can then run commands. It is also required for new output to an address outside loopback. Requires exclusive: true; preview: true shows the plan. No undo: previous holds the values before. Test with gma3_test_osc_input. Needs bridge 0.33.0.",
      inputSchema: {
        enable_input: z.boolean().optional(),
        enable_output: z.boolean().optional(),
        preferred_ip: z.string().optional().describe('IPv4 network that picks the interface, e.g. "127.0.0.0/8". It does not limit who can send.'),
        lines: z
          .array(
            z.object({
              line: z.number().optional(),
              add: z.boolean().optional(),
              remove: z.boolean().optional(),
              name: z.string().optional(),
              port: z.number().optional(),
              prefix: z.string().optional(),
              destination_ip: z.string().optional(),
              receive: z.boolean().optional(),
              receive_command: z.boolean().optional(),
              send: z.boolean().optional(),
              send_command: z.boolean().optional(),
              echo_input: z.boolean().optional(),
              echo_output: z.boolean().optional(),
              note: z.string().optional(),
            }).passthrough(),
          )
          .optional(),
        network: z.boolean().optional().describe("Confirms that commands can then be run from the network (or output goes onto it)."),
        preview: z.boolean().optional(),
        verify: z.boolean().optional(),
        exclusive: z.boolean().optional(),
      },
    },
    async (args) => operation(() => configureOsc(ctx, args)),
  );

  server.registerTool(
    "gma3_test_osc_input",
    {
      title: "Test that OSC input works",
      description:
        "Proves that the console receives OSC commands, with no shell: sends /[prefix/]cmd SetUserVariable \"McpOscTest\" \"<nonce>\" to 127.0.0.1 on the port of each line with Receive Command (or `line`), then reads the variable back through the bridge. Matched when the console ran it. The variable is deleted afterwards; refused when it already exists or input is off. Needs bridge 0.33.0 (and 0.31.0's variable ops).",
      inputSchema: {
        line: z.number().optional().describe("Only this OSC line (default: every line with Receive Command)."),
        timeout_ms: z.number().optional().describe("How long to wait for each command (200-5000, default 1500)."),
      },
    },
    async (args) => operation(() => testOscInput(ctx, args)),
  );
};
