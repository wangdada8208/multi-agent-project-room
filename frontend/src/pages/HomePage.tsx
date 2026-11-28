import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, Search } from "lucide-react";
import { AppShell } from "../components/layout/AppShell";
import { AttentionStrip, type AttentionItem } from "../components/rooms/AttentionStrip";
import { RoomCard } from "../components/rooms/RoomCard";
import { Button } from "../components/ui/Button";
import { Segmented } from "../components/ui/Segmented";
import { toast } from "../components/ui/Toast";
import { redemptionsKey } from "../hooks/room/usePendingRequests";
import { fetchHubActivity } from "../lib/activityApi";
import { apiFetch, fetchRooms } from "../lib/api";
import { cloudInviteName } from "../lib/domain/cloudInvite";
import { pendingRequestsFrom } from "../lib/domain/pendingRequests";
import { listRoomRedemptions, listRoomSeats } from "../lib/localHelper";
import { useAuthStore } from "../stores/authStore";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useWorkspaceUiStore } from "../stores/workspaceUiStore";
import type { Room } from "../types/chat";
import {
  isOnboardingDismissed,
  markOnboardingDismissed,
  OnboardingView,
  useOnboardingProgress,
} from "./OnboardingPage";
import "../components/rooms/Rooms.css";

type RoomFilter = "all" | "mine" | "pending";

