# Multi-token `CLAUDE_BIN_PREFIX_ARG`

The middleware does not support a multi-token form of `CLAUDE_BIN_PREFIX_ARG` (no JSON-array variant, no whitespace-splitting variant). Only one prefix arg is accepted, by design.

## Why this is out of scope

`src/claude-runner.ts` exposes two env hooks for substituting the `claude` binary in tests and production:

- `CLAUDE_BIN` — replaces the executable path (e.g. `node` instead of `claude`).
- `CLAUDE_BIN_PREFIX_ARG` — a **single** argv element inserted ahead of the runner's own args (e.g. a path to a hang-forever fixture script).

The single-arg constraint is intentional and documented inline at `src/claude-runner.ts:186-189`:

```ts
// Only ONE prefix arg is supported (singular by name). Multi-token wrappers
// like `node --loader tsx ./wrapper.js` should be packaged into a shell
// script and pointed at via CLAUDE_BIN itself — splitting on whitespace
// here would surprise wrappers whose own args contain spaces.
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_BIN_PREFIX_ARGS = process.env.CLAUDE_BIN_PREFIX_ARG
  ? [process.env.CLAUDE_BIN_PREFIX_ARG]
  : [];
```

The standard Unix-idiomatic answer for multi-token wrapping is a shell script:

```bash
# /usr/local/bin/claude-wrapper.sh
#!/usr/bin/env bash
exec node --loader tsx /opt/claude-wrapper.js "$@"
```

```bash
CLAUDE_BIN=/usr/local/bin/claude-wrapper.sh  # done.
```

This composes cleanly, keeps wrapper concerns out of the middleware's env contract, and avoids the foot-guns of an in-process multi-token form (whitespace splitting that misbehaves on quoted args; a JSON-array variant with a parse-error fallback path that has to be documented and tested).

## Why we're not adding `CLAUDE_BIN_PREFIX_ARGS_JSON`

A JSON-array variant was proposed in #24 to skip the wrapper-script step. Rejected because:

- **No production deployment hits the limitation today.** The two test fixtures (`scripts/test-cancel-turn.ts`, `scripts/test-side-session-queue.ts`) use a single hang-script path and work fine. The proposal explicitly framed itself as *"if/when production needs multi-token wrappers"* — speculative, no forcing function.
- **Permanent surface area for a hypothetical scenario.** Three valid states (set+valid / set+invalid / unset), one precedence rule over `CLAUDE_BIN_PREFIX_ARG`, one warn-and-degrade path on parse failure. All of that has to live in code, in `.env.example`, in the comment block, and in the maintainer's head — for a problem that doesn't exist.
- **The workaround is two lines of bash.** Asking deployers to write a wrapper script when they need multi-token composition is the right cost trade.
- **Project philosophy.** `CLAUDE.md` is explicit: *"Don't add features, refactor, or introduce abstractions beyond what the task requires. Don't design for hypothetical future requirements."*

## When to revisit

If a real production deployment hits the multi-token need and the wrapper-script workaround is genuinely insufficient (e.g. the wrapper itself needs to vary per-channel and a shell script can't capture that), reopen with the actual deployment as the forcing function. The implementation is small whenever it's actually needed.

## Prior requests

- #24 — "Enhancement: support multi-token CLAUDE_BIN_PREFIX_ARGS_JSON"
