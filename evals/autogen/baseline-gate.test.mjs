#!/usr/bin/env node

import assert from "node:assert/strict";
import { evaluateCandidate } from "./baseline-gate.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const chatCalls = [];
const chatResults = [];
const judgeCalls = [];
const judgeResults = [];

const chatImpl = (request) => {
  const result = deferred();
  chatCalls.push(request);
  chatResults.push(result);
  return result.promise;
};

const judgeImpl = (request) => {
  const result = deferred();
  judgeCalls.push(request);
  judgeResults.push(result);
  return result.promise;
};

const evaluation = evaluateCandidate({
  candidate: { prompt: "Why is my pod failing?", rubric: "Find the root cause." },
  skillSystem: "skill instructions",
  creds: { kind: "test" },
  chatImpl,
  judgeImpl,
});

await nextTurn();
assert.equal(chatCalls.length, 2, "skill and baseline answers should start together");
assert.equal(judgeCalls.length, 0, "judging must wait for both answers");

chatResults[1].resolve({ text: "baseline answer" });
chatResults[0].resolve({ text: "skill answer" });
await nextTurn();

assert.equal(judgeCalls.length, 2, "skill and baseline judges should start together");
assert.deepEqual(
  judgeCalls.map((call) => call.answer),
  ["skill answer", "baseline answer"],
  "answers must stay paired with the correct judge",
);

judgeResults[1].resolve({ score: 0.2, reason: "baseline misses", valid: true });
judgeResults[0].resolve({ score: 0.9, reason: "skill passes", valid: true });

assert.deepEqual(await evaluation, {
  withSkill: {
    answer: "skill answer",
    score: 0.9,
    reason: "skill passes",
    valid: true,
  },
  baseline: {
    answer: "baseline answer",
    score: 0.2,
    reason: "baseline misses",
    valid: true,
  },
});

console.log("✓ baseline gate runs independent answer and judge calls concurrently");
