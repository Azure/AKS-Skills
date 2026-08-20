import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DISPATCHER = path.join(DIR, "dispatch.mjs");
const FIXTURE_DIR = path.resolve(
  DIR,
  "../../scenarios/aks-troubleshooting/nodepool-scale-failure",
);

function dispatch(args, fixtureDir = FIXTURE_DIR) {
  return spawnSync(process.execPath, [DISPATCHER, ...args], {
    encoding: "utf8",
    env: { ...process.env, VALLY_MOCK_DIR: fixtureDir },
  });
}

test("matched commands return their canned response", () => {
  const result = dispatch(["az", "aks", "nodepool", "list"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\bnp2\b/);
  assert.equal(result.stderr, "");
});

test("unmatched commands fail instead of returning empty success", () => {
  const result = dispatch(["az", "account", "show"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /No mock response matched command: az account show/,
  );
});

test("missing fixtures fail instead of returning empty success", () => {
  const result = dispatch(["az", "aks", "show"], path.join(DIR, "missing"));

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unable to load mock responses/);
});
