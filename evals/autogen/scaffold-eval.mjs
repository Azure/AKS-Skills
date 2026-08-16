// scaffold-eval.mjs — autogen step 1: propose candidate quality + trigger tests.
//
// Reads a skill BUNDLE (SKILL.md + its references/*.md), asks the model to
// propose quality test cases (behavior, not phrasing) AND routing/trigger cases
// (positives + reciprocal boundary near-misses), validates their shape, and
// writes a candidates.json for the baseline gate to filter/render. This machine
// WRITES evals; it does not record runs.
//
// Usage:
//   node src/autogen/scaffold-eval.mjs \
//     --skill ../AKS-Skills/skills/aks-troubleshooting/SKILL.md \
//     --skill-path aks-troubleshooting/SKILL.md \
//     --system aks-troubleshooting \
//     --out out/aks-troubleshooting.candidates.json \
//     [--min 4] [--max 8] [--no-triggers] [--dry-run]
//
// --no-triggers skips the trigger-generation call (quality candidates only).
// --dry-run skips the model calls and emits fixed samples (for wiring tests).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chat, parseJsonLoose } from "./lib/llm.mjs";
import { loadSkillBundle } from "./skill-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLD = { name: "scaffold-eval.mjs", version: "1.0.0" };

// Best-effort repository commit SHA so a generated candidate set is bound to the
// exact source tree. Falls back to the CI-provided SHA, then null.
function repoCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: __dirname, encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA || null;
  }
}

// Drop duplicate items by a normalized key (case-insensitive, trimmed).
function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = String(keyFn(it)).trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// The registered skill IDs are the subdirectory names of the skills/ root that
// holds this skill (skills/<id>/SKILL.md). Boundary route targets must be one of
// these (plus the router's "none"); anything else is a hallucinated route.
export function registeredSkillIds(skillFile) {
  const root = path.resolve(path.dirname(skillFile), "..");
  const ids = new Set(["none"]);
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    // A directory only counts as a registered skill if it actually contains a
    // SKILL.md — an empty or placeholder directory is NOT a valid route target.
    if (d.isDirectory() && fs.existsSync(path.join(root, d.name, "SKILL.md"))) ids.add(d.name);
  }
  return ids;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.replace(/^--/, "");
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true; // boolean flag
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const DRY_RUN_SAMPLE = [
  {
    description: "ImagePullBackOff response identifies registry auth vs tag causes",
    prompt: "My pod is stuck in ImagePullBackOff. How do I figure out why?",
    keywords: ["describe"],
    rubric:
      "Response distinguishes between image-not-found/tag errors and registry authentication failures, and shows how to read the underlying pull error",
    threshold: 0.9,
  },
];

const DRY_RUN_TRIGGERS = {
  positives: ["My pod is stuck in ImagePullBackOff — help me figure out why."],
  boundaries: [
    {
      prompt: "AKS node pool create failed with VMCannotFitEphemeralOSDisk — what does that mean?",
      expected: "aks-known-issues",
    },
  ],
};

function validateCandidate(c, i) {
  const errs = [];
  if (typeof c.description !== "string" || !c.description.trim()) errs.push("description missing");
  if (typeof c.prompt !== "string" || !c.prompt.trim()) errs.push("prompt missing");
  if (typeof c.rubric !== "string" || !c.rubric.trim()) errs.push("rubric missing");
  if (c.keywords != null && !Array.isArray(c.keywords)) errs.push("keywords must be an array");
  const t = c.threshold;
  if (t != null && (typeof t !== "number" || t < 0 || t > 1)) errs.push("threshold must be 0..1");
  if (errs.length) throw new Error(`candidate[${i}] invalid: ${errs.join("; ")}`);
  return {
    description: c.description.trim(),
    prompt: c.prompt.trim(),
    keywords: Array.isArray(c.keywords) ? c.keywords.filter((k) => typeof k === "string").slice(0, 3) : [],
    rubric: c.rubric.trim(),
    threshold: typeof t === "number" ? t : 0.9,
  };
}

