#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/d2-wealth}"
RELEASE_DIR="${RELEASE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SHARED_DIR="${APP_ROOT}/shared"
CURRENT_LINK="${APP_ROOT}/current"

mkdir -p "${APP_ROOT}/releases" "${SHARED_DIR}/data"

cd "${RELEASE_DIR}"
npm ci
npm run build

ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"

systemctl restart d2-wealth-backend
systemctl reload nginx
