#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aks-router-provider-'));
const skillsDir = path.join(tempDir, 'skills');
const skillDir = path.join(skillsDir, 'aks-troubleshooting');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(
  path.join(skillDir, 'SKILL.md'),
  '---\nname: aks-troubleshooting\ndescription: Diagnose AKS cluster problems\n---\n',
);

process.env.SKILLS_BASE = skillsDir;
process.env.EVAL_PROVIDER = 'openai';
process.env.OPENAI_BASE_URL = 'http://localhost:8000/v1';

const RouterProvider = require('./router-provider');
const originalFetch = global.fetch;
const originalReadDir = fs.readdirSync;
const originalReadFile = fs.readFileSync;
let fetchCalls = 0;
let directoryReads = 0;
let fileReads = 0;

global.fetch = async () => {
  fetchCalls += 1;
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'aks-troubleshooting' } }],
      usage: { total_tokens: 3, prompt_tokens: 2, completion_tokens: 1 },
    }),
  };
};
fs.readdirSync = (...args) => {
  directoryReads += 1;
  return originalReadDir(...args);
};
fs.readFileSync = (...args) => {
  fileReads += 1;
  return originalReadFile(...args);
};

async function main() {
  const provider = new RouterProvider({});
  const context = { vars: { prompt: 'Why is my AKS cluster unhealthy?' } };

  const first = await provider.callApi('', context);
  assert.strictEqual(first.output, 'aks-troubleshooting');
  assert.ok(directoryReads > 0, 'the first call should discover skills');
  assert.ok(fileReads > 0, 'the first call should read skill metadata');

  const readsAfterFirstCall = { directoryReads, fileReads };
  const second = await provider.callApi('', context);
  assert.strictEqual(second.output, 'aks-troubleshooting');
  assert.deepStrictEqual(
    { directoryReads, fileReads },
    readsAfterFirstCall,
    'subsequent calls should reuse the discovered routing context',
  );
  assert.strictEqual(fetchCalls, 2, 'only routing metadata, not model responses, should be cached');

  console.log('Router provider caches skill discovery across calls.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    global.fetch = originalFetch;
    fs.readdirSync = originalReadDir;
    fs.readFileSync = originalReadFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
