#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: ./build-multiarch.sh [--dry-run | --help]
Reads .build.env (or BUILD_ENV_FILE). BUILD_OUTPUT selects push, load or cache.
--dry-run validates configuration and prints the build command without Docker calls.
HELP
}
DRY_RUN=false
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=true ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 1; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
BUILD_ENV_FILE="${BUILD_ENV_FILE:-.build.env}"
if [[ -f "$BUILD_ENV_FILE" ]]; then
  set -a
  # Only source a trusted local configuration. It is not sent to the build context.
  # shellcheck disable=SC1090
  source "$BUILD_ENV_FILE"
  set +a
else
  echo "Build env file not found: $BUILD_ENV_FILE. Copy .build.env.example first." >&2
  exit 1
fi

IMAGE_NAME="${IMAGE_NAME:-}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILD_OUTPUT="${BUILD_OUTPUT:-push}"
BUILDER_NAME="${BUILDER_NAME:-douyin-onebot-builder}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
CONTEXT="${CONTEXT:-.}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PNPM_VERSION="${PNPM_VERSION:-9.15.3}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.63.0}"

fail() { echo "$*" >&2; exit 1; }
[[ -n "$IMAGE_NAME" ]] || fail "IMAGE_NAME is required in $BUILD_ENV_FILE"
[[ "$IMAGE_NAME" != *[[:space:]]* && "$IMAGE_NAME" != -* && "$IMAGE_NAME" != *@* ]] || fail "Invalid IMAGE_NAME"
[[ "$IMAGE_TAG" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || fail "Invalid IMAGE_TAG"
[[ "$PLATFORMS" =~ ^linux/(amd64|arm64)(,linux/(amd64|arm64))*$ ]] || fail "PLATFORMS must contain linux/amd64 and/or linux/arm64"
[[ -f "$DOCKERFILE" ]] || fail "Dockerfile not found: $DOCKERFILE"
[[ -d "$CONTEXT" ]] || fail "Build context directory not found: $CONTEXT"
[[ "$PLAYWRIGHT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid PLAYWRIGHT_VERSION"
case "$BUILD_OUTPUT" in
  push)
    [[ "$IMAGE_NAME" != *your-name* && "$IMAGE_NAME" == */* ]] || fail "Set IMAGE_NAME to your registry repository before pushing"
    ;;
  load)
    [[ "$PLATFORMS" != *,* ]] || fail "BUILD_OUTPUT=load requires exactly one platform"
    ;;
  cache) ;;
  *) fail "BUILD_OUTPUT must be push, load or cache" ;;
esac

args=(buildx build --builder "$BUILDER_NAME" --platform "$PLATFORMS"
  --file "$DOCKERFILE" --tag "${IMAGE_NAME}:${IMAGE_TAG}"
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY"
  --build-arg "PNPM_VERSION=$PNPM_VERSION"
  --build-arg "PLAYWRIGHT_VERSION=$PLAYWRIGHT_VERSION"
  --add-host host.docker.internal=host-gateway)
create_args=(buildx create --name "$BUILDER_NAME" --driver docker-container)
# Proxy build args are Docker's predefined proxy arguments, not image ENV/ARG.
# Host CLI proxies and container proxies have separate addresses and scopes.
for pair in HTTP_PROXY:http_proxy HTTPS_PROXY:https_proxy ALL_PROXY:all_proxy NO_PROXY:no_proxy; do
  upper="${pair%%:*}"; lower="${pair#*:}"; variable="BUILD_${upper}"
  value="${!variable:-}"
  if [[ -n "$value" ]]; then
    args+=(--build-arg "$upper=$value" --build-arg "$lower=$value")
    create_args+=(--driver-opt "env.$lower=$value")
  fi
done
case "$BUILD_OUTPUT" in
  push) args+=(--push) ;;
  load) args+=(--load) ;;
esac
args+=("$CONTEXT")

if $DRY_RUN; then
  printf 'docker'
  for arg in "${args[@]}"; do
    # Never print configured proxy credentials.
    case "$arg" in *PROXY=*|*proxy=*) arg="${arg%%=*}=<configured>" ;; esac
    printf ' %q' "$arg"
  done
  printf '\n'
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "Docker is not installed or not in PATH"
docker buildx version >/dev/null 2>&1 || fail "Docker Buildx is unavailable"
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker "${create_args[@]}"
fi
docker buildx inspect "$BUILDER_NAME" --bootstrap >/dev/null
echo "Building ${IMAGE_NAME}:${IMAGE_TAG}; platforms=$PLATFORMS; output=$BUILD_OUTPUT"
docker "${args[@]}"
case "$BUILD_OUTPUT" in
  push) echo "Pushed ${IMAGE_NAME}:${IMAGE_TAG}" ;;
  load) echo "Loaded ${IMAGE_NAME}:${IMAGE_TAG} into local Docker" ;;
  cache) echo "Build completed in BuildKit cache; no image pushed or loaded" ;;
esac
