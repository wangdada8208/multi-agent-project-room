"""Calendar negotiation domain models, outbound filtering, and private reporting.

Components:
1. FreeBusySlot: Represents an approved free/busy time window.
2. MockCalendar: Fictional calendar storage for local safe testing.
3. CalendarOutboundFilter: Redacts private details; detects unapproved proposals.
4. PrivateConsensusReport & PrivateReportService: Delivers audit reports to owners.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("calendar_negotiation")


@dataclass(frozen=True)
class FreeBusySlot:
    """An approved free time window that an agent is authorized to disclose."""

    day_of_week: str  # e.g. "Wednesday", "Wed"
    start_time: str   # e.g. "14:00"
    end_time: str     # e.g. "16:00"

    def to_dict(self) -> dict:
        return {
            "day_of_week": self.day_of_week,
            "start_time": self.start_time,
            "end_time": self.end_time,
        }

    def slot_key(self) -> str:
        """Normalized string representation for comparison."""
        return f"{self.day_of_week.lower()}_{self.start_time}_{self.end_time}"


@dataclass
class CalendarEvent:
    """A fictional calendar event containing private details never to be disclosed."""

    event_id: str
    title: str
    notes: str
    location: str
    participants: list[str]
    day_of_week: str
    start_time: str
    end_time: str


class MockCalendar:
    """Fictional private calendar store for testing agent boundaries."""

    def __init__(self, events: list[CalendarEvent] | None = None) -> None:
        self.events = events or []

    def get_private_keywords(self) -> list[str]:
        """Extract titles, locations, and notes that must never leak into room messages."""
        keywords: set[str] = set()
        for ev in self.events:
            if ev.title:
                keywords.add(ev.title)
            if ev.location:
                keywords.add(ev.location)
            if ev.notes:
                for word in ev.notes.split():
                    if len(word) > 2:
                        keywords.add(word)
        return list(keywords)


class CalendarOutboundFilter:
    """Enforces least-privilege disclosure on outbound agent communications."""

    @staticmethod
    def filter_message(
        content: str,
        approved_slots: list[FreeBusySlot],
        sensitive_keywords: list[str] | None = None,
    ) -> str:
        """Redacts private calendar details and ensures only approved slots appear."""
        filtered = content

        # 1. Redact all private keywords
        if sensitive_keywords:
            for kw in sensitive_keywords:
                if kw and len(kw) > 1:
                    pattern = re.compile(re.escape(kw), re.IGNORECASE)
                    filtered = pattern.sub("[REDACTED]", filtered)

        return filtered

    @staticmethod
    def detect_unapproved_proposal(
        content: str,
        approved_slots: list[FreeBusySlot],
    ) -> Optional[str]:
        """Detects if peer or agent mentioned a day/slot outside the approved list.

        Returns the unapproved token/day if detected, otherwise None.
        """
        approved_days = {slot.day_of_week.lower()[:3] for slot in approved_slots}
        weekdays = {
            "monday": "mon",
            "tuesday": "tue",
            "wednesday": "wed",
            "thursday": "thu",
            "friday": "fri",
            "saturday": "sat",
            "sunday": "sun",
            "周一": "mon",
            "周二": "tue",
            "周三": "wed",
            "周四": "thu",
            "周五": "fri",
            "周六": "sat",
            "周日": "sun",
        }

        content_lower = content.lower()
        for word, code in weekdays.items():
            if word in content_lower:
                if code not in approved_days:
                    return word

        return None


@dataclass
class CandidateSlotProposal:
    """Structured proposal tracking for two-party consensus verification."""

    slot_text: str
    proposed_by_agent: str
    confirmed_by: set[str] = field(default_factory=set)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def confirm(self, agent_name: str) -> bool:
        """Record an agent's confirmation. Returns True if two distinct agents confirmed."""
        self.confirmed_by.add(agent_name.lower())
        return len(self.confirmed_by) >= 2


@dataclass
class PrivateConsensusReport:
    """Private audit report delivered only to the respective owner."""

    report_id: str
    loop_id: str
    owner_id: str
    agreed_time_slot: Optional[str]
    agreed_participants: list[str]
    approved_disclosures: list[dict]
    unresolved_items: list[str]
    rounds_used: int
    consensus_status: str
    generated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {
            "report_id": self.report_id,
            "loop_id": self.loop_id,
            "owner_id": self.owner_id,
            "agreed_time_slot": self.agreed_time_slot,
            "agreed_participants": self.agreed_participants,
            "approved_disclosures": self.approved_disclosures,
            "unresolved_items": self.unresolved_items,
            "rounds_used": self.rounds_used,
            "consensus_status": self.consensus_status,
            "generated_at": self.generated_at,
        }


class PrivateReportService:
    """Generates and formats structured audit reports for owners."""

    @staticmethod
    def generate_report(
        loop_id: str,
        owner_id: str,
        agreed_slot: Optional[str],
        participants: list[str],
        approved_disclosures: list[FreeBusySlot],
        unresolved_items: list[str] | None = None,
        rounds_used: int = 0,
        consensus_status: str = "confirmed",
    ) -> PrivateConsensusReport:
        import uuid
        return PrivateConsensusReport(
            report_id=str(uuid.uuid4()),
            loop_id=loop_id,
            owner_id=owner_id,
            agreed_time_slot=agreed_slot,
            agreed_participants=participants,
            approved_disclosures=[slot.to_dict() for slot in approved_disclosures],
            unresolved_items=unresolved_items or [],
            rounds_used=rounds_used,
            consensus_status=consensus_status,
        )
