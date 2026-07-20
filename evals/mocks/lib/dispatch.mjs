#!/usr/bin/env node
// Mock tool-call dispatcher for agentic evals.
//
// The `bin/az` and `bin/kubectl` shims exec this script, passing the tool name
// followed by the original arguments. We rebuild the command line, look up the
// active scenario's fixture (resolved from the agent's cwd so each scenario is
// auto-selected), and emit a canned response.
//
// Design invariant: an UNMATCHED command returns empty stdout + exit 0 (a bland
// "nothing here") rather than an error, so a rabbit-holing agent's off-target
// calls stay observable in the trajectory instead of crashing the run.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const [tool, ...args] = process.argv.slice(2);
const cmd = [tool, ...args].join(" ");

// Prefer an explicit override (used by the custom-executor fallback); otherwise
// resolve the fixture from `.mocks/responses.json` under the current workspace.
const dir = process.env.VALLY_MOCK_DIR || join(process.cwd(), ".mocks");

let spec;
try {
  spec = JSON.parse(readFileSync(join(dir, "responses.json"), "utf8"));
} catch {
  process.exit(0); // no fixtures here → behave as a no-op
}

for (const r of spec.responses ?? []) {
  // A non-string `match` would coerce in surprising ways (e.g. `undefined` →
  // /(?:)/, which matches everything), so require an explicit string pattern.
  if (typeof r.match !== "string") continue;
  let re;
  try {
    re = new RegExp(r.match);
  } catch {
    continue; // skip invalid regex so one bad fixture line can't crash the run
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

process.exit(0); // unmatched → empty success (observable, not an error)
