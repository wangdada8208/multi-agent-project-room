"""Room file upload/download API."""

from __future__ import annotations

import uuid
import logging
from pathlib import Path
from datetime import datetime, timezone

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from app.core.security import get_current_user
from app.models.user import User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/rooms/{room_id}/files", tags=["files"])

UPLOAD_DIR = Path(__file__).resolve().parents[3] / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB


class FileRecord:
    """In-memory file metadata (upgrade to DB model later)."""

    _store: dict[str, dict] = {}

    @classmethod
    def create(cls, room_id: str, filename: str, size: int, uploaded_by: str) -> dict:
        fid = str(uuid.uuid4())
        record = {
            "id": fid,
            "room_id": room_id,
            "filename": filename,
            "size": size,
            "uploaded_by": uploaded_by,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
        }
        cls._store[fid] = record
        return record

    @classmethod
    def list_for_room(cls, room_id: str) -> list[dict]:
        return [r for r in cls._store.values() if r["room_id"] == room_id]

    @classmethod
    def get(cls, fid: str) -> dict | None:
        return cls._store.get(fid)


@router.get("")
async def list_files(
    room_id: str,
    current_user: User = Depends(get_current_user),
) -> dict:
    files = FileRecord.list_for_room(room_id)
    return {"files": sorted(files, key=lambda f: f["uploaded_at"], reverse=True)}


@router.post("/upload")
async def upload_file(
    room_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
) -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

    room_upload_dir = UPLOAD_DIR / room_id
    room_upload_dir.mkdir(parents=True, exist_ok=True)

    safe_name = f"{uuid.uuid4().hex[:8]}_{file.filename}"
    file_path = room_upload_dir / safe_name

    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    record = FileRecord.create(
        room_id=room_id,
        filename=file.filename,
        size=len(content),
        uploaded_by=current_user.display_name or current_user.username,
    )
    logger.info("File uploaded: %s (%d bytes)", file.filename, len(content))
    return {"file": record}


@router.get("/{file_id}/download")
async def download_file(
    room_id: str,
    file_id: str,
    current_user: User = Depends(get_current_user),
):
    record = FileRecord.get(file_id)
    if not record or record["room_id"] != room_id:
        raise HTTPException(status_code=404, detail="File not found")

    room_dir = UPLOAD_DIR / room_id
    for p in room_dir.iterdir():
        if p.name.endswith(f"_{record['filename']}"):
            return FileResponse(p, filename=record["filename"])

    raise HTTPException(status_code=404, detail="File data missing on disk")
