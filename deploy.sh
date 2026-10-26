#!/usr/bin/env bash
# Deploy the RasterFit Native CAD + Raster container to the VPS.
#
# Builds the image locally, streams it to the server (`docker load`), then
# restarts the container with hardened runtime flags.
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
if [ "${FULL_DOCKER_BUILD:-0}" = "1" ]; then
  docker build -f docker/Dockerfile -t "${IMAGE}" .
else
  cargo build --release -p rf-cli
  npm --prefix web run wasm:build
  npm --prefix web run build
  TMP_CTX="$(mktemp -d)"
  trap 'rm -rf "${TMP_CTX}"' EXIT
  mkdir -p "${TMP_CTX}/server" "${TMP_CTX}/web"
  cp target/release/rf-cli "${TMP_CTX}/rf-cli"
  cp server/requirements.txt "${TMP_CTX}/server/requirements.txt"
  cp server/app.py "${TMP_CTX}/server/app.py"
  cp -r web/dist "${TMP_CTX}/web/dist"
  cat > "${TMP_CTX}/Dockerfile" <<'EOF'
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt
COPY rf-cli /usr/local/bin/rf-cli
RUN chmod +x /usr/local/bin/rf-cli
COPY server/app.py /app/server/app.py
COPY web/dist /app/web/dist
ENV RF_CLI_BIN=/usr/local/bin/rf-cli
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8080"]
EOF
  docker build -t "${IMAGE}" "${TMP_CTX}"
fi

echo "==> Streaming image to ${SERVER}"
docker save "${IMAGE}" | gzip | ssh -i "${SSH_KEY}" -o ConnectTimeout=20 "${SERVER}" 'gunzip | docker load'

echo "==> Restarting container on ${SERVER}"
ssh -i "${SSH_KEY}" -o ConnectTimeout=20 "${SERVER}" "PORT=${PORT} IMAGE=${IMAGE} CONTAINER=${CONTAINER} SA_USERNAME=${RASTERFIT_SUPERADMIN_USERNAME:-superadmin} SA_PASSWORD=${RASTERFIT_SUPERADMIN_PASSWORD:-}" 'bash -s' <<'REMOTE'
set -euo pipefail
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker run -d \
  --name "${CONTAINER}" \
  --restart unless-stopped \
  --read-only --tmpfs /tmp:mode=1777 --tmpfs /run \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --env RASTERFIT_SUPERADMIN_USERNAME="${SA_USERNAME}" \
  --env RASTERFIT_SUPERADMIN_PASSWORD="${SA_PASSWORD}" \
  -v rasterfit-data:/data \
  --health-cmd "python3 -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')\"" \
  --health-interval 5s --health-timeout 3s --health-retries 3 \
  -p "${PORT}:8080" \
  "${IMAGE}"
for i in $(seq 1 25); do
  sleep 0.5
  [ "$(docker inspect -f '{{.State.Health.Status}}' "${CONTAINER}" 2>/dev/null || echo n/a)" = "healthy" ] && break
done
docker ps --filter "name=${CONTAINER}" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
REMOTE

echo "==> Deployed: http://${SERVER#*@}:${PORT}"
