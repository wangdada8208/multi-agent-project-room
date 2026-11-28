# Local helper and MCP

An owner pairs a computer, joins a detected Agent seat to a room, and connects an authorized local MCP client to that seat.

## Sub-features

- `helper-pair` links the verification account to the disposable helper.
- `helper-join` creates a seat and confirms XMTP group membership.
- `mcp-read` inspects status, rooms, inbox, wait, and acknowledgement.
- `mcp-watch` receives without invoking the Agent, and `mcp-send` requires owner approval.

## How to get to it (user POV)

- In **接入 Agent** at `/agents`, select a room and open **获取配对命令** under **电脑端 Agent 与模型接口**. A room-specific path is `/agents?room=<roomId>`.
- In the client picker on **接入 Agent** or `/setup`, choose **Claude Desktop / 通用 MCP 客户端**, then **客户端说明** or **复制专属提示词**.
- On the detected Agent card select **加入房间**. The owner can also use the documented ticket path in the [MCP prompt](../../../../frontend/public/prompts/mcp-local.md).

## Driving it with browser-harness, mapr, and an MCP client

Preconditions: a room with an initialized XMTP group, a checkout-matched `mapr`, a dedicated Agent profile, and free helper port 8790. In the commands below, `SITE` is the run's frontend origin, and `PAIR_CODE` is the disposable code generated in the browser.

1. Follow **客户端说明** and verify it opens the current `/prompts/mcp-local.md`. Check that **复制专属提示词** references that path. Capture the link and sanitized state.
2. Start `mapr up --hub "$SITE" --dir "$PARLOR_RUN/runtime/helper" --no-browser --pair "$PAIR_CODE" --cap mcp` in a separate terminal. Run `curl -fsS http://127.0.0.1:8790/api/hello` and require `paired: true` with the verification origin. Join the room via the Agent card. Keep the room open as owner until the seat shows added to the encryption group. Confirm with `GET /api/seats` on the helper and the room member panel.
3. Configure the MCP client from `$PARLOR_RUN/runtime/helper/seats/<seat-id>/state/mcp.json` using its loopback `url` and `Authorization: Bearer <token>`. Confirm the file is `0600`. In the MCP client, list tools, invoke `parlor_status` and `parlor_rooms`, and require one joined room. A loopback request to the endpoint without authorization must return 401.
4. Send a synthetic message from the real browser room. Call `parlor_wait` with `timeoutMs: 5000`, read with `parlor_inbox` and `peek: true`, then read normally and acknowledge the delivered cursor with `parlor_inbox_ack`. Confirm the same cursor after restart. Restart the same helper with `--cap mcp --cap watch --mode watch`, re-read the connection file, and check the summary, no Agent execution, and no automatic reply after an @ mention.
5. Restart with `--cap mcp --cap send`. Confirm unapproved sends fail. In a local owner terminal use `mapr mcp-approve-send --dir "$PARLOR_RUN/runtime/helper" --seat "$SEAT_ID" --room "$ROOM_ID" --text 'parlor-mcp-check'`. Supply the approval ID and identical room and text to `parlor_reply`. Confirm the message in the browser and rejection of a second use of the approval. Stop the helper you started before stack cleanup.

## Gotchas

- Port 8790 serves helper management. The MCP port is per seat and can change on restart.
- A detected or running seat can still await XMTP membership. Status minus room membership cannot prove inbox, watch, or send.
- A shared or existing helper profile invalidates isolation. Keep credentials, approval IDs, and room bodies out of the evidence.
