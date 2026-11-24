"""Deployment control flow using fake tools; never contacts a server or database."""
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    "failure",
    ["none", "migration", "health", "docker_access", "compose_standalone",
     "archive", "pull_transient", "pull_exhausted"],
)
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
if [[ "$*" == "compose version" && "$FAILURE" == compose_standalone ]]; then exit 1; fi
if [[ "$*" == "info" && "$FAILURE" == docker_access ]]; then exit 1; fi
if [[ "$1 $2" == "image inspect" ]]; then
  [[ "$FAILURE" == compose_standalone || -f "$CALL_LOG.loaded" ]]
  exit $?
fi
if [[ "$1 $2" == "load -i" && "$FAILURE" == archive && "$3" == "$MAPR_IMAGE_ARCHIVE" ]]; then
  touch "$CALL_LOG.loaded"
fi
if [[ "$*" == "compose pull backend frontend" ]]; then
  if [[ "$FAILURE" == pull_exhausted ]]; then exit 1; fi
  if [[ "$FAILURE" == pull_transient && ! -f "$CALL_LOG.pull-failed" ]]; then
    touch "$CALL_LOG.pull-failed"
    exit 1
  fi
fi
if [[ "$*" == *"pg_dump"* ]]; then echo synthetic-backup; fi
if [[ "$*" == *"printenv POSTGRES_PASSWORD"* ]]; then echo synthetic_password; fi
if [[ "$*" == *"ps -q backend" ]]; then echo backend-container; fi
if [[ "$*" == *"ps -q frontend" ]]; then echo frontend-container; fi
if [[ "$1" == inspect && "$*" == *HostConfig.PortBindings* ]]; then echo 18180
elif [[ "$1" == inspect ]]; then echo sha256:synthetic-previous-image; fi
if [[ "$*" == *"alembic"* && "$FAILURE" == migration ]]; then exit 7; fi
'''
    for name, content in {
        "docker": fake_docker,
        "docker-compose": '#!/usr/bin/env bash\nif [[ "$1" == version ]]; then exit 0; fi\nexec docker compose "$@"\n',
        "curl": '#!/usr/bin/env bash\necho "curl $*" >> "$CALL_LOG"\n[[ "$FAILURE" != health ]]\n',
        "sleep": '#!/usr/bin/env bash\necho "sleep $*" >> "$CALL_LOG"\n',
    }.items():
        script = bin_dir / name
        script.write_text(content)
        script.chmod(0o700)
    env = {
        **os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "MAPR_DEPLOY_DIR": str(target), "IMAGE_TAG": "a" * 40,
        "VITE_XMTP_WORKER_ADDRESS": "0x" + "1" * 40, "VITE_XMTP_ENV": "dev",
        "GITHUB_WORKSPACE": str(ROOT), "CALL_LOG": str(log), "FAILURE": failure,
        "MAPR_IMAGE_ARCHIVE": "", "MAPR_PULL_RETRIES": "", "MAPR_PULL_RETRY_DELAY": "",
    }
    if failure == "archive":
        archive = tmp_path / "release images.tar.gz"
        archive.touch()
        env["MAPR_IMAGE_ARCHIVE"] = str(archive)
    if failure == "pull_transient":
        env["MAPR_PULL_RETRIES"] = "2"
        env["MAPR_PULL_RETRY_DELAY"] = "7"
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
    if failure == "pull_exhausted":
        assert result.returncode != 0
        assert calls.count("compose pull backend frontend") == 3
        assert [line for line in calls.splitlines() if line.startswith("sleep ")] == ["sleep 5", "sleep 10"]
        assert "alembic" not in calls
        assert "stop backend" not in calls
        assert "images.yml up -d --no-build backend frontend" in calls
        assert "Restoring previous images" in result.stderr
        assert (target / "docker-compose.yml").read_text() == "# previous compose\n"
        assert (target / ".env").read_text() == "SYNTHETIC=1\n"
        return
    assert calls.index("pg_dump") < calls.index("alembic")
    assert calls.index("stop backend") < calls.index("alembic")
    if failure in ("none", "compose_standalone", "archive", "pull_transient"):
        assert result.returncode == 0, result.stderr
        assert "Deployment healthy" in result.stdout
        assert "VITE_XMTP_ENV=dev" in (target / ".env").read_text().splitlines()
        assert "MAPR_DATABASE_PASSWORD=synthetic_password" in (target / ".env").read_text().splitlines()
        assert "MAPR_FRONTEND_PORT=18180" in (target / ".env").read_text().splitlines()
        assert "http://127.0.0.1:18180/ready" in calls
        if failure == "compose_standalone":
            assert "pull backend frontend" not in calls
            assert "Using already downloaded immutable images" in result.stdout
        elif failure == "archive":
            assert f"load -i {archive}" in calls
            before_load, after_load = calls.split(f"load -i {archive}", 1)
            inspect = (
                "image inspect ghcr.io/wangdada8208/multi-agent-project-room-backend:" + env["IMAGE_TAG"]
                + " ghcr.io/wangdada8208/multi-agent-project-room-frontend:" + env["IMAGE_TAG"]
            )
            assert inspect in before_load and inspect in after_load
            assert "pull backend frontend" not in calls
        elif failure == "pull_transient":
            pull = "compose pull backend frontend"
            assert f"{pull}\nsleep 7\n{pull}\n" in calls
            assert calls.count(pull) == 2
            assert "images.yml up -d --no-build backend frontend" not in calls
            assert "Restoring previous images" not in result.stderr
        else:
            assert "pull backend frontend" in calls
    else:
        assert result.returncode != 0
        # Once a migration has been attempted, even its failure can leave a
        # changed schema. Never restart the old Hub against unverified data.
        assert "images.yml up -d --no-build backend frontend" not in calls
        assert calls.strip().endswith("compose stop backend")
        assert "Backend remains stopped" in result.stderr
        assert (backup / "docker-compose.yml").read_text() == "# previous compose\n"
        assert (backup / ".env").read_text() == "SYNTHETIC=1\n"
        assert "Database is not automatically downgraded" in result.stderr


def test_deploy_script_syncs_optional_auth_env_and_preserves_backslashes(tmp_path):
    target = tmp_path / "server"
    target.mkdir()
    (target / ".env").write_text(
        "SYNTHETIC=1\nMAPR_SMTP_PASSWORD=old-pw\nMAPR_EMAIL_FROM_NAME=Existing\n"
    )
    (target / "docker-compose.yml").write_text("# previous compose\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    fake_docker = '''#!/usr/bin/env bash
