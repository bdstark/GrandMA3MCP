# Patch tools (KB-26)

`gma3_patch_types`, `gma3_patch_list`, `gma3_patch_add`, `gma3_patch_set`, `gma3_patch_remove`. They need bridge
0.19.0 (the `patch.*` ops); an older plugin is reported as such. The design and its evidence are in
[DIALOG.md](../../DIALOG.md) ("KB-25", "KB-26") and the
[KB-25 record](../probes/kb-25-dialogs-macos-2.5.1.md).

## Common behaviour

**No dialogs.** Patching on grandMA3 happens in the patch edit copy (`ShowData.Patch`). The Patch menu opens the copy
and asks "Save and Exit / Discard and Exit / Stay in Patch" when it closes. These tools never open the menu. They enter
the copy with `ChangeDestination "ShowData"."Patch"` and commit it with `ChangeDestination Root`, both sent with
`CmdIndirect`, which commits silently. `Cmd()` is never used: a dialog opened from the plugin thread would stall the
bridge.

**Exclusive use.** Every change tool requires `exclusive: true`; without it the call is refused before anything is
sent. The patch copy and the command line are shared with the operator. Opening the Patch menu fills the same copy,
and a session moves the operator's prompt into the patch. A change tool therefore assumes nobody else uses the console
for its ~10 seconds.

**Isolation check: best-effort detection.** Before committing, the tool fingerprints the copy and the live patch:
every object and property of every patch collection, leaving out the FIDs the call touches and the data the console
derives itself (listed in the KB-25 record). It compares the two, one collection per request. Anything else that
differs means someone changed the show during the session: nothing is committed and the copy is left open.

The check is read over several seconds, so it is **not a consistent snapshot**. An edit landing in a collection
after that collection was read is missed, and would be committed with the session. That is why exclusive use is
required rather than implied.

**No undo.** A committed patch change cannot be reverted with `Oops`. The tools say so in every successful result.

**The session.** Each change tool sends these steps, stopping at the first one that does not succeed:

| Step | Kind | Bridge op | What it does |
| --- | --- | --- | --- |
| `check_state` | read | `patch.state` | The command line is at Root, the copy is closed (nobody is in the Patch menu) and no modal is open |
| `check_add` / `check_edits` / `check_fixtures` | read | `patch.check` | The tool's pre-flight (below) |
| `enter` | mutation | `patch.enter` | Queues the two `ChangeDestination` commands into the copy and its stage's Fixtures |
| `wait_copy` | read | `patch.state` | Polls (100 ms, up to 3 s) until the copy is open at that destination |
| `add` / `set` / `remove` | mutation | `patch.add` / `patch.set` / `patch.remove` | The change, in the copy only |
| `isolation_check` | read | `patch.collections`, `patch.fingerprint` | Fingerprints of copy and live per collection, touched FIDs left out |
| `commit` | mutation | `patch.commit` | Queues `ChangeDestination Root` |
| `wait_commit` | read | `patch.state` | Polls until the destination is Root and the copy is closed |
| `read_back` | read | `patch.list` | After the commit; see each tool |

**When a session cannot be finished.** If the change step is refused or gets no reply, the tool closes the copy
again, but only when it provably holds no change at all: fingerprints equal with nothing left out (steps
`close_check`, `close`, `wait_close`). The same applies if the copy never opens. Otherwise, and always after a failed
isolation check, the copy is left open and the result carries `copyLeftOpen: true`. The operator then resolves it at
the console: Menu › Patch, then **Discard and Exit** (drops everything in the copy) or **Save and Exit** (keeps it).

**Outcome.** The outcome is decided per session, not by counting steps:

| Outcome | When |
| --- | --- |
| `succeeded` | The change was committed and the copy closed. `committed: true`; `verification` reports the read-back |
| `failed` | Nothing was committed (`committed: false`): a refusal before anything was sent, a refused change with the copy closed again, or a failed isolation check (`copyLeftOpen: true`) |
| `unknown` | A step after `enter` got no reply, the copy never opened, or the commit was not confirmed; `committed` / `copyLeftOpen` say what is known |

**Bridge-side safety net.** Each mutating op re-checks in the console:
- `patch.add`: the copy, the destination, a free FID range, a free DMX range inside one universe, a single-break
  mode. After `AddFixtures` it checks that exactly the requested fixtures exist where requested, and deletes them
  again on any problem.
