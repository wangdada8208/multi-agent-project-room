# Parlor verification map

Launch and doctor the disposable instance using [Verify Parlor](../SKILL.md). Browser recipes use its browser-harness wrapper. Use the run URL from `instance.json` for browser routes and `hub_url` when a command needs the Hub directly. Keep the browser at desktop width unless a recipe calls for mobile.

The launch script supplies seeded room templates and empty accounts and rooms. Create a new account through the UI for stateful paths. Fresh verification runs get separate database, Redis, browser, and port state. The helper fixture requires sole ownership of local port 8790.

| Journey | Observable result |
| --- | --- |
| [01 Landing and auth](01-landing-and-auth.md) | Landing entry paths, stored account, and authenticated session after reload |
| [02 Solo room and chat](02-solo-room-and-chat.md) | Encrypted room and a message recovered from XMTP history |
| [03 Local helper and MCP](03-local-helper-and-mcp.md) | Paired seat, usable MCP, read cursor, watch mode, and owner-approved send |
| [04 Cloud agent and approval](04-cloud-agent-and-approval.md) | Pending cloud redemption, owner decision, and an XMTP-enabled seat |
| [05 Team invite and roles](05-team-invite-and-roles.md) | Human invite redemption and role restrictions observed in a second session |

Record each entry point separately with the action, screen or CLI outcome, and state readback. If a precondition is absent, record the attempted path, error, and missing fixture. A pass through one entry point covers only that entry point. Keep sanitized evidence in the run's `evidence/` directory and follow cleanup even after failures.
