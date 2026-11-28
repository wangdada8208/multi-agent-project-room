import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { openHelperLink } from "../../components/HelperLink";
import { removeSeatFromRoom } from "../room/useSeatActions";
import { useLocalHelper } from "../useLocalHelper";
import {
  createJoinTicket, createPairingCode, isMobileBrowser, joinViaTicket, listLocalAgents,
  listLocalSeats, listMyHelpers, listRoomSeats, resolvePresetOpenDecision,
  type HelperHandoffAction, type HelperDevice, type LocalAgentView, type PairingCode, type SeatViewLocal,
} from "../../lib/localHelper";
import { inboxAddress } from "../../lib/xmtpLocalIdentity";

export type TimedPairingCode = PairingCode & { remainingSeconds: number };

function secondsUntil(expiresAt: string) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
}

export function usePairingCode() {
  const [pairing, setPairing] = useState<TimedPairingCode | null>(null);
  const [pairingError, setPairingError] = useState("");
  const request = useRef<"idle" | "pending" | "loaded">("idle");

  const ensurePairing = useCallback((forceRefresh = false) => {
    if (request.current === "pending" || (!forceRefresh && request.current === "loaded")) return;
    request.current = "pending";
    setPairingError("");
    setPairing(null);
    createPairingCode()
      .then((issued) => {
        request.current = "loaded";
        setPairing({ ...issued, remainingSeconds: secondsUntil(issued.expires_at) });
      })
      .catch((err) => {
        request.current = "idle";
        setPairingError(err instanceof Error ? err.message : "生成配对码失败");
      });
  }, []);

  const expiresAt = pairing?.expires_at;
  useEffect(() => {
    if (!expiresAt) return;
    let timer: number;
    const tick = () => {
      window.clearTimeout(timer);
      const remainingSeconds = secondsUntil(expiresAt);
      setPairing((current) => current?.expires_at === expiresAt && current.remainingSeconds !== remainingSeconds
        ? { ...current, remainingSeconds } : current);
      if (remainingSeconds > 0) {
        const millis = Date.parse(expiresAt) - Date.now();
        timer = window.setTimeout(tick, Math.max(1, millis % 1000 || 1000));
      }
    };
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [expiresAt]);

  return { pairing, pairingError, ensurePairing };
}

export const PairingCodeContext = createContext<ReturnType<typeof usePairingCode> | null>(null);

export function useLocalAgents({ roomId: effectiveRoomId, ownerXmtpAddress, onJoined, legacyMobile, hubOrigin }: {
  roomId: string;
  ownerXmtpAddress?: string;
  onJoined?: (seat: SeatViewLocal) => void;
  legacyMobile: boolean;
  hubOrigin: string;
}) {
  const isMobile = isMobileBrowser();
  const { probe, refresh: refreshProbe, updatedAt } = useLocalHelper();
  const sharedPairing = useContext(PairingCodeContext);
  const standalonePairing = usePairingCode();
  const { pairing, pairingError, ensurePairing } = sharedPairing ?? standalonePairing;
  const [guideNotice, setGuideNotice] = useState("");
  const [pendingPreset, setPendingPreset] = useState<{ presetId: string; label: string } | null>(null);
  const [highlightStepOne, setHighlightStepOne] = useState(false);
  const [expandAnotherComputer, setExpandAnotherComputer] = useState(false);
  const pairingSectionRef = useRef<HTMLDivElement>(null);
  const presetContinueRef = useRef<HTMLDivElement>(null);
  const highlightTimerRef = useRef<number>(0);

  const [agents, setAgents] = useState<LocalAgentView[]>([]);
  const [seats, setSeats] = useState<SeatViewLocal[]>([]);
  const [helpers, setHelpers] = useState<HelperDevice[]>([]);
  const [helperPick, setHelperPick] = useState("");
  const [unlockedAddress, setUnlockedAddress] = useState("");
  const [pendingJoin, setPendingJoin] = useState<{ agentKey: string; roomId: string } | null>(null);
  const [joiningKey, setJoiningKey] = useState<string | null>(null);
  const [joinError, setJoinError] = useState("");
  const joinInFlight = useRef(false);
  const [joinedSeat, setJoinedSeat] = useState<SeatViewLocal | null>(null);
  const [listError, setListError] = useState("");
  const [rescanning, setRescanning] = useState(false);

  // 探测循环：未 running 时每 3 秒重试；running 时每 5 秒刷新列表
  const refreshLocal = useCallback(async () => {
    const [agentList, seatList] = await Promise.all([listLocalAgents(), listLocalSeats()]);
    setAgents(agentList);
    setSeats(seatList);
    setListError("");
  }, []);

  const helperRunning = probe?.state === "running";
  useEffect(() => {
    if (!helperRunning) return;
    let active = true;
    void refreshLocal().catch((err) => {
      if (active) setListError(err instanceof Error ? err.message : "读取本机助手失败");
    });
    return () => { active = false; };
  }, [helperRunning, updatedAt, refreshLocal]);

  const isHelperReadyAndPaired = !isMobile && probe?.state === "running" && probe.hello.paired;
  const activePairCode = !isHelperReadyAndPaired && pairing && pairing.remainingSeconds > 0 ? pairing.code : undefined;
  const presetDecision = resolvePresetOpenDecision(probe, isMobile);
  const pendingPresetAction: HelperHandoffAction | undefined = pendingPreset && !isMobile
    ? {
        preset: pendingPreset.presetId,
        roomId: effectiveRoomId || undefined,
        pairCode: activePairCode,
      }
    : undefined;

  useEffect(() => {
    if (isHelperReadyAndPaired) {
      setGuideNotice("");
    }
  }, [isHelperReadyAndPaired]);

  // 已配对后拉取设备列表供签发票据
  useEffect(() => {
    if (!isHelperReadyAndPaired) return;
    let cancelled = false;
    listMyHelpers()
      .then((list) => {
        if (cancelled) return;
        const active = list.filter((h) => !h.revoked);
        setHelpers(active);
        const freshest = [...active].sort(
          (a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""),
        )[0];
        if (freshest) setHelperPick((prev) => prev || freshest.id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isHelperReadyAndPaired]);

  const needPairingCode =
    legacyMobile || (probe !== null && !isHelperReadyAndPaired) || expandAnotherComputer;

  useEffect(() => {
    if (needPairingCode) {
      ensurePairing(false);
    }
  }, [needPairingCode, ensurePairing]);

  async function handleManualRescan() {
    setRescanning(true);
    try {
      await refreshProbe?.({ throwOnError: true, cancelRefetch: false });
    } catch (err) {
      setListError(err instanceof Error ? err.message : "扫描失败");
    } finally {
      setRescanning(false);
    }
  }

  const myAddress = ownerXmtpAddress || unlockedAddress;

  async function runJoin(agentKey: string, targetRoomId: string, address: string) {
    if (joinInFlight.current) return;
    joinInFlight.current = true;
    setJoiningKey(agentKey);
    setJoinError("");
    try {
      let helperId = helperPick;
      if (!helperId) {
        const list = (await listMyHelpers()).filter((h) => !h.revoked);
        setHelpers(list);
        helperId =
          [...list].sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""))[0]?.id ?? "";
        if (helperId) setHelperPick(helperId);
      }
      if (!helperId) {
        setJoinError("本机助手尚未绑定到当前账号，请先完成配对后再加入。");
        return;
      }
      const { ticket } = await createJoinTicket(helperId, {
        room_id: targetRoomId,
        agent_key: agentKey,
        owner_xmtp_address: address,
      });
      let seat: SeatViewLocal;
      try {
        seat = await joinViaTicket(ticket, agentKey);
      } catch (err) {
        if (err instanceof TypeError) {
          setJoinError("无法连接本机助手。请确认电脑上的本机助手已启动，并在浏览器中允许本地网络访问。");
          openHelperLink({ ticket, agentKey });
          return;
        }
        throw err;
      }
      setJoinedSeat(seat);
      onJoined?.(seat);
      await refreshLocal();
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : "加入失败，请重试");
    } finally {
      joinInFlight.current = false;
      setJoiningKey(null);
    }
  }

  function startJoin(agentKey: string) {
    const target = effectiveRoomId;
    if (!target) {
      setJoinError("请先选择或创建一个要加入的房间。");
      return;
    }
    setJoinError("");
    setJoinedSeat(null);
    if (myAddress) {
      void runJoin(agentKey, target, myAddress);
    } else {
      setPendingJoin({ agentKey, roomId: target });
    }
  }

  async function leaveSeat(seat: SeatViewLocal) {
    try {
      const current = (await listRoomSeats(seat.roomId)).find((row) => row.seat_id === seat.seatId);
      if (!current || current.group_status === "removed") {
        await refreshLocal();
        return;
      }
      if (current.group_status !== "pending") {
        setListError("请进入房间并解锁加密身份，在「成员」面板移出该席位。");
        return;
      }
      await removeSeatFromRoom(current);
      await refreshLocal();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "移出席位失败");
    }
  }

  useEffect(() => () => window.clearTimeout(highlightTimerRef.current), []);

  function openPresetConfig(presetId: string, label = presetId) {
    if (presetDecision === "open-helper") {
      const win = openHelperLink({
        preset: presetId,
        roomId: effectiveRoomId || undefined,
        pairCode: activePairCode,
      });
      if (win) {
        setPendingPreset(null);
        setGuideNotice("");
        return;
      }
      if (isHelperReadyAndPaired) {
        setPendingPreset({ presetId, label });
        window.requestAnimationFrame(() => {
          presetContinueRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        return;
      }
    }

    setPendingPreset({ presetId, label });
    ensurePairing(false);
    setGuideNotice(presetDecision === "guide-mobile"
      ? `当前为手机或平板浏览器。要配置「${label}」，请在电脑浏览器打开本页，或复制下方命令到电脑「终端」执行后，再用电脑继续配置。`
      : presetDecision === "guide-install"
        ? `要配置「${label}」，请先完成第 1 步：复制下方命令到这台电脑的「终端」粘贴并回车。本机助手启动并配对后，此页会提示你继续配置。`
        : `如需手动打开「${label}」的配置，请使用下方的本机控制台链接。`);
    setHighlightStepOne(true);
    window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlightStepOne(false), 2400);
    window.requestAnimationFrame(() => {
      pairingSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  const activeSeatKeysInSelectedRoom = useMemo(() => {
    const keys = new Set<string>();
    if (!effectiveRoomId) return keys;
    for (const s of seats) {
      if (
        s.roomId === effectiveRoomId &&
        (s.status === "running" || s.status === "starting")
      ) {
        keys.add(s.agentKey);
      }
    }
    return keys;
  }, [seats, effectiveRoomId]);

  const activeSeatsForDisplay = useMemo(
    () => seats.filter((s) => s.status !== "revoked" && s.status !== "stopped"),
    [seats],
  );

  function unlockForJoin(key: string) {
    if (!pendingJoin) return;
    const address = inboxAddress(key);
    setUnlockedAddress(address);
    setPendingJoin(null);
    void runJoin(pendingJoin.agentKey, pendingJoin.roomId, address);
  }

  return {
    probe, isMobile, isHelperReadyAndPaired, presetDecision, pairing, pairingError, guideNotice, pendingPreset,
    pendingPresetAction, clearPreset: () => setPendingPreset(null), highlightStepOne, expandAnotherComputer,
    setExpandAnotherComputer, pairingSectionRef, presetContinueRef, ensurePairing,
    agents, helpers, helperPick, setHelperPick, pendingJoin, cancelJoin: () => setPendingJoin(null),
    joiningKey, joinError, joinedSeat, listError, rescanning, handleManualRescan, startJoin, leaveSeat, openPresetConfig,
    activeSeatKeysInSelectedRoom, activeSeatsForDisplay, unlockForJoin, myAddress,
  };
}