// Normalize the trigger generation into { positives:[str], boundaries:[{prompt,expected}] }.
// Shape and targets are STRICT and fail-closed: a present-but-malformed field, a
// blank/typeless entry, or a boundary routing to an UNREGISTERED skill throws
// (nonzero exit) rather than being silently coerced/dropped — emitting a bad
// routing target or hiding a broken generation is worse than failing the run.
// The only silent drops are redundancies: duplicate prompts and boundaries that
// route back to this same skill (which are not boundaries at all).
export function validateTriggers(raw, skillName, knownSkills) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("triggers: expected an object { positives, boundaries }");
  }
  if (raw.positives !== undefined && !Array.isArray(raw.positives)) {
    throw new Error("triggers.positives must be an array of strings");
  }
  if (raw.boundaries !== undefined && !Array.isArray(raw.boundaries)) {
    throw new Error("triggers.boundaries must be an array of {prompt, expected}");
  }
  const positives = [];
  for (const p of raw.positives ?? []) {
    if (typeof p !== "string" || !p.trim()) {
      throw new Error(`triggers.positives: every entry must be a non-empty string (got ${JSON.stringify(p)})`);
    }
    positives.push(p.trim());
  }

  const boundaries = [];
  for (const b of raw.boundaries ?? []) {
    if (!b || typeof b !== "object" || Array.isArray(b)) {
      throw new Error("triggers.boundaries: every entry must be an object {prompt, expected}");
    }
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    const expected = typeof b.expected === "string" ? b.expected.trim() : "";
    if (!prompt || !expected) {
      throw new Error(`triggers.boundaries: entry missing prompt/expected (${JSON.stringify(b)})`);
    }
    // Routing back to this same skill is not a boundary — drop as redundant.
    if (skillName && expected === skillName) continue;
    // A boundary MUST route to a registered skill (a directory with a real
    // SKILL.md). An unregistered target is a hallucinated route: fail closed.
    if (!knownSkills || !knownSkills.size || !knownSkills.has(expected)) {
      throw new Error(`triggers.boundaries: unregistered route target "${expected}" (${prompt})`);
    }
    boundaries.push({ prompt, expected });
  }
  return {
    positives: dedupeBy(positives, (p) => p),
    boundaries: dedupeBy(boundaries, (b) => b.prompt),
  };
}

export async function generateDrafts({
  qualityTemplate,
  triggerTemplate,
  bundleText,
  skillName,
  knownSkills,
  chatImpl = chat,
}) {
  const qualityRequest = chatImpl({ system: qualityTemplate, user: bundleText });
  const triggerRequest = triggerTemplate
    ? chatImpl({ system: triggerTemplate, user: bundleText })
    : Promise.resolve(null);
  const [qualityResponse, triggerResponse] = await Promise.all([qualityRequest, triggerRequest]);

  return {
    raw: parseJsonLoose(qualityResponse.text),
    triggers: triggerResponse
      ? validateTriggers(parseJsonLoose(triggerResponse.text), skillName, knownSkills)
      : { positives: [], boundaries: [] },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.skill || !args["skill-path"] || !args.system) {
    console.error("error: --skill, --skill-path and --system are required");
    process.exit(2);
  }
  const min = Number(args.min ?? 4);
  const max = Number(args.max ?? 8);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error(`invalid --min/--max: need 1 <= min <= max (got min=${args.min}, max=${args.max})`);
  }
  const skillFile = path.resolve(args.skill);
  const bundle = loadSkillBundle(skillFile);
  const skillName = bundle.name || args.system;
  const knownSkills = registeredSkillIds(skillFile);
  console.log(
    `bundle: ${bundle.files.length} file(s) loaded ` +
      `(SKILL.md + ${bundle.files.length - 1} reference file(s))`
  );
  if (bundle.omitted.length) {
    console.log(`bundle: ${bundle.omitted.length} file(s) omitted at cost budget:`);
    for (const f of bundle.omitted) console.log(`  - ${path.relative(process.cwd(), f)}`);
  }

  let raw, triggers;
  if (args["dry-run"]) {
    raw = DRY_RUN_SAMPLE;
    triggers = args["no-triggers"] ? { positives: [], boundaries: [] } : DRY_RUN_TRIGGERS;
  } else {
    const qualityTemplate = fs
      .readFileSync(path.join(__dirname, "prompts", "quality.md"), "utf8")
      .replaceAll("{{MIN}}", String(min))
      .replaceAll("{{MAX}}", String(max));
    const triggerTemplate = args["no-triggers"]
      ? null
      : fs
          .readFileSync(path.join(__dirname, "prompts", "trigger.md"), "utf8")
          .replaceAll("{{SKILL_NAME}}", skillName);
    ({ raw, triggers } = await generateDrafts({
      qualityTemplate,
      triggerTemplate,
      bundleText: bundle.text,
      skillName,
      knownSkills,
    }));
  }

  if (!Array.isArray(raw)) throw new Error("model did not return a JSON array of candidates");
  let candidates = dedupeBy(raw.map(validateCandidate), (c) => c.prompt);
  if (candidates.length > max) candidates = candidates.slice(0, max);
  // Fail closed on too few candidates. Dry-run is a plumbing smoke test that
  // intentionally emits a single fixed sample, so it is exempt from the floor.
  if (!args["dry-run"] && candidates.length < min) {
    throw new Error(
      `only ${candidates.length} valid quality candidate(s) after validation/dedupe; need >= ${min}`
    );
  }
  if (args["dry-run"]) triggers = validateTriggers(triggers, skillName, knownSkills);

  const out = {
    system: args.system,
    skillName,
    skillPath: args["skill-path"],
    provenance: "autogen",
    generator: SCAFFOLD,
    generatedAt: new Date().toISOString(),
    context: {
      repoCommit: repoCommit(),
      files: bundle.files,
      omitted: bundle.omitted,
      truncated: bundle.truncated,
      sha256: crypto.createHash("sha256").update(bundle.text).digest("hex"),
    },
    candidates,
    triggers,
  };

  const outPath = path.resolve(args.out ?? `out/${args.system}.candidates.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `wrote ${outPath} — ${candidates.length} quality candidate(s), ` +
      `${triggers.positives.length} trigger positive(s), ${triggers.boundaries.length} boundary case(s)`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
