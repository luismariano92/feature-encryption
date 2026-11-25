#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="backup-tool"
CONTAINER_NAME="backup-tool"
VOLUME_NAME="backup-tool-data"

if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    echo "Building image $IMAGE_NAME..."
    docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"
fi

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "Starting existing container $CONTAINER_NAME..."
    docker start "$CONTAINER_NAME"
else
    echo "Creating and starting container $CONTAINER_NAME..."
    docker run -d \
        --name "$CONTAINER_NAME" \
        -p 3000:3000 \
        -v "$VOLUME_NAME":/data \
        "$IMAGE_NAME"
fi

echo "Backup tool is running at http://localhost:3000"
