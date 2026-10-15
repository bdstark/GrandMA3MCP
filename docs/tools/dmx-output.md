# DMX universes and output (SU-09)

`gma3_dmx_output`, `gma3_configure_dmx_output` in `src/tools/dmxoutput.ts`, bridge 0.30.0 (`dmx.output`, `dmx.set`,
`dmx.addEntry`, `dmx.removeEntry`). Evidence: [SETUP.md](../../SETUP.md) SU-09 and the
[SU-09 record](../probes/su-09-dmx-output-macos-2.5.1.md).

## Where output comes from

- **Universes** (the live patch's `DmxUniverses`, 1024 of them) carry:
  - `Used`, the fixtures patched into the universe;
  - `Granted`, `Request` (Auto, On, Off) and the `PortOut` / `PortIn` / `PortRDM` ports;
  - the merge mode, and the parked and tester counts.

  A universe that wants output (patched, or set to output) needs a grant. An idle universe reads `Granted: Yes`,
  because nothing needs a grant there.
- **The grant** comes from the session's MA licensing. On grandMA3 onPC it comes from connected MA hardware (such as
  a command wing or a processing unit). The probe's onPC had none, so its two universes in use read `Granted: No`,
  nothing was output, and `GetDMXValue` returned nothing. `Request On` asks for a grant but does not create one.
- **Art-Net and sACN** live in `Root.DeviceConfigurations.DMXProtocols`. Each protocol has an `Out` and an `In`
  switch and data entries. Each entry maps `LocalUniverse` … `LocalUniverse + Amount − 1` to protocol universes, and
  has a `Mode`, `Enabled` and (sACN) `Priority`. An Art-Net universe is the absolute number: net × 256 + subnet × 16
  + universe.
- **Output stations** (`Root.DeviceConfigurations.OutputStations`) are the station's interfaces: the IP addresses
  the protocols send from.

## gma3_dmx_output

Read-only. The universes in use (patched, set to output or with a grant request), plus any given in `universes`. Each
has its fields, the protocol entries that cover it (entry, enabled, mode, the protocol's `Out`, and the protocol
universe it is sent as), and an explanation:

| `state` | Meaning |
| --- | --- |
| `idle` | nothing patched, no output set |
| `not_granted` | the session has no grant for it: not output, values unreadable |
| `no_protocol_output` | granted, but no enabled entry with its protocol's output on covers it (it reaches MA-Net devices only, if any) |
| `sent` | granted and sent, as the listed Art-Net / sACN universes |

Also included: `totals` (universes, used, wanting output, granted among those), both protocols with every entry,
the output stations, and a one-line summary.

`gma3_fixture_output` and `gma3_dmx` add `outputState` for each universe whose output they cannot read, so an agent
learns why rather than getting an empty result.

## gma3_configure_dmx_output

| Param | Notes |
| --- | --- |
| `protocol` | `artnet` or `sacn` (required with `output` or `entries`) |
| `output` | the protocol's `Out` switch |
| `entries` | each `{entry}` (an existing number), `{add: true}`, or `{entry, remove: true}`, with `local_universe` (1..1024), `amount` (≥ 1, ending at 1024 at most), `universe` (Art-Net absolute 0..32767, sACN 1..63999), `mode`, `priority` (sACN, 0..200), `enabled` |
| `grant_request` | `{universes, value: auto|on|off}` |
| `network` | required when the change makes a protocol send DMX onto the network |
| `preview`, `exclusive`, `verify` | `exclusive` required unless `preview` |

**Validation first.** The console silently ignores an invalid mode, clamps a priority above 200 to 200 and accepts an
amount of 0, so the tool refuses such values before anything is sent. It also refuses an entry number the protocol
does not have.

**Order.**
1. Turning a protocol's output off goes first.
2. New entries are appended, then each entry's mapping is written. `Enabled` comes last for each entry, so an entry
   starts sending only once its mapping is in place.
3. Grant requests.
4. Turning a protocol's output on comes last.
5. Removals run after the edits, highest number first, so the numbers stay valid.

**The network.** After the change, a protocol whose `Out` is on and that has an enabled entry sends DMX onto the
network through the output stations' interfaces. If the change makes that happen, it is refused without
`network: true`; `preview` shows the plan and the note.

**Read-back.** Every written property is read back and compared, and a removal is checked by the entry count. A
value the console did not take is a mismatch. The result carries `previous` (both protocols, and the requests of the
universes touched) for a manual restore, since there is no undo, and `now` (the protocols, and each universe
explained again).

## Live test

`test/live/dmx-output.live.ts` (`GMA3_LIVE=1`; the configuration part also needs `GMA3_LIVE_EXCLUSIVE=1`, and runs
only while Art-Net and sACN output are both off, so nothing reaches the network):
1. every universe in use is explained;
2. a fixture with unreadable output gets `outputState`;
3. a preview names the network;
4. a priority of 250 is refused;
5. sACN entry 1 is edited, one entry added and universe 1024's request set, then everything is restored from the
   first read.
