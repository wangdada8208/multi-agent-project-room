#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${IMAGE_TAG:?An immutable image tag is required}"
[[ "$IMAGE_TAG" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid image tag' >&2; exit 1; }
docker info >/dev/null || { echo 'Runner requires configured Docker access; socket permissions will not be changed.' >&2; exit 1; }
if docker compose version >/dev/null 2>&1; then
  dc=(docker compose)
elif command -v docker-compose >/dev/null && docker-compose version >/dev/null 2>&1; then
  dc=(docker-compose)
else
  echo 'No working Docker Compose command is available' >&2
  exit 1
fi
export MAPR_COMPOSE_COMMAND="${dc[*]}"
target=${MAPR_DEPLOY_DIR:-/opt/multi-agent-project-room}
[[ -f "$target/.env" && -f "$target/docker-compose.yml" ]] || { echo 'Initialize server configuration separately before deploying.' >&2; exit 1; }
backup="$target/backups/$(date -u +%Y%m%dT%H%M%SZ)-$IMAGE_TAG"
mkdir -p "$backup"
cp "$target/docker-compose.yml" "$backup/docker-compose.yml"
cp "$target/.env" "$backup/.env"
chmod 600 "$backup/.env"
cd "$target"
"${dc[@]}" exec -T postgres pg_dump -U postgres -d agent_room -Fc > "$backup/database.dump"
[[ -s "$backup/database.dump" ]] || { echo 'Database backup is empty' >&2; exit 1; }
# Preserve the exact running images, independent of mutable latest tags.
backend_id=$("${dc[@]}" ps -q backend)
frontend_id=$("${dc[@]}" ps -q frontend)
[[ -n "$backend_id" && -n "$frontend_id" ]] || { echo 'No running release to roll back to' >&2; exit 1; }
backend_image=$(docker inspect --format '{{.Image}}' "$backend_id")
frontend_image=$(docker inspect --format '{{.Image}}' "$frontend_id")
# Server routing can use a different port from the development default.
# Preserve the running frontend port instead of colliding with another service.
frontend_port=$(docker inspect --format '{{range (index .HostConfig.PortBindings "80/tcp")}}{{println .HostPort}}{{end}}' "$frontend_id")
[[ "$frontend_port" =~ ^[0-9]+$ && "$frontend_port" -ge 1 && "$frontend_port" -le 65535 ]] || { echo 'Expected exactly one published frontend HTTP port' >&2; exit 1; }
export MAPR_FRONTEND_PORT="$frontend_port"
echo "Preserving frontend HTTP port: $frontend_port"
printf 'services:\n  backend:\n    image: %s\n  frontend:\n    image: %s\n' "$backend_image" "$frontend_image" > "$backup/images.yml"
rollback() {
  echo "Deployment failed. Restoring previous images; database backup: $backup/database.dump" >&2
  cp "$backup/docker-compose.yml" "$target/docker-compose.yml"
  cp "$backup/.env" "$target/.env"
  "${dc[@]}" -f docker-compose.yml -f "$backup/images.yml" up -d --no-build backend frontend || echo 'Image rollback failed; operator intervention required.' >&2
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
values = {'VITE_XMTP_WORKER_ADDRESS': address, 'VITE_XMTP_ENV': xmtp_env, 'MAPR_FRONTEND_PORT': os.environ['MAPR_FRONTEND_PORT']}
if not re.search(r'^MAPR_DATABASE_PASSWORD=.+$', raw, re.M):
    password = subprocess.check_output(os.environ['MAPR_COMPOSE_COMMAND'].split() + ['exec', '-T', 'postgres', 'printenv', 'POSTGRES_PASSWORD'], text=True).strip()
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
cp "${MAPR_RELEASE_DIR:-$GITHUB_WORKSPACE}/docker-compose.yml" "$target/docker-compose.yml"
"${dc[@]}" config --quiet
"${dc[@]}" pull backend frontend
"${dc[@]}" run --rm --no-deps backend python3 -m alembic -c /app/alembic.ini upgrade head
"${dc[@]}" up -d --no-build backend frontend
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 5 "http://127.0.0.1:$frontend_port/health" >/dev/null; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]] || { echo 'Health check failed' >&2; false; }
trap - ERR
"${dc[@]}" ps
python3 - "$backup" <<'PYPERM'
import sys
from pathlib import Path
for name in ('database.dump', '.env'):
    print(f'Backup permissions ({name}): {Path(sys.argv[1], name).stat().st_mode & 0o777:o}')
PYPERM
echo "Deployment healthy. Backup retained at $backup"
