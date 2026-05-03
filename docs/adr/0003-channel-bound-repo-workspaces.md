# ADR-0003: Discord channels bind 1:1 to a repo workspace

**Status:** Accepted — 2026-05-02
**Related:** `src/claude-runner.ts` (`CWD`, `SPAWN_OPTS`, `Session`, `createSession`, `resumeWithPrompt`, `loadSessions`), `src/bot-instance.ts` (session-create path), `src/qwen-harness.ts`, `src/discord-bot.ts`, `sessions.json`, CONTEXT.md → "Session"

## Context

The middleware spawns a `claude -p --resume <id>` subprocess per Discord channel session, with cwd hard-coded at module load via `process.env.CLAUDE_CWD` (`src/claude-runner.ts:121`). That single global cwd was acceptable while the middleware served exactly one repo (dcc).

The skill suite (`/triage`, `/tdd`, `/to-issues`, `/to-prd`, `/self-review`, `/dispatch`, `/resolve-reviews`, `/grill-me`, `/diagnose`, `/improve-codebase-architecture`, `setup-workflow`, …) assumes cwd **is** the target repo. The skills read repo-relative config (`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`, `CONTEXT.md`, `docs/adr/`), drive `git`/`gh`/`glab` against the cwd, write files relative to it, and create branches in it. There is no in-skill mechanism to retarget a different repo per invocation.

Once the middleware needed to serve multiple repos from one host (`dcc`, `agent-middleware`, `dcc-canon-rag`, …) under `--permission-mode bypassPermissions` and per-skill `--posture auto` (no human-in-the-loop friction), the single global cwd became the central correctness risk: a workflow command issued in any channel would silently target whichever repo the middleware had been booted against, regardless of the operator's intent.

## Decision

**Each Discord channel is bound to exactly one repo on disk. Every Claude (and Qwen) subprocess for that channel spawns with that repo as its cwd. Workflow skills work transparently because cwd is correct.**

The binding is administered, durable, and never mutated from inside Discord.

### Source of truth

A committed `channels.json` at the middleware repo root, keyed on Discord channel name (which by operator commitment equals the repo name and is never renamed):

```jsonc
{
  "agent-middleware": {
    "path": "/mnt/c/dev/agent-middleware",
    "channelId": "1500174751111446680"   // informational; not used in lookup
  },
  "dcc":              { "path": "/mnt/c/dev/dcc" },
  "dcc-canon-rag":    { "path": "/mnt/c/dev/dcc-canon-rag" }
}
```

`channels.json` is the only trust boundary. A channel name not present in the map is unbound; workflow commands in it refuse loudly. Adding a repo is a deliberate two-step act: create the Discord channel with the repo's name, then add the entry to `channels.json`.

### Transport

`Session` (in `claude-runner.ts`) and `PersistedSession` both gain a `repoName: string` field. `SPAWN_OPTS.cwd` becomes a per-spawn lookup against an allowlist loaded once at boot:

```ts
const REPO_PATHS: Record<string, string> = loadChannelsConfig();

function spawnOpts(repoName: string): SpawnOptions {
  const cwd = REPO_PATHS[repoName];
  if (!cwd) throw new Error(`unbound repo: ${repoName}`);
  return { ...SPAWN_OPTS_BASE, cwd };
}

// every spawn site:
spawn("claude", args, spawnOpts(session.repoName));
```

Resolution happens once, at session create, in `bot-instance.ts`. The session-create handler reads `message.channel.name`, looks it up in `REPO_PATHS`, and either calls `createSession(prompt, ..., { repoName })` or replies with a refusal listing the configured channels.

`loadSessions()` validates each persisted `repoName` against the current allowlist. Sessions whose repo is no longer configured are marked `error` with a clear reason rather than resumed silently against a stale or missing path.

### Qwen parity

`qwen-harness.ts` mirrors the same plumbing: its session struct gains `repoName`; Qwen's file-touching tools and `createSessionAndAwait` (the `ask_claudecode` bridge) thread it through. A Qwen session bound to repo A always spawns its delegated Claude subprocess in repo A.

### Inheritance and edges

- **`/btw` side sessions** inherit the parent channel's `repoName`. (Already mostly aligned with ADR-0002 — side sessions share `cwd` with the parent.)
- **Threads** inherit the parent channel's `repoName`. No re-binding inside a thread.
- **DMs to ClaudeCode and Qwen** are repo-less by default. Workflow skills refuse with `"DMs are repo-less. Use a #<repo> channel for workflow commands."` Repo-agnostic skills (`/grill-me`, `/score`, `/update-config`, `/keybindings-help`, `/schedule`, `/loop` itself) work fine — they don't read repo-relative config.
- **`/schedule` and `/loop`** capture `repoName` at scheduling time and fire with it. Re-resolving on fire is rejected: it would mean "this scheduled job binds to whichever repo the channel is mapped to *now*", which is fine while binding is stable but turns into a silent target shift if it ever isn't. Capture-at-schedule is robust under any future weakening of the never-rename commitment.

### What `setup-workflow` is and isn't

`setup-workflow` is a per-repo bootstrap that writes `docs/agents/{issue-tracker,triage-labels,domain}.md` and an `## Agent skills` block in `CLAUDE.md`/`AGENTS.md`. It is a prerequisite for the workflow skills, but **the bot does not gate on it**. Skills already degrade with clear errors when their config files are missing; adding a bot-side gate would duplicate that and couple the bot to skill internals.

