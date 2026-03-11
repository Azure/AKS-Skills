#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PY=${PYTHON_BIN:-python3}

usage() {
  cat <<EOF
Usage: $0 [--fixtures-root <path>] [--filter <case_substring>] --mode <shell|http> [--ask-cmd <cmd>] [--holmes-url <url>] [--output <dir>] [--auto-fetch]

Runs HolmesGPT eval fixtures against any agent:
- Optionally auto-fetch fixtures from HolmesGPT repo
- Executes before_test
- Asks user_prompt via shell (stdin/stdout) or HTTP
- Compares output to expected_output
- Executes after_test (always)
- Writes JSON + Markdown report

Options:
  --fixtures-root  Path to tests/llm/fixtures/test_ask_holmes (if omitted with --auto-fetch, will fetch)
  --auto-fetch     Clone or update HolmesGPT and use its fixtures path automatically
  --filter         Substring to filter case directory names
  --mode           Backend mode: shell or http
  --ask-cmd        Shell mode: command to run; prompt piped to stdin, read stdout
  --holmes-url     HTTP mode: base URL (default env or http://127.0.0.1:5050)
  --output         Output directory (default: skills/holmesgpt-eval-runner/results)
EOF
}

FIXTURES_ROOT=""
FILTER=""
OUTPUT_DIR="$ROOT_DIR/results"
HOLMES_URL="${HOLMESGPT_URL:-}"
MODE=""
ASK_CMD=""
AUTO_FETCH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fixtures-root) FIXTURES_ROOT="$2"; shift 2 ;;
    --filter) FILTER="$2"; shift 2 ;;
    --holmes-url) HOLMES_URL="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --ask-cmd) ASK_CMD="$2"; shift 2 ;;
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --auto-fetch) AUTO_FETCH=true; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1"; usage; exit 1 ;;
  esac
done

if [[ -z "$FIXTURES_ROOT" && "$AUTO_FETCH" == true ]]; then
  FIXTURES_ROOT=$("$ROOT_DIR/scripts/fetch_fixtures.sh")
fi

if [[ -z "$FIXTURES_ROOT" ]]; then
  echo "Missing --fixtures-root (or use --auto-fetch)" >&2
  exit 1
fi

if [[ "$MODE" == "http" ]]; then
  export HOLMESGPT_URL="${HOLMES_URL:-${HOLMESGPT_URL:-http://127.0.0.1:5050}}"
elif [[ "$MODE" == "shell" ]]; then
  if [[ -z "$ASK_CMD" ]]; then
    echo "Shell mode requires --ask-cmd" >&2
    exit 1
  fi
else
  echo "--mode must be 'shell' or 'http'" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

exec "$PY" "$ROOT_DIR/scripts/run_eval.py" \
  --fixtures-root "$FIXTURES_ROOT" \
  ${FILTER:+--filter "$FILTER"} \
  --output "$OUTPUT_DIR" \
  --mode "$MODE" \
  ${ASK_CMD:+--ask-cmd "$ASK_CMD"}
