"""Test Phase 2 Fictional Calendar Negotiation mechanics.

Covers:
1. FreeBusySlot normalization and MockCalendar private keyword extraction
2. Outbound filtering redacting private calendar details while keeping free slots
3. Outbound detection of unapproved day/time proposals
4. MessageLoop suspension upon boundary violation
5. MessageLoop safe resumption requiring matching ActionGrant scope
6. Structured two-party consensus verification (prevents single-agent forged consensus)
7. PrivateReportService generating audit report for owners
"""

import pytest

from app.collab.calendar_negotiation import (
    FreeBusySlot,
    CalendarEvent,
    MockCalendar,
    CalendarOutboundFilter,
    PrivateReportService,
    CandidateSlotProposal,
)
from app.collab.message_loop import MessageLoop, LoopStatus, TeamRole


def test_free_busy_slot_and_mock_calendar():
    """Scenario 1: Slot representation and MockCalendar keyword extraction."""
    slot = FreeBusySlot(day_of_week="Wednesday", start_time="14:00", end_time="16:00")
    assert slot.slot_key() == "wednesday_14:00_16:00"
    assert slot.to_dict() == {
        "day_of_week": "Wednesday",
        "start_time": "14:00",
        "end_time": "16:00",
    }

    event1 = CalendarEvent(
        event_id="e1",
        title="Doctor Appointment with Dr. Smith",
        notes="Private checkup at clinic",
        location="Room 302 Medical Center",
        participants=["Alice", "Dr. Smith"],
        day_of_week="Wednesday",
        start_time="10:00",
        end_time="11:30",
    )
    cal = MockCalendar(events=[event1])
    keywords = cal.get_private_keywords()
    assert "Doctor Appointment with Dr. Smith" in keywords
    assert "Room 302 Medical Center" in keywords


def test_calendar_outbound_filter_redacts_private_details():
    """Scenario 2: Outbound filter strips private titles/locations, preserves slots."""
    approved_slots = [
        FreeBusySlot(day_of_week="Wednesday", start_time="14:00", end_time="16:00")
    ]
    sensitive_keywords = [
        "Doctor Appointment with Dr. Smith",
        "Room 302 Medical Center",
    ]

    # Model tried to leak private context in output
    raw_message = (
        "I can meet on Wednesday 14:00-16:00 after my Doctor Appointment with Dr. Smith "
        "near Room 302 Medical Center."
    )

    filtered = CalendarOutboundFilter.filter_message(
        content=raw_message,
        approved_slots=approved_slots,
        sensitive_keywords=sensitive_keywords,
    )

    assert "Doctor Appointment with Dr. Smith" not in filtered
    assert "Room 302 Medical Center" not in filtered
    assert "[REDACTED]" in filtered
    assert "Wednesday 14:00-16:00" in filtered


def test_calendar_outbound_filter_detects_unapproved_proposals():
    """Scenario 3: Filter detects proposals for unauthorized days."""
    approved_slots = [
        FreeBusySlot(day_of_week="Wednesday", start_time="14:00", end_time="16:00")
    ]

    # Content proposing authorized day: not detected
    assert CalendarOutboundFilter.detect_unapproved_proposal("How about Wednesday 14:00?", approved_slots) is None
    assert CalendarOutboundFilter.detect_unapproved_proposal("周三下午两点合适吗？", approved_slots) is None

    # Content proposing unauthorized day (Thursday): detected
    unapproved = CalendarOutboundFilter.detect_unapproved_proposal("Can we reschedule to Thursday 10:00?", approved_slots)
    assert unapproved == "thursday"

    unapproved_zh = CalendarOutboundFilter.detect_unapproved_proposal("我们改到周四上午碰头吧", approved_slots)
    assert unapproved_zh == "周四"


