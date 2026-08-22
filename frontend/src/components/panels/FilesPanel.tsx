import { useCallback, useEffect, useRef, useState } from "react";

interface RoomFile {
  id: string;
  room_id: string;
  filename: string;
  size: number;
  uploaded_by: string;
  uploaded_at: string;
}

interface FilesPanelProps {
  roomId: string;
  authToken?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesPanel({ roomId, authToken }: FilesPanelProps) {
  const [files, setFiles] = useState<RoomFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/rooms/${roomId}/files`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files ?? []);
      }
    } catch {
      // silent
    }
  }, [roomId, authToken]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  async function handleUpload(fileList: FileList | null) {
    if (!fileList?.length) return;
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(fileList)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/v1/rooms/${roomId}/files/upload`, {
          method: "POST",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
          body: form,
        });
        if (!res.ok) {
          setError(`上传失败: ${file.name}`);
          break;
        }
      }
      await loadFiles();
    } catch {
      setError("网络错误");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="panel-section">
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => handleUpload(e.target.files)}
      />
      <button
        type="button"
        className="btn-primary"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
      >
        {uploading ? "上传中..." : "📎 上传文件"}
      </button>
      {error && <p className="panel-error">{error}</p>}

      {files.length === 0 ? (
        <p className="panel-empty">暂无文件</p>
      ) : (
        <div className="files-list">
          {files.map((f) => (
            <a
              key={f.id}
              className="file-row"
              href={`/api/v1/rooms/${roomId}/files/${f.id}/download`}
              download={f.filename}
            >
              <span>📄</span>
              <div className="file-row__info">
                <span className="file-row__name">{f.filename}</span>
                <small>{formatSize(f.size)} · {f.uploaded_by}</small>
              </div>
              <span className="file-row__download">↓</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
