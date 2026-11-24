import { X } from "lucide-react";
import type { useMessageSearch } from "../../hooks/room/useMessageSearch";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

export function RoomSearch({ search, encrypted }: { search: ReturnType<typeof useMessageSearch>; encrypted: boolean }) {
  if (!search.showSearch) return null;
  return <section className="wb-search" aria-label="消息搜索">
    <form className="search-bar" onSubmit={(event) => { event.preventDefault(); void search.handleSearch(); }}>
      <input className="input" value={search.searchQuery} aria-label="搜索消息"
        placeholder={encrypted ? "本机搜索加密消息…" : "搜索消息…"} autoFocus
        onChange={(event) => search.setSearchQuery(event.target.value)} />
      {encrypted && search.xmtpSenderOptions.length > 0 && <select className="input" aria-label="按发送者过滤"
        value={search.searchSender} onChange={(event) => search.setSearchSender(event.target.value)}>
        <option value="">全部发送者</option>
        {search.xmtpSenderOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>}
      <Button type="submit" variant="secondary" size="sm" loading={search.isSearching} disabled={!search.searchQuery.trim()}>搜索</Button>
      <IconButton label="关闭搜索" onClick={search.closeSearch}><X size={16} /></IconButton>
    </form>
    {search.searchError && <p className="wb-error" role="alert">{search.searchError}</p>}
    {search.searchResults.length > 0 && <div className="search-results">
      <p>找到 {search.searchResults.length} 条结果{encrypted ? "（仅覆盖本机已同步消息）" : ""}</p>
      {search.searchResults.map((message) => <div key={message.id} className="search-result">
        <strong>{message.sender_name || message.sender_id}</strong><span>{message.content}</span>
        <small>{new Date(message.created_at).toLocaleString("zh-CN")}</small>
      </div>)}
    </div>}
  </section>;
}
