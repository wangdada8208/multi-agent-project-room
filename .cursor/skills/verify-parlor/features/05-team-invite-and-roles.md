# Team invite and roles

An owner can invite a second human into the encrypted room and choose whether they can participate or observe.

## Sub-features

- `team-invite` issues and revokes a human invitation scoped to an encrypted room.
- `team-redeem` preserves the invite across login and records the owner's approval.
- `team-roles` confirms member and observer permissions from both accounts.

## How to get to it (user POV)

- In `/rooms/<roomId>`, select **邀请** in the desktop room header or open the **邀请** tab in the room side panel.
- In another browser profile, paste the invite link into the address bar, or into **粘贴邀请链接** on `/setup`.
- Use **打开成员** or the **待审批** navigation link as owner. Use the **权限** section to inspect member roles.

## Driving it with browser-harness

Preconditions: a bound XMTP group, a synthetic owner and a second synthetic human with an independent browser profile and XMTP identity. Run both drivers sequentially and point each at the same verification Hub.

In the browser wrapper, create an isolated context with `cdp("Target.createBrowserContext", disposeOnDetach=False)["browserContextId"]`. Create a tab with `cdp("Target.createTarget", url="about:blank", browserContextId=context_id)["targetId"]`. Use `switch_tab(tab_id)` and `goto_url(invite_url)` for the invitee. At the end, use `cdp("Target.disposeBrowserContext", browserContextId=context_id)` to discard that session and its local state.

1. Under **邀请成员进入加密群**, require owner approval, choose the member role, and use **生成加密入群邀请链接**. Copy with **复制邀请链接**. Open the link while signed out in the second profile. Require **登录后将自动回到邀请房间**. Sign in and unlock or create the second local XMTP identity. The room submits the signed join request after unlocking. Repeat with a fresh invite through the onboarding paste path.
2. In the owner's room, open **待审批的入群申请** and choose **批准**. Wait for the second account to appear in the member list. Switch to the second profile and confirm successful join by sending one synthetic message through the unlocked composer.
3. Generate a separate **观察者** invitation and redeem using a third disposable human identity. Confirm the owner sees **观察者** and the observing profile can read the synthetic room but cannot use the composer. Use a separate invite to test **拒绝** and an unused invite to test **吊销**. Confirm neither yields membership.
4. Verify state again after reopening the room in each profile. Record role and grant, decision, and membership metadata without collecting the invite URL or room content. Close each profile after the run.

## Gotchas

- Separate browser tabs in a single profile share authentication and XMTP storage for the same origin.
- The **只读分享** link is a separate surface from **观察者** membership. Record it separately if exercised.
- A direct room address carries no invite. Use the actual invite generated for the disposable room.
