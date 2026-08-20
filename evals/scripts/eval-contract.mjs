import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export const SCHEMA_VERSION = 1;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const REPOSITORY_PATTERN =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function validateCommit(value, label = "commit") {
  invariant(
    typeof value === "string" && COMMIT_PATTERN.test(value),
    `${label} must be a full lowercase 40-character commit SHA`,
  );
  return value;
}

export function validateRepository(value, label = "repository") {
  invariant(
    typeof value === "string" && REPOSITORY_PATTERN.test(value),
    `${label} must have the form owner/repository`,
  );
  return value;
}

export function validateIdentifier(value, label) {
  invariant(
    typeof value === "string" &&
      value.trim() === value &&
      value.length > 0 &&
      !value.includes("\0") &&
      !value.includes("\n") &&
      !value.includes("\r"),
    `${label} must be a non-empty single-line string`,
  );
  return value;
}

export function validateGitBranch(value, label) {
  const branch = validateIdentifier(value, label);
  const result = spawnSync("git", ["check-ref-format", "--branch", branch], {
    stdio: "ignore",
  });
  invariant(
    result.status === 0,
    `${label} must satisfy git check-ref-format --branch`,
  );
  return branch;
}

export function validatePositiveIntegerString(value, label) {
  invariant(
    typeof value === "string" && /^[1-9][0-9]*$/.test(value),
    `${label} must be a positive integer string`,
  );
  return value;
}

export function validateGitHubUrl(value, label) {
  invariant(
    typeof value === "string" &&
      value.length > 0 &&
      !/[\r\n]/.test(value),
    `${label} is invalid`,
  );
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  invariant(
    parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      value.startsWith("https://github.com/"),
    `${label} is invalid`,
  );
  return value;
}

export async function readJson(file, label = file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return parsed;
}

export function parseCliArgs(argv, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    invariant(token.startsWith("--"), `Unexpected argument: ${token}`);
    const key = token.slice(2);
    invariant(allowed.has(key), `Unknown option: --${key}`);
    const value = argv[index + 1];
    invariant(
      typeof value === "string" && !value.startsWith("--"),
      `--${key} requires a value`,
    );
    invariant(values[key] === undefined, `--${key} may only be provided once`);
    values[key] = value;
    index += 1;
  }
  return values;
}
