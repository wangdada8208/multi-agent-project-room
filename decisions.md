# Decisions

## 2026-06-17 — Lightweight Auth And Task Traceability

Decision:

- Use a lightweight username/password account system for the MVP.
- Store password hashes with PBKDF2 from the Python standard library.
- Issue signed bearer tokens using the configured `MAPR_AUTH_SECRET_KEY`.
- Keep Agent registration and A2A discovery open for local adapter ergonomics.
- Require auth for room, message history, approval, and task REST APIs.
- Track A2A tasks with optional `room_id`, `source_message_id`, and `approval_id`.

Rationale:

- This gives real user identity for approvals and room creation without adding
  OAuth/SSO complexity.
- Task traceability makes the core collaboration loop inspectable from chat,
  approvals, and task panels.

Follow-up:

- Replace the default dev secret before production use.
- Introduce agent-specific tokens before exposing agent write APIs broadly.
