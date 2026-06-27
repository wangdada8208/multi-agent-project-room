# Roadmap

This file tracks the next development direction after the MVP collaboration
room became usable.

## Now: Stabilization And Acceptance

- [ ] Complete `ACCEPTANCE_CHECKLIST.md` against production.
- [ ] Update `PLAN.md` checkboxes after each verified area.
- [ ] Keep `CLAUDE.md` and `RUNBOOK.md` aligned with production reality.
- [ ] Confirm only one Codex and one Claude adapter are running during demos.

## Next: A2A Reliability

- [x] Add explicit task timeout handling so tasks cannot remain `working`
      forever.
- [ ] Add retry policy for transient A2A delivery failures.
- [ ] Surface failure reasons in the task panel.
- [x] Mark tasks failed quickly when the target agent is offline.
- [x] Add automated coverage for agent-offline and timeout paths.

## Next: Agent State Quality

- [ ] Extend adapter registration to report `online`, `busy`, `error`, and
      `quota_limited`.
- [ ] Show adapter health in the Agent panel.
- [ ] Add last-seen timestamps to the UI.
- [ ] Make duplicate local adapter starts visible in logs and fail fast.

## Later: Collaboration Depth

- [ ] Improve A2A relay dialogue prompts for short, useful turn-taking.
- [ ] Add a conversation transcript summary at the end of relay dialogue.
- [ ] Add structured handoff messages between Claude and Codex.
- [ ] Add per-room knowledge search inside agent prompts.

## Later: Product Hardening

- [ ] Add authenticated production admin operations.
- [ ] Add rate limiting to public endpoints.
- [ ] Add richer production observability.
- [ ] Add backup and restore documentation for PostgreSQL.
