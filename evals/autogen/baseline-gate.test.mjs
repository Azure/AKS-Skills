import assert from "node:assert/strict";
import test from "node:test";
import { gatherCandidateEvidence } from "./baseline-gate.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("gathers chats and judges in concurrent dependency-ordered pairs", async () => {
  const skillChat = deferred();
  const baselineChat = deferred();
  const skillJudge = deferred();
  const baselineJudge = deferred();
  const chatCalls = [];
  const judgeCalls = [];
  let finished = false;

  const pending = gatherCandidateEvidence({
    candidate: { prompt: "diagnose this", rubric: "find the root cause" },
    skillContent: "skill instructions",
    creds: { model: "test" },
    chatImpl: ({ system }) => {
      const isSkill = system.includes("## Skill Instructions");
      chatCalls.push(isSkill ? "skill" : "baseline");
      return isSkill ? skillChat.promise : baselineChat.promise;
    },
    judgeImpl: ({ answer }) => {
      const isSkill = answer === "skill answer";
      judgeCalls.push(isSkill ? "skill" : "baseline");
      return isSkill ? skillJudge.promise : baselineJudge.promise;
    },
  });
  pending.then(() => {
    finished = true;
  });

  try {
    assert.deepEqual(chatCalls, ["skill", "baseline"]);
    assert.deepEqual(judgeCalls, []);

    skillChat.resolve({ text: "skill answer" });
    await nextTurn();
    assert.deepEqual(judgeCalls, []);

    baselineChat.resolve({ text: "baseline answer" });
    await nextTurn();
    assert.deepEqual(judgeCalls, ["skill", "baseline"]);

    skillJudge.resolve({ score: 0.9, reason: "strong", valid: true });
    await nextTurn();
    assert.equal(finished, false);

    baselineJudge.resolve({ score: 0.4, reason: "weak", valid: true });
    assert.deepEqual(await pending, {
      withSkill: {
        answer: "skill answer",
        score: 0.9,
        reason: "strong",
        valid: true,
      },
      baseline: {
        answer: "baseline answer",
        score: 0.4,
        reason: "weak",
        valid: true,
      },
    });
  } finally {
    skillChat.resolve({ text: "skill answer" });
    baselineChat.resolve({ text: "baseline answer" });
    skillJudge.resolve({ score: 0.9, reason: "strong", valid: true });
    baselineJudge.resolve({ score: 0.4, reason: "weak", valid: true });
  }
});
