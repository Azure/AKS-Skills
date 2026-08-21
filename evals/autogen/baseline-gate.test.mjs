#!/usr/bin/env node

import assert from "node:assert/strict";
import { evaluateCandidate } from "./baseline-gate.mjs";

function trackConcurrency(delegate) {
  let active = 0;
  let max = 0;
  return {
    fn: async (...args) => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setImmediate(resolve));
      try {
        return delegate(...args);
      } finally {
        active -= 1;
      }
    },
    max: () => max,
  };
}

const chats = trackConcurrency(({ system }) => ({
  text: system.includes("Follow the skill instructions") ? "skill answer" : "baseline answer",
}));
const judges = trackConcurrency(({ answer }) => ({
  score: answer === "skill answer" ? 0.95 : 0.3,
  reason: "fixture",
  valid: true,
}));

const result = await evaluateCandidate(
  { prompt: "diagnose this", rubric: "give the fixture answer" },
  "Use the fixture answer.",
  { kind: "fixture" },
  { chatFn: chats.fn, judgeFn: judges.fn }
);

assert.equal(chats.max(), 2, "skill and baseline completions should run concurrently");
assert.equal(judges.max(), 2, "skill and baseline judges should run concurrently");
assert.deepEqual(result, {
  withSkill: { answer: "skill answer", score: 0.95, reason: "fixture", valid: true },
  baseline: { answer: "baseline answer", score: 0.3, reason: "fixture", valid: true },
});

console.log("Baseline gate concurrency test passed.");
