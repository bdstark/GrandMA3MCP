/**
 * SU-09: DMX universes and protocol output (SETUP.md SU-09, docs/probes/su-09-dmx-output-macos-2.5.1.md).
 *
 *   gma3_dmx_output            read-only: every universe in use, its grant and what sends it (Art-Net / sACN entries),
 *                              the two protocols with their entries, and the output stations; each universe explained
 *   gma3_configure_dmx_output  turns a protocol's output on or off, adds / edits / removes its data entries, and sets
 *                              universes' grant request; preview, read back per property
 *
 * Bridge ops dmx.output / dmx.set / dmx.addEntry / dmx.removeEntry (0.30.0). Console facts (onPC 2.5.1, live
 * 2026-10-15):
 *   - A universe that wants output (patched, PortOut) carries a grant; on this onPC with no MA hardware, the two in use
 *     read Granted No and GetDMXValue returns nothing for them. An idle universe reads Granted Yes (nothing to grant).
 *     Request (Auto / On / Off, enum LicenseRequest) asks for a grant; On did not grant one here.
 *   - Art-Net and sACN live in Root.DeviceConfigurations.DMXProtocols: a protocol Out / In switch and data entries,
 *     each mapping LocalUniverse .. +Amount-1 to Art-Net absolute universes (net x 256 + subnet x 16 + universe) or
 *     sACN universes, with a Mode, Enabled and (sACN) Priority.
 *   - Writes take effect at once and read back; invalid values are silently ignored (Mode "x") or clamped (Priority
 *     250 reads 200; Amount 0 is accepted as 0), so every write is judged by its read-back and inputs are validated.
 */
import { z } from "zod";
import type { Gma3Bridge } from "../bridge.js";
import { BridgeError } from "../bridge.js";
import { asRead, buildResult, notRequested, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, finiteNumber } from "../validate.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";

type Protocol = "artnet" | "sacn";
interface Entry {
  index: number;
  name?: string;
  enabled?: boolean | null;
  mode?: string | null;
  localUniverse?: number | null;
  amount?: number | null;
  universe?: number | null;
  priority?: number | null;
  [k: string]: unknown;
}
interface ProtocolState {
  out?: boolean | null;
  in?: boolean | null;
  interface?: string | null;
  preferredIp?: string | null;
  entries: Entry[];
}
interface UniverseRow {
  no: number;
  name?: string;
  /** Fixtures patched into the universe (the console's USED). */
  fixtures: number;
  granted?: boolean | null;
  request?: string | null;
  portOut?: boolean | null;
  outputs?: Array<{ protocol: Protocol; entry: number; enabled?: boolean | null; mode?: string | null; protocolOut?: boolean | null; as?: number | null }>;
  [k: string]: unknown;
}
export interface OutputState {
  protocols: Record<Protocol, ProtocolState>;
  universes: UniverseRow[];
  totals: { universes: number; used: number; outputWanted: number; grantedOfWanted: number };
  stations: Array<Record<string, unknown>>;
}

const NAMES: Record<Protocol, string> = { artnet: "Art-Net", sacn: "sACN" };
const NOT_GRANTED =
  "the session has no grant for it, so the console does not output it and its DMX values cannot be read. A grant comes from the MA licensing of the session: on grandMA3 onPC, from connected MA hardware (such as a command wing or a processing unit); with none, nothing is output. The universe's grant request (gma3_configure_dmx_output grant_request) asks for one; it does not create one.";

/** An entry in this mode sends DMX (Art-Net: every mode but Input; sACN: the Output modes). */
export function isOutputMode(protocol: Protocol, mode: string): boolean {
  return protocol === "artnet" ? mode !== "Input" : mode.startsWith("Output");
}