echo "$*" >> "$CALL_LOG"
if [[ "$1 $2" == "image inspect" ]]; then exit 1; fi
if [[ "$*" == *"pg_dump"* ]]; then echo synthetic-backup; fi
if [[ "$*" == *"printenv POSTGRES_PASSWORD"* ]]; then echo synthetic_password; fi
if [[ "$*" == *"ps -q backend" ]]; then echo backend-container; fi
if [[ "$*" == *"ps -q frontend" ]]; then echo frontend-container; fi
if [[ "$1" == inspect && "$*" == *HostConfig.PortBindings* ]]; then echo 18180
elif [[ "$1" == inspect ]]; then echo sha256:synthetic-previous-image; fi
'''
    for name, content in {
        "docker": fake_docker,
        "curl": '#!/usr/bin/env bash\nexit 0\n',
        "sleep": '#!/usr/bin/env bash\nexit 0\n',
    }.items():
        script = bin_dir / name
        script.write_text(content)
        script.chmod(0o700)

    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "MAPR_DEPLOY_DIR": str(target),
        "IMAGE_TAG": "b" * 40,
        "VITE_XMTP_WORKER_ADDRESS": "0x" + "1" * 40,
        "VITE_XMTP_ENV": "production",
        "GITHUB_WORKSPACE": str(ROOT),
        "CALL_LOG": str(log),
        "MAPR_GOOGLE_CLIENT_ID": "cid-123.apps.googleusercontent.com",
        "MAPR_SMTP_PASSWORD": r"p@ss\1\2word",
        "MAPR_EMAIL_FROM_NAME": "",
    }
    result = subprocess.run(
        ["bash", str(ROOT / "scripts/deploy.sh")],
        env=env,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    env_lines = (target / ".env").read_text().splitlines()
    assert "MAPR_GOOGLE_CLIENT_ID=cid-123.apps.googleusercontent.com" in env_lines
    assert r"MAPR_SMTP_PASSWORD=p@ss\1\2word" in env_lines
    assert "MAPR_EMAIL_FROM_NAME=Existing" in env_lines
