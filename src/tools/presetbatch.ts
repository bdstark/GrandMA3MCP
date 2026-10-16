/**
 * The batch form of gma3_store_preset (SU-12): several presets, each from explicit content, built in the console's
 * Preview environment.
 *
 * The single form stores whatever the programmer holds. The batch form builds each preset from its own content
 * (fixtures with presets, intensity and/or attribute values, or several looks), so the operator's Normal programmer
 * is never touched: every preset is built in the Preview programmer from empty, each look is checked there right after
 * its commands, then gma3_store_preset's own checks and read-back run on that programmer (environment Preview). A
 * preset that fails does not stop the others; an unknown step stops the build. Preview is left at the end and the
 * Normal programmer is checked to be unchanged.
 */
import { MAX_BATCH_ITEMS, duplicates, summarizeBatch, type BatchEntry } from "../batch.js";
import { asRead, buildResult, validationFailure, type OperationResult, type StepFn, type StepResult, type Verification } from "../results.js";
import { Validator } from "../validate.js";
import type { ToolContext } from "./context.js";
import { buildInPreview, validateLooks, type LookSpec, type PreviewItem } from "./cuelists.js";
import { expandFixtures } from "./groups.js";
import { prepareStorePreset, type StorePresetArgs } from "./presets.js";

const OP = "store_preset";

/** Fields of a preset item that describe its content rather than the store. */
const CONTENT_KEYS = ["fixtures", "presets", "intensity", "values", "looks"] as const;

interface PresetItem {
  preset: string;
  /** Every fixture id the looks target: the store's scope. */
  scope: string[];
  looks: LookSpec[];
  store: StorePresetArgs;
}

/** A list of fixture ids and "a Thru b" ranges as one selection command ("Fixture 401 Thru 404 + Fixture 501.1"). */
export function selectionOf(entries: unknown[]): string {
  return entries.map((e) => `Fixture ${String(e).trim()}`).join(" + ");
}

/** Fixture ids of a look's list (ranges expanded), or the reason it is not one. */
function idsOf(v: Validator, path: string, value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    v.fail(`${path} must be a non-empty list of fixture ids or "a Thru b" ranges (the preset's scope)`);
    return undefined;
  }
  const out: string[] = [];
  value.forEach((f, i) => {
    const ids = v.check(() => expandFixtures(`${path}[${i}]`, f));
    if (ids) out.push(...ids);
  });
  return out;
}

/**
 * Validate every item: its content (looks whose fixtures are id lists), and the store request gma3_store_preset would
 * make from it (scope = every fixture the looks target). Any error refuses the whole call before anything is sent.
 */
