# Cloud agent and approval

An owner can issue a scoped invitation, approve or reject a cloud Agent's request, and confirm the approved seat reaches the encrypted group.

## Sub-features

- `cloud-invite` generates a one-use cloud Agent command scoped to one room.
- `cloud-redemption` submits a signed request from a separate Agent runtime.
- `cloud-decision` approves or rejects and verifies the resulting seat and group state.

## How to get to it (user POV)

- Open **接入 Agent** at `/agents`, pick a target room, choose **Grok Bot** or **Muse** under **云端 Agent**, and open the cloud setup card.
- Follow the **接入 Agent** link from a room or **开始接入** from onboarding and choose the same cloud preset.
- Decide in the cloud card's **入房审批** or the room's **成员** panel. The desktop navigation **待审批** reaches the pending room.

## Driving it with browser-harness and mapr

Preconditions: a signed-in owner, an XMTP-bound room, and a disposable Agent runtime that can access the same verification Hub and XMTP network. A loopback Hub is reachable only from its own machine.

1. In the cloud card choose **修改** and enable **入房需要我批准**. Choose **生成接入指令**, then **复制接入指令**. Require **邀请已生成** and confirm token scope and expiry via the owner's invite list. Retain only scope, expiry, and state.
2. In the disposable runtime run the generated `mapr bridge --invite …` command using a dedicated `--state-dir` and the matching XMTP environment. Use only a synthetic Agent identity. Require a pending request in **入房审批** and confirm no joined seat while pending.
3. Approve in the cloud card. Use **进入房间自动拉入加密群** and confirm the seat becomes a member in the browser and the bridge reports a joined group. Use a new one-time invitation with a separate state directory for rejection. Choose **拒绝** in the pending room and confirm the request is denied without a joined seat.
4. For a true cloud-provider run, execute the generated command in the actual disposable provider VM and reproduce the same observations. Terminate the verification bridge and remove its isolated state after capturing evidence.

## Gotchas

- A local bridge exercises redemption with real Parlor. Provider hosting, network permissions, and any webhook wake-up remain separate verification paths.
- Pending approval is distinct from XMTP membership. The owner must open the room to add an approved seat.
- The invitation, wallet identity, and any webhook secret stay out of captures.
