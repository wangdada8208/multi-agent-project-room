import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useRoomStore } from "../stores/roomStore";
import type { Room } from "../types/chat";

async function fetchRooms(): Promise<Room[]> {
  const res = await fetch("/api/v1/rooms");
  const data = await res.json();
  return data.rooms ?? data.data ?? [];
}

export function RoomsPage() {
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const queryClient = useQueryClient();

  const roomsQuery = useQuery({ queryKey: ["rooms"], queryFn: fetchRooms });
  const setRooms = useRoomStore((state) => state.setRooms);

  const createMutation = useMutation({
    mutationFn: () =>
      fetch("/api/v1/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName || "新房间", description: newDesc }),
      }).then((r) => r.json()),
    onSuccess: () => {
      setNewName("");
      setNewDesc("");
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
    },
  });

  useEffect(() => {
    if (roomsQuery.data) setRooms(roomsQuery.data);
  }, [roomsQuery.data, setRooms]);

  const rooms: Room[] = roomsQuery.data ?? [];

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section className="page-card">
        <p className="section-label">房间</p>
        <h1 className="card-title">项目房间</h1>
        <p className="card-subtitle">选择一个房间进入，或创建一个新的协作空间。</p>

        {roomsQuery.isLoading && <div className="empty-state"><p>加载中...</p></div>}
        {roomsQuery.isError && (
          <div className="empty-state">
            <p style={{ color: "#dc2626" }}>无法加载房间列表，请检查后端服务是否运行。</p>
          </div>
        )}

        {rooms.length === 0 && !roomsQuery.isLoading && (
          <div className="empty-state">
            <p>暂无房间，创建一个开始协作吧。</p>
          </div>
        )}

        <div className="room-grid">
          {rooms.map((room) => (
            <Link className="room-card" key={room.id} to={`/rooms/${room.id}`}>
              <div className="name">{room.name}</div>
              <div className="desc">
                {room.description || `房间 ${room.id.slice(0, 8)}...`}
              </div>
              <div className="meta">
                {room.created_at
                  ? new Date(room.created_at).toLocaleDateString("zh-CN")
                  : ""}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <div className="create-section">
        <p className="section-label">创建</p>
        <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 12 }}>新房间</div>
        <div className="row">
          <input
            placeholder="房间名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            placeholder="描述（可选）"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            style={{ flex: 2 }}
          />
          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            style={{
              padding: "10px 20px",
              border: "none",
              borderRadius: 10,
              background: "var(--accent)",
              color: "white",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
              opacity: createMutation.isPending ? 0.6 : 1,
            }}
          >
            {createMutation.isPending ? "创建中..." : "创建房间"}
          </button>
        </div>
      </div>
    </div>
  );
}