If a repo hasn't been through `setup-workflow`, the first workflow command in its channel will surface the missing-config error from the skill itself. The operator runs `/setup-workflow`, the files appear, subsequent commands succeed.

## Alternatives considered

- **(B) Channel ID as the lookup key.** Rejected. IDs are immutable Discord snowflakes, which is theoretically safer (a rename can't break the binding), but the operator commits to never renaming channels, and ID-keyed `channels.json` is opaque — entries can't be inspected without cross-referencing Discord. Name-keyed config is human-readable, matches the channel as displayed in the sidebar / mentions / breadcrumbs, and the configured channel name doubles as drift detection: `bot-instance.ts` warns if `message.channel.name` ever stops matching its config. Channel ID is captured in the config as informational metadata.
- **(C) Channel topic (`repo: dcc`) as the binding.** Rejected. Topic is metadata built for things that change ("currently discussing X"); identity is the right shape for "this binding never changes". Topic edits are silent, low-friction, and don't show in the sidebar — wrong fit for an admin act that should be deliberate and visible.
- **(D) One middleware process per repo, each with its own `CLAUDE_CWD`.** Rejected. Zero runner code change but multiplies operational cost (N systemd units, port allocation, restart story) and forces N separate canon-commit + self-restart machineries. Self-restart's `expectingRestart` debounce is per-process; canon-worktree contention across processes is real if multiple repos commit canon. The runner change to support per-spawn cwd is small (~80–120 lines); operational cost of N processes is permanent.
- **(E) Single cwd, refuse workflow skills outside the bound channel.** Rejected. Equivalent to "one repo per machine" plus a polite error. The whole point is to serve multiple repos from one host.
- **(F) Per-message `[repo: agent-middleware]` override directive.** Rejected. Reintroduces a mutable side door — the contract becomes "channel-pinned **except when it isn't**". Undermines the never-changes invariant and creates a new failure mode (wrong override under load).
- **(G) Persist absolute `repoPath` on `Session` instead of symbolic `repoName`.** Rejected. Sessions describe conversations, not disk paths. Persisting `repoName` keeps `channels.json` as the single source of truth, makes drift detection trivial in `loadSessions()`, and decouples the session record from disk layout.

## Consequences

**Positive.**
- Workflow skills work in every channel without per-invocation disambiguation. The skill suite never has to know about Discord.
- Wrong-repo commits cannot happen by accident: a misnamed channel is unbound, refused; a correctly-named channel resolves to exactly one path.
- Multi-model parity. Claude, Qwen, and (when integrated) NemoClaw all read the same `repoName` from the same `Session` shape.
- `channels.json` is grep-able, diff-able, code-reviewed. Onboarding a new repo is one channel + one config entry.
- `/btw`, threads, `/schedule`, and `/loop` all inherit cleanly without special-casing.

**Negative.**
- Renaming a Discord channel breaks its binding. Operator commits to not doing this; if they ever do, persisted sessions error loudly on next message rather than silently corrupting.
- `channels.json` is committed config — adding a repo requires a redeploy/restart unless a `/api/middleware/reload-channels` endpoint is added later.
- Qwen harness must be plumbed in lockstep. Diverging Claude/Qwen session shapes here would resurrect the silent-wrong-target risk on the Qwen path.
- The mixed-history `#general`-style channel this conversation has been happening in needs a one-time disposition (see Follow-ups).

**Neutral.**
- The `bypassPermissions` + per-skill `auto` posture stays as is. The safety story for "wrong target" no longer relies on human-in-the-loop friction; it relies on the channel→repo binding being correct and durable.
- `process.env.CLAUDE_CWD` becomes a fallback / dev-only default. Production reads `channels.json`.

## Follow-ups

- **Q5 — disposition of the existing mixed-history channel.** This conversation is happening in a channel with a year of mixed dcc / agent-middleware / canon-rag / pure-infra history. One-time operator choice (track in a separate issue):
  - **(a)** Rename the existing channel to `#dcc` and pin it to `~/dcc`; create `#agent-middleware`, `#dcc-canon-rag` siblings. Preserves muscle memory; the year of mixed history becomes a harmless lie about the past.
  - **(b)** Keep the existing channel as `#general`/`#lab`, unbound, refusing workflow commands. Cleanest model. Most consistent with the never-changes invariant.
  - Option (c) (per-message override) is rejected by this ADR.
- **Implementation slices** (suggested split when this is picked up):
  1. `channels.json` + `loadChannelsConfig()` + `REPO_PATHS` map. No behavior change yet.
  2. `Session.repoName` + `PersistedSession.repoName` + `spawnOpts(repoName)`. Threaded through `createSession`, `resumeWithPrompt`, `createSessionAndAwait`. Default to `process.env.CLAUDE_CWD`'s repo name during transition.
  3. `bot-instance.ts` resolution + refusal path on unbound channels.
  4. `loadSessions()` validation against current allowlist; orphan sessions → `status: "error"`.
  5. `qwen-harness.ts` mirror.
  6. Drop the `CLAUDE_CWD` default once all channels are bound.
- **Optional `/api/middleware/reload-channels`.** Hot-reload `channels.json` without process restart. Cheap to add; defer until a second repo gets onboarded and the restart cost is felt.
- **Drift detection.** When `message.channel.name !== config.entry.name` for the matched ID, log a warning. Useful canary even though renames are forbidden by operator commitment.
