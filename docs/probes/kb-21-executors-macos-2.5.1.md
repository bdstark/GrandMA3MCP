# KB-21 live probe: explicit executor targets and stable bindings (macOS, onPC 2.5.1.0)

`node scripts/kb21-probe.mjs run --out docs/probes/kb-21-executors-macos-2.5.1.json` on 2026-10-10 (22:41 UTC): **28/28**
([script report](kb-21-executors-macos-2.5.1.json)). Bridge 0.17.0 with `gma3_mcp_feedback` 0.5.0, `gma3_mcp_control` 0.4.0
and `gma3_mcp_hardkeys` 0.10.0 (the set pinned at `ea5bc0d`), started by the operator path `Plugin 1 "lua input=keyboard
control=fake"` on show `mcp-test-disposable` (the plugin re-imported from the library as `bridge.xml`; the show has no
macros of its own, so every start was typed on the command line). The holds ran on the **fake** control backend (the
console backend refuses executor elements until KB-22; nothing was pressed on the console). Verify ran first (7/7, nothing
queued). Three earlier runs of the same day found and fixed, in order: the bridge's control binding source dropping
`executorPage` (a page-bound bind resolved against the following spec: `binding-unknown`), the `[busy]` guard refusing the
probe's own page change / deletion / reassignment while a button was held (now run from a probe-owned deferred macro, slot
116, the KB-13 pattern), an empty executor on the user's page carrying no page identity (`GetExecutor` returns no page
handle for it), and a following binding's generation moving **four times** per console page change while the cached
executors were re-read (now no generation is claimed until every following executor was observed on the page the
snapshot names: one move per page change). The JSON report is the final run's.

## Facts established

- **Explicit identity:** every executor target of `feedback.context` carries `pool {Default, 1}`, `page {no, name}`,
  `executor`, `mode` (`current` on the user's page, `page` through `ObjectList("Page P.E")`), `width`; the 27 assigned
  executors of page 1 read identically through both paths. Page 9999 is `pageMissing` on every target and still does
  not exist afterwards (`ObjectList("Page 9999")` nil); pages 1-5 exist on the show, page 6 is the first missing one.
- **Expanded assignments:** `Set Page 1.180 Property "Width" "2"` and `Set Page 1.180 Property Width 2` both answered
  `OK` and changed nothing (Width read back 1). The direct property write `ObjectList("Page 1.180")[1]:Set("Width", 2)`
  through the `lua` op took (Width read back 2): executor 180 reports `width 2, expanded`, and the reader reports 181
  `coveredBy 180 (width 2)`, not a playback target. What the console itself answers for the covered number: both
  `ObjectList("Page 1.181")` and `GetExecutor(181)` return a handle of class **`Proxy`** with no `Width` and no `Object`
  (not nil as for a plainly empty executor), so a covered number is readable as "a slot with nothing of its own".
- **Frozen holds (fake backend):** a down on 180 (following binding) resolved `execDefault#1/1.180.key|<Sequence>|Go+`;
  the status listed it under `frozen` (page 1, pool, the assigned object). A console command while the button was held was
  refused `[busy]` by the bridge; `Page 2` from the deferred macro moved the following binding's generation (its 180 is
  empty on page 2), the hold stayed under the old generation with its frozen target unchanged, and the release was applied
  to **page 1's 180**, not to page 2's. A fresh down on 180 on page 2 was `target-unavailable` (empty).
- **Independent page:** bound to page 1 explicitly, `Page 2` on the console did not move the generation and the targets
  still read page 1's assignments through `ObjectList`; a down naming page 1 was admitted while the console showed page
  2 (frozen to page 1.182); the same number without `target.page` was `target-unavailable` ("needs target.page").
- **Deletion and reassignment while held** (from the deferred macro): deleting 182's assignment moved the generation and
  emptied the target, the release still went to the recorded object on page 1.182; a new down on 182 was
  `target-unavailable` (empty). Reassigning 183 moved the generation and the release named the object that was pressed.
- **Missing page:** a down naming page 6 was `target-unavailable` (not in the binding) and page 6 still did not exist.
- **Two surfaces:** a second session pressing page 1.180 while the first held it was refused `conflict` naming the
  owner; after the release its down was admitted.
- **Cleanup:** the registered undos ran (releases first, the deferred macro deleted after a name check, the three
  assignments deleted, `Page 1`); 180-183 empty again, no session, gesture, queued intent or unresolved release left.

## Not exercised live

A Quickey-bank reservation (the bank is not provisioned on this show; the exclusion is harness evidence); executor
operations themselves (KB-22: the console backend); a page bound while the console switches data pools; the M-Touch
and M-Play hardware (the surface's record covers the service's `sim` path: mtpnxk `docs/probes/kb-21-surface-macos-2.5.1.md`).
