# Saving the show (SU-20)

Save the show file from a chat with no shell, without replacing another show's file by accident. Needs bridge
0.35.0.

| Tool | What it does |
| --- | --- |
| `gma3_show_files` | Read-only: the current show, the shows folder, and every `.show` file with its size and time |
| `gma3_save_show` | Save under the current name or a new one; answers SaveShow's own confirmation; reports the file written |

## What the console does (onPC 2.5.1)

From the probe ([su-20-save-show-macos-2.5.1.md](../probes/su-20-save-show-macos-2.5.1.md)):

- **Plain `SaveShow`** under the current name writes at once, with no dialog.
- **`SaveShow "name"`** under a new name asks "Change show file name?" (OK / Cancel). OK writes the file at once, and
  that name becomes the console's current show.
- **Under the name of another existing file**, it asks "Change show file name and overwrite existing show file?".
  Cancel writes nothing.
- **A dialog opened from the plugin thread stalls the bridge**, so the bridge queues SaveShow with `CmdIndirect`,
  which lands on a later frame. The server then polls and answers the dialog. Earlier records warned against
  SaveShow through the bridge: `SaveShow /NoConfirmation` read `/NoConfirmation` as a name and opened the rename
  dialog on the plugin thread.
- **The shows folder** (`GetPath(Enums.PathType.Showfiles)`) is listed with `DirList`. It reports each file's local
  wall-clock time as if it were UTC (6 h off in MDT). The bridge corrects it with the console's UTC offset (`time`)
  and keeps the wall-clock text (`localTime`).

## gma3_show_files

The current show and its file, the folder path, and every file newest first: name, size in bytes, `time` (ISO 8601,
UTC) and `localTime` (the console's wall clock). It includes the open dialog, if any.

## gma3_save_show

| Parameter | Meaning |
| --- | --- |
| `name` | Show name without `.show` (it is dropped if given). Default: the current show. 1-128 characters, no quotes, slashes, `\ : * ? < > |` or control characters, no leading or trailing spaces |
| `overwrite` | Replace another show's existing file with this name (default false: refuse) |
| `timeout_ms` | How long to wait for the save (2000-120000, default 20000) |
| `exclusive` | Required: the file is written and the current show name may change |

Steps:
1. **Read** the files and the current show. The tool refuses when a dialog is already open, when whether one is
   open can't be read (a failed lookup is never "no dialog"), when the current name can't be read, or when the folder
   can't be listed (an existing file could not be ruled out).
2. **Check the name.** The current name is a normal save. A new name expects the rename dialog. Another show's
   existing file expects the overwrite dialog and is refused without `overwrite: true`; the refusal names the
   file's size and time. Names compare case-insensitively, as on macOS and Windows.
3. **Queue** SaveShow. File times have whole seconds, so when the existing file is from the console's current
   second, the tool first waits until the clock has passed it. If the reply to the queue request is lost, the save
   may still run: it is watched, never resent, and never reported as "not queued".
4. **Poll** every 150 ms:
   - the expected dialog is answered with OK only when its message is the one the console shows for this show: "Do
     you intend to change the show file name to '<name>'?" or "You are going to change the show file name and
     overwrite the file with the name '<name>' that already exists. Do you want to continue ?".
     - The text around the name is compared with whitespace collapsed, since it wraps.
     - The name between the first and the last quote is compared exactly, every space and apostrophe kept: "Joe's
       Show" is not "s Show", and "Show  B" (two spaces) is not "Show B".
     - The bridge checks the title and the name again just before it clicks. Any other message is refused;
   - any other dialog stops the tool, including a same-title dialog for another show. It is reported and left for
     the operator, never answered;
   - the save is done when a file this save produced is there (new, or with a later time than before) and the
     console names it current.

   Only the latest read counts. If the last read failed, the tool reads once more. If that fails too, the result
   is `unavailable`, and the earlier read appears only as `lastObserved`.

Verification:
- `matched`: written and current. The result has `file` (name, size, time), `previous` (the current show and the
  file before), `current`, and `dialog` (expected, answered).
- `mismatched`: the file is missing or still has its earlier time, or another show is current.
- `unavailable`: an unexpected dialog, an unreadable dialog state, a lost reply with no write seen, completion that
  could not be observed, or nothing within the timeout.

A new name makes it the current show. The result warns that later saves without a name write the new file.

The bridge answers only SaveShow's own two dialogs (`show.answer` checks the title) and clicks only OK or Cancel.
