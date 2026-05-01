# Triage Labels

> **Why this file exists.** The `/triage` skill processes incoming issues through a five-role state machine (`needs-triage` → `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). It needs to know what *string* in your tracker corresponds to each role. If this mapping is wrong or missing, the skill creates duplicate labels and triage runs break silently.
>
> **Who reads it.** Every Claude session that runs `/triage` in this repo. Also the `/to-issues` skill when assigning initial labels.
>
> **What to change later.** Edit the right-hand column to match labels your team actually uses. If you add a *new* triage role (e.g. `blocked-on-external`), do that here too — but consider whether the existing five roles cover it, since downstream skills only know about those five.

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Canonical role             | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
