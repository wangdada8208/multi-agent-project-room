import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createDoc, fetchDoc, fetchDocs, searchDocs } from "../../lib/api";

export function KnowledgePanel({ roomId }: { roomId: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const docsQuery = useQuery({ queryKey: ["rooms", roomId, "docs"], queryFn: () => fetchDocs(roomId) });
  const docQuery = useQuery({
    queryKey: ["rooms", roomId, "docs", selectedDocId],
    queryFn: () => fetchDoc(roomId, selectedDocId as string),
    enabled: !!selectedDocId,
  });
  const searchQuery = useQuery({
    queryKey: ["rooms", roomId, "docs", "search", query],
    queryFn: () => searchDocs(roomId, query),
    enabled: query.trim().length > 0,
  });
  const createMutation = useMutation({
    mutationFn: () => createDoc(roomId, { title, content }),
    onSuccess: () => {
      setTitle("");
      setContent("");
      queryClient.invalidateQueries({ queryKey: ["rooms", roomId, "docs"] });
    },
  });
  const visibleDocs = query ? searchQuery.data ?? [] : docsQuery.data ?? [];

  return (
    <section className="side-card">
      <div className="side-title">知识库</div>
      <input className="panel-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文档..." />
      <div className="doc-list">
        {visibleDocs.slice(0, 5).map((doc) => (
          <button className="doc-item" key={doc.id} onClick={() => setSelectedDocId(doc.id)}>
            <div className="doc-title">{doc.title}</div>
            {"snippet" in doc && typeof doc.snippet === "string" && (
              <div className="doc-snippet">{doc.snippet}</div>
            )}
          </button>
        ))}
      </div>
      {docQuery.data && (
        <article className="doc-reader">
          <div className="doc-title">{docQuery.data.title}</div>
          <pre>{docQuery.data.content}</pre>
        </article>
      )}
      <div className="doc-create">
        <input className="panel-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="文档标题" />
        <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Markdown 内容..." />
        <button className="mini-button primary" disabled={!title.trim() || !content.trim()} onClick={() => createMutation.mutate()}>
          上传文档
        </button>
      </div>
    </section>
  );
}
