# KB-01 probe evidence — Windows, onPC 2.5.1.0

Date: 2026-10-09. Status: **complete for Windows / one and two onPC displays, US layout**, using the
reproducible script plus its manual checks, and the macOS run 3 multi-display checks. The other exploratory
follow-up probes of the [macOS record](kb-01-macos-2.5.1.md) (remap during a hold, Quickeys, Freeze search,
OS-synthetic events) were not repeated.

## Environment

| Item | Value |
| --- | --- |
| onPC | 2.5.1.0 Release, hostType onPC, HostOS Windows |
| OS | Windows 11 Home 10.0.26300, host `dmxmini701` |
| User / profile | Admin / UserProfile "Default" |
| Display | Two monitors attached (Generic PnP Monitor 1920x1080 ×2). Run 1: Display 1 only. Run 2: Display 1 and Display 2 |
| Show | `mcp-test-disposable` (fixture 5 present) |
| Bridge | gma3_mcp_bridge 0.3.4, Lua enabled, luahook=preserve |
| Probe channel | `scripts/kb01-probe.mjs` over the bridge (Node.js 24.21.0, native, not Docker) |
| OS focus | Claude app frontmost, onPC in background, for `auto`, `longpress` and `type` (foreground process checked with `GetForegroundWindow` immediately after `longpress` and before `type`); onPC frontmost for `hw-a`/`hw-b` |
| Keyboard layout | en-US (`0409:00000409`), not varied |

## Run 1 — one onPC display

### Automated run

`node scripts/kb01-probe.mjs auto --out docs/probes/kb-01-windows-2.5.1.json`: **26/26 passed**, state
restored (Blind off, command line empty, MASTATE false, selection empty, environment Normal, shortcuts on)
([kb-01-windows-2.5.1.json](kb-01-windows-2.5.1.json)). The default shortcut table, VirtualKey redirects,
key-name case sensitivity, modifier handling, MA via LeftShift/RightShift, Blind/Highlight/Solo/Preview
readers, shortcuts-disabled behaviour and the double-press result match macOS.

K11 (indexes 2, 99 and 0 all type `5`) ran with only Display 1 configured, so it shows that non-existent
display indexes are accepted, not routing between two onPC displays.

### Manual checks

| # | Check | Observed |
| --- | --- | --- |
| L1 | `longpress`: `S` held 110 frames via `Keyboard()`, onPC in background | command line `Store `; **Store Settings pop-up opened** (operator confirmed); closed with Esc ×2 |
| T1 | `type`: Edit Command dialog open, `char 'a'` + `char 'ü'`, onPC in background | `cmdtext` read back `aü`; operator saw `aü` in the dialog; closed with Esc ×2 |
| H1 | `hw-a`: operator held physical Left Shift (onPC focused); injected `LeftShift` release ~1.5 s into the hold | MASTATE true at 28.26 s; injected release at 29.84 s; MASTATE false for all 20 polls (~3 s) while still held — no auto-repeat re-press |
| H2 | `hw-b`: injected `LeftShift` press (MASTATE true); operator tapped physical Left Shift | injected press at 0.07 s (MASTATE true); **MASTATE dropped at the physical tap** (22.26 s); cleanup release at 22.85 s harmless (MASTATE false) |

## Run 2 — two onPC displays (same day)

Display 1 and Display 2 open on the two monitors (`GetDisplayByIndex(1..2)`). The automated run was repeated,
then the macOS run 3 checks M1–M4 were run as Lua over the bridge.

`node scripts/kb01-probe.mjs auto --out docs/probes/kb-01-windows-2.5.1-2displays.json`: **26/26 passed**,
state restored ([kb-01-windows-2.5.1-2displays.json](kb-01-windows-2.5.1-2displays.json)).

| # | Action | Observed |
| --- | --- | --- |
| M1 | `Keyboard(d,'press'/'release','5')` for d = 1, 2, 3, 4, 7, 15, 16, 99, 0, -1 | `5` in the command line for **every** index, including indexes with no display |
| M2 | Edit Command dialog opened on Display 2; `char` `a`, `b`, `c` via index 1, 2, 9 | `cmdtext` `a` → `ab` → `abc`; operator saw `abc` in the **Display 2** dialog |
| M3 | Escape via index 1 with the dialog open on Display 2 | dialog on Display 2 closed (operator confirmed); `cmdtext` still `abc`; a second Escape cleared it |
| M4 | Store long-press (`S` held 110 frames) via index 2 | command line `Store `; Store Settings pop-up opened on **Display 1** (operator confirmed) |

## Consequences

- The KB-01 contracts recorded for macOS hold on Windows for this subset: `Keyboard()` works through the
  operator's shortcut table, MA is the Shift keys, and readback is via `CmdObj().cmdtext` and the master
  `FADERENABLED` properties.
- Injected input reached onPC while another application had OS focus (automated run, long-press and text
  entry). This is observed for this run, not a guarantee.
- Text entry of a non-ASCII character (`ü`) through `char` works with an en-US layout.
- Same-key release across injected and hardware sources is confirmed in both directions (H1, H2), as on macOS:
  a physical release ends an injected hold and an injected release ends a physical hold.
- With two onPC displays, `display_index` had **no observed effect** on key routing, text focus, Escape or
  pop-up placement (M1–M4), as on macOS. The bridge must not claim display targeting on Windows either.
- Escape closed the dialog without clearing its pending text (M3); clearing took a second Escape. This matches
  the recovery note that Escape changes UI and command state and is not a cleanup step.

Not covered on Windows: non-US layouts, remap/disable during a hold, Quickeys, Freeze.

Cleanup: command line empty, dialogs and pop-ups closed, MASTATE false, selection empty, environment Normal,
shortcuts on.
