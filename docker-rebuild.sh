#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="backup-tool"
CONTAINER_NAME="backup-tool"
VOLUME_NAME="backup-tool-data"

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "Removing existing container $CONTAINER_NAME..."
    docker rm -f "$CONTAINER_NAME"
fi

echo "Rebuilding image $IMAGE_NAME (no cache)..."
docker build --no-cache -t "$IMAGE_NAME" "$SCRIPT_DIR"

echo "Creating and starting container $CONTAINER_NAME..."
docker run -d \
    --name "$CONTAINER_NAME" \
    -p 3000:3000 \
    -v "$VOLUME_NAME":/data \
    "$IMAGE_NAME"

echo "Backup tool is running at http://localhost:3000"
