"""Gateway module: health check endpoint."""
from fastapi import APIRouter
from app.core.database import check_database_connection
from app.config import get_settings

router = APIRouter(tags=["gateway"])
settings = get_settings()


@router.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "Multi-Agent Project Room",
    }


@router.get("/health/details")
async def health_details() -> dict:
    db_status = await check_database_connection()
    return {
        "status": "ok",
        "service": "Multi-Agent Project Room",
        "version": "1.0.0",
        "a2a_protocol_version": settings.a2a_protocol_version,
        "a2a_public_url": settings.a2a_public_url,
        "database": db_status,
    }
