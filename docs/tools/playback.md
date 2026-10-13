# Executor and sequence playback configuration (SB-01)

Three tools inspect and configure how a sequence plays from an executor. They use only the existing bridge
ops (`objects`, `object`, `children`, `set`); no Lua is generated, nothing needs `gma3_lua`, and they work with
the bridge's Lua execution disabled. Evidence: [the SB-01 probe record](../probes/sb-01-playback-macos-2.5.1.md).

| Tool | Changes | Owner of the settings |
| --- | --- | --- |
| `gma3_executor_settings` | nothing (read-only) | — |
| `gma3_configure_executor` | key, MA-key, fader and encoder functions, Fix, the executor's Lock | the executor (`Page <p>.<e>`) |
| `gma3_configure_sequence` | Wrap Around, priority, restart mode and the other playback options, the sequence's Lock | the sequence, so **every executor it is assigned to** |

Cue triggers and timing (what makes a chase run) are set with `gma3_set_cue_trigger` / `gma3_set_cue_timing`
([cues](cues.md)); assigning a sequence is `gma3_assign_to_executor` ([executors](executors.md)).

## The things to know first

- **The console silently ignores values it does not accept.** `Set` of `KeyPress "Bogus"`, `Fader "Highlight"`
  or `EncoderLeft "Flash"` returns without error and the property keeps its previous value. It also *accepts* key
  functions that make no sense for a sequence (`Call`, `LogIn`, `At`). So the tools validate every choice against
  their own lists first, and every `set` reply (the bridge reads the property back after writing) must show the
  requested value, otherwise the step fails.
- **Locks are per object.** The Page, the Executor and the Sequence each have their own `Lock` (it reads `UL` when
  locked, empty when not). Writes to a locked executor, to any executor on a locked page, or to a locked sequence
  are silently ignored; `Store` into a locked sequence answers "Cannot Create Object". A page or executor lock does
  not protect the sequence, and a sequence lock does not protect its executors. **Kill Protect** and **Swap
  Protect** are sequence settings that protect *playback* from the Kill and Swap actions; they do not stop editing.
  The console's `StructureLocked` / `SystemLocked` flags are read-only and always refused.
- **Configuration does not start playback.** None of the tools sends a playback keyword (Go, On, Off, Toggle, Flash,
  Press, ...), moves a fader or touches the selection or programmer. Each configure tool reads the sequence's
  `HasActivePlayback` before and after (`playback.activeBefore` / `activeAfter`) and warns if it changed.
- **A chase loops only with Wrap Around on and a trigger on its first cue.** With three cues all on a Time trigger
  and Wrap Around on, `Go+` runs 1→2→3→1→… until `Off`; with Wrap Around off it stops on the last cue and stays
  active. (Manual: Wrap Around is automatically disabled if the OffCue has a trigger.)
- Writing properties is not the same as `Assign <function> At Page p.e`: the manual notes that the command form
  clears the unpress function. The tools never use it.

## Shared behaviour of the two configure tools

- **Validation before anything is sent.** Unknown parameter values, functions not valid for that element of a
  sequence executor, and calls with nothing to configure are refused with `validationErrors`.
- **A value that could not be read is unknown, never a default.** The bridge leaves a property it cannot read out
  of its reply. Before planning, every value the plan depends on (the requested properties, the target's Lock, the
  page Lock for an executor, StructureLocked and SystemLocked) must have been read; otherwise the call is refused
  before anything is sent. A missing Lock is never taken as "unlocked", a missing function never as "Empty", and
  a requested value is "unchanged" only when its current value was actually read. A `set` reply without a value
  makes that step `unknown` (it confirms neither an unlock nor an `Empty` function), and a read-back missing a
  field does not verify.
- **Plan, then send only what changes.** The tool reads the current values and builds
  `intended.changes` (`key`, `property`, `from`, `to`); requested values that are already set are listed in
  `intended.unchanged` and never sent. Every requested value overwrites the current one; there is no merge.
  When nothing changes, the result is `succeeded` with `noop: true` and no request was sent.
- **`preview: true`** performs only the reads and returns the same plan, the lock state and (for sequences) the
  sharing executors. It does not take the mutation lock.
