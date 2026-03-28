#!/bin/sh
set -e

WEBHOOK_URL="${REMOTE_UPDATE_WEBHOOK:-${HUGO_WEBHOOK_URL:-${WEBHOOK_URL:-}}}"
ACTION="${1:-update}"
FILENAME="${2:-}"
TITLE="${3:-}"

if [ -n "$WEBHOOK_URL" ]; then
  payload="{\"action\":\"${ACTION}\",\"filename\":\"${FILENAME}\",\"title\":\"${TITLE}\"}"
  curl -sS -X POST -H "Content-Type: application/json" -d "$payload" "$WEBHOOK_URL" >/dev/null
  exit 0
fi

HUGO_SITE_DIR="${HUGO_SITE_DIR:-/www/wwwroot/www.noisedh.cn}"
cd "$HUGO_SITE_DIR"
hugo --minify
