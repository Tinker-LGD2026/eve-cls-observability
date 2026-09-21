# Changelog

## 0.2.0 - Unreleased

### Fixed

- Preserve failed and cancelled lifecycle outcomes even when error content capture is disabled.
- Enforce `recordReasoning` for step thoughts and restore the documented production content gate.
- Close unterminated model/tool spans at step-attempt terminal events.
- Keep unknown token usage distinct from a reported zero value.
- Bound session/turn state and avoid retaining raw tool outputs.
- Reject custom telemetry destinations and isolate reserved/global OTLP headers.
- Wait for in-flight CLS uploads during flush/shutdown and isolate optional mirror failures.
- Encode each CLS entry once, drop only oversized entries, and bound retry delays.
- Preserve eve message kinds, support structured system instructions, and ignore stale message cursors.
- Use exact action correlation and attach resumed child spans to the current runtime trace.

### Added

- State-machine, security, exporter lifecycle, message mapping, and protocol regression tests.
- Clean reproducible package build and tarball consumer smoke test.
- CI coverage for Node.js 24 and the supported eve 0.56.x range.
