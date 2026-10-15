# onPC 2.5.1 crash: `AddFixtures` with `amount > 1` for a mode with cells

A bug report for MA Lighting (submitted 2026-10-14), with a self-contained reproduction. Found in the end-user field test
([SETUP.md](../../../SETUP.md) SU-02).

## Summary

Calling the documented Lua function `AddFixtures` with `amount = 4` for the "52 channel" mode of the library fixture
"Oppsk 36PCS 4in1 LED Wall Washer" (12 cells) crashes onPC: `EXC_BAD_ACCESS` (null pointer + 4) on the `MainTask`
thread, inside `AddFixtures`. The same call with `amount = 1` works. The arguments are the ones the manual documents
and its example uses.

## Environment

| | |
| --- | --- |
| Software | grandMA3 onPC 2.5.1.0 (Release), arm64 binary UUID `4C4C4473-5555-3144-A115-2DAB5F4F3C60` |
| OS | macOS 26.5.1 (25F80), Apple silicon |
| Show | new, empty show |
| Fixture type | `grandma2/oppsk@36pcs 4in1 led wall washer.pxml` from the shipped library, mode "52 channel" |

## Steps to reproduce

1. Copy `addfixtures_repro.xml` and `addfixtures_repro.lua` (this folder) to
   `<user library>/datapools/plugins/` (`~/MALightingTechnology/gma3_library/datapools/plugins/` on macOS).
2. Start a new, empty show.
3. Command line: `Import Plugin Library "addfixtures_repro.xml" At Plugin 1`
4. Command line: `Plugin "addfixtures_repro" "A"`

The plugin imports the fixture type from the library, then does what the manual's `AddFixtures` example does:

```lua
Cmd('ChangeDestination Root')
Cmd('ChangeDestination "ShowData"."Patch"')
Cmd('ChangeDestination "Stages"."Stage 1"."Fixtures"')
local mode = Patch().FixtureTypes["36PCS 4in1 LED Wall Washer"].DMXModes["52 channel"]
AddFixtures({ mode = mode, amount = 4, fid = "201", name = "Repro", patch = { "1.001" } })
```

**Expected:** four fixtures, FID 201–204, patched from 1.001; `AddFixtures` returns `true`.
**Actual:** onPC terminates during the `AddFixtures` call.

The plugin writes each step to `<temp>/addfixtures_repro.log` before it happens. The run that crashed
(2026-10-14 22:24:16):

```
repro 1.0.1, variant A, grandMA3 2.5.1.0
destination for the import: FixtureTypes
import oppsk@36pcs 4in1 led wall washer.pxml: OK
destination for AddFixtures: Stage 1.Fixtures
calling AddFixtures{ mode = 36PCS 4in1 LED Wall Washer/52 channel (footprint 0,51,-1,…), amount = 4, fid = "201", name = "Repro", patch = { "1.001" } }
```

No line after the call: onPC was gone.

## Crash report

`~/Library/Logs/DiagnosticReports/app_gma3-2026-10-14-222420.ips` (attach it to the report).

- `EXC_BAD_ACCESS`, `KERN_INVALID_ADDRESS at 0x0000000000000004`, then `abort()` from the console's own signal
  handler; thread `MainTask`.
- Faulting stack, as image offsets into `app_gma3` (arm64):

  ```
  0x17c5a3c 0x17c5bf8 0x17d1b3c   (signal handler -> abort)
  _sigtramp
  0xf71c7c                        <- faulting access
  0xa2c8dc 0x1980694 0x19a422c 0x1a40a1c
  0x1acfe80                       AddFixtures + 0xe64
  0x18364c0 0x1836638 0x185abe0   Lua VM
  0x1842afc                       pcall
  0x18364c0 0x183c708 …           Lua VM, plugin start
  ```

The `AddFixtures` and `pcall` frames were identified from the functions' runtime addresses (`tostring()` on the Lua C
functions): one ASLR slide, `0x24e4000` for that run, puts Lua's `print`, `pcall`, `tostring` and `pairs` exactly on
symbol starts of the binary, and puts the frame at `0x1acfe80` at offset `0xe64` into the `AddFixtures` binding.

The first occurrence (2026-10-14 19:18:53, `app_gma3-2026-10-14-191853.ips`, calling the same function) has the same 19 innermost frames.

## Which calls crash

| Variant | Fixture type / mode | Cells | `amount` | `patch` | Result |
| --- | --- | --- | --- | --- | --- |
| A | Oppsk 36PCS 4in1 LED Wall Washer / 52 channel | 12 | 4 | `{ "1.001" }` | **crash** (twice: field test and repro) |
| B | same | 12 | 2 | `{ "1.001" }` | not run |
| C | same | 12 | 2 | none | not run |
| D | ADJ Mega Hex Par / Ch08 | none | 2 | `{ "1.001" }` | not run |
| E | same as A | 12 | 1 | `{ "1.001" }` | not run |

Seen in the field test:
- Mega Hex Par / Ch08 (no cells), `amount = 12` with `patch`: worked, but only the first fixture was patched.
- `amount = 1` with `patch`: worked every time, for the wall washer, a 15-channel beam with no cells, and the 40-cell
  Chauvet Festoon 2 RGB.

## Notes for the report

- The manual (`lua_objectfree_addfixtures.html`) documents `amount` as "how many fixtures should be added" and
  `patch` as up to eight addresses, one per DMX break, but does not say how addresses step for `amount > 1`. With a
  mode without cells, `amount > 1` adds every fixture but patches only the first (seen twice).
- Workaround: one `AddFixtures` call per fixture, each with its own address.
