import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(EVALS_DIR);
const CAPTURE_DIR = path.join(REPO_DIR, "skills", "aks-network-capture", "scripts");

async function writeExecutable(file, content) {
  await writeFile(file, content);
  await chmod(file, 0o755);
}

test("create-capture renders a least-privilege digest-pinned manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aks-capture-manifest-"));
  try {
    const bin = path.join(root, "bin");
    const manifest = path.join(root, "manifest.yaml");
    const calls = path.join(root, "calls.log");
    await mkdir(bin);
    await writeExecutable(
      path.join(bin, "kubectl"),
      `#!/bin/sh
printf '<%s>\n' "$@" >> "$MOCK_LOG"
if [ "$1" = "get" ] && [ "$2" = "configmap" ]; then
  cat "$MOCK_RUNNER"
elif [ "$1" = "apply" ] || [ "$1" = "create" ]; then
  cat > "$MOCK_MANIFEST"
  if [ "$1" = "create" ]; then
    printf '%s' capture-job
  fi
fi
exit 0
`,
    );

    await execFile(
      path.join(CAPTURE_DIR, "create-capture.sh"),
      [
        "--name",
        "capture",
        "--node-names",
        "node1",
        "--duration",
        "30s",
        "--tcpdump-filter",
        "tcp and port 443",
      ],
      {
        cwd: REPO_DIR,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MOCK_LOG: calls,
          MOCK_MANIFEST: manifest,
          MOCK_RUNNER: path.join(CAPTURE_DIR, "run-capture.sh"),
        },
      },
    );

    const rendered = await readFile(manifest, "utf8");
    assert.match(rendered, /privileged:\s*false/);
    assert.match(rendered, /drop:\s*\["ALL"\]/);
    assert.match(
      rendered,
      /image:\s*"mcr\.microsoft\.com\/[^"\n]+@sha256:[a-f0-9]{64}"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generate-test-traffic keeps user values as separate arguments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aks-traffic-arguments-"));
  try {
    const bin = path.join(root, "bin");
    const calls = path.join(root, "calls.log");
    await mkdir(bin);
    await writeExecutable(
      path.join(bin, "kubectl"),
      `#!/bin/sh
for arg in "$@"; do printf '<%s>\n' "$arg" >> "$MOCK_LOG"; done
printf '%s\n' --- >> "$MOCK_LOG"
`,
    );

    await execFile(
      path.join(CAPTURE_DIR, "generate-test-traffic.sh"),
      [
        "--source-pod",
        "frontend",
        "--target",
        "db.internal",
        "--type",
        "tcp",
        "--target-port",
        "5432",
        "--duration",
        "1s",
        "--interval",
        "0",
      ],
      {
        cwd: REPO_DIR,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MOCK_LOG: calls,
        },
      },
    );

    assert.match(
      await readFile(calls, "utf8"),
      /<db\.internal>\n<5432>\n<1>\n<0>\n<tcp>\n/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
