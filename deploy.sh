#!/usr/bin/env bash
# Deploy the RasterFit container to the VPS.
#
# Builds the image locally, streams it to the server (`docker load`), then
# restarts the container with the hardened runtime flags.
#
# Configurable via env vars:
#   SSH_KEY  (default: ~/.ssh/rasterfit_deploy)
#   SERVER   (default: root@187.124.20.168)
#   PORT     (default: 8080)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/rasterfit_deploy}"
SERVER="${SERVER:-root@187.124.20.168}"
PORT="${PORT:-8080}"
IMAGE="rasterfit:final"
CONTAINER="rasterfit"

echo "==> Building ${IMAGE} (local)"
docker build -f docker/Dockerfile -t "${IMAGE}" .

echo "==> Streaming image to ${SERVER}"
docker save "${IMAGE}" | gzip | ssh -i "${SSH_KEY}" -o ConnectTimeout=20 "${SERVER}" 'gunzip | docker load'

echo "==> Restarting container on ${SERVER}"
ssh -i "${SSH_KEY}" -o ConnectTimeout=20 "${SERVER}" "PORT=${PORT} IMAGE=${IMAGE} CONTAINER=${CONTAINER}" 'bash -s' <<'REMOTE'
set -euo pipefail
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker run -d \
  --name "${CONTAINER}" \
  --restart unless-stopped \
  --read-only --tmpfs /tmp --tmpfs /var/cache/nginx --tmpfs /run \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --health-cmd "wget -q -O /dev/null http://127.0.0.1:${PORT}/healthz" \
  --health-interval 5s --health-timeout 3s --health-retries 3 \
  -p "${PORT}:8080" \
  "${IMAGE}"
for i in $(seq 1 20); do
  sleep 0.5
  [ "$(docker inspect -f '{{.State.Health.Status}}' "${CONTAINER}" 2>/dev/null || echo n/a)" = "healthy" ] && break
done
docker ps --filter "name=${CONTAINER}" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
REMOTE

echo "==> Deployed: http://${SERVER#*@}:${PORT}"
