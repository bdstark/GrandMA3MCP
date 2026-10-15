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

/** What happens to one universe's DMX, in words, and a state name. */
export function explainUniverse(u: UniverseRow): { state: "idle" | "not_granted" | "no_protocol_output" | "sent"; explanation: string; sentAs: string[] } {
  const wanted = u.fixtures > 0 || u.portOut === true || u.request === "On";
  const sending = (u.outputs ?? []).filter((o) => o.enabled === true && o.protocolOut === true);
  const sentAs = sending.map((o) => `${NAMES[o.protocol]} universe ${o.as ?? "?"} (entry ${o.entry}, ${o.mode ?? "mode unknown"})`);
  if (!wanted) return { state: "idle", explanation: `Universe ${u.no} is not in use: nothing is patched to it and no output is set for it.`, sentAs };
  if (u.granted !== true) return { state: "not_granted", explanation: `Universe ${u.no} (${u.fixtures} fixture(s) patched) is not granted: ${NOT_GRANTED}`, sentAs };
  if (!sending.length) {
    const off = (u.outputs ?? []).filter((o) => o.enabled === true && o.protocolOut !== true).map((o) => `${NAMES[o.protocol]} entry ${o.entry} is enabled but ${NAMES[o.protocol]} output is off`);
    const disabled = (u.outputs ?? []).filter((o) => o.enabled !== true).map((o) => `${NAMES[o.protocol]} entry ${o.entry} covers it but is disabled`);
    return { state: "no_protocol_output", explanation: `Universe ${u.no} is granted but no Art-Net or sACN output sends it${[...off, ...disabled].length ? ` (${[...off, ...disabled].join("; ")})` : " (no protocol entry covers it)"}; it reaches only MA-Net devices, if any are connected.`, sentAs };
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
/** One property write. `add` names the added entry (its position in the adds) whose index is known only after it is added. */
type Planned = { name: string; target: "protocol" | "entry" | "universe"; protocol?: Protocol; index?: number; add?: number; universe?: number; property: string; value: string; expect: string };

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

const yesNo = (b: boolean) => (b ? "Yes" : "No");

export async function configureOutput(ctx: ToolContext, raw: Record<string, unknown>): Promise<OperationResult> {
  const op = "configure_dmx_output";
  const v = new Validator();
  const protocol = raw.protocol === undefined ? undefined : raw.protocol === "artnet" || raw.protocol === "sacn" ? (raw.protocol as Protocol) : (v.fail('protocol must be "artnet" or "sacn"'), undefined);
  const output = raw.output === undefined ? undefined : typeof raw.output === "boolean" ? raw.output : (v.fail("output must be true or false"), undefined);
  const entries: EntrySpec[] = Array.isArray(raw.entries) ? (raw.entries as EntrySpec[]) : raw.entries === undefined ? [] : (v.fail("entries must be a list"), []);
  if ((output !== undefined || entries.length) && !protocol) v.fail("protocol (artnet or sacn) is required with output or entries");
  const gr = raw.grant_request as { universes?: unknown; value?: unknown } | undefined;
  let grantUniverses: number[] = [];
  let grantValue: string | undefined;
  if (gr !== undefined) {
    grantUniverses = Array.isArray(gr.universes) && gr.universes.length ? gr.universes.map((x, i) => v.check(() => finiteNumber(`grant_request.universes[${i}]`, x, { integer: true, min: 1, max: 1024 })) ?? 1) : (v.fail("grant_request.universes must list universes 1..1024"), []);
    grantValue = REQUESTS[gr.value as keyof typeof REQUESTS] ?? (v.fail('grant_request.value must be "auto", "on" or "off"'), undefined);
  }
  const uniMax = protocol === "artnet" ? 32767 : 63999;
  const uniMin = protocol === "artnet" ? 0 : 1;
  entries.forEach((e, i) => {
    const p = `entries[${i}]`;
    if (e.add && e.entry !== undefined) v.fail(`${p}: add or entry, not both`);
    if (!e.add && e.entry === undefined) v.fail(`${p}: give entry (the entry number) or add: true`);
    if (e.remove && (e.add || Object.keys(e).some((k) => !["entry", "remove"].includes(k)))) v.fail(`${p}: remove takes only entry`);
    if (e.entry !== undefined) v.check(() => finiteNumber(`${p}.entry`, e.entry, { integer: true, min: 1, max: 1000 }));
    if (e.local_universe !== undefined) v.check(() => finiteNumber(`${p}.local_universe`, e.local_universe, { integer: true, min: 1, max: 1024 }));
    if (e.amount !== undefined) v.check(() => finiteNumber(`${p}.amount`, e.amount, { integer: true, min: 1, max: 1024 }));
    if (e.local_universe !== undefined && e.amount !== undefined && e.local_universe + e.amount - 1 > 1024) v.fail(`${p}: local_universe + amount - 1 must not pass 1024`);
    if (e.universe !== undefined) v.check(() => finiteNumber(`${p}.universe`, e.universe, { integer: true, min: uniMin, max: uniMax }));
    if (e.mode !== undefined && protocol && !MODES[protocol].includes(e.mode)) v.fail(`${p}.mode must be one of ${MODES[protocol].join(", ")}`);
    if (e.priority !== undefined) {
      if (protocol !== "sacn") v.fail(`${p}.priority applies to sACN only`);
      else v.check(() => finiteNumber(`${p}.priority`, e.priority, { integer: true, min: 0, max: 200 }));
    }
    if (e.enabled !== undefined && typeof e.enabled !== "boolean") v.fail(`${p}.enabled must be true or false`);
    if (e.add && e.remove) v.fail(`${p}: add and remove together`);
  });
  if (output === undefined && !entries.length && gr === undefined) v.fail("nothing to change: give output, entries and/or grant_request");
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
    const p = protocol ? before.protocols[protocol] : undefined;
    const problems: string[] = [];
    for (const e of entries) if (e.entry !== undefined && p && !p.entries.some((x) => x.index === e.entry)) problems.push(`${NAMES[protocol as Protocol]} has no entry ${e.entry} (it has ${p.entries.map((x) => x.index).join(", ") || "none"})`);
    if (problems.length) {
      steps.push(asRead({ name: "check", status: "failed", error: `${problems.join("; ")}; nothing was changed` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was changed") });
    }

    // The plan: removals last (highest index first) so the numbers of the edited entries stay valid.
    const plan: Planned[] = [];
    const adds: EntrySpec[] = entries.filter((e) => e.add);
    const edits = entries.filter((e) => e.entry !== undefined && !e.remove);
    const removes = entries.filter((e) => e.remove).map((e) => e.entry as number).sort((a, b) => b - a);
    const entryProps = (e: EntrySpec, where: { index: number } | { add: number }) => {
      const props: Array<[string, string]> = [];
      if (e.local_universe !== undefined) props.push(["LocalUniverse", String(e.local_universe)]);
      if (e.amount !== undefined) props.push(["Amount", String(e.amount)]);
      if (e.universe !== undefined) props.push([protocol === "artnet" ? "Art-NetAbsolute" : "sACNUniverse", String(e.universe)]);
      if (e.mode !== undefined) props.push(["Mode", e.mode]);
      if (e.priority !== undefined) props.push(["Priority", String(e.priority)]);
      // Enabled last: an entry starts sending only once its mapping is set.
      if (e.enabled !== undefined) props.push(["Enabled", yesNo(e.enabled)]);
      const label = "index" in where ? String(where.index) : `new ${where.add + 1}`;
      for (const [property, value] of props) plan.push({ name: `${protocol} entry ${label} ${property}`, target: "entry", protocol, ...where, property, value, expect: value });
    };
    for (const e of edits) entryProps(e, { index: e.entry as number });
    adds.forEach((e, k) => entryProps(e, { add: k }));
    for (const n of grantUniverses) plan.push({ name: `universe ${n} Request`, target: "universe", universe: n, property: "Request", value: grantValue as string, expect: grantValue as string });
    // The protocol switch after its entries: output goes on with the mapping in place, and off before anything else.
    if (output !== undefined) {
      const sw: Planned = { name: `${protocol} Out`, target: "protocol", protocol, property: "Out", value: yesNo(output), expect: yesNo(output) };
      if (output) plan.push(sw);
      else plan.unshift(sw);
    }

    // Would DMX go onto the network after this? The protocol's output on with at least one enabled entry.
    const enabledAfter = (prot: Protocol) => {
      const ps = before.protocols[prot];
      const editOf = (i: number) => edits.find((e) => e.entry === i);
      const kept = ps.entries.filter((x) => !removes.includes(x.index)).filter((x) => (editOf(x.index)?.enabled ?? x.enabled) === true).length;
      return kept + (prot === protocol ? adds.filter((e) => e.enabled === true).length : 0);
    };
    const outAfter = (prot: Protocol) => (prot === protocol && output !== undefined ? output : before.protocols[prot].out === true);
    const sendsAfter = (["artnet", "sacn"] as Protocol[]).filter((x) => outAfter(x) && enabledAfter(x) > 0);
    const sendsBefore = (["artnet", "sacn"] as Protocol[]).filter((x) => before.protocols[x].out === true && before.protocols[x].entries.some((e) => e.enabled === true));
    const newlySending = sendsAfter.filter((x) => !sendsBefore.includes(x) || (x === protocol && (adds.some((e) => e.enabled) || edits.some((e) => e.enabled === true))));
    const previewOut = {
      plan: plan.map(({ name, value }) => ({ step: name, value })),
      adds: adds.length,
      removes,
      sendsToNetworkAfter: sendsAfter.map((x) => NAMES[x]),
      ...(newlySending.length ? { networkNote: `${newlySending.map((x) => NAMES[x]).join(" and ")} would send DMX onto the network through the output stations' interfaces (${before.stations.map((s) => `${s.name} ${s.ip}`).join(", ")})` } : {}),
    };
    if (preview) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: `Preview only; nothing was sent. ${plan.length + adds.length + removes.length} change(s).${previewOut.networkNote ? ` ${previewOut.networkNote}.` : ""}`, extra: previewOut });
    if (newlySending.length && raw.network !== true) {
      steps.push(asRead({ name: "check_network", status: "failed", error: `${previewOut.networkNote}; pass network: true to confirm. Nothing was changed` }));
      return buildResult({ operation: op, target, steps, verification: unavailable("nothing was changed"), extra: previewOut });
    }

    // Apply: adds first (their numbers are known only then), then the plan, then removals.
    const sent: Planned[] = [];
    let stopped = false;
    const newIndex: number[] = [];
    for (let i = 0; i < adds.length && !stopped; i++) {
      try {
        const r = (await ctx.bridge.request("dmx.addEntry", { protocol, exclusive: true }, t)) as { index: number };
        newIndex.push(r.index);
        steps.push({ name: `${protocol} add entry`, status: "succeeded", op: "dmx.addEntry", detail: r });
      } catch (err) {
        steps.push(stepFromError(`${protocol} add entry`, err, { op: "dmx.addEntry" }));
        stopped = true;
      }
    }
    for (const x of plan) {
      if (stopped) break;
      const index = x.add !== undefined ? newIndex[x.add] : x.index;
      const name = x.add !== undefined ? `${protocol} entry ${index} ${x.property}` : x.name;
      const args = { target: x.target, protocol: x.protocol, index, universe: x.universe, property: x.property, value: x.value, exclusive: true };
      try {
        const r = (await ctx.bridge.request("dmx.set", args, t)) as { before?: string; value?: string };
        steps.push({ name, status: "succeeded", op: "dmx.set", detail: r });
        sent.push({ ...x, name, index });
      } catch (err) {
        steps.push(stepFromError(name, err, { op: "dmx.set" }));
        stopped = true;
      }
    }
    for (const n of removes) {
      if (stopped) break;
      try {
        const r = await ctx.bridge.request("dmx.removeEntry", { protocol, index: n, exclusive: true }, t);
        steps.push({ name: `${protocol} remove entry ${n}`, status: "succeeded", op: "dmx.removeEntry", detail: r });
      } catch (err) {
        steps.push(stepFromError(`${protocol} remove entry ${n}`, err, { op: "dmx.removeEntry" }));
        stopped = true;
      }
    }

    // Read back every property that was sent (a value the console ignored or clamped is a mismatch).
    let verification: Verification = notRequested();
    const readBack: StepResult[] = [];
    let after: OutputState | undefined;
    if (raw.verify !== false) {
      try {
        after = await readState(ctx.bridge, t, grantUniverses);
        readBack.push(asRead({ name: "read_back", status: "succeeded", op: "dmx.output" }));
        const mism: string[] = [];
        const show = (v: unknown) => (typeof v === "boolean" ? yesNo(v) : String(v));
        for (const x of sent) {
          let got: unknown;
          if (x.target === "protocol") got = after.protocols[x.protocol as Protocol].out;
          else if (x.target === "universe") got = after.universes.find((u) => u.no === x.universe)?.request;
          else {
            const removedBelow = removes.filter((r) => r < (x.index as number)).length;
            const e = after.protocols[x.protocol as Protocol].entries.find((y) => y.index === (x.index as number) - removedBelow);
            const key = { LocalUniverse: "localUniverse", Amount: "amount", "Art-NetAbsolute": "universe", sACNUniverse: "universe", Mode: "mode", Priority: "priority", Enabled: "enabled" }[x.property] as string;
            got = e ? e[key] : undefined;
          }
          if (show(got) !== x.expect) mism.push(`${x.name} reads ${got === undefined ? "nothing" : show(got)}, expected ${x.expect}`);
        }
        for (const n of removes) if (!stopped && after.protocols[protocol as Protocol].entries.length !== before.protocols[protocol as Protocol].entries.length + newIndex.length - removes.length) mism.push(`entry ${n} was not removed`);
        const checked = `${sent.length} written propert${sent.length === 1 ? "y" : "ies"}${removes.length ? ` and ${removes.length} removal(s)` : ""}, read back`;
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
      warnings: ["the DMX output configuration has no undo; previous holds the values before this call", ...(newlySending.length ? [`${newlySending.map((x) => NAMES[x]).join(" and ")} now send DMX onto the network`] : [])],
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
