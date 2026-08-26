import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/aks-troubleshooting/scripts");
const expectedServer = "https://fixture.hcp.eastus.azmk8s.io:443";
const secret = "do-not-print";

function fixture(server) {
  const root = mkdtempSync(join(tmpdir(), "aks-scripts-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(bin);
  const write = (name, content) => {
    const file = join(bin, name);
    writeFileSync(file, content);
    chmodSync(file, 0o755);
  };
  write("az", `#!/bin/sh
printf 'az %s\\n' "$*" >> "$CALLS"
printf '%s\\n' '{"fqdn":"fixture.hcp.eastus.azmk8s.io","privateFqdn":null,"agentPoolProfiles":[]}'
`);
  write("kubectl", `#!/bin/sh
printf 'kubectl %s\\n' "$*" >> "$CALLS"
case "$*" in
  *" config view "*) printf '%s' "$SERVER" ;;
  *" get pod "*"-o wide"*) printf 'app-0 1/1 Running\\n' ;;
  *" get pod "*"-o json"*) printf '%s\\n' '{"spec":{"containers":[{"name":"app","resources":{}}]}}' ;;
  *" describe pod "*) printf 'describe ok\\n' ;;
  *" logs "*)
    i=1
    while [ "$i" -le 60 ]; do printf 'line-%s client_secret=${secret}\\n' "$i"; i=$((i + 1)); done ;;
  *" get events "*) printf 'events ok\\n' ;;
  *" top pod "*) printf 'usage ok\\n' ;;
  *) printf 'unexpected call\\n' >&2; exit 1 ;;
esac
`);
  return {
    root,
    calls,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, SERVER: server },
  };
}

function run(name, args, state) {
  return spawnSync(join(scripts, name), args, { encoding: "utf8", env: state.env });
}

function useFixture(server, callback) {
  const state = fixture(server);
  try {
    callback(state);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
}

test("target mismatch stops both scripts before Kubernetes reads", () => {
  for (const name of ["cluster-snapshot.sh", "pod-deep-dive.sh"]) {
    useFixture("https://different.hcp.eastus.azmk8s.io:443", (state) => {
      const args = name === "cluster-snapshot.sh"
        ? ["rg", "cluster", "ctx"]
        : ["prod", "app-0", "rg", "cluster", "ctx", join(state.root, "artifacts")];
      const result = run(name, args, state);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not target the named AKS cluster/);
      const calls = readFileSync(state.calls, "utf8");
      assert.match(calls, /config view/);
      assert.doesNotMatch(calls, / (get|describe|logs|top|exec) /);
    });
  }
});

test("pod log projection is bounded and redacted while raw logs stay on disk", () => {
  useFixture(expectedServer, (state) => {
    const artifacts = join(state.root, "artifacts");
    const result = run(
      "pod-deep-dive.sh",
      ["prod", "app-0", "rg", "cluster", "ctx", artifacts],
      state,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.match(result.stdout, /\[REDACTED]/);
    assert.equal((result.stdout.match(/^line-/gm) || []).length, 100);
    assert.match(readFileSync(join(artifacts, "current.raw.log"), "utf8"), new RegExp(secret));
    assert.match(readFileSync(join(artifacts, "previous.raw.log"), "utf8"), new RegExp(secret));
    assert.equal((readFileSync(state.calls, "utf8").match(/--tail=50/g) || []).length, 2);
  });
});
