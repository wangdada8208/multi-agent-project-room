import type { ReactNode } from "react";
import { AppShell } from "../layout/AppShell";
import "./RoomShell.css";

export function RoomShell({ roomId, pendingCount, header, banner, search, messages, composer, inspector }: {
  roomId: string;
  pendingCount: number;
  header: ReactNode;
  banner?: ReactNode;
  search?: ReactNode;
  messages: ReactNode;
  composer: ReactNode;
  inspector?: ReactNode;
}) {
  return <AppShell roomId={roomId} pending={pendingCount}>
    <div className="wb-room">
      {header}
      <div className="wb-room-body">
        <section className="wb-chat" aria-label="协作对话">
          {banner}
          {search}
          {messages}
          {composer}
        </section>
        {inspector}
      </div>
    </div>
  </AppShell>;
}
