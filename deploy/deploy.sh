#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/d2-wealth}"
RELEASE_DIR="${RELEASE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SHARED_DIR="${APP_ROOT}/shared"
CURRENT_LINK="${APP_ROOT}/current"
SITE_HOSTNAME="${SITE_HOSTNAME:-d2r.bjav.io}"
NGINX_SOURCE="${RELEASE_DIR}/deploy/nginx/d2r.bjav.io.conf"
NGINX_TARGET="/etc/nginx/sites-available/d2r.bjav.io.conf"
NGINX_ENABLED_TARGET="/etc/nginx/sites-enabled/d2r.bjav.io.conf"
SYSTEMD_SOURCE="${RELEASE_DIR}/deploy/systemd/d2-wealth-backend.service"
SYSTEMD_TARGET="/etc/systemd/system/d2-wealth-backend.service"

mkdir -p "${APP_ROOT}/releases" "${SHARED_DIR}/data"

cd "${RELEASE_DIR}"
npm ci --ignore-scripts
node ./scripts/patch-d2-parser.mjs
npm rebuild better-sqlite3
npm run build

if [ -d "${CURRENT_LINK}" ] && [ ! -L "${CURRENT_LINK}" ]; then
  rm -rf "${CURRENT_LINK}"
fi

install -D -m 644 "${SYSTEMD_SOURCE}" "${SYSTEMD_TARGET}"
install -D -m 644 "${NGINX_SOURCE}" "${NGINX_TARGET}"
ln -sfn "${NGINX_TARGET}" "${NGINX_ENABLED_TARGET}"

for candidate in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  if [ ! -e "${candidate}" ]; then
    continue
  fi

  resolved_candidate="$(readlink -f "${candidate}")"
  resolved_target="$(readlink -f "${NGINX_TARGET}")"
  if [ "${resolved_candidate}" = "${resolved_target}" ]; then
    continue
  fi

  if grep -q "server_name ${SITE_HOSTNAME}" "${candidate}"; then
    echo "Removing conflicting nginx site for ${SITE_HOSTNAME}: ${candidate}"
    rm -f "${candidate}"
  fi
done

ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"

systemctl daemon-reload
nginx -t
systemctl restart d2-wealth-backend
systemctl reload nginx
