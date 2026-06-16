"""Knowledge document service."""

from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.knowledge.models import KnowledgeDoc


def _snippet(content: str, query: str, size: int = 120) -> str:
    index = content.lower().find(query.lower())
    if index < 0:
        return content[:size]
    start = max(index - 40, 0)
    end = min(index + len(query) + 80, len(content))
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(content) else ""
    return f"{prefix}{content[start:end]}{suffix}"


async def create_doc(
    db: AsyncSession,
    room_id: str,
    title: str,
    content: str,
    author_id: str | None = None,
) -> KnowledgeDoc:
    doc = KnowledgeDoc(
        room_id=room_id,
        title=title,
        content=content,
        author_id=author_id,
    )
    db.add(doc)
    await db.commit()
    await db.refresh(doc)
    return doc


async def list_docs(db: AsyncSession, room_id: str) -> list[KnowledgeDoc]:
    result = await db.execute(
        select(KnowledgeDoc)
        .where(KnowledgeDoc.room_id == room_id)
        .order_by(KnowledgeDoc.updated_at.desc())
    )
    return list(result.scalars().all())


async def get_doc(db: AsyncSession, room_id: str, doc_id: str) -> KnowledgeDoc | None:
    result = await db.execute(
        select(KnowledgeDoc).where(
            KnowledgeDoc.room_id == room_id,
            KnowledgeDoc.id == doc_id,
        )
    )
    return result.scalars().first()


async def search_docs(db: AsyncSession, room_id: str, query: str) -> list[dict]:
    result = await db.execute(
        select(KnowledgeDoc)
        .where(
            KnowledgeDoc.room_id == room_id,
            or_(
                KnowledgeDoc.title.ilike(f"%{query}%"),
                KnowledgeDoc.content.ilike(f"%{query}%"),
            ),
        )
        .order_by(KnowledgeDoc.updated_at.desc())
        .limit(20)
    )
    return [
        {
            "id": doc.id,
            "title": doc.title,
            "snippet": _snippet(doc.content, query),
            "updated_at": doc.updated_at.isoformat(),
        }
        for doc in result.scalars().all()
    ]
