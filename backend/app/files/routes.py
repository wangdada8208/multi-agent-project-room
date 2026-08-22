"""Room file upload/download API with DB persistence."""

from __future__ import annotations

import uuid
import re
import logging
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from .models import RoomFile

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/rooms/{room_id}/files", tags=["files"])

UPLOAD_DIR = Path(__file__).resolve().parents[3] / "uploads"
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB


@router.get("")
async def list_files(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    stmt = (
        select(RoomFile)
        .where(RoomFile.room_id == room_id)
        .order_by(RoomFile.uploaded_at.desc())
    )
    result = await db.execute(stmt)
    records = result.scalars().all()
    return {"files": [r.to_dict() for r in records]}


@router.post("/upload")
async def upload_file(
    room_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

    # Sanitize filename to prevent path traversal
    clean_name = re.sub(r"[^a-zA-Z0-9._\-\u4e00-\u9fff]", "_", file.filename)
    if not clean_name or clean_name.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid filename")

    stored_name = f"{uuid.uuid4().hex[:12]}_{clean_name}"
    room_upload_dir = UPLOAD_DIR / room_id
    room_upload_dir.mkdir(parents=True, exist_ok=True)

    file_path = room_upload_dir / stored_name
    resolved = str(file_path.resolve())
    if not resolved.startswith(str(room_upload_dir.resolve())):
        raise HTTPException(status_code=400, detail="Path traversal detected")

    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    record = RoomFile(
        room_id=room_id,
        filename=clean_name,
        stored_name=stored_name,
        size=len(content),
        uploaded_by=current_user.display_name or current_user.username,
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)

    logger.info("File uploaded: %s (%d bytes) to room %s", clean_name, len(content), room_id[:8])
    return {"file": record.to_dict()}


@router.get("/{file_id}/download")
async def download_file(
    room_id: str,
    file_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    record = await db.get(RoomFile, file_id)
    if not record or record.room_id != room_id:
        raise HTTPException(status_code=404, detail="File not found")

    file_path = UPLOAD_DIR / room_id / record.stored_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File data missing on disk")

    return FileResponse(file_path, filename=record.filename)
