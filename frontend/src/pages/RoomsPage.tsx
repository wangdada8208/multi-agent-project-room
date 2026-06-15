import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { fetchRooms } from "../lib/api";
import { useRoomStore } from "../stores/roomStore";

export function RoomsPage() {
  const roomsQuery = useQuery({ queryKey: ["rooms"], queryFn: fetchRooms });
  const setRooms = useRoomStore((state) => state.setRooms);

  useEffect(() => {
    if (roomsQuery.data) {
      setRooms(roomsQuery.data);
    }
  }, [roomsQuery.data, setRooms]);

  return (
    <section className="page-card">
      <p className="eyebrow">Rooms</p>
      <h2>Project rooms</h2>

      {roomsQuery.isLoading && <p>Loading rooms...</p>}
      {roomsQuery.isError && <p className="error-text">Could not load rooms.</p>}

      <div className="room-grid">
        {(roomsQuery.data ?? []).map((room) => (
          <Link className="room-card" key={room.id} to={`/rooms/${room.id}`}>
            <strong>{room.name}</strong>
            <span>{room.description || room.id}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