export function HomePage() {
  useDocumentTitle("房间 · Parlor");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RoomFilter>("all");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [onboardingDismissed, setOnboardingDismissed] = useState(isOnboardingDismissed);
  const openCreateRoom = useWorkspaceUiStore((state) => state.openCreateRoom);

  useEffect(() => {
    if (searchParams.get("create") === "1") {
      openCreateRoom();
      const next = new URLSearchParams(searchParams);
      next.delete("create");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, openCreateRoom]);

  const roomsQuery = useQuery({
    queryKey: ["rooms"],
    queryFn: fetchRooms,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const rooms: Room[] = roomsQuery.data ?? [];
  const onboardingProgress = useOnboardingProgress();

  const ownedRooms = useMemo(
    () => rooms.filter((r) => Boolean(user?.id && r.created_by === user.id)),
    [rooms, user?.id],
  );

  // §8.4: 看板每 30 秒轮询待审批申请，页面隐藏时暂停；与 AppShell 共享 queryKey 自动去重
  const pendingQueries = useQueries({
    queries: ownedRooms.map((room) => ({
      queryKey: [...redemptionsKey(room.id), "pending"],
      queryFn: () => listRoomRedemptions(room.id, "pending"),
      staleTime: 30_000,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });

  // §11 R4: 席位与安全元数据活动流 30s staleTime，不拉取加密聊天正文（S1）
  const seatQueries = useQueries({
    queries: rooms.map((room) => ({
      queryKey: ["rooms", room.id, "seats"],
      queryFn: () => listRoomSeats(room.id),
      staleTime: 30_000,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });

  const activityQueries = useQueries({
    queries: rooms.map((room) => ({
      queryKey: ["rooms", room.id, "activity-summary"],
      queryFn: () => fetchHubActivity(room.id, { limit: 1 }),
      staleTime: 30_000,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });

  const pendingByRoom = useMemo(() => {
    const map = new Map<string, ReturnType<typeof pendingRequestsFrom>>();
    ownedRooms.forEach((room, idx) => {
      const rows = pendingQueries[idx]?.data ?? [];
      map.set(
        room.id,
        pendingRequestsFrom(rows, (token) => cloudInviteName(token)),
      );
    });
    return map;
  }, [ownedRooms, pendingQueries]);

  const attentionItems: AttentionItem[] = useMemo(() => {
    const list: AttentionItem[] = [];
    for (const room of ownedRooms) {
      const reqs = pendingByRoom.get(room.id) ?? [];
      for (const req of reqs) {
        list.push({ room, request: req });
      }
    }
    return list;
  }, [ownedRooms, pendingByRoom]);

  const seatsByRoom = useMemo(() => {
    const map = new Map<string, (typeof seatQueries)[number]["data"]>();
    rooms.forEach((room, idx) => map.set(room.id, seatQueries[idx]?.data));
    return map;
  }, [rooms, seatQueries]);

  const activityByRoom = useMemo(() => {
    const map = new Map<string, (typeof activityQueries)[number]["data"]>();
    rooms.forEach((room, idx) => map.set(room.id, activityQueries[idx]?.data));
    return map;
  }, [rooms, activityQueries]);

  const filteredRooms = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rooms
      .filter((room) => {
        if (filter === "mine" && room.created_by !== user?.id) return false;
        if (filter === "pending" && (pendingByRoom.get(room.id)?.length ?? 0) === 0) return false;
        if (!q) return true;
        return (
          room.name.toLowerCase().includes(q) ||
          (room.description ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const aAt = activityByRoom.get(a.id)?.items?.[0]?.created_at ?? a.created_at;
        const bAt = activityByRoom.get(b.id)?.items?.[0]?.created_at ?? b.created_at;
        return Date.parse(bAt) - Date.parse(aAt);
      });
  }, [rooms, filter, search, user?.id, pendingByRoom, activityByRoom]);

  async function handleDeleteRoom(room: Room) {
    setActionError("");
    setDeletingId(room.id);
    try {
      const res = await apiFetch(`/api/v1/rooms/${encodeURIComponent(room.id)}`, {
        method: "DELETE",
      });
      if (res.status === 403) {
        setActionError("只有房主可以删除房间。");
        return;
      }
      if (!res.ok) {
        setActionError("删除房间失败，请稍后重试。");
        return;
      }
      setConfirmDeleteId(null);
      toast(`已删除「${room.name}」`, "ok");
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
    } catch {
      setActionError("网络异常，删除房间失败。");
    } finally {
      setDeletingId(null);
    }
  }

  const totalPending = attentionItems.length;
  const userName = user?.display_name || user?.username || "我";
  const showOnboarding =
    !roomsQuery.isLoading && !roomsQuery.isError && !onboardingDismissed && !onboardingProgress.allComplete;
  const showFirstTimeOnboarding = showOnboarding && rooms.length === 0;

  function dismissOnboarding() {
    markOnboardingDismissed();
    setOnboardingDismissed(true);
  }

  return (
    <AppShell>
      <div className="wb-rooms-page">
        <header className="wb-rooms-head">
          <div className="wb-rooms-head__copy">
            <h1>房间</h1>
            <p>
              {rooms.length} 个房间
              {totalPending > 0 ? ` · ${totalPending} 条待审批` : ""}
            </p>
          </div>
          {!showFirstTimeOnboarding && (
            <div className="wb-rooms-head__actions">
              <Link to="/agents" className="ui-button ui-button--secondary ui-button--md">
                <Bot size={16} strokeWidth={1.8} />
                <span>接入助手</span>
              </Link>
              <Button variant="primary" size="md" onClick={openCreateRoom}>
                <Plus size={16} strokeWidth={2} />
                <span>新建房间</span>
              </Button>
            </div>
          )}
        </header>

        <AttentionStrip items={attentionItems} />

        {actionError && (
          <div className="wb-rooms-alert" role="alert">
            {actionError}
          </div>
        )}

        {roomsQuery.isLoading && (
          <div className="wb-rooms-state">
            <span className="ui-spinner" aria-hidden="true" />
            <p>正在加载房间…</p>
          </div>
        )}

        {roomsQuery.isError && (
          <div className="wb-rooms-state" role="alert">
            <p>加载房间列表失败，请重试。</p>
            <Button variant="secondary" size="sm" onClick={() => void roomsQuery.refetch()}>
              重试
            </Button>
          </div>
        )}

        {showFirstTimeOnboarding && (
          <OnboardingView
            embedded
            progress={onboardingProgress}
            onStartTemplate={openCreateRoom}
            onDismiss={dismissOnboarding}
          />
        )}

        {!roomsQuery.isLoading && !roomsQuery.isError && rooms.length === 0 && !showFirstTimeOnboarding && (
          <div className="wb-rooms-state">
            <p>还没有房间。先从模板建一个吧。</p>
            <div className="wb-rooms-state__actions">
              <Button variant="primary" onClick={openCreateRoom}>
                <Plus size={15} strokeWidth={2} />
                新建房间
              </Button>
              <Link to="/agents" className="ui-button ui-button--secondary ui-button--md">
                接入助手
              </Link>
            </div>
          </div>
        )}

        {!roomsQuery.isLoading && !roomsQuery.isError && rooms.length > 0 && (
          <>
            {showOnboarding && (
              <OnboardingView
                embedded
                progress={onboardingProgress}
                onStartTemplate={openCreateRoom}
                onDismiss={dismissOnboarding}
              />
            )}
            <div className="wb-rooms-toolbar">
              <label className="wb-rooms-search">
                <Search size={15} strokeWidth={1.9} className="wb-rooms-search__icon" aria-hidden="true" />
                <input
                  className="wb-rooms-search__input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索房间"
                  aria-label="搜索房间"
                  data-shortcut-room-search
                  aria-keyshortcuts="/"
                />
              </label>
              <Segmented<RoomFilter>
                label="筛选房间"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "全部" },
                  { value: "mine", label: "我创建的" },
                  { value: "pending", label: totalPending > 0 ? `待审批 (${totalPending})` : "待审批" },
                ]}
              />
              <span className="wb-rooms-toolbar__sort">按最近动态排序</span>
            </div>

            {filteredRooms.length === 0 ? (
              <div className="wb-rooms-state">
                <p>没有匹配的房间。</p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                  }}
                >
                  清除筛选
                </Button>
              </div>
            ) : (
              <div className="wb-rooms-grid">
                {filteredRooms.map((room) => (
                  <RoomCard
                    key={room.id}
                    room={room}
                    currentUserId={user?.id}
                    currentUserName={userName}
                    pendingCount={pendingByRoom.get(room.id)?.length ?? 0}
                    seats={seatsByRoom.get(room.id) ?? []}
                    activity={activityByRoom.get(room.id) ?? null}
                    confirmingDelete={confirmDeleteId === room.id}
                    deleting={deletingId === room.id}
                    onEnter={() => navigate(`/rooms/${encodeURIComponent(room.id)}`)}
                    onRequestDelete={() => setConfirmDeleteId(room.id)}
                    onCancelDelete={() => setConfirmDeleteId(null)}
                    onConfirmDelete={() => void handleDeleteRoom(room)}
                  />
                ))}
                <button
                  type="button"
                  className="wb-room-card wb-room-card--new"
                  onClick={openCreateRoom}
                >
                  <span className="wb-room-card__plus" aria-hidden="true">
                    <Plus size={18} strokeWidth={2} />
                  </span>
                  <strong>新建房间</strong>
                  <span>选个模板，或建空白房间</span>
                </button>
              </div>
            )}
          </>
        )}

      </div>
    </AppShell>
  );
}
