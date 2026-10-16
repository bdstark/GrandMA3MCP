# SU-20 probe: saving the show (macOS, onPC 2.5.1)

Evidence for [SU-20 in SETUP.md](../../SETUP.md#su-20--save-the-show).

- **Date:** 2026-10-16
- **Platform:** macOS (Darwin 25.5), grandMA3 onPC 2.5.1.0, bridge 0.34.0, then 0.35.0
- **Method:**
  - the bridge's `lua` op;
  - SaveShow queued with `CmdIndirect`;
  - the top modal read with `GetTopModal` and a walk of its UI children;
  - buttons clicked with `Mouse` at their `AbsRect` centre (KB-25).
- **Show files:** with the user's approval, the working show (`NewShow_2026.10.15_23.16.24UTC`) was saved as
  `mcp-save-probe-1` and `mcp-save-probe-2`, and later `mcp-save-live-1`. At the end it was saved back under its own
  name. The scratch files remain in the shows folder.

## The shows folder

| Read | Result |
| --- | --- |
| `GetPath(Enums.PathType.Showfiles)` | `~/MALightingTechnology/gma3_2.5.1/shared/shows` (also DemoShowfiles, TemplateShowfiles) |
| `DirList(path, "*.show")` | a table of `{name, size, time}`, the same 6 files and sizes as `ls` |
| `Root().MANetSocket:Get("ShowFile")` | the current show's name, without `.show` |
| DirList `time` | the local wall-clock time as if it were UTC: a file written at 04:22:45 MDT (epoch 1792146165) reads 1792124565, exactly 6 h earlier |

The UTC offset needs care: `os.date("!*t")` returns `isdst = false`, which `os.time` reads as standard time (MST, 7 h).
With the local DST flag carried over, the corrected time matched the file's `stat` time to the second.

## SaveShow

| Command (CmdIndirect) | Dialog | After OK |
| --- | --- | --- |
| `SaveShow "mcp-save-probe-1"` (new name) | MessageBox "Change show file name?" / "Do you intend to change the show file name to 'mcp-save-probe-1'?", OK / Cancel, display 1 | the file is written within ~30 ms of the click, and the current show is `mcp-save-probe-1` |
| `SaveShow "mcp-save-probe-2"` (new name) | the same dialog | the same |
| `SaveShow` (current name) | none | the file is rewritten (new time, size 1315066) |
| `SaveShow "mcp-save-probe-1"` (another existing file) | "Change show file name and overwrite existing show file?" / "You are going to change the show file name and overwrite the file with the name 'mcp-save-probe-1' that already exists. Do you want to continue ?", OK / Cancel | Cancel: nothing is written; the current show is unchanged |

The bridge kept answering throughout, since CmdIndirect lands on a later frame and the dialog never opened on the
plugin thread.

## Live test

`test/live/save-show.live.ts`, 4/4 with bridge 0.35.0 (needs `GMA3_LIVE_EXCLUSIVE=1` and `GMA3_LIVE_SAVE=1`;
`GMA3_LIVE_SAVE_RESTORE` names the show to end on):
- saved as `mcp-save-live-1` (1318492 bytes), with the rename dialog answered;
- saved under the current name with no dialog and a newer time;
- `NewShow_2026.10.15_23.16.24UTC` was refused without `overwrite`, and its file stayed untouched;
- saved back as `NewShow_2026.10.15_23.16.24UTC` with `overwrite: true` (the overwrite dialog answered), which is
  current again.

`smoke.live.ts` passed afterwards on the restored show.