/** What happens to one universe's DMX, in words, and a state name. */
export function explainUniverse(u: UniverseRow): { state: "idle" | "not_granted" | "no_protocol_output" | "sent"; explanation: string; sentAs: string[] } {
  const wanted = u.fixtures > 0 || u.portOut === true || u.request === "On";
  // Input entries receive the universe; they never send it.
  const sending = (u.outputs ?? []).filter((o) => o.enabled === true && o.protocolOut === true && (o.mode == null || isOutputMode(o.protocol, o.mode)));
  const receiving = (u.outputs ?? []).filter((o) => o.enabled === true && o.mode != null && !isOutputMode(o.protocol, o.mode)).map((o) => `${NAMES[o.protocol]} entry ${o.entry} receives it (${o.mode})`);
  const sentAs = sending.map((o) => `${NAMES[o.protocol]} universe ${o.as ?? "?"} (entry ${o.entry}, ${o.mode ?? "mode unknown"})`);
  if (!wanted) return { state: "idle", explanation: `Universe ${u.no} is not in use: nothing is patched to it and no output is set for it.`, sentAs };
  if (u.granted !== true) return { state: "not_granted", explanation: `Universe ${u.no} (${u.fixtures} fixture(s) patched) is not granted: ${NOT_GRANTED}`, sentAs };
  if (!sending.length) {
    const off = (u.outputs ?? []).filter((o) => o.enabled === true && o.protocolOut !== true && (o.mode == null || isOutputMode(o.protocol, o.mode))).map((o) => `${NAMES[o.protocol]} entry ${o.entry} is enabled but ${NAMES[o.protocol]} output is off`);
    const disabled = (u.outputs ?? []).filter((o) => o.enabled !== true).map((o) => `${NAMES[o.protocol]} entry ${o.entry} covers it but is disabled`);
    const why = [...off, ...disabled, ...receiving];
    return { state: "no_protocol_output", explanation: `Universe ${u.no} is granted but no Art-Net or sACN output sends it${why.length ? ` (${why.join("; ")})` : " (no protocol entry covers it)"}; it reaches only MA-Net devices, if any are connected.`, sentAs };
  }
  return { state: "sent", explanation: `Universe ${u.no} is granted and sent as ${sentAs.join(", ")}.`, sentAs };
}

async function readState(bridge: Gma3Bridge, t: number, universes?: number[]): Promise<OutputState> {
  try {
    return (await bridge.request("dmx.output", universes?.length ? { universes } : {}, t)) as OutputState;
  } catch (err) {
    if (err instanceof BridgeError && /unknown op/.test(err.message)) throw new Error("the console runs an older bridge plugin without dmx.output (needs bridge 0.30.0); update the plugin");
    throw err;
  }
}

/** For gma3_fixture_output / gma3_dmx: why the given universes' output is (not) readable. Null when it cannot be read. */
export async function explainUniverses(bridge: Gma3Bridge, nums: number[], t: number): Promise<Array<{ universe: number; state: string; explanation: string }> | null> {
  if (!nums.length) return [];
  try {
    const s = await readState(bridge, t, nums);
    return nums.map((n) => {
      const u = s.universes.find((x) => x.no === n);
      if (!u) return { universe: n, state: "unknown", explanation: `universe ${n} is not in the console's universe list` };
      const e = explainUniverse(u);
      return { universe: n, state: e.state, explanation: e.explanation };
    });
  } catch {
    return null;
  }
}

