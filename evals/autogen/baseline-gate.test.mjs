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

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

const skillAnswer = deferred();
const baselineAnswer = deferred();
const skillGrade = deferred();
const baselineGrade = deferred();
const answerCalls = [];
const judgeCalls = [];

const evaluation = evaluateCandidate({
  prompt: "Why is my pod pending?",
  rubric: "Find the scheduling cause.",
  skillContent: "Troubleshoot the pod.",
  creds: { kind: "test" },
  chatFn: ({ system }) => {
    const kind = system.includes("## Skill Instructions") ? "skill" : "baseline";
    answerCalls.push(kind);
    return kind === "skill" ? skillAnswer.promise : baselineAnswer.promise;
  },
  judgeFn: ({ answer }) => {
    judgeCalls.push(answer);
    return answer === "skill answer" ? skillGrade.promise : baselineGrade.promise;
  },
});

await flushMicrotasks();
assert.deepEqual(answerCalls, ["skill", "baseline"], "both answer calls should start together");
assert.deepEqual(judgeCalls, [], "judging must wait until both answers complete");

skillAnswer.resolve({ text: "skill answer" });
await flushMicrotasks();
assert.deepEqual(judgeCalls, [], "judging must not start with only one answer");

baselineAnswer.resolve({ text: "baseline answer" });
await flushMicrotasks();
assert.deepEqual(
  judgeCalls,
  ["skill answer", "baseline answer"],
  "both judge calls should start together",
);

skillGrade.resolve({ score: 0.9, reason: "strong", valid: true });
baselineGrade.resolve({ score: 0.4, reason: "weak", valid: true });

assert.deepEqual(await evaluation, {
  withSkill: { answer: "skill answer", score: 0.9, reason: "strong", valid: true },
  baseline: { answer: "baseline answer", score: 0.4, reason: "weak", valid: true },
});

console.log("✓ baseline gate runs independent answer and judge calls concurrently");
