import { useQueries, useQuery } from "@tanstack/react-query";
import { Bot, Code, Folder, Hand, Infinity, LayoutGrid, Lightbulb, LogOut, Plus, Scale, SlidersHorizontal, User, Workflow } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { fetchRooms } from "../../lib/api";
import { roomTemplateKey } from "../../lib/roomTemplate";
import { redemptionsKey } from "../../hooks/room/usePendingRequests";
import { listRoomRedemptions } from "../../lib/localHelper";
import { getThemePreference, setThemePreference, type ThemePreference } from "../../lib/theme";
import { useAuthStore } from "../../stores/authStore";
import { Avatar } from "../ui/Avatar";
import "./AppShell.css";

const roomIcons = new Map([["code_review", Code], ["brainstorm", Lightbulb], ["debate", Scale], ["dev_team", Workflow]]);

const themes: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "浅色" }, { value: "dark", label: "深色" }, { value: "system", label: "跟随系统" },
];

export function AppShell({ children, roomId, pending }: { children: ReactNode; roomId?: string; pending?: number }) {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: fetchRooms }).data ?? [];
  const ownedRooms = rooms.filter((room) => user && room.created_by === user.id && (room.id !== roomId || pending === undefined));
  const inbox = useQueries({ queries: ownedRooms.map(({ id }) => ({
    queryKey: [...redemptionsKey(id), "pending"],
    queryFn: () => listRoomRedemptions(id, "pending"),
    refetchInterval: 30000, refetchIntervalInBackground: false, retry: false,
  })) });
  const byRoom = new Map(ownedRooms.map(({ id }, index) => [id, inbox[index]?.data?.length ?? 0]));
  if (roomId && pending !== undefined) byRoom.set(roomId, pending);
  const count = [...byRoom.values()].reduce((total, item) => total + item, 0);
  const pendingRoom = [...byRoom].find(([, value]) => value > 0)?.[0] ?? roomId;
  const [theme, setTheme] = useState(getThemePreference);
  const name = user?.display_name || user?.username || "我的账号";

  const account = (mobile: boolean) => (
    <details className={mobile ? "app-account app-account--mobile" : "app-account"}>
      <summary title={name}>
        {mobile ? <User size={20} /> : <Avatar actor="me" name={name} size="sm" />}
        <span>{mobile ? "我的" : <>{name}{user?.email && <small>{user.email}</small>}</>}</span>
        {!mobile && <SlidersHorizontal size={16} />}
      </summary>
      <div className="app-account__menu">
        <span>外观</span>
        {themes.map(({ label, value }) => (
          <button key={value} type="button" aria-pressed={theme === value} onClick={() => {
            setThemePreference(value);
            setTheme(value);
          }}>{label}</button>
        ))}
        <button type="button" onClick={logout}><LogOut size={14} />退出登录</button>
      </div>
    </details>
  );

  return (
    <div className={roomId ? "app-shell app-shell--room" : "app-shell"}>
      <aside className="app-rail">
        <Link to="/home" className="app-rail__brand" title="Multi-Agent 协作室">
          <span><Infinity size={17} /></span><strong>Project Room</strong>
        </Link>
        <nav className="app-rail__nav" aria-label="主导航">
          <NavLink to="/home" title="协作室"><LayoutGrid size={17} /><span>协作室</span></NavLink>
          <NavLink to="/agents" title="接入 Agent"><Bot size={17} /><span>接入 Agent</span></NavLink>
          <Link to={pendingRoom ? `/rooms/${encodeURIComponent(pendingRoom)}?panel=members` : "/home"} title="待处理">
            <Hand size={17} /><span>待处理</span>{count > 0 && <b className="workbench-count">{count}</b>}
          </Link>
        </nav>
        <nav className="app-rail__rooms" aria-label="我的房间">
          <h2>我的房间 <Link to="/setup" aria-label="创建房间" title="创建房间"><Plus size={16} /></Link></h2>
          {rooms.map((room) => {
            const Icon = roomIcons.get(roomTemplateKey(room) ?? "") ?? Folder;
            return <NavLink key={room.id} to={`/rooms/${encodeURIComponent(room.id)}`} title={room.name}>
              <span><Icon size={13} /></span><strong>{room.name}</strong>
              {Boolean(byRoom.get(room.id)) && <i className="app-rail__pending-dot" aria-label="有待批准申请" />}
            </NavLink>;
          })}
        </nav>
        {account(false)}
      </aside>
      <main className="app-shell__main">{children}</main>
      {!roomId && <nav className="app-mobile-tabs" aria-label="主导航">
        <NavLink to="/home"><LayoutGrid size={20} />协作室{count > 0 && <span className="workbench-count">{count}</span>}</NavLink>
        <NavLink to="/agents"><Bot size={20} />接入 Agent</NavLink>
        {account(true)}
      </nav>}
    </div>
  );
}
