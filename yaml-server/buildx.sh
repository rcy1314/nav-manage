#!/usr/bin/env sh
set -eu

IMAGE_NAME="${IMAGE_NAME:-noise233/nav-manage}"
IMAGE_TAG="${IMAGE_TAG:-}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-multiarch}"
PUSH="${PUSH:-1}"
LOAD="${LOAD:-0}"
NO_CACHE="${NO_CACHE:-1}"
CONTEXT_DIR="${CONTEXT_DIR:-.}"
DOCKERFILE_PATH="${DOCKERFILE_PATH:-Dockerfile}"
INSTALL_HUGO="${INSTALL_HUGO:-true}"

if [ -z "${BUILD_TIME:-}" ]; then
  BUILD_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
fi

if [ -z "${IMAGE_TAG}" ]; then
  if [ -n "${GITHUB_REF_NAME:-}" ]; then
    IMAGE_TAG="${GITHUB_REF_NAME}"
  elif command -v git >/dev/null 2>&1; then
    IMAGE_TAG="$(git describe --tags --always --dirty 2>/dev/null || true)"
  fi
fi

if [ -z "${IMAGE_TAG}" ]; then
  IMAGE_TAG="dev"
fi

SOURCE_REVISION="${SOURCE_REVISION:-${GITHUB_SHA:-}}"
if [ -z "${SOURCE_REVISION}" ] && command -v git >/dev/null 2>&1; then
  SOURCE_REVISION="$(git rev-parse HEAD 2>/dev/null || true)"
fi

set -- docker buildx build \
  --builder "${BUILDER}" \
  --platform "${PLATFORMS}" \
  --build-arg "IMAGE_TAG=${IMAGE_TAG}" \
  --build-arg "BUILD_TIME=${BUILD_TIME}" \
  --build-arg "SOURCE_REVISION=${SOURCE_REVISION}" \
  --build-arg "INSTALL_HUGO=${INSTALL_HUGO}" \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  -t "${IMAGE_NAME}:latest"

if [ "${PUSH}" = "1" ]; then
  set -- "$@" --push
else
  if [ "${LOAD}" = "1" ]; then
    case "${PLATFORMS}" in
      *,*)
        echo "LOAD=1 仅支持单平台构建（PLATFORMS 不能包含逗号）" >&2
        exit 2
        ;;
    esac
    set -- "$@" --load
  fi
fi

if [ "${NO_CACHE}" = "1" ]; then
  set -- "$@" --no-cache
fi

set -- "$@" -f "${DOCKERFILE_PATH}" "${CONTEXT_DIR}"

if [ "${DRY_RUN:-0}" = "1" ]; then
  printf '%s ' "$@"
  printf '\n'
  exit 0
fi

if ! docker buildx inspect "${BUILDER}" >/dev/null 2>&1; then
  docker buildx create --name "${BUILDER}" --use >/dev/null
else
  docker buildx use "${BUILDER}" >/dev/null
fi

exec "$@"
