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
  /** True only when every interface and address was read; otherwise reachability is unknown. */
  interfacesComplete?: boolean;
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
/** Reachability is known only from a complete interface scan; a partial or failed one is never "loopback only". */
const reachKnown = (s: OscState) => s.interfacesComplete === true;
const commandLines = (s: OscState) => (s.enableInput === true ? s.lines.filter((l) => l.receiveCommand === true) : []);
const sendingLines = (s: OscState) => (s.enableOutput === true ? s.lines.filter((l) => l.send === true || l.sendCommand === true) : []);
/** Values the network judgement depends on that the console did not report (never assumed off). */
function unreadableFlags(s: OscState): string[] {
  const out: string[] = [];
  if (typeof s.enableInput !== "boolean") out.push("EnableInput");
  if (typeof s.enableOutput !== "boolean") out.push("EnableOutput");
  for (const l of s.lines) {
    for (const [k, label] of [["port", "Port"], ["receiveCommand", "ReceiveCommand"], ["send", "Send"], ["sendCommand", "SendCommand"], ["destinationIp", "DestinationIP"]] as const) {
      if (l[k] === null || l[k] === undefined || (k === "port" && typeof l[k] !== "number")) out.push(`line ${l.index} ${label}`);
    }
  }
  return out;
}
const address = (l: OscLine) => `${l.prefix ? `/${l.prefix}` : ""}/cmd`;

