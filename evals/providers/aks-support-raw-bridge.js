#!/usr/bin/env node

const { rawOneShot } = require('./llm-client');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  try {
    const response = await rawOneShot(JSON.parse(input));
    process.stdout.write(JSON.stringify(response));
  } catch {
    process.exitCode = 2;
  }
});
