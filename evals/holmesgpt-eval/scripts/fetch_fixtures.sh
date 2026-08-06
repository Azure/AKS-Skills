#!/usr/bin/env bash
set -euo pipefail

# Fetch HolmesGPT repo as a ZIP (no git required) and print the fixtures path to STDOUT only.
# All download/extract logs go to STDERR so callers can safely capture the path.
# After extraction, automatically split gold answers out of fixtures (gold_split.py)
# so the agent consumes solver YAMLs without expected_output.
#
# Env overrides:
#   REPO_URL   (default: https://github.com/HolmesGPT/holmesgpt.git)
#   REF        (default: pinned commit below; accepts a SHA, tag, or branch name)
#
# Requirements: wget or curl; unzip or Python 3 (zipfile) for extraction.

REPO_URL=${REPO_URL:-https://github.com/HolmesGPT/holmesgpt.git}
# Pinned upstream commit (master @ 2026-08-05). The harness EXECUTES each case's
# before_test/after_test shell blocks, so an unpinned ref would let upstream
# changes alter what runs here. To bump: review the upstream diff, update REF.
REF=${REF:-10b772be5412f7d51ec19293b055a0bf8b981072}
BASE_DIR=$(cd "$(dirname "$0")/.." && pwd)
VENDOR_DIR="$BASE_DIR/vendor"
TARGET_DIR="$VENDOR_DIR/holmesgpt"
FIXTURES_REL="tests/llm/fixtures/test_ask_holmes"

mkdir -p "$VENDOR_DIR"

# Construct ZIP URL from repo URL (strip trailing .git if present).
# archive/<ref>.zip resolves SHAs, tags, and branch names alike.
REPO_BASE=${REPO_URL%.git}
ZIP_URL="$REPO_BASE/archive/${REF}.zip"
ZIP_PATH="$VENDOR_DIR/holmesgpt-${REF}.zip"
TMP_DIR="$VENDOR_DIR/_extract_$$"

# Clean tmp dir if exists
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

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

# Extract ZIP to TMP_DIR via unzip or Python zipfile
if command -v unzip >/dev/null 2>&1; then
  echo "Extracting ZIP with unzip..." 1>&2
  unzip -q -o "$ZIP_PATH" -d "$TMP_DIR"
else
  if command -v python3 >/dev/null 2>&1; then
    echo "Extracting ZIP with python3 -m zipfile..." 1>&2
    python3 - "$ZIP_PATH" "$TMP_DIR" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  else
    echo "Error: neither unzip nor python3 is available to extract the ZIP" 1>&2
    rm -rf "$TMP_DIR"
    exit 1
  fi
fi

# Identify top-level extracted directory (GitHub zips usually create a single folder)
TOP=$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n1 || true)
if [[ -z "${TOP:-}" || ! -d "$TOP" ]]; then
  echo "Error: failed to find extracted top-level directory under $TMP_DIR" 1>&2
  rm -rf "$TMP_DIR"
  exit 1
fi

# Replace TARGET_DIR with contents of TOP (move contents, not folder name specific)
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
# Enable dotglob so we move hidden files if present
shopt -s dotglob nullglob || true
mv "$TOP"/* "$TARGET_DIR"/ 2>/dev/null || true
shopt -u dotglob nullglob || true

# Clean up temp + ZIP
rm -rf "$TMP_DIR" "$ZIP_PATH"

FIXTURES_PATH="$TARGET_DIR/$FIXTURES_REL"
if [[ ! -d "$FIXTURES_PATH" ]]; then
  echo "Fixtures not found at $FIXTURES_PATH" 1>&2
  exit 1
fi

# Gold split: prepare solver YAMLs and move gold answers out of case YAMLs.
GOLD_SPLITTER="$BASE_DIR/scripts/gold_split.py"
if [[ -f "$GOLD_SPLITTER" ]]; then
  # Ensure PyYAML is available (best effort) using a simple import test
  if ! python3 -c "import yaml" >/dev/null 2>&1; then
    echo "PyYAML missing; attempting: python3 -m pip install --user PyYAML" 1>&2
    python3 -m pip install --user PyYAML >/dev/null 2>&1 || true
  fi
  echo "Splitting gold answers out of fixtures..." 1>&2
  # Run split per case; ignore errors so fetch still succeeds
  find "$FIXTURES_PATH" -type f -name test_case.yaml -print0 | while IFS= read -r -d '' f; do
    case_dir=$(dirname "$f")
    python3 "$GOLD_SPLITTER" split --case "$case_dir" >/dev/null 2>&1 || true
  done
else
  echo "Warning: gold_split.py not found; skipping gold split." 1>&2
fi

# Print fixtures path to STDOUT (callers capture this)
printf "%s\n" "$FIXTURES_PATH"
