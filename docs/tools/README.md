# Workflow and inspection tools

Per-area documentation for the tools built on the shared result model (see "Workflow tools" in the top-level
README). Each page lists the tool parameters, the exact bridge requests and console commands sent and their
order, whether the tool changes the selection or programmer, what read-back verifies and what it cannot, and
the live test procedure on a disposable show.

| Area | Tools | Page |
| --- | --- | --- |
| Fixture programming (FR-03) | `gma3_select`, `gma3_set_attribute`, `gma3_set_color`, `gma3_set_position`, `gma3_clear_programmer` | [fixtures.md](fixtures.md) |
| Cue storage and editing (FR-04, FR-05) | `gma3_store_cue`, `gma3_store_cue_part`, `gma3_set_cue_timing`, `gma3_set_cue_trigger`, `gma3_goto_cue`, `gma3_delete_cue` | [cues.md](cues.md) |
| Executors (FR-06) | `gma3_assign_to_executor`, `gma3_label_executor` | [executors.md](executors.md) |
| Structured inspection (FR-07 .. FR-10) | `gma3_fixture_attributes`, `gma3_programmer`, `gma3_fixture_output`, `gma3_dmx`, `gma3_cue_contents` | [inspection.md](inspection.md) |

`AGENT-RULES.md` records the implementation rules every area follows (bridge-only, no retries, shared
validation and result helpers, serialised mutations, documentation and test requirements).

## Serialisation caveat (applies to every mutating tool)

Mutations issued by this MCP server run one at a time through a single lock, so a multi-command workflow is
not interleaved with another tool call from the same server. A workflow holds the lock from its first command
through its read-back, and `gma3_lua` requests take the same lock because a script may call `Cmd()` or
`Set()`. The lock orders only this process's requests. It does not stop another console operator, another MCP
server or client, or a macro from changing the selection or programmer between two commands. Treat every
result's `verification` field as the source of truth, not the lock.
