#!/usr/bin/env node
// Mock tool-call dispatcher for agentic evals.
//
// The `bin/az` and `bin/kubectl` shims exec this script, passing the tool name
// followed by the original arguments. We rebuild the command line, look up the
// active scenario's fixture (resolved from the agent's cwd so each scenario is
// auto-selected), and emit a canned response.
//
// Missing or unmatched fixture evidence fails closed so an unsupported command
// cannot masquerade as a successful tool call in the evaluated trajectory.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const [tool, ...args] = process.argv.slice(2);
const cmd = [tool, ...args].join(" ");

// Prefer an explicit override (used by the custom-executor fallback); otherwise
// resolve the fixture from `.mocks/responses.json` under the current workspace.
const dir = process.env.VALLY_MOCK_DIR || join(process.cwd(), ".mocks");
const fixturePath = join(dir, "responses.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let spec;
try {
  spec = JSON.parse(readFileSync(fixturePath, "utf8"));
} catch (error) {
  fail(`Unable to load mock responses from ${fixturePath}: ${error.message}`);
}

if (!Array.isArray(spec.responses)) {
  fail(`Mock responses in ${fixturePath} must contain a responses array`);
}

for (const [index, r] of spec.responses.entries()) {
  if (typeof r?.match !== "string") {
    fail(`Mock response ${index} in ${fixturePath} must define a string match`);
  }

  let re;
  try {
    re = new RegExp(r.match);
  } catch (error) {
    fail(`Invalid match in mock response ${index} from ${fixturePath}: ${error.message}`);
  }

  if (re.test(cmd)) {
    if (typeof r.stdout === "string") {
      process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
    }
    if (typeof r.stderr === "string") {
      process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : r.stderr + "\n");
    }
    process.exit(typeof r.exit === "number" ? r.exit : 0);
  }
}

fail(`No mock response matched command: ${cmd}`);
