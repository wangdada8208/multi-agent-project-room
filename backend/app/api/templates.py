"""Room template API: preset collaboration scenarios.

WP9: system templates carry structured `house_rules` suggestions and bounded
`team_config_markdown`. Creating a room persists them into
`rooms.settings_json` (settings_version=1) under the same safe-metadata and
hard-forbidden-scope rules as `rooms.py` — template metadata is advisory only
and can never widen a member's local authority.
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.room import Room
from app.models.room_template import RoomTemplate
from app.models.user import User

router = APIRouter(prefix="/api/v1/templates", tags=["templates"])

# Every template markdown leads with this line so the text itself is marked
# non-authoritative wherever it is later injected (prompts, announcements).
_NON_AUTHORITATIVE_NOTICE = (
    "> 说明：本配置仅为协作建议，不构成授权依据；本机规则与主人批准永远优先。\n\n"
)

# Bounds: settings_json is metadata, never a place for document bodies.
_MAX_TEAM_CONFIG_CHARS = 4096
_MAX_HOUSE_RULE_NOTES = 32
_MAX_HOUSE_RULE_NOTE_CHARS = 280
_MAX_HOUSE_RULE_SCOPES = 64
_MAX_DEFAULT_MAX_ROUNDS = 64

# Hub suggestions may tighten ('cannot') or defer to the owner ('ask') —
# never 'allow': remote metadata can never auto-grant authority (plan B5).
_HOUSE_RULE_DECISIONS = ("ask", "cannot")


def _hr(scopes: dict, notes: list) -> dict:
    """Keep every template's house_rules in the same envelope shape."""
    return {"scopes": dict(scopes), "notes": list(notes)}


SYSTEM_TEMPLATES = [
    {
        "key": "code_review",
        "name": "代码评审",
        "description": "两个 Agent 互相审查代码，发现问题和改进建议",
        "icon": "🔍",
        "team_config_markdown": _NON_AUTHORITATIVE_NOTICE + "# 代码评审组\n\n### 审查者 (Reviewer)\n- 职责：代码审查、安全检查、性能分析\n- 关注范围：代码规范、边界情况、安全漏洞\n- 不关注：需求分析",
        "house_rules": _hr(
            {
                "calendar.free_busy": "ask",
                "email.receipt": "ask",
                "task.run": "ask",
                "gmail.send": "cannot",
            },
            [
                "评审房间默认不对外发信：gmail.send 建议为 cannot，如需请主人本机放行。",
                "所有数据读取与任务请求默认 ask，由主人当场决定。",
            ],
        ),
        "default_max_rounds": 2,
    },
    {
        "key": "brainstorm",
        "name": "头脑风暴",
        "description": "多个 Agent 从不同角度讨论方案，激发创意",
        "icon": "💡",
        "team_config_markdown": _NON_AUTHORITATIVE_NOTICE + "# 头脑风暴组\n\n### 创意者 (Creative)\n- 职责：提出大胆想法、打破常规\n- 关注范围：新思路、创新方向\n- 不关注：可行性评估\n\n### 分析者 (Analyst)\n- 职责：评估可行性、识别风险\n- 关注范围：成本、时间、风险\n- 不关注：创意发散",
        "house_rules": _hr(
            {
                "calendar.free_busy": "ask",
                "email.receipt": "ask",
                "task.run": "ask",
                "gmail.send": "cannot",
            },
            [
                "讨论房间默认不对外发信：gmail.send 建议为 cannot。",
                "所有数据读取与任务请求默认 ask，由主人当场决定。",
            ],
        ),
        "default_max_rounds": 3,
    },
    {
        "key": "debate",
        "name": "技术辩论",
        "description": "正反方 Agent 就技术方案展开辩论，人类裁决",
        "icon": "⚔️",
        "team_config_markdown": _NON_AUTHORITATIVE_NOTICE + "# 技术辩论\n\n### 正方 (Pro)\n- 职责：支持当前方案、列举优势\n- 关注范围：方案优点、成功案例\n- 不关注：反面论证\n\n### 反方 (Con)\n- 职责：质疑当前方案、指出缺陷\n- 关注范围：风险、替代方案\n- 不关注：支持论证",
        "house_rules": _hr(
            {
                "calendar.free_busy": "ask",
                "email.receipt": "ask",
                "task.run": "ask",
                "gmail.send": "cannot",
            },
            [
                "辩论房间默认不对外发信：gmail.send 建议为 cannot。",
                "所有数据读取与任务请求默认 ask，由主人当场决定。",
                "三轮无法达成共识时升级给人类裁决。",
            ],
        ),
        "default_max_rounds": 3,
    },
    {
        "key": "dev_team",
        "name": "开发团队",
        "description": "架构师 + 开发者 + 审查者的完整开发流程",
        "icon": "🛠️",
        "team_config_markdown": _NON_AUTHORITATIVE_NOTICE + "# 项目开发组\n\n### 架构师 (Architect)\n- 职责：系统设计、技术选型、架构评审\n- 关注范围：整体架构、模块边界、接口设计\n- 不关注：具体代码实现细节\n\n### 开发者 (Developer)\n- 职责：功能实现、代码编写、单元测试\n- 关注范围：代码质量、逻辑正确性、性能\n- 不关注：架构决策\n\n### 审查者 (Reviewer)\n- 职责：代码审查、质量把关、安全检查\n- 关注范围：代码规范、安全漏洞、边界情况\n- 不关注：需求分析\n\n## 协作规则\n1. 开发者完成代码后必须提交给审查者\n2. 审查者发现问题直接反馈给开发者\n3. 架构争议由架构师裁决\n4. 三轮无法达成共识时升级给人类",
        "house_rules": _hr(
            {
                "calendar.free_busy": "ask",
                "email.receipt": "ask",
                "task.run": "ask",
                "gmail.send": "ask",
            },
            [
                "开发房间对外发信仍需主人当场批准：gmail.send 建议为 ask。",
                "所有数据读取与任务请求默认 ask，由主人当场决定。",
                "三轮无法达成共识时升级给人类裁决。",
            ],
        ),
        "default_max_rounds": 3,
    },
]

