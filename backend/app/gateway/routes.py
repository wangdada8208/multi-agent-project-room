"""Gateway module: health check endpoint."""
from fastapi import APIRouter
from app.core.database import check_database_connection

router = APIRouter(tags=["gateway"])


@router.get("/health")
async def health() -> dict:
    db_status = await check_database_connection()
    return {
        "status": "ok",
        "service": "Multi-Agent Project Room",
        "database": db_status,
    }
