# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project does not yet ship versioned releases; everything sits under
`[Unreleased]` until a tag exists.

## [Unreleased]

### Added

- `/btw` channel slash-command — parallel side-session for "btw, quick question"
  interjections without dropping the main turn. Capped at one in-flight per
  channel; queued via FIFO with ⏳ reaction. ADR-0005. (#17)
- `/cancel` and `/end` channel slash-commands — Ctrl+C / Ctrl+D analogs for the
  channel's in-flight Claude turn. (#16)
- Channel transcript foundation — per-channel MemPalace drawer set in
  `wing="conversation"`, `room=<channelId>`. Each Discord message in a watched
  channel becomes a drawer at write time; capped at 500 messages with
  drop-oldest-on-write. Activity-bounded retention. ADR-0002, ADR-0004. (#11)
- Hard wire cap (30 000 tokens) with explicit per-component system-prompt
  budget (8 000 tokens, sub-allocated). Pre-flight `validateWireBudget` rejects
  over-budget requests instead of letting vLLM 400. ADR-0003. (#12)
- Persona startup-validation — fail-fast on over-budget personas at load time.
  (#9)
- Oversized-turn handling at the Discord routing layer — single human user
  message > `TURN_BUDGET` is rejected with chunk-or-attach feedback; bot
  messages are silently truncated with a one-line warning. (#10)
- MemPalace failure-mode warning — in-channel notice emitted once per outage
  when the palace is unreachable, so users know recall is degraded. (#28)

### Changed

- Wire-budget constants extracted into a shared module so the persona,
  pre-flight, and compression paths import from a single source. (#29)
- MemPalace deploy artifacts (api-server, deploy script, MCP proxy) relocated
  from `dcc` into this repo at `tools/mempalace/`. The corpus-mining script
  remains in `dcc/tools/mempalace/` because it's coupled to dcc's content
  layout. ADR-0006. (#21)
- ADR-0002 renumbered to ADR-0005 to resolve a numbering collision. (#19)
