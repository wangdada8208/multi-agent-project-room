"""Regression tests for GitService status parsing.

The live smoke check on 2026-11-12 found that `/api/v1/rooms/{id}/git/status`
reported a modified file as `MOKE.md` instead of `SMOKE.md`. `_git()` used
`stdout.strip()`, which removed the leading space of the first
`git status --short` line (" M SMOKE.md"), and `changes()` then sliced
`line[3:]` off by one character.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from app.repository.service import GitService


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )


def _init_repo(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-b", "fixture")
    _git(repo, "config", "user.name", "Fixture")
    _git(repo, "config", "user.email", "fixture@example.invalid")
    (repo / "SMOKE.md").write_text("baseline\n", encoding="utf-8")
    _git(repo, "add", "SMOKE.md")
    _git(repo, "commit", "-m", "fixture baseline")


def test_unstaged_change_keeps_full_filename(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    (repo / "SMOKE.md").write_text("changed\n", encoding="utf-8")

    raw = GitService(repo)._git("status", "--short")
    assert raw.startswith(" M SMOKE.md"), raw
    assert GitService(repo).changes() == [{"path": "SMOKE.md", "status": "M"}]


def test_status_endpoint_fields_use_full_filename(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    (repo / "SMOKE.md").write_text("changed\n", encoding="utf-8")

    status = GitService(repo).status()
    assert status["branch"] == "fixture"
    assert [c["path"] for c in status["changes"]] == ["SMOKE.md"]
    assert status["last_commit"]["message"] == "fixture baseline"


def test_staged_and_untracked_files_are_not_truncated(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    (repo / "SMOKE.md").write_text("staged change\n", encoding="utf-8")
    _git(repo, "add", "SMOKE.md")
    (repo / "NEW.md").write_text("untracked\n", encoding="utf-8")

    changes = {c["path"]: c["status"] for c in GitService(repo).changes()}
    assert changes.get("SMOKE.md") == "M"
    assert changes.get("NEW.md") == "??"


def test_diff_still_reports_full_filename(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    (repo / "SMOKE.md").write_text("changed\n", encoding="utf-8")

    assert GitService(repo).diff()["files"] == [{"status": "M", "path": "SMOKE.md"}]
