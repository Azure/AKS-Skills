#!/usr/bin/env node

import assert from "node:assert/strict";
import { collectCandidateEvidence } from "./baseline-gate.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const answerResults = [deferred(), deferred()];
const judgeResults = [deferred(), deferred()];
const chatCalls = [];
const judgeCalls = [];

const candidate = {
  prompt: "Why is my AKS pod pending?",
  rubric: "The answer identifies the scheduling constraint.",
};
const skillSystem = "skill instructions";
const creds = { kind: "test" };

const evidencePromise = collectCandidateEvidence({
  candidate,
  skillSystem,
  creds,
  chatFn: (request) => {
    const index = chatCalls.push(request) - 1;
    return answerResults[index].promise;
  },
  judgeFn: (request) => {
    const index = judgeCalls.push(request) - 1;
    return judgeResults[index].promise;
  },
});

await nextTurn();
assert.equal(chatCalls.length, 2, "both independent answer calls should start together");
assert.equal(judgeCalls.length, 0, "judging must wait for both answers");
assert.deepEqual(
  chatCalls.map(({ system, user }) => ({ system, user })),
  [
    { system: skillSystem, user: candidate.prompt },
    {
      system:
        "You are a helpful assistant with expertise in Azure Kubernetes Service (AKS) and Kubernetes operations.",
      user: candidate.prompt,
    },
  ],
);

answerResults[0].resolve({ text: "skill answer" });
await nextTurn();
assert.equal(judgeCalls.length, 0, "judging must not start while the baseline answer is pending");

answerResults[1].resolve({ text: "baseline answer" });
await nextTurn();
assert.equal(judgeCalls.length, 2, "both independent judge calls should start together");
assert.deepEqual(
  judgeCalls.map(({ prompt, answer, rubric }) => ({ prompt, answer, rubric })),
  [
    { prompt: candidate.prompt, answer: "skill answer", rubric: candidate.rubric },
    { prompt: candidate.prompt, answer: "baseline answer", rubric: candidate.rubric },
  ],
);

judgeResults[0].resolve({ score: 0.95, reason: "skill passes", valid: true });
judgeResults[1].resolve({ score: 0.2, reason: "baseline fails", valid: true });

assert.deepEqual(await evidencePromise, {
  withSkill: {
    answer: "skill answer",
    score: 0.95,
    reason: "skill passes",
    valid: true,
  },
  baseline: {
    answer: "baseline answer",
    score: 0.2,
    reason: "baseline fails",
    valid: true,
  },
});

console.log("baseline gate starts independent answer and judge calls concurrently");
