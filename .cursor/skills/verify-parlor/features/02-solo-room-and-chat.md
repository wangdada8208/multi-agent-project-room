# Solo room and encrypted chat

A signed-in human can create a room alone, enable end-to-end encryption, send a message, and see it again after reopening the room.

## Sub-features

- `solo-create` creates a blank or templated room from the workbench or onboarding.
- `solo-encrypt` creates and binds the XMTP group using the browser identity.
- `solo-chat` sends and searches synthetic text after reconnecting.

## How to get to it (user POV)

- From `/home`, choose **新建房间** or the **创建房间** link beside **我的房间**.
- On first use, start with a template from the onboarding view at `/setup` or the onboarding card in `/home`.
- Reopen the created room from **我的房间** or the room grid.

## Driving it with browser-harness

Preconditions: a synthetic signed-in user and an available XMTP development network. Use a fresh browser profile and a disposable passphrase.

1. Open **新建房间**. In **选择模板**, choose a template. Fill **房间名称** with `Parlor Solo Verification` and choose **创建并进入**. Repeat for the blank room and template entry points with distinct names. Confirm each room in the authenticated room list.
2. On `/setup/<roomId>` enter a fresh passphrase in `#wb-setup-passphrase` and select **立即启用并进入房间**. Expect `/rooms/<roomId>` and the live encrypted composer. Confirm the room's XMTP group binding via its authenticated room metadata.
3. Type `parlor-solo-check` into **发消息，输入 @ 召唤 Agent…**. Send with **发送**, then send a second synthetic message using Enter. Wait until each message is shown as sent. Reopen the room, unlock if prompted, and use **本机搜索加密消息** to find the first message. Require the message in the XMTP history and no matching plaintext stored in Hub's `messages` table or Hub log.

## Gotchas

- Room metadata creation can succeed while XMTP is unavailable. Record that split if binding or message delivery fails.
- A second fresh browser profile uses a different XMTP identity. Reopen with the original identity for the history proof.
- Use synthetic text and a disposable passphrase. Preserve delivery evidence without persisting message content in shared artifacts.
