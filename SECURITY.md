# Security policy

## Report a vulnerability privately

Use GitHub's **[Report a vulnerability](https://github.com/bdstark/GrandMA3MCP/security/advisories/new)**
to submit a private report. Private vulnerability reporting is enabled for this repository.

If you cannot use GitHub private reporting, email the maintainer at
**[bdstark@gmail.com](mailto:bdstark@gmail.com)** with the subject `GrandMA3MCP security report`.
Do not post exploit details in public issues, pull requests or discussions before the maintainer has
had an opportunity to assess the report and coordinate disclosure.

Include:

- Affected commit and component versions, including a module pin if you vendor the Lua modules.
- Platform, exact grandMA3 version, client/consumer and deployment topology.
- Required access and settings, a minimal reproduction, expected versus actual behavior, and impact.
- Sanitized logs or a small proof of concept, plus any mitigation you have verified.

Do not send credentials, customer show files or proprietary console files. Initial reports can describe
sensitive evidence without attaching it; coordinate a suitable way to share it. Test only systems you
own or are authorized to test, using a disposable show disconnected from production output.

Reports and fixes are handled on a best-effort basis. There is no guaranteed response or remediation
time, bounty program or commitment to backport fixes. If you have not received a response, follow up
privately. Coordinate the timing and content of public disclosure with the maintainer where possible.
Ordinary bugs and feature requests belong in [GitHub issues](https://github.com/bdstark/GrandMA3MCP/issues).

## Versions and downstream consumers

The current beta development line is `main`; security fixes target that line. Older commits, copied Lua
modules and forks do not receive automatic fixes. Include the exact revision in a report even if you
cannot reproduce on current `main`. The [compatibility matrix](docs/compatibility.md) records testing
coverage, not a security certification or a promise of version support.

Independent consumers should track upstream fixes and deliberately update their
[pinned modules](docs/modules.md#vendoring-into-another-plugin-mtpnxk). A matching hash proves that the
file matches the selected revision; it does not prove that revision has no vulnerabilities.

## Trust boundaries and deployment assumptions

The bridge accepts loopback TCP connections and has **no authentication**. Any process able to reach
that listener, including other local users' processes, can use its enabled operations. Loopback is not
per-user isolation. Do not expose the listener through public port mappings, LAN relays or router
forwarding. For remote use, follow the [SSH guide](docs/remote-access.md), restrict SSH access to trusted
operators, and keep the forwarded listener on loopback. OSC is a separate optional control path and is
not protected or forwarded by that SSH tunnel.

Treat MCP clients, independent module consumers and other processes with access as trusted console
operators. Normal command and workflow tools can change show data and playback; commands may also
perform file operations. Disabling arbitrary Lua does not turn the server into a read-only service.
Input ownership coordinates participating clients within an instance; it is not authentication or a
lock against physical operators or independent plugin instances.

Arbitrary Lua and console input are off by default and require an operator's explicit opt-in. Enabled
Lua has access to the console API and real `io`/`os` facilities. Its execution budget is a best-effort
runaway-script limit, **not a sandbox or reliable cancellation mechanism**. A client timeout does not
cancel execution, and blocking console calls can stall the plugin. See the [Lua policy](docs/lua.md).

These documented capabilities are intentional. Reports of bypassing the opt-in gates, accepting
non-loopback peers, unintended file access, ownership/isolation failures or malformed requests causing
unexpected behavior are still welcome. Include the access and configuration required so the impact
can be assessed against the actual trust boundary.

If you suspect active misuse, stop the bridge and affected client connections, disable any exposed
forwarding, and inspect the console's input and show state before resuming operation. Do not replay
uncertain commands as a recovery step. Preserve sanitized evidence for a private report.
