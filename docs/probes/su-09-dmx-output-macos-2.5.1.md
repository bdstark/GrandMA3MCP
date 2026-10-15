# SU-09 probe: universes, grants and Art-Net / sACN configuration (macOS, onPC 2.5.1)

Evidence for [SU-09 in SETUP.md](../../SETUP.md#su-09--dmx-universes-and-output).

- **Date:** 2026-10-15
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, no MA hardware connected, the throwaway show
  `NewShow_2026.10.15_04.21.01UTC`, bridge 0.29.0 then 0.30.0
- **Method:** read-only Lua through the bridge's `lua` op (properties in the display role), then writes on disabled
  entries with both protocols' output off, each restored at once. Nothing was sent onto the network.

## Universes

`ShowData.LivePatch.DmxUniverses` has 1024 `DmxUniverse` objects with 512 children each. The relevant properties:

| Property | Universe 1 (pars, washers, beam) | Universe 2 (Festoons) | Universe 3 (idle) |
| --- | --- | --- | --- |
| `Used` | 8 (fixtures patched) | 2 | 0 |
| `Granted` | No | No | Yes |
| `Request` | Auto | Auto | Auto |
| `PortOut` | Yes | Yes | No |

1022 universes read `Granted: Yes`: the idle ones, where nothing needs a grant. The two in use are not granted.
`GetDMXValue` returns nothing for them, which is why `gma3_fixture_output` could not read DMX in the field test.

`Request` takes `Auto`, `On` and `Off` (enum `LicenseRequest`). `Set("Request", "Yes")` was silently ignored.
`Request On` on universe 1 read back `On`, but the universe stayed not granted (2 s later too); it was set back to
`Auto`.

## Protocols

`Root.DeviceConfigurations` holds `DMXProtocols` (`ArtNet`, `sACN`) and `OutputStations` (Console, onPC, PU,
NetworkNode; this onPC lists three stations: 127.0.0.1, 192.168.2.162 and a session entry).

| Object | Properties (values here) |
| --- | --- |
| `ArtNet` | `Out` No, `In` No, `Interface` 0.0, `PreferredIP` 10.0.0.0/8, `SetupMode` No, `ArtPollRate`, `OutputDelay` |
| `Art-Net-Data 1` | `LocalUniverse` 1, `Amount` 1, `Net` 0, `Art-NetSub-Net` 0, `Universe` 0, `Art-NetAbsolute` 0, `Mode` Auto, `Enabled` No, `EnableRDM` No, `PacketDelay` 0.10 ms |
| `sACN` | `Out` No, `In` No, `Interface`, `PreferredIP` |
| `sACNData 1` | `LocalUniverse` 1, `Amount` 1, `sACNUniverse` 1, `Mode` Output Multicast, `Priority` 100, `TTL` 8, `Enabled` No, `PreviewOnly` No |

Modes: `ArtNetDataMode` Auto / Broadcast / Unicast / Input. `SacnDataMode` Output Multicast / Output Unicast /
Input Multicast / Input Unicast.

## Writes (output off, restored)

| Write | Read back |
| --- | --- |
| Art-Net entry: `LocalUniverse` 2, `Amount` 3, `Universe` 5 | 2, 3, 5; `Art-NetAbsolute` 5 |
| `Art-NetAbsolute` 300 | net 1, subnet 2, universe 12 (300 = 256 + 32 + 12) |
| `Mode` Unicast / `Mode` "Banana" | Unicast / unchanged (Auto): **silently ignored** |
| `Amount` 0 | 0: **accepted** although meaningless |
| sACN `sACNUniverse` 12, `Priority` 150, `Mode` Output Unicast | 12, 150, Output Unicast |
| sACN `Priority` 250 | 200: **clamped** |
| `sACNDataCollect:Append()` | `sACNData 2`, disabled, local universe 1; `Remove(2)` removes it |

So the tool validates before writing and judges every write by its read-back.

## The tools, live (bridge 0.30.0)

- **`gma3_dmx_output`:** "2 universe(s) want output, 0 of them granted"; universes 1 and 2 are `not_granted`, each
  covered by the disabled sACN and Art-Net entry 1.
- **`gma3_fixture_output` on 101 and `gma3_dmx` on universe 1:** both now carry `outputState: not_granted` with the
  explanation.
- **`gma3_configure_dmx_output`:**
  - Turning Art-Net output on was refused without `network: true`; the preview named the three station interfaces.
  - With sACN output off: entry 1 was edited and an entry added (8 properties matched), universe 2's request set,
    and all of it restored (6 properties and the removal matched).
  - A priority of 250 was refused before sending.

`test/live/dmx-output.live.ts` 1/1 (1.5 s): the same read checks, then the configuration part on sACN entry 1 and
universe 1024's request, with output off and everything restored to the first read.
