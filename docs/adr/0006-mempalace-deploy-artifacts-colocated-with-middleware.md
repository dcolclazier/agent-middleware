# ADR-0006: MemPalace deploy artifacts colocated with middleware

**Status:** Accepted — 2026-05-02

## Context

MemPalace is the shared cross-agent memory service that runs on Spark #2 at `:8100`. Its deploy artifacts (`api-server.py`, `deploy-to-spark.sh`, `mcp-proxy.py`, README) historically lived in `dcolclazier/dcc` at `tools/mempalace/` because that's where the user happened to be working when MemPalace was introduced.

That placement was incidental, not architectural. After ADR-0001 extracted middleware out of `dcc`, the MemPalace deploy artifacts should have followed — they have no coupling to the Unity game project, but heavy coupling to this middleware's `mempalace-client.ts` and to the operational concerns this repo already owns (Spark deploy, systemd, cross-agent infrastructure). Leaving them in `dcc` produced surface-area drift: pin bumps, hook fixes, and protocol changes had to land in a repo whose reviewers and CI know nothing about MemPalace.

A patch-bump exercise on 2026-05-02 (3.3.1 → 3.3.4) made the smell concrete — the pin lived in three places in `dcc/tools/mempalace/`, but the only consumer that actually cared about the version was this repo's HTTP client.

## Decision

Move `api-server.py`, `deploy-to-spark.sh`, `mcp-proxy.py`, and `README.md` to `agent-middleware/tools/mempalace/`. Leave `mine-training-data.sh` in `dcc/tools/mempalace/`.

The split is deliberate: `mine-training-data.sh` rsyncs `dcc/SPARK/training_data_truth/` and runs `mempalace mine` against it. It is intrinsically coupled to `dcc`'s content layout — when `dcc` reorganizes its training corpus, that script changes. The mining surface belongs with the corpus it mines; the deploy surface belongs with the middleware it serves.

## Consequences

- Pin bumps and operational fixes land in this repo's review flow. Future grep-for-mempalace searches in `agent-middleware` find the deploy story instead of finding nothing.
- Two places to look when chasing a MemPalace bug: `agent-middleware/tools/mempalace/` for serving and `dcc/tools/mempalace/mine-training-data.sh` for ingestion. Documented at the top of the README in each.
- `mempalace-client.ts` is unaffected — it only speaks HTTP to `MEMPALACE_URL`.
- The Spark venv at `~/mempalace/.venv/` and palace data at `~/mempalace/palace/` are unchanged by this move; only the deploy-script source location changes.

## Alternatives considered

- **Keep everything in `dcc`.** Simplest, but doubles down on the incidental placement and forces every MemPalace change to ship through a repo whose reviewers don't own MemPalace.
- **Move everything (including `mine-training-data.sh`) to `agent-middleware`.** Cleaner conceptual home, but the mining script would then need to either ssh into a `dcc` checkout or hardcode paths into `dcc`. Both approaches push complexity uphill to avoid a small split that is honestly described.
- **Move everything to a third repo `mempalace-ops`.** Overkill for ~four files; would inflate the deploy story across three repos for marginal isolation.
