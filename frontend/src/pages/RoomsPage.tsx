import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchRooms, createRoom } from "../lib/api";
import { useRoomStore } from "../stores/roomStore";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import type { Room } from "../types/chat";

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
        body: JSON.stringify({ name: newName || "New Room", description: newDesc }),
      }).then((r) => r.json()),
    onSuccess: () => {
      setNewName("");
      setNewDesc("");
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
    },
  });

  useEffect(() => {
    if (roomsQuery.data) {
      setRooms(roomsQuery.data);
    }
  }, [roomsQuery.data, setRooms]);

  const rooms: Room[] = roomsQuery.data ?? [];

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <section className="page-card" style={{ padding: 20 }}>
        <p className="eyebrow">Rooms</p>
        <h2 style={{ marginBottom: 12 }}>Project Rooms</h2>

        {roomsQuery.isLoading && <p style={{ color: "#94a3b8" }}>Loading rooms...</p>}
        {roomsQuery.isError && (
          <p className="error-text" style={{ color: "#f87171" }}>
            Could not load rooms. Is the server running?
          </p>
        )}

        {rooms.length === 0 && !roomsQuery.isLoading && (
          <p style={{ color: "#64748b", marginBottom: 16 }}>
            No rooms yet. Create one to get started.
          </p>
        )}

        <div className="room-grid">
          {rooms.map((room) => (
            <Link className="room-card" key={room.id} to={`/rooms/${room.id}`}>
              <strong style={{ fontSize: 16 }}>{room.name}</strong>
              <span>
                {room.description
                  ? room.description.slice(0, 60)
                  : `Room ${room.id.slice(0, 8)}...`}
              </span>
              <small style={{ color: "#64748b", fontSize: 11, marginTop: 4 }}>
                {new Date(room.created_at).toLocaleDateString()}
              </small>
            </Link>
          ))}
        </div>
      </section>

      <section
        className="page-card"
        style={{ padding: 20, display: "grid", gap: 12, height: "auto" }}
      >
        <p className="eyebrow">Create</p>
        <h2 style={{ marginBottom: 0, fontSize: 20 }}>New Room</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Input
            placeholder="Room name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: 1, minWidth: 160 }}
          />
          <Input
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            style={{ flex: 2, minWidth: 200 }}
          />
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create Room"}
          </Button>
        </div>
      </section>
    </div>
  );
}
