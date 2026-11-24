import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoom, fetchRooms } from "../../lib/api";

export function useTargetRoom({ fixedRoomId, selectedRoomId, onSelect }: {
  fixedRoomId?: string;
  selectedRoomId?: string;
  onSelect?: (id: string) => void;
}) {
  const [localPick, setLocalPick] = useState("");
  const client = useQueryClient();
  const roomsQuery = useQuery({ queryKey: ["rooms"], queryFn: fetchRooms, enabled: !fixedRoomId });
  const rooms = roomsQuery.data ?? [];
  const requested = selectedRoomId || localPick;
  const roomId = fixedRoomId ?? (rooms.some((room) => room.id === requested) ? requested : rooms[0]?.id ?? "");
  function selectRoom(id: string) {
    setLocalPick(id);
    onSelect?.(id);
  }
  const create = useMutation({
    mutationFn: (name: string) => createRoom(name),
    onSuccess: (room) => {
      client.setQueryData(["rooms"], [room, ...rooms.filter(({ id }) => id !== room.id)]);
      selectRoom(room.id);
    },
  });
  return { roomId, rooms, roomsLoaded: Boolean(fixedRoomId || roomsQuery.isSuccess), error: roomsQuery.error, create, selectRoom };
}