def test_message_loop_suspension_on_boundary_hit():
    """Scenario 4: Loop suspends when boundary violation occurs."""
    role_a = TeamRole(name="AliceAgent", agent_name="Codex", responsibilities=["negotiate"])
    role_b = TeamRole(name="BobAgent", agent_name="Claude", responsibilities=["negotiate"])
    loop = MessageLoop(topic="Schedule Meeting", participants=[role_a, role_b])

    assert loop.status == LoopStatus.PENDING

    # Boundary violated: suspend loop
    loop.suspend(
        reason="Peer proposed Thursday outside authorized Wednesday boundary",
        required_scope="calendar:expand_slots",
    )

    assert loop.status == LoopStatus.SUSPENDED
    assert "Peer proposed Thursday" in loop.suspension_reason
    assert loop.required_grant_scope == "calendar:expand_slots"


def test_message_loop_resumes_only_with_matching_grant():
    """Scenario 5: Loop resumes only when valid grant matching required scope is provided."""
    loop = MessageLoop(topic="Schedule Meeting")
    loop.suspend(
        reason="Needs Thursday authorization",
        required_scope="calendar:expand_slots",
    )

    # Resume with wrong scope: raises ValueError
    with pytest.raises(ValueError, match="Cannot resume loop without valid grant"):
        loop.resume(grant={"scope": "unrelated:scope"})

    assert loop.status == LoopStatus.SUSPENDED

    # Resume with matching grant: succeeds
    resumed = loop.resume(grant={"scope": "calendar:expand_slots"})
    assert resumed is True
    assert loop.status == LoopStatus.ACTIVE
    assert loop.suspension_reason is None
    assert loop.required_grant_scope is None


def test_structured_consensus_requires_two_party_confirmation():
    """Scenario 6: Consensus requires two distinct agents confirming exact slot."""
    loop = MessageLoop(topic="Schedule Meeting")

    # Step 1: Codex proposes Wednesday 14:00-15:00
    proposal = loop.propose_slot("Codex", "Wednesday 14:00-15:00")
    assert proposal.slot_text == "Wednesday 14:00-15:00"
    assert loop.status != LoopStatus.CONSENSUS

    # Single agent self-confirming cannot trigger consensus
    self_confirm = loop.confirm_slot("Codex", "Wednesday 14:00-15:00")
    assert self_confirm is False
    assert loop.status != LoopStatus.CONSENSUS

    # Different slot text does not confirm
    wrong_slot = loop.confirm_slot("Claude", "Thursday 10:00-11:00")
    assert wrong_slot is False
    assert loop.status != LoopStatus.CONSENSUS

    # Second distinct agent confirms exact slot: consensus reached!
    two_party_confirm = loop.confirm_slot("Claude", "Wednesday 14:00-15:00")
    assert two_party_confirm is True
    assert loop.status == LoopStatus.CONSENSUS
    assert "结构化双向共识" in loop.consensus_summary


def test_private_report_service_generation():
    """Scenario 7: PrivateReportService generates structured audit report."""
    approved_slots = [
        FreeBusySlot(day_of_week="Wednesday", start_time="14:00", end_time="16:00")
    ]

    report = PrivateReportService.generate_report(
        loop_id="loop-123",
        owner_id="user-alice",
        agreed_slot="Wednesday 14:00-15:00",
        participants=["Codex", "Claude"],
        approved_disclosures=approved_slots,
        unresolved_items=["Send formal calendar invite via owner mail"],
        rounds_used=4,
        consensus_status="confirmed",
    )

    assert report.report_id is not None
    assert report.owner_id == "user-alice"
    assert report.agreed_time_slot == "Wednesday 14:00-15:00"
    assert report.rounds_used == 4
    assert len(report.approved_disclosures) == 1
    assert report.approved_disclosures[0]["day_of_week"] == "Wednesday"

    d = report.to_dict()
    assert d["consensus_status"] == "confirmed"
    assert d["agreed_time_slot"] == "Wednesday 14:00-15:00"
