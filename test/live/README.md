# Live console tests

These tests talk to a real grandMA3 onPC through the running bridge plugin and **modify show
data**. They are never part of `npm test`. Run them on purpose, against a disposable show:

```bash
GMA3_LIVE=1 npm run test:live
```

Guard rails, enforced by `test/live/live.ts`:

* `GMA3_LIVE=1` must be set, otherwise every live test is skipped.
* The loaded show file name must match `GMA3_LIVE_SHOW` (a regular expression, default
  `disposable|mcp[-_ ]?test|scratch`). Load a throwaway show (for example `New Show "mcp-test"`)
  before running; the tests refuse to touch a show whose name does not match.
* Tests only create, change and delete objects in the reserved ranges listed below, and delete
  what they created when they finish. Nothing calls `SaveShow`.

## Show objects the live tests use

| Range | Used by |
| --- | --- |
| Sequence 900–909 and their cues | cue storage, editing, navigation and deletion tests |
| Group 900–902 | fixture selection tests |
| Page 90, executors 90.201–90.215 | executor assignment and labelling tests |
| Fixtures 1–10 (must be patched in the disposable show) | programmer, attribute and output tests |
| Macro 900 | reserved |

Each live test file documents the exact objects it creates at the top of the file.