- **Locks.** A locked target is refused before anything is sent, naming the owner (`page`, `executor`,
  `sequence`). `unlock: true` unlocks the owning object(s), applies the changes and locks them again; relocking is
  attempted even when a change failed or its reply was lost, and a relock that cannot be confirmed is a warning
  ("may be left UNLOCKED"). With a locked page and executor, the page is unlocked first and relocked last (a locked
  page blocks the executor's own Lock write). `lock: true|false` sets the target's own Lock as part of the call;
  `lock: false` on a locked target is itself an explicit unlock (no relock). A page lock always needs `unlock: true`.
- **One `set` per value, in parameter order**, stopping at the first step that is not a confirmed success. A
  `set` whose reply shows a different value is `failed` (the console kept the old value); a lost reply is
  `unknown` and is never resent. Outcome follows the shared result model: `failed` when nothing was changed,
  `partial` after at least one confirmed change.
- **`verify`** (default true) reads every changed property and the final Lock back and compares them
  (`verification`). Not verified: anything not requested, and the effect of a function at playback time.
- **Serialisation caveat.** Mutations from this server run one at a time inside the mutation lock. The lock does not
  isolate anything from another operator, MCP server or macro: an object can change between the read and the write.

## gma3_executor_settings

| Parameter | Type | Meaning |
| --- | --- | --- |
| `page` | integer 1-9999 | Executor page. |
| `executor` | integer | 101-190, 201-290, 301-390, 401-490 (plus Xkeys 191-198, 291-298). |
| `references` | boolean, default true | Scan every page for executors that share the sequence. |

Requests: `objects Page <p>` (Lock), `objects Page <p>.<e>` (Object, as a handle), `objects Page <p>.<e>` (the
function properties, Fix, Lock, StructureLocked, SystemLocked); for a sequence: `object DataPool` (the current data
pool's address), `objects <sequence address>` (settings, Lock), `object <sequence address>` (HasActivePlayback), and
the reference scan (`children DataPool.Pages`, then
`children <page>` with `No` and `Object` for each page; at most 200 pages, otherwise `complete: false`).

Returns `pageInfo`, `empty`, `assigned` (`class`, `index`, `name`, `addr`), `executorSettings` (`functions`,
`fix`, `locked`, ...), `allowedFunctions`, `sequence` (`addr`, `dataPool`, `ref`, `settings`, `locked`, `active`),
`protection` (each lock and protect flag by owner), `references` and a warning when the sequence is shared. A value
that could not be read is `null` (never "unlocked" or "Empty") and its property is listed in `unreadable`. An
executor holding something other than a sequence is reported, but no function list is qualified for it.

**Sequences from another data pool.** An executor can hold a sequence from another data pool (see the manual's
data pool topic), so the assigned sequence is always read by the address the executor reports, never rebuilt as
`Sequence <n>` (which would read the current pool's sequence of the same number). `sequence.dataPool` is
`current`, `other` or `unknown`; `sequence.ref` (`Sequence <n>`) is given only for the current pool, because
`gma3_configure_sequence` addresses sequences by number in the current data pool and cannot configure another
pool's sequence. The reference scan covers the current data pool's pages.

## gma3_configure_executor

| Parameter | Property | Allowed values (sequence executor) |
| --- | --- | --- |
| `key_press`, `ma_key_press` | KeyPress, MAKeyPress | Empty, Go+, Go-, <<<, >>>, On, Off, Toggle, Top, Kill, Pause, Goto, Load, Select, SelectFixtures, Rate1, Speed1, Learn, LearnSpeed, HalfSpeed, DoubleSpeed, ReSync, FastSync, **Flash, Temp, Swap, Black, Time** (key-only) |
| `key_unpress`, `ma_key_unpress` | KeyUnpress, MAKeyUnpress | the list above without the key-only functions |
| `encoder_left`, `encoder_right` | EncoderLeft, EncoderRight | the list above without the key-only functions (the console refuses them) |
| `fader`, `encoder` | Fader, Encoder | Empty, Master, X, XA, XB, Temp, Rate, Speed, Time |
| `fix` | Fix | true / false |
| `lock`, `unlock`, `preview`, `verify` | | see above |

Names match case-insensitively and are sent in the console's spelling; `Empty` clears a function (reads back
empty). The executor must exist on an existing page and hold a sequence; anything else is refused before
anything is sent. Executor settings belong to this executor only.

Requests in order: `objects Page <p>` (Lock), `objects Page <p>.<e>` (Object), `objects Page <p>.<e>` (current
values), `object <sequence address>` (playback before; the sequence the executor holds, also from another data
pool), then `set Page <p> Lock No` / `set Page <p>.<e> Lock No` (only
with `unlock`), one `set Page <p>.<e> <Property> <value>` per change, `set ... Lock Yes|No` (explicit `lock`),
the relocks, `objects Page <p>.<e>` (read-back) and `object <sequence address>` (playback after). The result names
the sequence (`sequence`, `sequenceAddr`).

## gma3_configure_sequence

| Parameter | Property | Values |
| --- | --- | --- |
| `wrap_around` | WrapAround | true / false |
| `priority` | Priority | super, swap, htp, highest, high, ltp, low, lowest |
| `restart_mode` | RestartMode | first_cue, current_cue, next_cue |
| `release_first_cue` | ReleaseFirstCue | true / false |
| `auto_start`, `auto_stop` | AutoStart, AutoStop | true / false |
| `master_go_mode` | MasterGoMode | none, go, on, top (applies only with Auto Stop off) |
| `auto_fix`, `auto_stomp`, `tracking`, `soft_ltp` | AutoFix, AutoStomp, Tracking, SoftLTP | true / false |
| `off_when_overridden` | OffWhenOverridden | true / false |
| `kill_protect`, `swap_protect` | KillProtect, SwapProtect | true / false (protect playback, not editing) |
| `use_executor_time`, `include_link_last_go` | UseExecutorTime, IncludeLinkLastGo | true / false |
| `xfade_mode`, `xfade_reload` | XFadeMode, XFadeReload | ab / split, true / false |
| `rate_master` (SB-06) | RateMaster | a speed master 1–16 or `"none"`: the cue timing runs at its effective BPM / 60 (60 BPM = 1:1) |
| `speed_master` (SB-06) | SpeedMaster | a speed master 1–16 or `"none"`: the phasers in the cues follow it |
| `rate_scale`, `speed_scale` (SB-06) | RateScale, SpeedScale | one, mul2 … mul256, div2 … div256 |
| `speed_from_rate` (SB-06) | SpeedFromRate | true / false: the rate also scales the stored speeds |
| `lock`, `unlock`, `preview`, `verify` | | see above |

Requests in order: `objects Sequence <n>` (settings, Lock), the reference scan, `object Sequence <n>` (playback
before), the `set` requests (unlock, one per change, explicit lock, relock), `objects Sequence <n>` (read-back),
`object Sequence <n>` (playback after). The result lists `references` (every executor of the current data pool
assigned this sequence) and warns when more than one executor shares it, or when the scan was incomplete; an
incomplete scan never blocks the change. Input/output filters are not part of the first release.

Masters are written by name, which the console requires (a number is silently ignored): a `resolve_masters` read step
(`children ShowData.Masters.Speed`) turns the number into the master's name first and refuses a master without a name
or one that shares its name with another. While a rate master is linked, the sequence's own rate fader is the shared
master. See [speed.md](speed.md) for the masters themselves.

## Not in the first release

Custom key commands, executor width/height, executor configurations (save/load/recast), MA-encoder functions,
non-sequence executors and Cue Zero mode. Speed and rate masters: [speed.md](speed.md) (SB-06).

## Live test procedure (`test/live/playback.live.ts`)

Not part of `npm test`. On a disposable show with an empty programmer:
`GMA3_LIVE=1 node --import tsx --test test/live/playback.live.ts` (about 13 s). It refuses to run when Sequence
905 exists or Page 90.210/90.211 are taken, and skips unless a complete programmer scan (coverage complete, no
channel errors or limitations) finds no values, then:

1. creates Page 90 if needed, Sequence 905 with three empty cues, assigns it to 90.210 and 90.211 and gives every
   cue a 0.5 s Time trigger (`gma3_set_cue_trigger`);
2. inspects 90.210 (both sharing executors listed), configures a Temp key and Temp fader and the sequence's
   settings (warning names 90.211), and checks that no playback started;
3. runs the chase with `Go+` (sent by the test) and checks at least two Cue 3 → Cue 1 wraps in 4.2 s, then with
   Wrap Around off checks 1→2→3 and no wrap;
4. configures Temp and then Flash keys and checks that `Press`/`Unpress Page 90.210` (sent by the test) make the
   sequence active only while pressed;
5. locks the executor and the sequence, checks both are refused without `unlock` (values unchanged), applied and
   relocked with `unlock: true`, and reported by owner, then unlocks them;
6. cleans up: Off, unlock, `Delete Page 90.21x`, `Delete Sequence 905`, and Page 90 if it created it. Nothing
   calls SaveShow.
