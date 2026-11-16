import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";

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
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesPanel({ roomId }: FilesPanelProps) {
  const [files, setFiles] = useState<RoomFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/files`);
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files ?? []);
      }
    } catch {
      // silent
    }
  }, [roomId]);

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
        const res = await apiFetch(`/api/v1/rooms/${roomId}/files/upload`, {
          method: "POST",
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
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleDownload(file: RoomFile) {
    setError("");
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/files/${file.id}/download`);
      if (!res.ok) {
        setError(`下载失败: ${file.filename}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("网络错误");
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
            <button
              key={f.id}
              type="button"
              className="file-row"
              style={{ background: "none", border: "none", font: "inherit", color: "inherit", width: "100%", textAlign: "left", cursor: "pointer" }}
              onClick={() => handleDownload(f)}
            >
              <span>📄</span>
              <div className="file-row__info">
                <span className="file-row__name">{f.filename}</span>
                <small>{formatSize(f.size)} · {f.uploaded_by}</small>
              </div>
              <span className="file-row__download">↓</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
