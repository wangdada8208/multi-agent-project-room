"""Room template API: preset collaboration scenarios."""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.room import Room
from app.models.room_template import RoomTemplate
from app.models.user import User

router = APIRouter(prefix="/api/v1/templates", tags=["templates"])

SYSTEM_TEMPLATES = [
    {
        "key": "code_review",
        "name": "代码评审",
        "description": "两个 Agent 互相审查代码，发现问题和改进建议",
        "icon": "🔍",
        "team_config_markdown": "# 代码评审组\n\n### 审查者 (Reviewer)\n- 职责：代码审查、安全检查、性能分析\n- 关注范围：代码规范、边界情况、安全漏洞\n- 不关注：需求分析",
    },
    {
        "key": "brainstorm",
        "name": "头脑风暴",
        "description": "多个 Agent 从不同角度讨论方案，激发创意",
        "icon": "💡",
        "team_config_markdown": "# 头脑风暴组\n\n### 创意者 (Creative)\n- 职责：提出大胆想法、打破常规\n- 关注范围：新思路、创新方向\n- 不关注：可行性评估\n\n### 分析者 (Analyst)\n- 职责：评估可行性、识别风险\n- 关注范围：成本、时间、风险\n- 不关注：创意发散",
    },
    {
        "key": "debate",
        "name": "技术辩论",
        "description": "正反方 Agent 就技术方案展开辩论，人类裁决",
        "icon": "⚔️",
        "team_config_markdown": "# 技术辩论\n\n### 正方 (Pro)\n- 职责：支持当前方案、列举优势\n- 关注范围：方案优点、成功案例\n- 不关注：反面论证\n\n### 反方 (Con)\n- 职责：质疑当前方案、指出缺陷\n- 关注范围：风险、替代方案\n- 不关注：支持论证",
    },
    {
        "key": "dev_team",
        "name": "开发团队",
        "description": "架构师 + 开发者 + 审查者的完整开发流程",
        "icon": "🛠️",
        "team_config_markdown": "# 项目开发组\n\n### 架构师 (Architect)\n- 职责：系统设计、技术选型、架构评审\n- 关注范围：整体架构、模块边界、接口设计\n- 不关注：具体代码实现细节\n\n### 开发者 (Developer)\n- 职责：功能实现、代码编写、单元测试\n- 关注范围：代码质量、逻辑正确性、性能\n- 不关注：架构决策\n\n### 审查者 (Reviewer)\n- 职责：代码审查、质量把关、安全检查\n- 关注范围：代码规范、安全漏洞、边界情况\n- 不关注：需求分析\n\n## 协作规则\n1. 开发者完成代码后必须提交给审查者\n2. 审查者发现问题直接反馈给开发者\n3. 架构争议由架构师裁决\n4. 三轮无法达成共识时升级给人类",
    },
]


@router.get("")
async def list_templates(
    db: AsyncSession = Depends(get_db),
) -> dict:
    """List all available room templates."""
    # Seed system templates if not present
    for tmpl_data in SYSTEM_TEMPLATES:
        existing = await db.execute(select(RoomTemplate).where(RoomTemplate.key == tmpl_data["key"]))
        if existing.scalars().first() is None:
            db.add(RoomTemplate(**tmpl_data))
    await db.commit()

    result = await db.execute(select(RoomTemplate).where(RoomTemplate.is_system == True).order_by(RoomTemplate.name))
    templates = result.scalars().all()
    return {"templates": [t.to_dict() for t in templates]}


class CreateFromTemplateRequest(BaseModel):
    template_key: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=120)


@router.post("/create-room")
async def create_room_from_template(
    payload: CreateFromTemplateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Create a room from a template."""
    stmt = select(RoomTemplate).where(RoomTemplate.key == payload.template_key)
    result = await db.execute(stmt)
    template = result.scalars().first()
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")

    room = Room(
        name=payload.name,
        description=template.description or "",
        created_by=current_user.id,
    )
    db.add(room)

    from app.models.room_permission import RoomPermission
    perm = RoomPermission(
        room_id=room.id,
        user_id=current_user.id,
        role="owner",
    )
    db.add(perm)
    await db.commit()
    await db.refresh(room)

    return {"room": room.to_dict(), "template": template.to_dict()}
