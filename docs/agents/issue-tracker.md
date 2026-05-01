# Issue tracker: GitHub

> **Why this file exists.** The engineering skills (`/to-prd`, `/to-issues`, `/triage`) consult this file to know how to create, read, comment on, and label issues in your tracker. Without it, those skills can't act on issues at all.
>
> **Who reads it.** Every Claude session that runs an issue-related skill in this repo. The file is durable — it lives in your repo, not in a Claude session.
>
> **What to change later.** Add or adjust CLI patterns below if your repo has special conventions (issue templates, required labels, branch-naming rules). Rerun `/setup-workflow` if you switch trackers entirely.

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