/** What the configuration means, in words and flags. */
export function explainOsc(s: OscState, sender?: { host: string; port: number; prefix?: string }) {
  const cmd = commandLines(s);
  const nets = networkIps(s);
  const known = reachKnown(s);
  const out = sendingLines(s);
  const unknownCmd = s.enableInput !== false ? s.lines.filter((l) => typeof l.receiveCommand !== "boolean") : [];
  const accepts = cmd.length > 0 ? true : typeof s.enableInput !== "boolean" || unknownCmd.length ? null : false;
  const matching = sender ? cmd.find((l) => l.port === sender.port && (l.prefix || "") === (sender.prefix || "")) : undefined;
  const reach = nets.length ? `, so anyone who can reach ${nets.join(", ")}${known ? "" : " (and possibly other networks: the interface scan was incomplete)"} can run commands on this console` : known ? "; this machine has no address outside loopback right now" : "; whether it is reachable from a network is unknown (the interface scan was incomplete)";
  return {
    input: {
      enabled: s.enableInput ?? null,
      acceptsCommands: accepts,
      commandLines: cmd.map((l) => ({ line: l.index, name: l.name, port: l.port, address: address(l) })),
      ...(unknownCmd.length ? { unreadableLines: unknownCmd.map((l) => l.index) } : {}),
      reachableFrom: cmd.length || accepts === null ? ["loopback", ...nets, ...(known ? [] : ["unknown: the interface scan was incomplete"])] : [],
      explanation:
        typeof s.enableInput !== "boolean"
          ? "whether input is on could not be read"
          : !s.enableInput
            ? "input is off: the console accepts no OSC"
            : !cmd.length
              ? unknownCmd.length
                ? `input is on; Receive Command could not be read on line ${unknownCmd.map((l) => l.index).join(", ")}, so whether commands are accepted is unknown`
                : "input is on, but no line has Receive Command: OSC commands are ignored"
              : `the console runs OSC commands sent to UDP port ${[...new Set(cmd.map((l) => l.port))].join(", ")} (${cmd.map((l) => address(l)).join(", ")}). It listens on every interface whatever Interface and PreferredIP say${reach}.`,
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

    // Nothing is judged from values the console did not report: an unreadable flag is never taken for off.
    const unreadable = unreadableFlags(before);
    if (unreadable.length) return refuse(`the console did not report ${unreadable.join(", ")}: whether commands or output reach the network cannot be judged`);

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
    // destination outside loopback that was not sent to before. Unknown reachability (an incomplete interface scan)
    // counts as networked. The plan below orders writes so that no intermediate state opens more than these two.
    const nets = networkIps(before);
    const networked = nets.length > 0 || !reachKnown(before);
    const where = nets.length ? `${nets.join(", ")}${reachKnown(before) ? "" : ", and possibly other networks (the interface scan was incomplete)"}` : "a network: this machine's interfaces could not all be read";
    const cmdBefore = commandLines(before);
    // A port is what the network reaches: a prefix or name change on a port that already runs commands opens nothing.
    const opensInput = networked && cmdAfter.some((l) => !cmdBefore.some((b) => b.port === l.port));
    const destBefore = new Set(sendingLines(before).map((l) => `${l.destinationIp}:${l.port}`));
    const opensOutput = sendingLines(after).filter((l) => !isLoopback(l.destinationIp) && !destBefore.has(`${l.destinationIp}:${l.port}`));
    const networkNotes = [
      ...(opensInput
        ? [`the console would run OSC commands sent to UDP port ${[...new Set(cmdAfter.map((l) => l.port))].join(", ")} from anyone who can reach ${where}: it listens on every interface whatever Interface and PreferredIP say`]
        : []),
      ...(opensOutput.length ? [`the console would send OSC onto the network to ${opensOutput.map((l) => `${l.destinationIp}:${l.port}`).join(", ")}`] : []),
    ];

    // The plan: input / output off first when they go off. Per line: flags that go off; an actively sending line's
    // Send / Send Command off while its destination or port changes; the other values; flags that go on; the
    // temporarily disabled send flags back on (when still wanted). Removals from the highest number; the preferred IP;
    // a re-bind (off, wait, on) when input stays on and an existing line's port changed or a receiving line was added;
    // input and output on last.
    const plan: Step[] = [];
    if (enableInput === false && before.enableInput) plan.push({ kind: "set", name: "EnableInput", target: "base", property: "EnableInput", value: "No" });
    if (enableOutput === false && before.enableOutput) plan.push({ kind: "set", name: "EnableOutput", target: "base", property: "EnableOutput", value: "No" });
    for (const e of effective) {
      const at = e.index !== undefined ? { index: e.index } : { add: e.add };
      const set = (name: string, property: string, value: string) => plan.push({ kind: "set", name: `line ${e.label} ${name}`, target: "line", ...at, property, value });
      if (e.add !== undefined) plan.push({ kind: "add", name: `add line ${e.label}`, add: e.add });
      const offs = e.changed.filter((p) => p.kind === "bool" && e.spec[p.key] === false);
      const ons = e.changed.filter((p) => p.kind === "bool" && e.spec[p.key] === true);
      const values = e.changed.filter((p) => p.kind !== "bool");
      const endpoint = values.some((p) => p.key === "port" || p.key === "destination_ip");
      const sendFlags = LINE_PROPS.filter((p) => p.key === "send" || p.key === "send_command");
      const tempOff = endpoint && e.before && before.enableOutput !== false ? sendFlags.filter((p) => e.before![p.state] === true && !offs.includes(p)) : [];
      for (const p of offs) set(p.property, p.property, "No");
      for (const p of tempOff) set(`${p.property} off (endpoint change)`, p.property, "No");
      for (const p of values) set(p.property, p.property, display(p.kind, e.spec[p.key]));
      for (const p of ons) set(p.property, p.property, "Yes");
      for (const p of tempOff) if (e.after[p.state] === true && !ons.includes(p)) set(`${p.property} on (after endpoint change)`, p.property, "Yes");
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

    // Apply: every write is judged by the value the console answers, every add and removal by the line count. A step
    // the console did not take (or whose answer is unreadable) stops the call before anything that depends on it, and
    // nothing is resent: the read-back decides an uncertain step.
    const addIndex: number[] = [];
    let stopped: string | undefined;
    let sentUpTo = 0;
    let count = before.lines.length;
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
          if (r?.index !== count + 1) {
            steps.push({ name: s.name, status: typeof r?.index === "number" ? "failed" : "unknown", op: "osc.addLine", error: `the console reported line ${String(r?.index)} (expected ${count + 1})`, detail: r });
            stopped = s.name;
            continue;
          }
          count++;
          addIndex[s.add] = r.index;
          steps.push({ name: `add line ${r.index}`, status: "succeeded", op: "osc.addLine", detail: r });
        } else if (s.kind === "remove") {
          const r = (await ctx.bridge.request("osc.removeLine", { index: s.index, exclusive: true }, t)) as { count?: unknown };
          if (r?.count !== count - 1) {
            steps.push({ name: s.name, status: typeof r?.count === "number" ? "failed" : "unknown", op: "osc.removeLine", error: typeof r?.count === "number" ? `the console has ${r.count} line(s) after the removal (expected ${count - 1}): the line was not removed` : "the console did not report the line count: whether the line was removed is decided by the read-back", detail: r });
            stopped = s.name;
            continue;
          }
          count--;
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
    const rebindOff = rebind && steps.some((x) => x.name === "EnableInput off (re-bind)" && x.status === "succeeded");
    const rebindOn = steps.some((x) => x.name === "EnableInput on (re-bind)" && x.status === "succeeded");

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
        ...(stopped ? [`stopped at ${stopped}: nothing after it was sent and nothing was resent`] : []),
        // Input switched off for a re-bind whose "on" did not succeed: reported from the read-back, never resent.
        ...(rebindOff && !rebindOn
          ? [now ? (now.enableInput === false ? "input was switched off for the re-bind and reads off now: OSC input is closed; switch it on with gma3_configure_osc enable_input: true" : `input reads ${now.enableInput === true ? "on" : "unknown"} after the re-bind's uncertain "on"`) : "input was switched off for the re-bind and its state could not be read back"]
          : []),
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
    // The marker must be confirmed absent: anything else (exists, or no clear answer) could overwrite a show's variable.
    const markerState = async (): Promise<boolean | undefined> => {
      const r = (await ctx.bridge.request("vars.get", { scope: "user", names: [MARKER] }, t)) as { items?: Array<{ name?: unknown; exists?: unknown; value?: unknown }> };
      const it = r?.items?.find((x) => x?.name === MARKER);
      return it && typeof it.exists === "boolean" ? it.exists : undefined;
    };
    try {
      const exists = await markerState();
      if (exists === true) return refuse(`the user variable ${MARKER} already exists (another test or a show variable); delete it first`);
      if (exists !== false) {
        steps.push(asRead({ name: "check_marker", status: "failed", op: "vars.get", error: `whether the user variable ${MARKER} exists could not be read; nothing was sent` }));
        return buildResult({ operation: op, target, steps, verification: unavailable("the marker variable's absence could not be confirmed; nothing was sent") });
      }
      steps.push(asRead({ name: "check_marker", status: "succeeded", op: "vars.get" }));
    } catch (err) {
      steps.push(asRead(stepFromError("check_marker", err, { op: "vars.get" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("the marker variable cannot be read (needs bridge 0.31.0); nothing was sent") });
    }

    // Per line: received (the nonce was read), not observed (reads worked, the nonce did not appear in the window), or
    // unobservable (no read worked: receipt cannot be judged). Only the first is proof; the second is not proof that
    // the console did not run it.
    type LineResult = { line: number; name?: string; port: number; address: string; received: boolean | null; latencyMs?: number; polls: number; readablePolls: number; lastSeen?: unknown; sendFailed?: boolean };
    const results: LineResult[] = [];
    for (const l of lines) {
      const nonce = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const name = `line ${l.index}: ${address(l)} to 127.0.0.1:${l.port}`;
      const row: LineResult = { line: l.index, name: l.name, port: l.port as number, address: address(l), received: null, polls: 0, readablePolls: 0 };
      const t0 = Date.now();
      try {
        await send(l.port as number, l.prefix || undefined, `SetUserVariable "${MARKER}" "${nonce}"`);
      } catch (err) {
        steps.push(stepFromError(name, err, { op: "osc" }));
        results.push({ ...row, received: false, sendFailed: true });
        continue;
      }
      while (Date.now() - t0 < timeoutMs) {
        await sleep(100);
        row.polls++;
        const r = (await ctx.bridge.request("vars.get", { scope: "user", names: [MARKER] }, t).catch(() => null)) as { items?: Array<{ name?: unknown; exists?: unknown; value?: unknown }> } | null;
        const it = r?.items?.find((x) => x?.name === MARKER);
        if (!it || typeof it.exists !== "boolean") continue;
        row.readablePolls++;
        row.lastSeen = it.exists ? it.value : null;
        if (it.value === nonce) {
          row.received = true;
          row.latencyMs = Date.now() - t0;
          break;
        }
      }
      if (row.received !== true) row.received = row.readablePolls > 0 ? false : null;
      steps.push({ name, status: row.received === null ? "unknown" : "succeeded", op: "osc", ...(row.received === null ? { error: "every read of the marker failed: receipt cannot be judged" } : {}), detail: row });
      results.push(row);
    }

    // Clean up and confirm: the marker must read absent afterwards.
    let cleanup: "deleted" | "remains" | "unknown" = "unknown";
    try {
      await ctx.bridge.request("vars.delete", { scope: "user", name: MARKER }, t);
    } catch {
      // judged by the read below
    }
    try {
      const exists = await markerState();
      cleanup = exists === false ? "deleted" : exists === true ? "remains" : "unknown";
    } catch {
      cleanup = "unknown";
    }
    const cleanupHint = `delete it with gma3_set_variable {scope: "user", name: "${MARKER}", delete: true}`;
    steps.push(
      cleanup === "deleted"
        ? { name: "delete_marker", status: "succeeded", op: "vars.delete" }
        : cleanup === "remains"
          ? { name: "delete_marker", status: "failed", op: "vars.delete", error: `the marker ${MARKER} is still there after the delete; ${cleanupHint}` }
          : { name: "delete_marker", status: "unknown", op: "vars.delete", error: `whether the marker ${MARKER} was deleted could not be read; if gma3_variables shows it, ${cleanupHint}` },
    );

    const notSeen = results.filter((r) => r.received === false && !r.sendFailed);
    const unsent = results.filter((r) => r.sendFailed);
    const blind = results.filter((r) => r.received === null);
    const checked = `the marker variable ${MARKER} holds each test's nonce within ${timeoutMs} ms`;
    const verification: Verification = unsent.length
      ? { status: "mismatched", checked, detail: `the test message could not be sent to ${unsent.map((r) => `line ${r.line} (port ${r.port})`).join(", ")}` }
      : notSeen.length
      ? {
          status: "mismatched",
          checked,
          detail: `not observed within ${timeoutMs} ms on ${notSeen.map((r) => `line ${r.line} (port ${r.port})`).join(", ")}: the marker was read but never held the nonce (likely causes: input not re-bound after a port change, a firewall, another program on the port)${blind.length ? `; receipt could not be observed on ${blind.map((r) => `line ${r.line}`).join(", ")}` : ""}`,
        }
      : blind.length
        ? unavailable(`receipt could not be observed on ${blind.map((r) => `line ${r.line} (port ${r.port})`).join(", ")}: every read of the marker failed`, checked)
        : { status: "matched", checked: `the marker variable ${MARKER} held each test's nonce: the console received and ran the command` };
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      summary:
        verification.status === "matched" && cleanup === "deleted"
          ? `OSC input works: the console ran the loopback test command on ${results.map((r) => `line ${r.line} (port ${r.port})`).join(", ")}.`
          : `OSC input test: ${results.filter((r) => r.received === true).length} of ${results.length} line(s) observed receiving${notSeen.length ? `, ${notSeen.length} not observed within ${timeoutMs} ms` : ""}${blind.length ? `, ${blind.length} unobservable` : ""}; marker ${cleanup}.`,
      ...(cleanup !== "deleted" ? { warnings: [cleanup === "remains" ? `the marker ${MARKER} remains (it blocks the next test); ${cleanupHint}` : `the marker's deletion could not be confirmed; ${cleanupHint} if it is still there`] } : {}),
      extra: { results, markerCleanup: cleanup, meaning: explainOsc(s, ctx.osc), note: "loopback proves the console receives; it listens on every interface, so a sender on the network reaches the same port unless a firewall stops it" },
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
