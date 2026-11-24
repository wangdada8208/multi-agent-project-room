import { useEffect, useReducer, useRef, useState } from "react";
import { inviteFlowReducer, idleInviteFlow, type InviteEvent, type InviteFlow } from "../../lib/domain/inviteFlow";
import { acceptRoomInvite, formatInviteAcceptError, issueSignatureNonce, redeemRoomInvite } from "../../lib/localHelper";
import { signXmtpMessage } from "../../lib/xmtpLocalIdentity";

export function useInviteFlow(token: string) {
  const [invite, dispatch] = useReducer(inviteFlowReducer, idleInviteFlow);
  const acceptance = useRef<{ token: string; result: Promise<unknown> } | null>(null);

  useEffect(() => {
    if (!token) return;
    if (acceptance.current?.token !== token) {
      acceptance.current = { token, result: acceptRoomInvite(token) };
    }
    let active = true;
    dispatch({ type: "accept", token });
    void acceptance.current.result.then(
      () => { if (active) dispatch({ type: "accepted", token }); },
      (err) => { if (active) dispatch({ type: "acceptFailed", token, message: formatInviteAcceptError(err) }); },
    );
    return () => { active = false; };
  }, [token]);

  const accepting = Boolean(token && (invite.kind === "idle" || invite.token !== token || invite.kind === "accepting"));
  return { invite, dispatch, accepting };
}

export function useInviteRedemption(input: {
  invite: InviteFlow;
  urlToken: string;
  address: string;
  dispatch: (event: InviteEvent) => void;
  finish: (token: string, refreshPermissions: boolean) => void;
}) {
  const { invite, urlToken, address, dispatch, finish } = input;
  const token = invite.kind !== "idle" && invite.token === urlToken ? urlToken : "";
  const canRedeem = invite.kind === "accepted" || invite.kind === "acceptFailed" || invite.kind === "redeeming" ||
    (invite.kind === "redeemFailed" && invite.retryable);
  const [retry, setRetry] = useState(0);
  const attempt = useRef<{ token: string; address: string; result: ReturnType<typeof redeemRoomInvite> } | null>(null);

  useEffect(() => {
    if (!token || !address || !canRedeem) return;
    if (attempt.current?.token !== token || attempt.current.address !== address) {
      const result = (async () => {
        const challenge = await issueSignatureNonce({ action: "invite-redeem", resource: token, address });
        const signature = await signXmtpMessage(challenge.message);
        return redeemRoomInvite(token, { xmtp_address: address, nonce: challenge.nonce, signature });
      })();
      attempt.current = { token, address, result };
    }
    let active = true;
    dispatch({ type: "redeem", token });
    void attempt.current.result.then((result) => {
      if (!active) return;
      dispatch({ type: result.status === "pending" ? "pendingApproval" : "redeemed", token });
      finish(token, true);
    }, (err) => {
      if (!active) return;
      const status = err instanceof Error && "status" in err ? err.status : undefined;
      const retryable = status !== 404 && status !== 410 && status !== 409;
      dispatch({
        type: "redeemFailed", token, retryable,
        message: err instanceof Error ? err.message : "核销入群邀请失败",
      });
      if (!retryable) finish(token, false);
    });
    return () => { active = false; };
  }, [token, address, canRedeem, dispatch, finish, retry]);

  return () => {
    attempt.current = null;
    setRetry((value) => value + 1);
  };
}
