# SU-18 probe: OSC configuration (macOS, onPC 2.5.1)

Evidence for [SU-18 in SETUP.md](../../SETUP.md#su-18--osc-configuration).

- **Date:** 2026-10-16
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, the throwaway show `NewShow_2026.10.15_23.16.24UTC`,
  bridge 0.32.0, then 0.33.0
- **Method:**
  - the bridge's `object`, `lua` and `vars.*` ops;
  - OSC `/cmd` messages from this repository's `OscSender`, with `SetUserVariable "McpOscProbe" "<nonce>"` as the
    marker;
  - `lsof -iUDP` for the sockets.
  - The configuration was restored after every change. Then `test/live/osc.live.ts`.

## The objects

| Read | Result |
| --- | --- |
| `ShowData.OSCBase` | class `OSCBase`. EnableInput `Yes`, EnableOutput `No`, Interface `1.1`, PreferredIP `127.0.0.0/8` (the field-test agent's settings) |
| its child 1 | class `OSCData`, set up by the field-test agent for its tempo helper. Mode `UDP`, Port 8000, Prefix "", Receive `Yes`, ReceiveCommand `Yes`, Send `No`, SendCommand `No`, DestinationIP `Enter IP here` |
| OSCData properties (schema) | DESTINATIONIP, MODE (enum OSCMode), PORT, PREFIX, DATAPOOL, PAGE, FADER, EXECUTORKNOB, KEY, FADERRANGE, RECEIVE, SEND, RECEIVECOMMAND, SENDCOMMAND, ECHOINPUT, ECHOOUTPUT (YesNo enums) |
| `Root().Interfaces` | lo0 (1.1 127.0.0.1, 1.2 127.51.68.120), en0 (2.1 192.168.5.59), en7 (no address). Interface `1.1` is lo0's first address |
| a line's Name in the display role | `OSCData 2 'McpLive OSC'`; the object's `name` is the plain name |

## Input

| Change | Socket | Command sent to 127.0.0.1 | Command sent to 192.168.5.59 |
| --- | --- | --- | --- |
| as found (PreferredIP 127.0.0.0/8, Interface 1.1) | `*:8000` | run | run |
| PreferredIP `192.168.0.0/16` | `*:8000`; Interface becomes `2.1` | run | run |
| PreferredIP `10.0.0.0/8` | `*:8000`; Interface becomes `0.0` | run | run |
| Interface `2.1` written directly | `*:8000` (the value applies a moment later) | run | run |
| EnableInput `No` | port 8000 closed | dropped | |
| EnableInput `Yes` again | `*:8000` | run | |
| line 1 ReceiveCommand `No` | | dropped | |
| line 1 Receive `No`, ReceiveCommand `Yes` | | run | |
| line 1 Port 8011 | still `*:8000`, even after 1.5 s, a Receive toggle or a PreferredIP change | 8011 dropped, 8000 run | |
| then EnableInput off and on | `*:8011` | 8011 run, 8000 dropped | |
| line 1 Prefix `mcp` | | `/cmd` dropped, `/mcp/cmd` run | |

So the input socket listens on every interface, and Interface and PreferredIP do not limit who can send. A port
change needs input off and on. The field test reported commands dropped until PreferredIP changed from
`10.0.0.0/8`. That did not reproduce here: with `10.0.0.0/8` commands still ran. Its earlier changes may simply not
have been bound yet.

## Output

On a line added with `Append()` the defaults were UDP, port 8000, destination 127.255.255.255. Set to destination
127.0.0.1:9111 with Send, SendCommand and EnableOutput on, the line produced:
- `FaderMaster Sequence 1 At 50` / `At 100` sent two messages, `/14.14.1.7.1 ,sifs FaderMaster … MH Moves`;
- a `SetUserVariable` sent through the bridge's `cmd` produced no message.

The line was removed and EnableOutput set back to No.

## Live test

`test/live/osc.live.ts`, 6/6 with bridge 0.33.0 (needs `GMA3_LIVE_EXCLUSIVE=1`):
- a new command line was refused without `network: true`, then added and read back;
- the loopback test was received in 117 ms;
- a port change re-bound input and the new port received;
- with a prefix, `/mcplive/cmd` was received;
- a send-only line to 127.0.0.1 delivered `/14.14.1.7.1` fader messages without re-binding input;
- the lines were removed, and the configuration matched the one found.

The first run found that a line's Name reads back in its display form; bridge 0.33.0 reads it as the object's name.