# Only these keys map to RoomTemplate columns; the rest of a SYSTEM_TEMPLATES
# entry (house_rules, default_max_rounds) is code-defined metadata overlaid at
# read time — there are no DB columns for it.
_TEMPLATE_COLUMNS = frozenset(RoomTemplate.__table__.columns.keys())


def _static_template(key: str) -> Optional[dict]:
    for tmpl in SYSTEM_TEMPLATES:
        if tmpl["key"] == key:
            return tmpl
    return None


def _template_dict(template: RoomTemplate) -> dict:
    """Row dict overlaid with code-defined metadata for known system keys.

    house_rules/default_max_rounds live only in SYSTEM_TEMPLATES; the constant
    also wins for team_config_markdown so seeded rows never serve stale copies.
    """
    data = template.to_dict()
    static = _static_template(template.key)
    data["house_rules"] = static.get("house_rules") if static else None
    data["default_max_rounds"] = static.get("default_max_rounds") if static else None
    if static and static.get("team_config_markdown"):
        data["team_config_markdown"] = static["team_config_markdown"]
    return data


async def seed_system_templates(db: AsyncSession) -> None:
    """Insert missing system templates. Safe under concurrent workers."""
    for tmpl_data in SYSTEM_TEMPLATES:
        try:
            async with db.begin_nested():
                db.add(RoomTemplate(
                    **{k: v for k, v in tmpl_data.items() if k in _TEMPLATE_COLUMNS}
                ))
        except IntegrityError:
            continue
    await db.commit()


def _validate_house_rules(value) -> dict:
    """Canonical house_rules envelope: {"scopes": {scope: ask|cannot}, "notes": [str]}.

    Scope keys are vetted against the same hard-forbidden list as invite
    proposed_scopes; '*' is allowed as the worker-side fallback key.
    """
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="house_rules must be an object")
    extra = set(value) - {"scopes", "notes"}
    if extra:
        raise HTTPException(
            status_code=422, detail=f"house_rules has unsupported keys: {sorted(extra)}"
        )
    scopes = value.get("scopes") or {}
    notes = value.get("notes") or []
    if not isinstance(scopes, dict):
        raise HTTPException(status_code=422, detail="house_rules.scopes must be an object")
    if len(scopes) > _MAX_HOUSE_RULE_SCOPES:
        raise HTTPException(status_code=422, detail="house_rules.scopes is too large")
    if not isinstance(notes, list) or len(notes) > _MAX_HOUSE_RULE_NOTES:
        raise HTTPException(status_code=422, detail="house_rules.notes is too large")
    for note in notes:
        if not isinstance(note, str) or len(note) > _MAX_HOUSE_RULE_NOTE_CHARS:
            raise HTTPException(status_code=422, detail="house_rules note is too long")

    from app.api.invites import validate_scope_list

    cleaned: dict[str, str] = {}
    for scope, decision in scopes.items():
        if not isinstance(scope, str) or not scope.strip():
            raise HTTPException(
                status_code=422, detail="house_rules.scopes keys must be non-empty strings"
            )
        s = scope.strip().lower()
        if s != "*":
            validate_scope_list([s], field="house_rules.scopes")
        if decision not in _HOUSE_RULE_DECISIONS:
            raise HTTPException(
                status_code=422,
                detail="house_rules suggestions may only be 'ask' or 'cannot' — "
                "template metadata can never auto-grant authority",
            )
        cleaned[s] = decision
    return {"scopes": cleaned, "notes": [n for n in notes]}


