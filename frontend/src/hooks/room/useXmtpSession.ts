import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { bindXmtpGroup } from "../../lib/api";
import { lockedXmtpSession, xmtpSessionReducer, type XmtpSession } from "../../lib/domain/xmtpSession";
import {
  createLocalXmtpClient,
  currentUnlockedXmtpKey,
  inboxAddress,
  lockXmtpIdentity,
  setUnlockedXmtpKey,
  XMTP_BIND_ERROR_MESSAGE,
  XMTP_NETWORK_ERROR_MESSAGE,
} from "../../lib/xmtpLocalIdentity";

export type RoomXmtpClient = Awaited<ReturnType<typeof createLocalXmtpClient>>;

function refreshedGroupId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const container = result as { data?: unknown; xmtp_group_id?: unknown };
  const data = container.data && typeof container.data === "object" ? container.data as { xmtp_group_id?: unknown } : container;
  return typeof data.xmtp_group_id === "string" && data.xmtp_group_id ? data.xmtp_group_id : null;
}

export function useXmtpSession({ roomId, groupId, enabled, refreshRoom, autoBind = false }: {
  roomId: string;
  groupId: string | null | undefined;
  enabled: boolean;
  refreshRoom: () => Promise<unknown>;
  autoBind?: boolean;
}) {
  const [key, setKeyState] = useState<string | null>(() => enabled ? currentUnlockedXmtpKey() : null);
  const [client, setClient] = useState<RoomXmtpClient | null>(null);
  const [state, dispatch] = useReducer(xmtpSessionReducer, lockedXmtpSession);
  const [clientRetry, setClientRetry] = useState(0);
  const [listenRetry, setListenRetry] = useState(0);
  const binding = useRef(false);
  const lockVersion = useRef(0);
  const autoBindAttempt = useRef<{ roomId: string; client: RoomXmtpClient } | null>(null);
  const [bindingGroup, setBindingGroup] = useState(false);

  useEffect(() => {
    if (!enabled || key) return;
    const restored = currentUnlockedXmtpKey();
    if (restored) setKeyState(restored);
  }, [enabled, key]);

  const setUnlockedKey = useCallback((nextKey: string) => {
    setUnlockedXmtpKey(nextKey);
    setKeyState(nextKey);
  }, []);

  const lock = useCallback(() => {
    lockVersion.current += 1;
    lockXmtpIdentity();
    setKeyState(null);
    dispatch({ type: "lock" });
  }, []);

  useEffect(() => {
    if (!enabled || !key) return;
    setUnlockedXmtpKey(key);
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
    }, () => {
      if (active) dispatch({ type: "failed", message: XMTP_NETWORK_ERROR_MESSAGE, reason: "connect" });
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

  const bindGroup = useCallback(async () => {
    if (!client || groupId || binding.current) return;
    const version = lockVersion.current;
    binding.current = true;
    setBindingGroup(true);
    dispatch({ type: "groupMissing" });
    try {
      const alreadyBound = refreshedGroupId(await refreshRoom());
      if (lockVersion.current !== version) return;
      if (!alreadyBound) {
        const group = await client.conversations.createGroup([]);
        if (lockVersion.current !== version) return;
        await bindXmtpGroup(roomId, group.id);
        if (lockVersion.current !== version) return;
        await refreshRoom();
      }
    } catch {
      let recovered: string | null = null;
      try {
        recovered = refreshedGroupId(await refreshRoom());
      } catch {
        recovered = null;
      }
      if (lockVersion.current === version && !recovered) {
        dispatch({ type: "failed", message: XMTP_BIND_ERROR_MESSAGE, reason: "bind" });
      }
    } finally {
      binding.current = false;
      setBindingGroup(false);
    }
  }, [client, groupId, roomId, refreshRoom]);

  useEffect(() => {
    if (!autoBind || !enabled || !key || !client || groupId || binding.current) return;
    const attempted = autoBindAttempt.current;
    if (attempted?.roomId === roomId && attempted.client === client) return;
    autoBindAttempt.current = { roomId, client };
    void bindGroup();
  }, [autoBind, enabled, key, client, groupId, roomId, bindGroup]);

  let session: XmtpSession = state;
  if (!key || !enabled) session = lockedXmtpSession;
  else if (state.kind === "locked" || ("groupId" in state && state.groupId !== groupId)) session = { kind: "connecting" };
  if (enabled && client && !groupId && session.kind !== "error") session = { kind: "noGroup" };

  const myXmtpAddress = useMemo(() => enabled && key ? inboxAddress(key) : "", [enabled, key]);
  return {
    session, xmtpClient: enabled ? client : null, setUnlockedKey, lock, listenRetry, dispatch, restartListener, reconnect,
    myXmtpAddress, draftKeyMaterial: enabled ? key : null, bindingGroup, bindGroup,
  };
}
