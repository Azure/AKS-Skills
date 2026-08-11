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
import { fileURLToPath } from "node:url";
import { chat, parseJsonLoose } from "./lib/llm.mjs";
import { loadSkillBundle } from "./skill-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
// Boundaries whose `expected` is missing or equal to this skill are dropped —
// a boundary that routes back to us is not a boundary.
function validateTriggers(raw, skillName) {
  const out = { positives: [], boundaries: [] };
  if (!raw || typeof raw !== "object") return out;
  for (const p of Array.isArray(raw.positives) ? raw.positives : []) {
    if (typeof p === "string" && p.trim()) out.positives.push(p.trim());
  }
  for (const b of Array.isArray(raw.boundaries) ? raw.boundaries : []) {
    if (!b || typeof b !== "object") continue;
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    const expected = typeof b.expected === "string" ? b.expected.trim() : "";
    if (!prompt || !expected) continue;
    if (skillName && expected === skillName) continue;
    out.boundaries.push({ prompt, expected });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.skill || !args["skill-path"] || !args.system) {
    console.error("error: --skill, --skill-path and --system are required");
    process.exit(2);
  }
  const min = Number(args.min ?? 4);
  const max = Number(args.max ?? 8);
  const skillFile = path.resolve(args.skill);
  const bundle = loadSkillBundle(skillFile);
  const skillName = bundle.name || args.system;
  if (bundle.files.length > 1) {
    console.log(
      `bundle: SKILL.md + ${bundle.files.length - 1} reference file(s)` +
        (bundle.truncated ? " (truncated at cost budget)" : "")
    );
  }

  let raw, triggers;
  if (args["dry-run"]) {
    raw = DRY_RUN_SAMPLE;
    triggers = DRY_RUN_TRIGGERS;
  } else {
    const template = fs
      .readFileSync(path.join(__dirname, "prompts", "quality.md"), "utf8")
      .replaceAll("{{MIN}}", String(min))
      .replaceAll("{{MAX}}", String(max));
    const { text } = await chat({ system: template, user: bundle.text });
    raw = parseJsonLoose(text);

    if (args["no-triggers"]) {
      triggers = { positives: [], boundaries: [] };
    } else {
      const triggerTemplate = fs
        .readFileSync(path.join(__dirname, "prompts", "trigger.md"), "utf8")
        .replaceAll("{{SKILL_NAME}}", skillName);
      const tResp = await chat({ system: triggerTemplate, user: bundle.text });
      triggers = validateTriggers(parseJsonLoose(tResp.text), skillName);
    }
  }

  if (!Array.isArray(raw)) throw new Error("model did not return a JSON array of candidates");
  const candidates = raw.map(validateCandidate);
  if (args["dry-run"]) triggers = validateTriggers(triggers, skillName);

  const out = {
    system: args.system,
    skillName,
    skillPath: args["skill-path"],
    provenance: "autogen",
    generatedAt: new Date().toISOString(),
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

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