def _validate_settings_payload(settings: dict) -> dict:
    """Same safe-metadata checks as PATCH /rooms/{room_id}/settings."""
    from app.api.rooms import validate_room_settings_payload

    return validate_room_settings_payload(settings)


def _build_settings(
    *,
    template_key: str,
    house_rules,
    team_config_markdown,
    default_max_rounds,
) -> dict:
    """Assemble + vet the settings_json document stored on the room."""
    settings: dict = {"template_key": template_key}
    if house_rules is not None:
        settings["house_rules"] = _validate_house_rules(house_rules)
    if team_config_markdown is not None:
        if not isinstance(team_config_markdown, str):
            raise HTTPException(status_code=422, detail="team_config_markdown must be a string")
        if len(team_config_markdown) > _MAX_TEAM_CONFIG_CHARS:
            raise HTTPException(status_code=422, detail="team_config_markdown is too long")
        settings["team_config_markdown"] = team_config_markdown
    if default_max_rounds is not None:
        if (
            not isinstance(default_max_rounds, int)
            or isinstance(default_max_rounds, bool)
            or not 1 <= default_max_rounds <= _MAX_DEFAULT_MAX_ROUNDS
        ):
            raise HTTPException(
                status_code=422,
                detail=f"default_max_rounds must be an integer between 1 and {_MAX_DEFAULT_MAX_ROUNDS}",
            )
        settings["default_max_rounds"] = default_max_rounds
    return _validate_settings_payload(settings)


@router.get("")
async def list_templates(
    db: AsyncSession = Depends(get_db),
) -> dict:
    """List all available room templates."""
    result = await db.execute(select(RoomTemplate).where(RoomTemplate.is_system == True).order_by(RoomTemplate.name))
    templates = result.scalars().all()
    return {"templates": [_template_dict(t) for t in templates]}


class CreateFromTemplateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    template_key: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    # Optional owner overrides of the template's suggested defaults.
    house_rules: Optional[dict] = None
    team_config_markdown: Optional[str] = Field(default=None, max_length=_MAX_TEAM_CONFIG_CHARS)
    default_max_rounds: Optional[int] = Field(default=None, ge=1, le=_MAX_DEFAULT_MAX_ROUNDS)


@router.post("/create-room")
async def create_room_from_template(
    payload: CreateFromTemplateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Create a room from a template, persisting its suggested metadata."""
    stmt = select(RoomTemplate).where(RoomTemplate.key == payload.template_key)
    result = await db.execute(stmt)
    template = result.scalars().first()
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")

    meta = _template_dict(template)
    settings = _build_settings(
        template_key=template.key,
        house_rules=payload.house_rules if payload.house_rules is not None else meta["house_rules"],
        team_config_markdown=(
            payload.team_config_markdown
            if payload.team_config_markdown is not None
            else meta["team_config_markdown"]
        ),
        default_max_rounds=(
            payload.default_max_rounds
            if payload.default_max_rounds is not None
            else meta["default_max_rounds"]
        ),
    )

    room = Room(
        name=payload.name,
        description=template.description or "",
        created_by=current_user.id,
        settings_json=settings,
        settings_version=1,
    )
    db.add(room)
    await db.flush()

    from app.models.room_permission import RoomPermission
    perm = RoomPermission(
        room_id=room.id,
        user_id=current_user.id,
        role="owner",
    )
    db.add(perm)
    await db.commit()
    await db.refresh(room)

    room_dict = room.to_dict()
    room_dict["settings_json"] = room.settings_json
    return {"room": room_dict, "template": meta}