- `patch.set`: unpatches every fixture it readdresses first and then applies the new addresses, so swaps work. It
  checks the new ranges against every other fixture and restores every change of the call on any problem.
- `patch.remove`: refuses fixtures with sub-fixtures.
- All five mutating ops are on the bridge's input-ownership guard (refused with `[busy]` while someone owns console
  input) and need `exclusive = true`.

## gma3_patch_types

Read-only (`patch.types`). The show's fixture types with number, name, short name, manufacturer and source, and per
DMX mode its number, name, `footprint`, `breaks` (number of DMX breaks) and `breakChannels`. `search` filters on
name, short name and manufacturer. Importing a type from the library is not supported yet. KB-25 found a dialog-free
path (`Import Library` in the copy's FixtureTypes), but claiming the imported type safely needs the ownership rule from
the KB-25 probe.

## gma3_patch_list

Read-only (`patch.list`). Fixtures of the live patch, every stage, sub-fixtures included, in patch order. Each row has
`fid`, `cid`, `idType`, `name`, `type`, `mode`, `patch`, `breaks` (`[{break, address}]`), `stage`, `depth`,
`parentFid` and `subfixtures`. `fromFid` / `toFid` filter numeric FIDs; `limit` (default 200, max 2000) / `offset`
paginate.

## gma3_patch_add

| Parameter | |
| --- | --- |
| `type`, `mode` | Fixture type and DMX mode, by number or name (`gma3_patch_types`) |
| `fid` | First fixture ID; the block is `fid .. fid+count-1` |
| `count` | 1-256, default 1 |
| `name` | Optional; the console names the fixtures otherwise |
| `address` | DMX start `"U.AAA"`; fixtures are patched consecutively by the mode's footprint |
| `findFreeFrom` | Instead of `address`: the first free block from this `"U.AAA"` (`FindBestDMXPatchAddr`, re-checked) |
| `stage` | Default: the first stage. Fixtures are added at the stage's top level |
| `exclusive` | Must be `true` |
| `verify` | Default `true` |

With neither `address` nor `findFreeFrom` the fixtures are added unpatched.

Pre-flight (`patch.check` `add`), nothing sent on failure:
- the FID range is free (`CheckFIDCollision`);
- the mode has a single DMX break;
- the DMX block is free (`CheckDMXCollision` plus the bridge's own range check against every patched fixture) and
  fits inside one universe.

The change is `patch.add`. Read-back lists the new FIDs and compares, per fixture: present, patch address (start +
i × footprint), name (when given) and mode.

## gma3_patch_set

`edits`: up to 256 of `{fid, address?, unpatch?, name?}`, each FID once, each changing something. `address` and
`unpatch` are exclusive.

Pre-flight (`patch.check` `edits`), nothing sent on failure:
- every FID exists;
- readdressed fixtures use single-break modes;
- the new ranges overlap no other patched fixture. The moving fixtures' own current ranges are ignored, so swaps and
  moves across a fixture's own range pass.

The change is `patch.set`. Read-back compares each fixture's patch address and/or name.

## gma3_patch_remove

`fids`: up to 256 FIDs, each once. Removing a fixture deletes it from the show; the console handles what referred to
it. Pre-flight (`patch.check` `fids`): every FID exists and has no sub-fixtures. The change is `patch.remove`.
Read-back checks the FIDs are gone. The result's `removed` lists the fixtures as they were.

## Live test procedure

`test/live/patch.live.ts`, with `GMA3_LIVE=1` **and** `GMA3_LIVE_EXCLUSIVE=1` (patch changes are committed with no
undo). It needs a disposable show with a fixture type that has a single-break mode, and FIDs 990–993 free. It:
1. adds FID 990–991 named "MCP live patch" at the first free block from 3.001;
2. checks that a second add at FID 990 is refused before anything is sent;
3. swaps the two addresses and renames 990, then unpatches 991;
4. removes both, and checks that the command line is back at Root with the copy closed.

The cleanup removes anything left in 990–993.

```bash
GMA3_LIVE=1 GMA3_LIVE_EXCLUSIVE=1 node --import tsx --test test/live/patch.live.ts
```
