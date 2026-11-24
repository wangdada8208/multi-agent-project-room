import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { bindXmtpGroup } from "../../lib/api";
import { lockedXmtpSession, xmtpSessionReducer, type XmtpSession } from "../../lib/domain/xmtpSession";
import { clearUnlockedXmtpKey, createLocalXmtpClient, inboxAddress, setUnlockedXmtpKey } from "../../lib/xmtpLocalIdentity";

export type RoomXmtpClient = Awaited<ReturnType<typeof createLocalXmtpClient>>;

export function useXmtpSession({ roomId, groupId, enabled, refreshRoom }: {
  roomId: string; groupId: string | null | undefined; enabled: boolean; refreshRoom: () => Promise<unknown>;
}) {
  const [key, setUnlockedKey] = useState<string | null>(null);
  const [client, setClient] = useState<RoomXmtpClient | null>(null);
  const [state, dispatch] = useReducer(xmtpSessionReducer, lockedXmtpSession);
  const [clientRetry, setClientRetry] = useState(0);
  const [listenRetry, setListenRetry] = useState(0);
  const binding = useRef(false);
  const [bindingGroup, setBindingGroup] = useState(false);

  useEffect(() => {
    if (!enabled || !key) return;
    setUnlockedXmtpKey(key);
    return () => clearUnlockedXmtpKey();
  }, [enabled, key]);

  useEffect(() => {
    if (!enabled || !key) return;
    let active = true;
    let opened: RoomXmtpClient | undefined;
    dispatch({ type: "connect" });
    void createLocalXmtpClient(key).then((result) => {
      if (!active) {
        result.close();
        return;
      }
      opened = result;
      setClient(result);
    }, (err) => {
      if (active) dispatch({ type: "failed", message: err instanceof Error ? err.message : "无法连接加密房间" });
    });
    return () => {
      active = false;
      opened?.close();
      setClient(null);
    };
  }, [enabled, key, clientRetry]);

  useEffect(() => {
    if (client && !groupId) dispatch({ type: "groupMissing" });
  }, [client, groupId]);

  const restartListener = useCallback(() => {
    dispatch({ type: "connect" });
    setListenRetry((n) => n + 1);
  }, []);
  const reconnect = () => {
    if (client) restartListener();
    else setClientRetry((n) => n + 1);
  };

  async function bindGroup() {
    if (!client || groupId || binding.current) return;
    binding.current = true;
    setBindingGroup(true);
    try {
      const group = await client.conversations.createGroup([]);
      await bindXmtpGroup(roomId, group.id);
      await refreshRoom();
    } catch (err) {
      dispatch({ type: "failed", message: err instanceof Error ? err.message : "创建并绑定加密群失败" });
    } finally {
      binding.current = false;
      setBindingGroup(false);
    }
  }

  let session: XmtpSession = state;
  if (!key || !enabled) session = lockedXmtpSession;
  else if (state.kind === "locked" || ("groupId" in state && state.groupId !== groupId)) session = { kind: "connecting" };
  if (enabled && client && !groupId && session.kind !== "error") session = { kind: "noGroup" };

  const myXmtpAddress = useMemo(() => enabled && key ? inboxAddress(key) : "", [enabled, key]);
  return {
    session, xmtpClient: enabled ? client : null, setUnlockedKey, listenRetry, dispatch, restartListener, reconnect,
    myXmtpAddress, draftKeyMaterial: enabled ? key : null, bindingGroup, bindGroup,
  };
}
