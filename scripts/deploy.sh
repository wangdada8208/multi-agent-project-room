#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${IMAGE_TAG:?An immutable image tag is required}"
[[ "$IMAGE_TAG" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid image tag' >&2; exit 1; }
docker info >/dev/null || { echo 'Runner requires configured Docker access; socket permissions will not be changed.' >&2; exit 1; }
docker compose version >/dev/null
target=${MAPR_DEPLOY_DIR:-/opt/multi-agent-project-room}
[[ -f "$target/.env" && -f "$target/docker-compose.yml" ]] || { echo 'Initialize server configuration separately before deploying.' >&2; exit 1; }
backup="$target/backups/$(date -u +%Y%m%dT%H%M%SZ)-$IMAGE_TAG"
mkdir -p "$backup"
cp "$target/docker-compose.yml" "$backup/docker-compose.yml"
cp "$target/.env" "$backup/.env"
chmod 600 "$backup/.env"
cd "$target"
docker compose exec -T postgres pg_dump -U postgres -d agent_room -Fc > "$backup/database.dump"
[[ -s "$backup/database.dump" ]] || { echo 'Database backup is empty' >&2; exit 1; }
# Preserve the exact running images, independent of mutable latest tags.
backend_id=$(docker compose ps -q backend)
frontend_id=$(docker compose ps -q frontend)
[[ -n "$backend_id" && -n "$frontend_id" ]] || { echo 'No running release to roll back to' >&2; exit 1; }
backend_image=$(docker inspect --format '{{.Image}}' "$backend_id")
frontend_image=$(docker inspect --format '{{.Image}}' "$frontend_id")
printf 'services:\n  backend:\n    image: %s\n  frontend:\n    image: %s\n' "$backend_image" "$frontend_image" > "$backup/images.yml"
rollback() {
  echo "Deployment failed. Restoring previous images; database backup: $backup/database.dump" >&2
  cp "$backup/docker-compose.yml" "$target/docker-compose.yml"
  cp "$backup/.env" "$target/.env"
  docker compose -f docker-compose.yml -f "$backup/images.yml" up -d --no-build backend frontend || echo 'Image rollback failed; operator intervention required.' >&2
  echo 'Database is not automatically downgraded. Review migration compatibility before restoring data.' >&2
}
trap rollback ERR
# Preserve current credentials; configure only the public build/Compose fields.
python3 - <<'PYCONFIG'
import os, re, subprocess
from pathlib import Path
p = Path('.env')
raw = p.read_text()
address = os.environ.get('VITE_XMTP_WORKER_ADDRESS', '')
xmtp_env = os.environ.get('VITE_XMTP_ENV', '')
if not re.fullmatch(r'0x[0-9a-fA-F]{40}', address) or xmtp_env not in ('dev', 'production', 'local'):
    raise SystemExit('Valid public worker address and matching XMTP environment required')
values = {'VITE_XMTP_WORKER_ADDRESS': address, 'VITE_XMTP_ENV': xmtp_env}
if not re.search(r'^MAPR_DATABASE_PASSWORD=.+$', raw, re.M):
    password = subprocess.check_output(['docker', 'compose', 'exec', '-T', 'postgres', 'printenv', 'POSTGRES_PASSWORD'], text=True).strip()
    if not re.fullmatch(r'[A-Za-z0-9_~.-]+', password):
        raise SystemExit('Existing database password requires explicit URI encoding; refusing to change it')
    values['MAPR_DATABASE_PASSWORD'] = password
for key, value in values.items():
    raw = re.sub(r'^' + key + r'=.*$', key + '=' + value, raw, flags=re.M) if re.search(r'^' + key + '=', raw, re.M) else raw.rstrip() + '\n' + key + '=' + value + '\n'
temp = p.with_suffix('.release.tmp')
temp.write_text(raw)
temp.chmod(0o600)
temp.replace(p)
PYCONFIG
cp "$GITHUB_WORKSPACE/docker-compose.yml" "$target/docker-compose.yml"
docker compose config --quiet
docker compose pull backend frontend
docker compose run --rm --no-deps backend python3 -m alembic -c /app/alembic.ini upgrade head
docker compose up -d --no-build backend frontend
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 5 http://127.0.0.1:5173/health >/dev/null; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]] || { echo 'Health check failed' >&2; false; }
trap - ERR
echo "Deployment healthy. Backup retained at $backup"
