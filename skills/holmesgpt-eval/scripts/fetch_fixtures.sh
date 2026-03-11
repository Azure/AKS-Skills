#!/usr/bin/env bash
set -euo pipefail

# Clone or update HolmesGPT repo and print the fixtures path

REPO_URL=${REPO_URL:-https://github.com/HolmesGPT/holmesgpt.git}
BRANCH=${BRANCH:-master}
BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
VENDOR_DIR="$BASE_DIR/vendor"
TARGET_DIR="$VENDOR_DIR/holmesgpt"
FIXTURES_REL="tests/llm/fixtures/test_ask_holmes"

mkdir -p "$VENDOR_DIR"

if [[ ! -d "$TARGET_DIR/.git" ]]; then
  git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
else
  git -C "$TARGET_DIR" fetch --depth=1 origin "$BRANCH"
  git -C "$TARGET_DIR" reset --hard "origin/$BRANCH"
fi

FIXTURES_PATH="$TARGET_DIR/$FIXTURES_REL"
if [[ ! -d "$FIXTURES_PATH" ]]; then
  echo "Fixtures not found at $FIXTURES_PATH" >&2
  exit 1
fi

printf "%s\n" "$FIXTURES_PATH"
