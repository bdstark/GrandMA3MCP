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

An entry sends only when it is enabled, its protocol's output is on and its mode is an output mode. For Art-Net
that is every mode but `Input`; for sACN, the `Output` modes. An enabled input entry receives the universe and is
named as such.

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

**Validation first, on the effective configuration.** Each touched entry is taken with its current values plus the
requested ones, and both complete ranges are checked:
- the local universes `local_universe` … `+amount − 1` must lie within 1..1024;
- the protocol universes `universe` … `+amount − 1` must lie within 0..32767 (Art-Net) or 1..63999 (sACN).

Changing only `local_universe` to 1024 on an entry with an amount of 2 is refused. The tool also refuses:
- an invalid mode, a priority above 200 or an amount of 0, which the console would ignore, clamp or accept as
  meaningless;
- an entry number the protocol does not have;
- two specs for one entry (a remove twice, or an edit and a remove), whose numbers would shift;
- an added entry without `local_universe` and `universe`.

**Order.**
1. A protocol's output turning off goes first.
2. Per entry:
   - an enabled entry that is remapped or disabled is **disabled first**;
   - its mapping is written while it is disabled;
   - it is enabled last, only after the mapping was confirmed.

   An entry that keeps sending is disabled for the moment of its remap.
3. Entries are added (disabled, as the console creates them), then mapped and enabled the same way.
4. Grant requests.
5. Removals, highest number first.
6. A protocol's output turning on comes last.

**Every reply is checked.** The bridge answers each write with the value read back at once. A value that differs,
or an answer that cannot be read, stops the call: nothing that depends on it (`Enabled`, the protocol's `Out`) is
sent. An entry that was disabled for its remap stays disabled, and the warnings say so.

**The network.** An entry sends DMX onto the network when it is enabled, its protocol's output is on and its mode
is an output mode. This is judged on the configuration after the change. If an entry would start sending, or would
send with another mapping, the change is refused without `network: true`. That includes switching an input entry to
an output mode, and turning output on with entries already enabled. `preview` shows the plan and the note.

**Read-back.** The whole configuration is read back after the change (also after a stop): the protocol switch,
every touched entry's mapping and enabled state, the entry count and the grant requests. A value the console did not
take is a mismatch. The result carries `previous` for a manual restore (there is no undo) and `now`, with each
universe explained again.

## Live test

`test/live/dmx-output.live.ts` (`GMA3_LIVE=1`; the configuration part also needs `GMA3_LIVE_EXCLUSIVE=1`, and runs
only while Art-Net and sACN output are both off, so nothing reaches the network):
1. every universe in use is explained;
2. a fixture with unreadable output gets `outputState`;
3. a preview names the network;
4. a priority of 250 is refused;
5. sACN entry 1 is edited, one entry added and universe 1024's request set, then everything is restored from the
   first read.
