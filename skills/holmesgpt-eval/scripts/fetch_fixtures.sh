#!/usr/bin/env bash
set -euo pipefail

# Fetch HolmesGPT repo as a ZIP (no git required) and print the fixtures path to STDOUT only.
# All download/extract logs go to STDERR so callers can safely capture the path.
#
# Env overrides:
#   REPO_URL   (default: https://github.com/HolmesGPT/holmesgpt.git)
#   BRANCH     (default: master)
#
# Requirements: wget or curl; unzip or Python 3 (zipfile) for extraction.

REPO_URL=${REPO_URL:-https://github.com/HolmesGPT/holmesgpt.git}
BRANCH=${BRANCH:-master}
BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
VENDOR_DIR="$BASE_DIR/vendor"
TARGET_DIR="$VENDOR_DIR/holmesgpt"
FIXTURES_REL="tests/llm/fixtures/test_ask_holmes"

mkdir -p "$VENDOR_DIR"

# Construct ZIP URL from repo URL (strip trailing .git if present)
REPO_BASE=${REPO_URL%.git}
ZIP_URL="$REPO_BASE/archive/refs/heads/${BRANCH}.zip"
ZIP_PATH="$VENDOR_DIR/holmesgpt-${BRANCH}.zip"

# Download ZIP via wget or curl
if command -v wget >/dev/null 2>&1; then
  echo "Downloading $ZIP_URL via wget..." 1>&2
  wget -q -O "$ZIP_PATH" "$ZIP_URL"
elif command -v curl >/dev/null 2>&1; then
  echo "Downloading $ZIP_URL via curl..." 1>&2
  curl -L -s -o "$ZIP_PATH" "$ZIP_URL"
else
  echo "Error: neither wget nor curl is available for download" 1>&2
  exit 1
fi

# Extract ZIP via unzip or Python zipfile
if command -v unzip >/dev/null 2>&1; then
  echo "Extracting ZIP with unzip..." 1>&2
  unzip -q -o "$ZIP_PATH" -d "$VENDOR_DIR"
else
  if command -v python3 >/dev/null 2>&1; then
    echo "Extracting ZIP with python3 -m zipfile..." 1>&2
    python3 - "$ZIP_PATH" "$VENDOR_DIR" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  else
    echo "Error: neither unzip nor python3 is available to extract the ZIP" 1>&2
    exit 1
  fi
fi

# Find extracted directory (usually holmesgpt-<branch>)
EXTRACTED_DIR=$(ls -1dt "$VENDOR_DIR"/holmesgpt-* 2>/dev/null | head -n1 || true)
if [[ -z "${EXTRACTED_DIR:-}" || ! -d "$EXTRACTED_DIR" ]]; then
  echo "Error: failed to find extracted directory under $VENDOR_DIR" 1>&2
  exit 1
fi

# Replace TARGET_DIR with extracted content
rm -rf "$TARGET_DIR"
mv "$EXTRACTED_DIR" "$TARGET_DIR"

# Clean up ZIP (optional)
rm -f "$ZIP_PATH"

FIXTURES_PATH="$TARGET_DIR/$FIXTURES_REL"
if [[ ! -d "$FIXTURES_PATH" ]]; then
  echo "Fixtures not found at $FIXTURES_PATH" >&2
  exit 1
fi

# Print fixtures path to STDOUT (callers capture this)
printf "%s\n" "$FIXTURES_PATH"
