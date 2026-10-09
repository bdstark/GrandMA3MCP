# Accessibility

GrandMA3MCP aims to make its documentation and programmatic interfaces usable by people with different
abilities and ways of working. Accessibility is relevant even though this repository does not provide
a graphical application of its own.

This is a statement of intent and contribution guidance, not a claim of conformance to an accessibility
standard. No formal accessibility audit or comprehensive assistive-technology testing has been completed.
The platform compatibility matrix records functional tests, not accessibility certification.

## What this project controls

The project controls its documentation, setup examples, MCP tool descriptions and responses, bridge
protocol and reusable Lua modules. The interface that presents these to a person is usually an MCP client,
a terminal, grandMA3 onPC or an independently developed control surface. Accessibility in those products
also affects the complete workflow and cannot be guaranteed by this repository.

Console keyboard injection is an automation capability, not evidence that the console is fully keyboard
accessible or a substitute for assistive technology. It can depend on focus, keyboard layout and the
operator's shortcut profile. Do not assume that an automated key sequence reached the intended control.

## Guidance for contributions

- Write clear instructions with descriptive headings and link text. Expand unfamiliar abbreviations and
  explain actionable errors in plain language.
- Keep commands and configuration examples available as selectable text. Include text explanations of
  important screenshots and diagrams; provide meaningful alternative text when adding images.
- Do not rely on color, icons, position or visual formatting alone to communicate status or required steps.
  For example, state “release unresolved” rather than communicating failure only through a colored indicator.
- Preserve useful structured results alongside readable explanations. Distinguish success, failure,
  uncertainty and unavailable data so clients can present them in different ways.
- Describe any focus, timing, shortcut, layout or display assumptions in interactive workflows. Where
  existing structured operations support the task, document them as an alternative to simulated input.
- When adding a user-facing interface or example, consider keyboard navigation, accessible names and
  nonvisual status feedback. Record what was actually tested and any known limitations.

The existing input limits, ownership and cleanup rules still apply. Do not weaken them to provide an
alternative interaction method. Discuss changes to those rules through the normal contribution process.

## Report an accessibility barrier

Use the [bug report template](https://github.com/bdstark/GrandMA3MCP/issues/new?template=bug_report.md)
for an existing barrier or the
[feature request template](https://github.com/bdstark/GrandMA3MCP/issues/new?template=feature_request.md)
for a proposed improvement. If the issue form itself is a barrier, or you prefer a private report, email
**[bdstark@gmail.com](mailto:bdstark@gmail.com)** with the subject `GrandMA3MCP accessibility`.

Describe the task you were trying to complete, where you encountered the barrier, what happened and what
would help. If relevant and comfortable to share, include the operating system, client, assistive
technology and versions used. You do not need to disclose a disability, diagnosis or other medical
information. Remove private show data, credentials and identifying information from examples.

Reports are reviewed on a best-effort basis without a guaranteed response or fix time. If a barrier is in
a third-party client or grandMA3, the maintainer may help identify that boundary or suggest a workaround;
fixes to those products depend on their maintainers. Accessibility reports that also expose a security
vulnerability should follow the [private security reporting process](SECURITY.md).
