import assert from "node:assert/strict";
import test from "node:test";
import { generateDrafts } from "./scaffold-eval.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("generates quality and trigger drafts concurrently", async () => {
  const quality = deferred();
  const trigger = deferred();
  const calls = [];
  let finished = false;

  const pending = generateDrafts({
    qualityTemplate: "quality system",
    triggerTemplate: "trigger system",
    bundleText: "skill bundle",
    skillName: "test-skill",
    knownSkills: new Set(["test-skill", "none"]),
    chatImpl: ({ system, user }) => {
      calls.push({ system, user });
      return system === "quality system" ? quality.promise : trigger.promise;
    },
  });
  pending.then(() => {
    finished = true;
  });

  try {
    assert.deepEqual(calls, [
      { system: "quality system", user: "skill bundle" },
      { system: "trigger system", user: "skill bundle" },
    ]);

    quality.resolve({
      text: JSON.stringify([
        {
          description: "quality case",
          prompt: "diagnose this",
          rubric: "find the root cause",
        },
      ]),
    });
    await nextTurn();
    assert.equal(finished, false);

    trigger.resolve({
      text: JSON.stringify({
        positives: ["diagnose this"],
        boundaries: [{ prompt: "unrelated request", expected: "none" }],
      }),
    });
    assert.deepEqual(await pending, {
      raw: [
        {
          description: "quality case",
          prompt: "diagnose this",
          rubric: "find the root cause",
        },
      ],
      triggers: {
        positives: ["diagnose this"],
        boundaries: [{ prompt: "unrelated request", expected: "none" }],
      },
    });
  } finally {
    quality.resolve({ text: "[]" });
    trigger.resolve({ text: '{"positives":[],"boundaries":[]}' });
  }
});

test("skips the trigger request when trigger generation is disabled", async () => {
  const calls = [];
  const result = await generateDrafts({
    qualityTemplate: "quality system",
    triggerTemplate: null,
    bundleText: "skill bundle",
    skillName: "test-skill",
    knownSkills: new Set(["test-skill", "none"]),
    chatImpl: async ({ system }) => {
      calls.push(system);
      return { text: "[]" };
    },
  });

  assert.deepEqual(calls, ["quality system"]);
  assert.deepEqual(result, {
    raw: [],
    triggers: { positives: [], boundaries: [] },
  });
});
