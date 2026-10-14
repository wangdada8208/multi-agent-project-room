"""Gateway module: health check endpoint."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import check_database_connection, check_database_readiness, get_db
from app.config import get_settings

router = APIRouter(tags=["gateway"])
settings = get_settings()


@router.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "Multi-Agent Project Room",
    }


@router.get("/ready")
async def readiness(db: AsyncSession = Depends(get_db)) -> JSONResponse:
    db_ready = await check_database_readiness(db)
    if db_ready.get("status") == "ready":
        return JSONResponse(
            status_code=200,
            content={
                "status": "ready",
                "service": "Multi-Agent Project Room",
                "database": "connected",
                "revision": db_ready.get("revision"),
            },
        )
    return JSONResponse(
        status_code=503,
        content={
            "status": "not ready",
            "service": "Multi-Agent Project Room",
            "database": "unavailable",
            "code": db_ready.get("code", "DATABASE_UNAVAILABLE"),
            "reason": db_ready.get("reason"),
        },
    )


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
