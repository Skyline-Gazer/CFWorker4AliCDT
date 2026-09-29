# Contributor and Codex guidance

## Repository layout

- src/ contains the Worker entry point, config parsing, Alibaba APIs, scheduled control pipeline, storage, notifications, and HTTP routing.
- static/ contains the dashboard HTML and fixed public bundle assets.
- migrations/ contains D1 schema migrations.
- scripts/ contains deployment config generation and production-health helpers.
- test/ contains offline Vitest coverage. Documentation consistency checks are under test/docs/.
- docs/operations/ contains current operator guides. Historical plans, reviews, and release packets are labeled at their top.
- .github/workflows/ contains CI, owner-gated deployment, secret installation, and monitoring workflows.

## Local validation and review

Run npm run validate before handing off code or documentation changes. It includes format:check, lint, typecheck, the offline test suite, and deploy:dry-run. npm test includes the documentation governance checks.

The .github/workflows/ci.yml workflow runs format, lint, typecheck, and tests without production credentials or deployment authority. Review any behavior or security claims against source and tests. Update the canonical operation guide when route, binding, deployment, or monitoring behavior changes; prefer a link over repeating long procedures.

## Production boundaries

The scheduled Cron path is the only ECS mutation authority. HTTP query and monitoring routes are read-only. Keep MONITOR_READ_TOKEN separate from ADMIN_TOKEN. Never print or place secret values in argv, logs, documentation, issues, or committed files.

Do not run PRE-FLIGHT, RELEASE, UPDATE, or install-monitor-read-token.yml from local work. Do not mutate Cloudflare, Alibaba IAM, ECS, or remote D1 as part of repository implementation or validation. The validation command uses a local Wrangler dry-run.

## Codex execution policy for this repository

- Use the local Codex CLI with model gpt-6-luna. Cloud Agent execution is disabled; do not propose or launch it.
- Do not mutate production services, secrets, IAM, ECS, Cron, or remote D1.
- Prefer leaving a reviewable worktree diff without committing or pushing.
- If a commit is explicitly requested, use a Refs #<issue> trailer style. Do not use closes, fixes, or resolves issue keywords in commit messages.
