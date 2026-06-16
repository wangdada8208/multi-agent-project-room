"""Read-only Git repository service."""

from __future__ import annotations

import subprocess
from pathlib import Path


class GitService:
    def __init__(self, repo_path: Path | None = None):
        self.repo_path = repo_path or Path(__file__).resolve().parents[3]

    def _git(self, *args: str) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "git command failed")
        return result.stdout.strip()

    def branch(self) -> dict:
        return {"branch": self._git("branch", "--show-current") or "detached"}

    def log(self, limit: int = 10) -> list[dict]:
        raw = self._git(
            "log",
            f"-{limit}",
            "--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s",
            "--date=iso-strict",
        )
        if not raw:
            return []
        commits = []
        for line in raw.splitlines():
            commit_hash, author, email, date, message = line.split("\x1f", 4)
            commits.append(
                {
                    "hash": commit_hash,
                    "short_hash": commit_hash[:7],
                    "author": author,
                    "email": email,
                    "date": date,
                    "message": message,
                }
            )
        return commits

    def changes(self) -> list[dict]:
        raw = self._git("status", "--short")
        changes = []
        for line in raw.splitlines():
            status = line[:2].strip() or "modified"
            path = line[3:]
            changes.append({"path": path, "status": status})
        return changes

    def diff(self) -> dict:
        files_raw = self._git("diff", "--name-status")
        files = []
        for line in files_raw.splitlines():
            parts = line.split("\t", 1)
            if len(parts) == 2:
                files.append({"status": parts[0], "path": parts[1]})
        return {"files": files, "patch": self._git("diff", "--stat")}

    def status(self) -> dict:
        commits = self.log(limit=1)
        return {
            "branch": self.branch()["branch"],
            "changes": self.changes(),
            "last_commit": commits[0] if commits else None,
        }
