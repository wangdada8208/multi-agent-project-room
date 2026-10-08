"""Deployment control flow using fake tools; never contacts a server or database."""
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("failure", ["none", "migration", "health", "docker_access"])
def test_deployment_backup_health_and_rollback(tmp_path, failure):
    target = tmp_path / "server"
    target.mkdir()
    (target / ".env").write_text("SYNTHETIC=1\n")
    (target / "docker-compose.yml").write_text("# previous compose\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    fake_docker = '''#!/usr/bin/env bash
echo "$*" >> "$CALL_LOG"
if [[ "$*" == "info" && "$FAILURE" == docker_access ]]; then exit 1; fi
if [[ "$*" == *"pg_dump"* ]]; then echo synthetic-backup; fi
if [[ "$*" == *"printenv POSTGRES_PASSWORD"* ]]; then echo synthetic_password; fi
if [[ "$*" == *"ps -q backend" ]]; then echo backend-container; fi
if [[ "$*" == *"ps -q frontend" ]]; then echo frontend-container; fi
if [[ "$1" == inspect ]]; then echo sha256:synthetic-previous-image; fi
if [[ "$*" == *"alembic"* && "$FAILURE" == migration ]]; then exit 7; fi
'''
    for name, content in {
        "docker": fake_docker,
        "curl": '#!/usr/bin/env bash\n[[ "$FAILURE" != health ]]\n',
        "sleep": '#!/usr/bin/env bash\nexit 0\n',
    }.items():
        script = bin_dir / name
        script.write_text(content)
        script.chmod(0o700)
    env = {
        **os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "MAPR_DEPLOY_DIR": str(target), "IMAGE_TAG": "a" * 40,
        "VITE_XMTP_WORKER_ADDRESS": "0x" + "1" * 40, "VITE_XMTP_ENV": "dev",
        "GITHUB_WORKSPACE": str(ROOT), "CALL_LOG": str(log), "FAILURE": failure,
    }
    result = subprocess.run(["bash", str(ROOT / "scripts/deploy.sh")],
                            env=env, text=True, capture_output=True)
    calls = log.read_text()
    if failure == "docker_access":
        assert result.returncode != 0
        assert "pg_dump" not in calls
        assert not (target / "backups").exists()
        return
    backup = next((target / "backups").iterdir())
    assert (backup / "database.dump").read_text().strip() == "synthetic-backup"
    assert (backup / "database.dump").stat().st_mode & 0o077 == 0
    assert calls.index("pg_dump") < calls.index("alembic")
    if failure == "none":
        assert result.returncode == 0, result.stderr
        assert "Deployment healthy" in result.stdout
        assert "VITE_XMTP_ENV=dev" in (target / ".env").read_text().splitlines()
        assert "MAPR_DATABASE_PASSWORD=synthetic_password" in (target / ".env").read_text().splitlines()
    else:
        assert result.returncode != 0
        assert (target / "docker-compose.yml").read_text() == "# previous compose\n"
        assert (target / ".env").read_text() == "SYNTHETIC=1\n"
        assert "images.yml up -d --no-build backend frontend" in calls
        assert "Database is not automatically downgraded" in result.stderr