export function validatePresetItems(items: Array<Record<string, unknown>>): { items: PresetItem[] } | { errors: string[] } {
  const v = new Validator();
  const out: PresetItem[] = [];
  if (items.some((raw) => raw.exclusive !== true)) v.fail("exclusive must be true: the presets are built in the console's Preview environment (its own programmer and selection; the operator's Normal programmer and the output are not touched), and nobody else may use the console while the build runs");
  items.forEach((raw, i) => {
    const path = `presets[${i}]`;
    const scope = new Set<string>();
    // Looks name their fixtures as id lists (the scope); they are applied as selection commands.
    const toLook = (l: Record<string, unknown>, p: string, fallback: unknown): Record<string, unknown> => {
      const list = l.fixtures ?? fallback;
      const ids = idsOf(v, `${p}.fixtures`, list);
      ids?.forEach((id) => scope.add(id));
      return { ...l, fixtures: ids ? selectionOf(list as unknown[]) : undefined };
    };
    const content: Record<string, unknown> = Object.fromEntries(CONTENT_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
    if (Array.isArray(raw.looks)) content.looks = (raw.looks as Array<Record<string, unknown>>).map((l, j) => toLook(l ?? {}, `${path}.looks[${j}]`, raw.fixtures));
    else if (raw.fixtures !== undefined || content.presets !== undefined || content.intensity !== undefined || content.values !== undefined) Object.assign(content, toLook(content, path, raw.fixtures));
    const looks = validateLooks(v, content, path, undefined);
    const store: StorePresetArgs = {
      ...(Object.fromEntries(Object.entries(raw).filter(([k]) => !(CONTENT_KEYS as readonly string[]).includes(k))) as unknown as StorePresetArgs),
      fixtures: [...scope],
      exclusive: true,
      environment: "Preview",
    };
    if (raw.force !== undefined) v.fail(`${path}: force (a forced conversion) is for the single form; the batch form stores new content`);
    if (raw.keep_activation === true) v.fail(`${path}: keep_activation is not available in the batch form (the Preview programmer is cleared between presets)`);
    if (raw.preview === true) v.fail("preview is not available in the batch form; check one preset with the single form");
    if (scope.size) {
      const prep = prepareStorePreset({ bridge: undefined as never, mutations: undefined as never, requestTimeoutMs: 0, luaToolAllowed: false }, store);
      if ("operation" in prep) for (const e of prep.validationErrors ?? []) v.fail(`${path}: ${e}`);
    }
    if (typeof raw.preset === "string" || typeof raw.preset === "number") out.push({ preset: String(raw.preset), scope: [...scope], looks, store });
  });
  for (const d of duplicates(out.map((p) => p.preset))) v.fail(`preset ${d} appears more than once in presets`);
  if (items.length > MAX_BATCH_ITEMS) v.fail(`presets: at most ${MAX_BATCH_ITEMS} items per call`);
  return v.ok ? { items: out } : { errors: v.errors };
}

/** Store the validated items: one Preview build, one gma3_store_preset run per preset, a batch result per preset. */
export async function storePresetsFromContent(ctx: ToolContext, merged: Array<Record<string, unknown>>, o: { detail: boolean; verify: boolean }): Promise<OperationResult> {
  const checked = validatePresetItems(merged);
  if ("errors" in checked) return validationFailure(OP, { presets: "refused" }, checked.errors);
  const items = checked.items;
  return ctx.mutations.run(async () => {
    const stored: Array<OperationResult | undefined> = items.map(() => undefined);
    const preview: PreviewItem[] = items.map((p, i) => {
      const pre = `preset ${p.preset}: `;
      const run: StepFn = async (): Promise<StepResult> => {
        const prep = prepareStorePreset(ctx, p.store);
        const r = "operation" in prep ? prep : await prep.body();
        stored[i] = r;
        const ok = r.outcome === "succeeded" && r.verification.status !== "mismatched";
        return { name: `${pre}store`, status: ok ? "succeeded" : r.outcome === "unknown" ? "unknown" : "failed", op: "gma3_store_preset", detail: { outcome: r.outcome, verification: r.verification.status }, ...(ok ? {} : { error: r.summary }) };
      };
      return { prefix: pre, looks: p.looks, store: [{ name: `${pre}store`, run }] };
    });
    const built = await buildInPreview(ctx, { items: preview, verify: o.verify, noun: "presets", inspect: [], continueAfterFailure: true });
    const common = built.steps.filter((s) => !items.some((p) => s.name.startsWith(`preset ${p.preset}: `)));
    if (!built.sent) {
      return buildResult({ operation: OP, target: { presets: items.map((p) => p.preset) }, steps: common, verification: { status: "unavailable", detail: "nothing was sent" }, summary: `${OP} was not performed; nothing was sent: ${common.find((s) => s.status !== "succeeded")?.error ?? "the inspection failed"}`, warnings: built.warnings });
    }
    const entries: BatchEntry[] = items.map((p, i) => {
      const label = `Preset ${p.preset}`;
      const report = built.items[i];
      if (report.status === "not_attempted") return { label, skipped: "not attempted: the build stopped before this preset (see the build steps)" };
      const store = stored[i];
      const lookSteps = report.steps.filter((s) => s.name !== `preset ${p.preset}: store`);
      if (!store) {
        const bad = report.steps.find((s) => s.status === "failed" || s.status === "unknown");
        return { label, result: { operation: OP, target: { preset: p.preset }, outcome: bad?.status === "unknown" ? "unknown" : "failed", verification: report.verification, steps: lookSteps, summary: `${label} was not stored: ${report.error ?? "a look did not apply"}`, looks: report.looks } };
      }
      const both: Verification[] = [report.verification, store.verification];
      const verification: Verification = both.some((x) => x.status === "mismatched")
        ? { status: "mismatched", checked: "the looks in the Preview programmer and the stored preset", detail: both.map((x) => x.detail).filter(Boolean).join("; ") }
        : both.every((x) => x.status === "matched")
          ? { status: "matched", checked: "the looks in the Preview programmer and the stored preset" }
          : store.verification.status === "not_requested" && report.verification.status === "not_requested"
            ? { status: "not_requested" }
            : { status: "unavailable", checked: "the looks in the Preview programmer and the stored preset", detail: both.map((x) => x.detail).filter(Boolean).join("; ") || "not verified" };
      return { label, result: { ...store, verification, steps: [...lookSteps, ...store.steps], looks: report.looks } };
    });
    const warnings = [...built.warnings];
    if (built.normalProgrammer === "changed") warnings.push("the Normal programmer changed during the build");
    if (!built.backInNormal) warnings.push("the console was not confirmed back in the Normal environment after the build; run gma3_phaser_release");
    const result = summarizeBatch(OP, entries, {
      detail: o.detail,
      warnings,
      extra: { normalProgrammer: built.normalProgrammer, backInNormal: built.backInNormal, build: common.map((s) => (s.status === "succeeded" ? { name: s.name, status: s.status } : { name: s.name, status: s.status, error: s.error })) },
    });
    // The build's own steps (Preview in and out, the Normal programmer check) decide too.
    const buildBad = common.find((s) => s.status === "failed" || s.status === "unknown");
    if (built.normalProgrammer === "changed") result.verification = { status: "mismatched", checked: result.verification.checked, detail: ["the Normal programmer changed during the build", result.verification.detail].filter(Boolean).join("; ") };
    if (buildBad && result.outcome === "succeeded") {
      result.outcome = "partial";
      result.steps.push(asRead({ name: buildBad.name, status: buildBad.status, error: buildBad.error }));
    }
    return result;
  });
}