async function readOutput(ctx: ToolContext, raw: Record<string, unknown>): Promise<unknown> {
  const v = new Validator();
  const universes = Array.isArray(raw.universes) ? raw.universes.map((x, i) => v.check(() => finiteNumber(`universes[${i}]`, x, { integer: true, min: 1, max: 1024 })) ?? 1) : undefined;
  if (!v.ok) return { error: v.errors.join("; ") };
  const s = await readState(ctx.bridge, ctx.requestTimeoutMs, universes);
  const rows = s.universes.map((u) => ({ ...u, ...explainUniverse(u) }));
  const notGranted = rows.filter((r) => r.state === "not_granted").map((r) => r.no);
  return {
    tool: "gma3_dmx_output",
    totals: s.totals,
    summary:
      `${s.totals.outputWanted} universe(s) want output (patched or set to output), ${s.totals.grantedOfWanted} of them granted. ` +
      `Art-Net output is ${s.protocols.artnet.out ? "on" : "off"} (${s.protocols.artnet.entries.filter((e) => e.enabled).length} of ${s.protocols.artnet.entries.length} entries enabled); sACN output is ${s.protocols.sacn.out ? "on" : "off"} (${s.protocols.sacn.entries.filter((e) => e.enabled).length} of ${s.protocols.sacn.entries.length} entries enabled).` +
      (notGranted.length ? ` Not granted: ${notGranted.join(", ")} (no output, values unreadable).` : ""),
    universes: rows,
    protocols: s.protocols,
    stations: s.stations,
    notes: [
      "universes listed: those in use, set to output or requested, plus the ones asked for; an idle universe reads granted (nothing to grant)",
      "an Art-Net universe is the absolute number (net x 256 + subnet x 16 + universe); entries map LocalUniverse .. LocalUniverse + Amount - 1",
      "read-only: nothing was changed",
    ],
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODES: Record<Protocol, string[]> = { artnet: ["Auto", "Broadcast", "Unicast", "Input"], sacn: ["Output Multicast", "Output Unicast", "Input Multicast", "Input Unicast"] };
const REQUESTS = { auto: "Auto", on: "On", off: "Off" } as const;
const UNIVERSE_RANGE: Record<Protocol, [number, number]> = { artnet: [0, 32767], sacn: [1, 63999] };
/** Defaults of an appended entry (as the console creates it, live 2026-10-15). */
const NEW_ENTRY: Record<Protocol, Mapping> = {
  artnet: { localUniverse: 1, amount: 1, universe: 0, mode: "Auto", priority: null, enabled: false },
  sacn: { localUniverse: 1, amount: 1, universe: 1, mode: "Output Multicast", priority: 100, enabled: false },
};

interface EntrySpec {
  entry?: number;
  add?: boolean;
  remove?: boolean;
  local_universe?: number;
  amount?: number;
  universe?: number;
  mode?: string;
  priority?: number;
  enabled?: boolean;
}
interface Mapping {
  localUniverse: number | null;
  amount: number | null;
  universe: number | null;
  mode: string | null;
  priority: number | null;
  enabled: boolean;
}
/** An entry before and after the change: an existing one (index) or an added one (add = its position in the adds). */
interface Effective {
  label: string;
  index?: number;
  add?: number;
  before?: Mapping;
  after: Mapping;
  remove: boolean;
  spec: EntrySpec;
}
/** One mutation. A set carries the value the console must answer with; anything else stops the call. */
type Step =
  | { kind: "set"; name: string; target: "protocol" | "entry" | "universe"; protocol?: Protocol; index?: number; add?: number; universe?: number; property: string; value: string }
  | { kind: "add"; name: string; add: number }
  | { kind: "remove"; name: string; index: number };

const yesNo = (b: boolean) => (b ? "Yes" : "No");
const MAP_PROPS: Array<{ key: keyof Mapping; property: (p: Protocol) => string }> = [
  { key: "localUniverse", property: () => "LocalUniverse" },
  { key: "amount", property: () => "Amount" },
  { key: "universe", property: (p) => (p === "artnet" ? "Art-NetAbsolute" : "sACNUniverse") },
  { key: "mode", property: () => "Mode" },
  { key: "priority", property: () => "Priority" },
];

const mappingOf = (e: Entry): Mapping => ({ localUniverse: e.localUniverse ?? null, amount: e.amount ?? null, universe: e.universe ?? null, mode: e.mode ?? null, priority: e.priority ?? null, enabled: e.enabled === true });
/** Does an entry send DMX? Enabled, its protocol's output on, and an output mode. An unknown mode counts as sending. */
const sends = (protocol: Protocol, out: boolean, m: Mapping) => out && m.enabled && (m.mode === null || isOutputMode(protocol, m.mode));
const mappingChanged = (a: Mapping, b: Mapping) => MAP_PROPS.some((p) => a[p.key] !== b[p.key]);

export async function configureOutput(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "configure_dmx_output";
  const v = new Validator();
  const protocol = raw.protocol === undefined ? undefined : raw.protocol === "artnet" || raw.protocol === "sacn" ? (raw.protocol as Protocol) : (v.fail('protocol must be "artnet" or "sacn"'), undefined);
  const output = raw.output === undefined ? undefined : typeof raw.output === "boolean" ? raw.output : (v.fail("output must be true or false"), undefined);
  const specs: EntrySpec[] = Array.isArray(raw.entries) ? (raw.entries as EntrySpec[]) : raw.entries === undefined ? [] : (v.fail("entries must be a list"), []);
  if ((output !== undefined || specs.length) && !protocol) v.fail("protocol (artnet or sacn) is required with output or entries");
  const gr = raw.grant_request as { universes?: unknown; value?: unknown } | undefined;
  let grantUniverses: number[] = [];
  let grantValue: string | undefined;
  if (gr !== undefined) {
    grantUniverses = Array.isArray(gr.universes) && gr.universes.length ? gr.universes.map((x, i) => v.check(() => finiteNumber(`grant_request.universes[${i}]`, x, { integer: true, min: 1, max: 1024 })) ?? 1) : (v.fail("grant_request.universes must list universes 1..1024"), []);
    if (new Set(grantUniverses).size !== grantUniverses.length) v.fail("grant_request.universes lists a universe twice");
    grantValue = REQUESTS[gr.value as keyof typeof REQUESTS] ?? (v.fail('grant_request.value must be "auto", "on" or "off"'), undefined);
  }
  const [uniMin, uniMax] = UNIVERSE_RANGE[protocol ?? "artnet"];
  const seen = new Set<number>();
  specs.forEach((e, i) => {
    const p = `entries[${i}]`;
    if (e.add && e.entry !== undefined) v.fail(`${p}: add or entry, not both`);
    if (!e.add && e.entry === undefined) v.fail(`${p}: give entry (the entry number) or add: true`);
    if (e.add && e.remove) v.fail(`${p}: add and remove together`);
    if (e.remove && Object.keys(e).some((k) => !["entry", "remove"].includes(k))) v.fail(`${p}: remove takes only entry`);
    if (e.entry !== undefined) {
      v.check(() => finiteNumber(`${p}.entry`, e.entry, { integer: true, min: 1, max: 1000 }));
      // One spec per entry: two (a remove twice, a remove and an edit) would act on shifted numbers.
      if (seen.has(e.entry)) v.fail(`${p}: entry ${e.entry} appears more than once; give one change per entry`);
      seen.add(e.entry);
    }
    if (e.add && (e.local_universe === undefined || e.universe === undefined)) v.fail(`${p}: an added entry needs local_universe and universe`);
    if (e.local_universe !== undefined) v.check(() => finiteNumber(`${p}.local_universe`, e.local_universe, { integer: true, min: 1, max: 1024 }));
    if (e.amount !== undefined) v.check(() => finiteNumber(`${p}.amount`, e.amount, { integer: true, min: 1, max: 1024 }));
    if (e.universe !== undefined) v.check(() => finiteNumber(`${p}.universe`, e.universe, { integer: true, min: uniMin, max: uniMax }));
    if (e.mode !== undefined && protocol && !MODES[protocol].includes(e.mode)) v.fail(`${p}.mode must be one of ${MODES[protocol].join(", ")}`);
    if (e.priority !== undefined) {
      if (protocol !== "sacn") v.fail(`${p}.priority applies to sACN only`);
      else v.check(() => finiteNumber(`${p}.priority`, e.priority, { integer: true, min: 0, max: 200 }));
    }
    if (e.enabled !== undefined && typeof e.enabled !== "boolean") v.fail(`${p}.enabled must be true or false`);
  });
  if (output === undefined && !specs.length && gr === undefined) v.fail("nothing to change: give output, entries and/or grant_request");
  const preview = raw.preview === true;
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true: the DMX output configuration of the console is changed (no undo; the result carries the previous values). preview: true needs no acknowledgement");
  const target = { protocol, output, entries: raw.entries, grant_request: raw.grant_request };
  if (!v.ok) return validationFailure(op, target, v.errors);

  return ctx.mutations.run(async () => {
    const t = ctx.requestTimeoutMs;
    const steps: StepResult[] = [];
    let before: OutputState;
    try {
      before = await readState(ctx.bridge, t, grantUniverses);
      steps.push(asRead({ name: "read_output", status: "succeeded", op: "dmx.output" }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_output", err, { op: "dmx.output" })));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was sent") });
    }
    const refuse = (why: string, extra: Record<string, unknown> = {}) => {
      steps.push(asRead({ name: "check", status: "failed", error: `${why}; nothing was changed` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was changed"), extra });
    };

    // The effective configuration: every touched entry before and after, with the console's current values for what
    // the request leaves out.
    const ps = protocol ? before.protocols[protocol] : undefined;
    const effective: Effective[] = [];
    let adds = 0;
    for (const s of specs) {
      if (s.add) {
        const base = NEW_ENTRY[protocol as Protocol];
        effective.push({ label: `new ${adds + 1}`, add: adds++, after: { ...base, ...pick(s, base) }, remove: false, spec: s });
        continue;
      }
      const cur = ps?.entries.find((x) => x.index === s.entry);
      if (!cur) return refuse(`${NAMES[protocol as Protocol]} has no entry ${s.entry} (it has ${ps?.entries.map((x) => x.index).join(", ") || "none"})`);
      const b = mappingOf(cur);
      effective.push({ label: String(s.entry), index: s.entry, before: b, after: s.remove ? b : { ...b, ...pick(s, b) }, remove: s.remove === true, spec: s });
    }
    // Both complete ranges of every changed or added entry, from current values plus the requested ones.
    const rangeProblems: string[] = [];
    for (const e of effective.filter((x) => !x.remove)) {
      const { localUniverse: lu, amount: n, universe: u } = e.after;
      if (lu === null || n === null || u === null) {
        rangeProblems.push(`entry ${e.label}: its local universe, amount or protocol universe cannot be read`);
        continue;
      }
      if (n < 1) rangeProblems.push(`entry ${e.label}: amount ${n} is not at least 1`);
      if (lu + n - 1 > 1024) rangeProblems.push(`entry ${e.label}: local universes ${lu}..${lu + n - 1} pass 1024`);
      if (u < uniMin || u + n - 1 > uniMax) rangeProblems.push(`entry ${e.label}: ${NAMES[protocol as Protocol]} universes ${u}..${u + n - 1} leave ${uniMin}..${uniMax}`);
    }
    if (rangeProblems.length) return refuse(rangeProblems.join("; "));

    // The plan. Per entry: disable first when an enabled entry is remapped or disabled; write the mapping while
    // disabled; enable last, only after the mapping was confirmed. A protocol's output goes off first and on last.
    const plan: Step[] = [];
    const protOutBefore = ps?.out === true;
    const protOutAfter = output ?? protOutBefore;
    if (protocol && output === false && protOutBefore) plan.push({ kind: "set", name: `${protocol} Out`, target: "protocol", protocol, property: "Out", value: "No" });
    for (const e of effective) {
      if (e.remove) continue;
      const where = e.index !== undefined ? { index: e.index } : { add: e.add };
      if (e.add !== undefined) plan.push({ kind: "add", name: `${protocol} add entry`, add: e.add });
      const base = e.before ?? NEW_ENTRY[protocol as Protocol];
      const changed = MAP_PROPS.filter((p) => (e.add !== undefined ? e.spec[specKey(p.key)] !== undefined : e.after[p.key] !== base[p.key]));
      const wasEnabled = e.before?.enabled === true;
      if (wasEnabled && (changed.length || !e.after.enabled)) plan.push({ kind: "set", name: `${protocol} entry ${e.label} Enabled`, target: "entry", protocol, ...where, property: "Enabled", value: "No" });
      for (const p of changed) plan.push({ kind: "set", name: `${protocol} entry ${e.label} ${p.property(protocol as Protocol)}`, target: "entry", protocol, ...where, property: p.property(protocol as Protocol), value: String(e.after[p.key]) });
      if (e.after.enabled && (!wasEnabled || changed.length)) plan.push({ kind: "set", name: `${protocol} entry ${e.label} Enabled`, target: "entry", protocol, ...where, property: "Enabled", value: "Yes" });
    }
    for (const n of grantUniverses) plan.push({ kind: "set", name: `universe ${n} Request`, target: "universe", universe: n, property: "Request", value: grantValue as string });
    for (const e of effective.filter((x) => x.remove).sort((a, b) => (b.index as number) - (a.index as number))) plan.push({ kind: "remove", name: `${protocol} remove entry ${e.index}`, index: e.index as number });
    if (protocol && output === true && !protOutBefore) plan.push({ kind: "set", name: `${protocol} Out`, target: "protocol", protocol, property: "Out", value: "Yes" });

    // The network: an entry that sends after the change (output on, enabled, an output mode) and did not send before,
    // or sends with another mapping.
    const newly: string[] = [];
    if (protocol) {
      for (const e of effective.filter((x) => !x.remove)) {
        const after = sends(protocol, protOutAfter, e.after);
        const was = e.before ? sends(protocol, protOutBefore, e.before) : false;
        if (after && (!was || mappingChanged(e.before as Mapping, e.after))) newly.push(`entry ${e.label}`);
      }
      // Output switched on: every untouched entry that would then send.
      if (protOutAfter && !protOutBefore) for (const x of ps?.entries ?? []) if (!effective.some((e) => e.index === x.index) && sends(protocol, true, mappingOf(x))) newly.push(`entry ${x.index}`);
    }
    const previewOut = {
      plan: plan.map((s) => ({ step: s.name, ...(s.kind === "set" ? { value: s.value } : {}) })),
      ...(newly.length ? { networkNote: `${NAMES[protocol as Protocol]} would send DMX onto the network (${newly.join(", ")}) through the output stations' interfaces (${before.stations.map((s) => `${s.name} ${s.ip}`).join(", ")})` } : {}),
    };
    if (preview) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: `Preview only; nothing was sent. ${plan.length} step(s).${previewOut.networkNote ? ` ${previewOut.networkNote}.` : ""}`, extra: previewOut });
    if (newly.length && raw.network !== true) return refuse(`${previewOut.networkNote}; pass network: true to confirm`, previewOut);

    // Apply, checking every reply: a write the console did not take stops the call before anything that depends on it.
    const addIndex: number[] = [];
    let stopped: string | undefined;
    const disabledForRemap = new Set<string>();
    for (const s of plan) {
      if (stopped) break;
      try {
        if (s.kind === "add") {
          const r = (await ctx.bridge.request("dmx.addEntry", { protocol, exclusive: true }, t)) as { index?: number };
          if (typeof r.index !== "number") throw new Error("the console did not report the new entry's number");
          addIndex[s.add] = r.index;
          steps.push({ name: `${protocol} add entry ${r.index}`, status: "succeeded", op: "dmx.addEntry", detail: r });
        } else if (s.kind === "remove") {
          const r = await ctx.bridge.request("dmx.removeEntry", { protocol, index: s.index, exclusive: true }, t);
          steps.push({ name: s.name, status: "succeeded", op: "dmx.removeEntry", detail: r });
        } else {
          const index = s.add !== undefined ? addIndex[s.add] : s.index;
          const name = s.add !== undefined ? s.name.replace(/entry new \d+/, `entry ${index}`) : s.name;
          const r = (await ctx.bridge.request("dmx.set", { target: s.target, protocol: s.protocol, index, universe: s.universe, property: s.property, value: s.value, exclusive: true }, t)) as { value?: unknown };
          const got = r?.value === undefined || r?.value === null ? undefined : String(r.value);
          if (got !== s.value) {
            steps.push({ name, status: "failed", op: "dmx.set", error: got === undefined ? `the console's answer for ${s.property} could not be read` : `the console kept ${s.property} ${got} (expected ${s.value})`, detail: r });
            stopped = name;
            continue;
          }
          steps.push({ name, status: "succeeded", op: "dmx.set", detail: r });
          if (s.property === "Enabled" && s.value === "No" && s.target === "entry") disabledForRemap.add(name.replace(/ Enabled$/, ""));
          if (s.property === "Enabled" && s.value === "Yes") disabledForRemap.delete(name.replace(/ Enabled$/, ""));
        }
      } catch (err) {
        steps.push(stepFromError(s.name, err, { op: s.kind === "add" ? "dmx.addEntry" : s.kind === "remove" ? "dmx.removeEntry" : "dmx.set" }));
        stopped = s.name;
      }
    }

    // Read back the whole configuration and compare every touched entry, the switch and the requests.
    let verification: Verification = notRequested();
    const readBack: StepResult[] = [];
    let after: OutputState | undefined;
    if (raw.verify !== false || stopped) {
      try {
        after = await readState(ctx.bridge, t, grantUniverses);
        readBack.push(asRead({ name: "read_back", status: "succeeded", op: "dmx.output" }));
        const mism: string[] = [];
        if (protocol) {
          const pa = after.protocols[protocol];
          if (output !== undefined && pa.out !== output) mism.push(`${NAMES[protocol]} output reads ${pa.out ? "on" : "off"}`);
          const removedBelow = (i: number) => effective.filter((e) => e.remove && (e.index as number) < i).length;
          for (const e of effective) {
            if (e.remove) {
              continue;
            }
            const idx = e.add !== undefined ? addIndex[e.add] : (e.index as number);
            if (idx === undefined) {
              mism.push(`entry ${e.label} was not added`);
              continue;
            }
            const got = pa.entries.find((x) => x.index === idx - removedBelow(idx));
            if (!got) {
              mism.push(`entry ${e.label} is missing`);
              continue;
            }
            const m = mappingOf(got);
            for (const p of MAP_PROPS) if (m[p.key] !== e.after[p.key] && (e.add === undefined || e.spec[specKey(p.key)] !== undefined)) mism.push(`entry ${e.label} ${p.property(protocol)} reads ${m[p.key]}, expected ${e.after[p.key]}`);
            if (m.enabled !== e.after.enabled) mism.push(`entry ${e.label} is ${m.enabled ? "enabled" : "disabled"}`);
          }
          const removes = effective.filter((e) => e.remove).length;
          if (pa.entries.length !== (ps?.entries.length ?? 0) + addIndex.filter((x) => x !== undefined).length - (stopped ? steps.filter((s) => s.op === "dmx.removeEntry" && s.status === "succeeded").length : removes)) mism.push("the number of entries is not the expected one");
        }
        for (const n of grantUniverses) {
          const r = after.universes.find((u) => u.no === n)?.request;
          if (r !== grantValue) mism.push(`universe ${n} request reads ${r ?? "nothing"}`);
        }
        const checked = "the protocol switch, every touched entry (mapping and enabled), the entry count and the grant requests, read back";
        verification = mism.length ? { status: "mismatched", checked, detail: [...new Set(mism)].join("; ") } : { status: "matched", checked };
      } catch (err) {
        readBack.push(asRead(stepFromError("read_back", err, { op: "dmx.output" })));
        verification = unavailable("the configuration could not be read back");
      }
    }
    const result = buildResult({
      operation: op,
      target,
      steps,
      verification,
      warnings: [
        "the DMX output configuration has no undo; previous holds the values before this call",
        ...(newly.length && !stopped ? [`${NAMES[protocol as Protocol]} now sends DMX onto the network (${newly.join(", ")})`] : []),
        ...(stopped ? [`stopped at ${stopped}: nothing after it was sent${disabledForRemap.size ? `; ${[...disabledForRemap].join(", ")} ${disabledForRemap.size === 1 ? "was" : "were"} disabled for the change and stay${disabledForRemap.size === 1 ? "s" : ""} disabled` : ""}`] : []),
      ],
      extra: {
        ...previewOut,
        previous: { protocols: before.protocols, ...(grantUniverses.length ? { universes: before.universes.filter((u) => grantUniverses.includes(u.no)).map((u) => ({ no: u.no, request: u.request })) } : {}) },
        ...(after ? { now: { protocols: after.protocols, universes: after.universes.map((u) => ({ no: u.no, ...explainUniverse(u) })) } } : {}),
      },
    });
    result.steps.push(...readBack);
    return result;
  });
}

/** The spec key of a mapping field. */
function specKey(k: keyof Mapping): keyof EntrySpec {
  return ({ localUniverse: "local_universe", amount: "amount", universe: "universe", mode: "mode", priority: "priority", enabled: "enabled" } as const)[k];
}

/** The requested fields of a spec over a base mapping. */
function pick(s: EntrySpec, base: Mapping): Partial<Mapping> {
  return {
    ...(s.local_universe !== undefined ? { localUniverse: s.local_universe } : {}),
    ...(s.amount !== undefined ? { amount: s.amount } : {}),
    ...(s.universe !== undefined ? { universe: s.universe } : {}),
    ...(s.mode !== undefined ? { mode: s.mode } : {}),
    ...(s.priority !== undefined ? { priority: s.priority } : {}),
    ...(s.enabled !== undefined ? { enabled: s.enabled } : { enabled: base.enabled }),
  };
}

export const registerDmxOutputTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_dmx_output",
    {
      title: "Read DMX universes, grants and Art-Net / sACN output",
      description:
        "Read-only. Every universe in use (patched or set to output, plus any asked for): fixtures patched, whether it is granted, its grant request, ports, merge mode, and the Art-Net / sACN entries that cover it with the protocol universe they send it as. Each universe is explained: idle, not granted (no output and unreadable values, with why), granted but sent by no protocol, or sent as which universes. " +
        "Also both protocols (output and input switches, interface, every data entry: local universes, amount, protocol universe, mode, enabled, priority) and the output stations. Use it when gma3_fixture_output or gma3_dmx return no values. Needs bridge 0.30.0.",
      inputSchema: { universes: z.array(z.number()).optional().describe("Universes to include besides the ones in use (1..1024).") },
    },
    async (args) => {
      try {
        return json(await readOutput(ctx, args as Record<string, unknown>));
      } catch (err) {
        return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );

  server.registerTool(
    "gma3_configure_dmx_output",
    {
      title: "Configure Art-Net / sACN output and universe grant requests",
      description:
        "Changes the console's DMX output configuration: protocol (artnet or sacn) output on or off; its data entries (entries: edit one by number, add: true for a new one, remove: true), each mapping local_universe .. +amount-1 to protocol universes from universe (Art-Net: absolute 0..32767 = net x 256 + subnet x 16 + universe; sACN: 1..63999), with mode, enabled and (sACN) priority 0..200; and grant_request (universes, value auto|on|off), which asks for a grant without creating one. " +
        "Validated before anything is sent; the console silently ignores or clamps invalid values, so every written property is read back. preview: true shows the plan. A change that makes a protocol send DMX onto the network (output on with an enabled entry) needs network: true. Requires exclusive: true. No undo: previous holds the values before. Needs bridge 0.30.0.",
      inputSchema: {
        protocol: z.enum(["artnet", "sacn"]).optional(),
        output: z.boolean().optional().describe("The protocol's output switch (Out)."),
        entries: z
          .array(
            z.object({
              entry: z.number().optional(),
              add: z.boolean().optional(),
              remove: z.boolean().optional(),
              local_universe: z.number().optional(),
              amount: z.number().optional(),
              universe: z.number().optional(),
              mode: z.string().optional().describe("Art-Net: Auto, Broadcast, Unicast, Input. sACN: Output Multicast, Output Unicast, Input Multicast, Input Unicast."),
              priority: z.number().optional(),
              enabled: z.boolean().optional(),
            }),
          )
          .optional(),
        grant_request: z.object({ universes: z.array(z.number()), value: z.enum(["auto", "on", "off"]) }).optional(),
        network: z.boolean().optional().describe("Confirms that the change sends DMX onto the network."),
        preview: z.boolean().optional(),
        exclusive: z.boolean().optional(),
        verify: z.boolean().optional(),
      },
    },
    (args) => operation(() => configureOutput(ctx, args as Record<string, unknown>)),
  );
};
