import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../..");
const SCRIPTS = join(REPO_ROOT, "skills/aks-troubleshooting/scripts");
const EXPECTED_SERVER = "https://fixture.hcp.eastus.azmk8s.io:443";
const SENTINEL = "do-not-print-this-secret";

function writeExecutable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function makeFixture(server = EXPECTED_SERVER) {
  const root = mkdtempSync(join(tmpdir(), "aks-troubleshooting-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls.log");
  mkdirSync(bin);

  writeExecutable(
    join(bin, "az"),
    `#!/bin/sh
printf 'az %s\\n' "$*" >> "$CALL_LOG"
printf '%s\\n' '{"fqdn":"fixture.hcp.eastus.azmk8s.io","privateFqdn":null,"provisioningState":"Succeeded","powerState":{"code":"Running"},"kubernetesVersion":"1.33","networkProfile":{"networkPlugin":"azure","networkPolicy":"azure"},"agentPoolProfiles":[]}'
`,
  );

  writeExecutable(
    join(bin, "kubectl"),
    `#!/bin/sh
printf 'kubectl %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  *" config view "*)
    printf '%s' "$MOCK_KUBE_SERVER"
    ;;
  *" get pod "*"-o wide"*)
    printf 'NAME READY STATUS RESTARTS AGE\\napp-0 1/1 Running 2 1h\\n'
    ;;
  *" get pod "*"-o json"*)
    printf '%s\\n' '{"spec":{"containers":[{"name":"app","resources":{"requests":{"memory":"64Mi"},"limits":{"memory":"128Mi"}}}]}}'
    ;;
  *" describe pod "*)
    printf 'Environment: client_secret=${SENTINEL}\\n'
    ;;
  *" logs "*"--previous"*)
    i=1
    while [ "$i" -le 70 ]; do
      printf 'previous-%s Authorization: Bearer ${SENTINEL}\\n' "$i"
      i=$((i + 1))
    done
    ;;
  *" logs "*)
    i=1
    while [ "$i" -le 80 ]; do
      printf 'current-%s client_secret=${SENTINEL}\\n' "$i"
      i=$((i + 1))
    done
    ;;
  *" get events "*)
    printf 'Warning BackOff token=${SENTINEL}\\n'
    ;;
  *" top pod "*)
    printf 'POD NAME CPU MEMORY\\napp-0 app 5m 64Mi\\n'
    ;;
  *)
    printf 'unexpected kubectl call: %s\\n' "$*" >&2
    exit 1
    ;;
esac
`,
  );

  return {
    root,
    calls,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: calls,
      MOCK_KUBE_SERVER: server,
    },
  };
}

function run(script, args, fixture) {
  return spawnSync(join(SCRIPTS, script), args, {
    encoding: "utf8",
    env: fixture.env,
  });
}

function callLog(fixture) {
  return readFileSync(fixture.calls, "utf8");
}

function withFixture(server, callback) {
  const fixture = makeFixture(server);
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function projectedLogLines(stdout, start, end) {
  const section = stdout.split(start)[1]?.split(end)[0] ?? "";
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("target mismatch stops both shipped scripts before Kubernetes reads", () => {
  for (const invocation of [
    {
      script: "cluster-snapshot.sh",
      args: ["rg", "cluster", "fixture-context"],
    },
    {
      script: "pod-deep-dive.sh",
      args: [
        "prod",
        "app-0",
        "rg",
        "cluster",
        "fixture-context",
        "artifacts",
      ],
    },
  ]) {
    withFixture("https://different.hcp.eastus.azmk8s.io:443", (fixture) => {
      if (invocation.script === "pod-deep-dive.sh") {
        invocation.args[5] = join(fixture.root, "artifacts");
      }
      const result = run(invocation.script, invocation.args, fixture);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not target the named AKS cluster/);
      const calls = callLog(fixture);
      assert.match(calls, /kubectl --context fixture-context config view/);
      assert.doesNotMatch(
        calls,
        /kubectl .* (get|describe|logs|top|exec|attach|port-forward) /,
      );
    });
  }
});

test("pod log projection is bounded and redacted while raw artifacts stay on disk", () => {
  withFixture(EXPECTED_SERVER, (fixture) => {
    const artifacts = join(fixture.root, "artifacts");
    const result = run(
      "pod-deep-dive.sh",
      ["prod", "app-0", "rg", "cluster", "fixture-context", artifacts],
      fixture,
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, new RegExp(SENTINEL));
    assert.match(result.stdout, /\[REDACTED]/);
    assert.match(result.stdout, /targetProof=matched/);

    const current = projectedLogLines(
      result.stdout,
      "--- Current Logs (all containers, redacted, last 50 lines) ---",
      "--- Previous Logs",
    );
    const previous = projectedLogLines(
      result.stdout,
      "--- Previous Logs (all containers, redacted, last 50 lines) ---",
      "--- Events ---",
    );
    assert.equal(current.length, 50);
    assert.equal(previous.length, 50);

    assert.match(
      readFileSync(join(artifacts, "logs-current.raw.txt"), "utf8"),
      new RegExp(SENTINEL),
    );
    assert.match(
      readFileSync(join(artifacts, "logs-previous.raw.txt"), "utf8"),
      new RegExp(SENTINEL),
    );

    const calls = callLog(fixture);
    assert.equal((calls.match(/--tail=50/g) || []).length, 2);
  });
});
