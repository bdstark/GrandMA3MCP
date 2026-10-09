# Contributing

Please follow the [code of conduct](CODE_OF_CONDUCT.md) in all project interactions.

Contributions are welcome: bug reports, documentation corrections, platform test results and focused
code changes. This is an independent beta project; consult the [compatibility matrix](docs/compatibility.md)
for what has actually been tested. For suspected vulnerabilities, use [private security reporting](SECURITY.md)
instead of a public issue or pull request.

## Report a bug or propose a feature

Open a [GitHub issue](https://github.com/bdstark/GrandMA3MCP/issues). For bugs, include:

- Repository commit, server and plugin versions; include module versions or the vendoring manifest for
  independent consumers.
- Operating system, Node.js version, exact grandMA3 version, MCP client or consuming plugin, and whether
  the connection is native, Docker or SSH.
- Minimal reproduction, expected behavior, observed behavior and sanitized errors or logs. For input
  problems, also include keyboard layout, shortcut profile, display setup, backend and relevant opt-in settings.
- Whether the result came from a fake backend, automated tests or a live console. Describe any uncertain
  dispatch, partial sequence or unresolved held key without automatically retrying it.

Remove credentials, private paths and identifying show data. Use a small synthetic example instead of
uploading a production show or proprietary MA Lighting files. For larger features or changes to protocol,
ownership or module boundaries, discuss the proposed behavior and acceptance criteria in an issue first.
State whether a Lua change is needed and why; prefer the existing structured operations when they suffice.

## Set up and check a change

Fork the repository, create a branch from current `main`, and install Node.js 22 and a stock Lua 5.4+
interpreter. Node 20 and 22 are the current CI matrix. From the repository root:

```sh
npm ci
npm run build
npm test
npm run coverage
```

`npm test` includes the three Lua harnesses when `lua5.4`, `lua54` or a compatible `lua` is on PATH.
Check the output: skipped Lua harnesses are not a full pass for a plugin or module change. Install Lua
and rerun them before claiming that validation. Coverage reports measure TypeScript, not Lua.
See [development](docs/development.md) for test locations and what each suite exercises.

Add focused regression tests for changed behavior. Exercise relevant failure paths as well as success:
validation before dispatch, disconnects/timeouts after dispatch, partial execution, cleanup, and ownership
recovery. Keep tests independent of a console where possible. Documentation-only changes need valid links
and accurate examples; they do not require unrelated live tests. Explain any checks you could not run.

Live testing is separate and optional unless needed to substantiate console behavior. Use the
[live test procedure](test/live/README.md), its reserved object ranges and a disposable show, with no live
output driving a production rig. Input probes press real keys and have their own prerequisites. Never
weaken their gates to make a test pass. Record the exact commit, platform, console version, profile,
displays, procedure and observed results; distinguish untested cases from failures. Update the
[compatibility matrix](docs/compatibility.md) only as far as that evidence supports.

## Preserve the integration boundaries

- Keep the bridge loopback-only. Input and arbitrary Lua remain separate, explicit operator opt-ins.
- Preserve the outcome model: a timeout or error after dispatch does not prove nothing happened. Do not
  automatically replay a mutation or fall back to another transport after uncertain delivery.
- Keep input ownership, mutation exclusion, stored release tuples and unresolved cleanup records intact.
  New paths must respect the same admission and recovery rules.
- Keep `gma3_mcp_hardkeys.lua` and `gma3_mcp_feedback.lua` usable without the bridge or MCP server.
  Follow the [module contract](docs/modules.md): instance-local state, injected dependencies, no console
  reads at chunk load, and bounded work through the consumer's service loop. Independent module instances
  do not arbitrate each other's console input.
- Update the tool/protocol documentation and consumers together when changing schemas or semantics.
  Explain compatibility and migration for API changes. Treat module API versions and implementation
  versions separately, and preserve the explicit distinction between unavailable data and a real zero.
- Keep vendor pins immutable. When publishing a new recommended module pair, follow the
  [vendoring procedure](docs/modules.md#vendoring-into-another-plugin-mtpnxk), including hashes of the exact
  files at an existing commit. Do not point a manifest at a future commit or silently relabel changed bytes.

## Submit a pull request

Describe the concrete problem, resulting behavior, relevant tests and any limitations or compatibility
changes. Link the issue or acceptance criteria where available. Include live evidence when the change
relies on undocumented console behavior, or explicitly state that it remains unverified. Keep generated
build output, local configuration, secrets and production show data out of the patch.

Keep changes focused and follow the surrounding TypeScript and Lua style. Update affected setup guides,
references and examples. Contributions are provided under the repository's [MIT license](LICENSE); only
submit material you have the right to contribute. Do not copy MA Lighting documentation or proprietary
code into the repository. Review is best effort; a contribution does not imply support for every console
version or deployment.
