# Triage Labels

> **Why this file exists.** The `/triage` skill processes incoming issues through a state machine (`needs-triage` → `needs-info` / `ready-for-agent` / `ready-for-human` / `needs-slicing` / `wontfix`). It needs to know what *string* in your tracker corresponds to each role. If this mapping is wrong or missing, the skill creates duplicate labels and triage runs break silently.
>
> **Who reads it.** Every Claude session that runs `/triage` in this repo. Also the `/to-issues` skill when assigning initial labels.
>
> **What to change later.** Edit the right-hand column to match labels your team actually uses. If you add a *new* triage role (e.g. `blocked-on-external`), do that here too — but consider whether the existing roles cover it, since downstream skills only know about the canonical names listed here.

The skills speak in terms of canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Canonical role             | Label in our tracker | Meaning                                                       |
| -------------------------- | -------------------- | ------------------------------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue                       |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information                      |
| `needs-slicing`            | `needs-slicing`      | Triaged as a PRD; awaiting `/to-issues` to produce slices     |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent                       |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation                                 |
| `wontfix`                  | `wontfix`            | Will not be actioned                                          |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## PRD lifecycle (note on `needs-slicing`)

PRDs are tracker-shaped, not directly implementable. Their lifecycle is:

1. Created → `needs-triage`.
2. Maintainer confirms it's a real PRD → `needs-slicing`. Next action: `/to-issues` against the PRD body to produce vertical-slice issues.
3. After slicing, the PRD's state label is **dropped**. The PRD stays open as a tracker; its progress is implicit in the slices' states. No `tracking` role is needed — slice presence is the signal.
4. When all slices close (or the PRD is abandoned), the PRD itself closes.

Edit the right-hand column to match whatever vocabulary you actually use.
