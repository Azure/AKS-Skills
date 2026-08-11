// baseline-gate.mjs — autogen step 2: keep only discriminating (non-tautological) tests.
//
// For each candidate the gate runs the prompt TWICE:
//   - WITH the skill as system context  → should PASS the rubric
//   - WITHOUT the skill (generic system) → should FAIL the rubric (baseline)
// A test is kept only if the skill's presence is what flips it from fail→pass.
// This blocks tautological tests that any vague answer would satisfy.
//
// Keep decision is margin-based (see Lever 2 below): keep when the skill answer
// is strong AND clears the baseline by a safe margin, then auto-calibrate a
// committed g-eval threshold that sits between baseline and skill.
//
// Kept tests are rendered as promptfoo quality-test YAML (tagged provenance:autogen).
// Trigger candidates (positives + reciprocal boundaries) are rendered straight
// through as routing YAML, and a wiring snippet is emitted for the maintainer.
//
// Usage:
//   node src/autogen/baseline-gate.mjs \
//     --candidates out/aks-troubleshooting.candidates.json \
//     --skill ../AKS-Skills/skills/aks-troubleshooting/SKILL.md \
//     --out out/aks-troubleshooting.autogen-tests.yaml \
//     [--report out/aks-troubleshooting.gate-report.json] \
//     [--trigger-out <path>] [--wiring-out <path>] [--dry-run]

import fs from "node:fs";
import path from "node:path";
import { chat, parseJsonLoose, resolveCreds } from "./lib/llm.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.replace(/^--/, "");
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const SKILL_SYSTEM = (skill) =>
  [
    "You are an AKS SRE agent. Follow the skill instructions below to respond to the user.",
    "",
    "## Skill Instructions",
    "",
    skill,
  ].join("\n");

// Mirror evals/providers/baseline-provider.js so the gate's "no skill" baseline
// matches the harness that will actually run these tests — otherwise the margin
// is measured against a weaker baseline and candidates get over-kept.
const BASELINE_SYSTEM =
  "You are a helpful assistant with expertise in Azure Kubernetes Service (AKS) and Kubernetes operations.";

const JUDGE_SYSTEM = [
  "You are a strict evaluator. Given a user prompt, an assistant answer, and a",
  "single success criterion, score how fully the answer satisfies the criterion.",
  "Score 1.0 = fully satisfies; 0.0 = does not satisfy at all. Judge only the",
  "criterion, not general helpfulness or style.",
  'Return ONLY JSON: {"score": <0..1>, "reason": "<one sentence>"}.',
].join("\n");

async function judge({ prompt, answer, rubric, creds }) {
  const user = [
    `# User prompt`,
    prompt,
    ``,
    `# Assistant answer`,
    answer,
    ``,
    `# Success criterion`,
    rubric,
  ].join("\n");
  const { text } = await chat({ system: JUDGE_SYSTEM, user, creds });
  const parsed = parseJsonLoose(text);
  const score = Number(parsed.score);
  return { score: Number.isFinite(score) ? score : 0, reason: parsed.reason ?? "" };
}

function keywordsPass(answer, keywords) {
  const lc = answer.toLowerCase();
  return (keywords ?? []).every((k) => lc.includes(String(k).toLowerCase()));
}

// --- Lever 2: margin-based, auto-calibrated keep decision --------------------
// A single fixed pass bar (0.9) throws away a candidate's strongest signal:
// the *gap* between the skill answer and the no-skill baseline. A test where
// skill=0.85 and baseline=0.40 is highly discriminating (margin 0.45) yet a
// 0.9 bar drops it. Instead we keep on margin, then calibrate a committed
// threshold that sits safely between baseline and skill.
const SAFETY = 0.1; // robustness buffer against g-eval run-to-run noise
const MIN_MARGIN = 2 * SAFETY; // 0.2 — need room for a threshold in the band
const MIN_SKILL = 0.7; // floor on skill answer quality (else it's a skill gap)
const THRESHOLD_CAP = 0.9; // don't commit a bar stronger than the original ceiling

const roundTo05 = (x) => Math.round(x * 20) / 20;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// Place the committed g-eval threshold just below the skill score (strongest
// bar the skill reliably clears), but never below baseline+SAFETY, never above
// the cap. Rounded to a clean 0.05 step.
function calibrateThreshold(skillScore, baselineScore) {
  const hi = roundTo05(skillScore - SAFETY);
  const lo = roundTo05(baselineScore + SAFETY);
  return clamp(Math.max(hi, lo), lo, THRESHOLD_CAP);
}

function yamlStr(s) {
  // JSON double-quoted scalars are valid YAML double-quoted scalars.
  return JSON.stringify(s);
}

function renderTestYaml(system, skillPath, kept, judgePin) {
  const blocks = kept.map((c) => {
    const asserts = [];
    for (const k of c.keywords ?? []) {
      asserts.push(`    - type: icontains\n      value: ${yamlStr(k)}`);
    }
    asserts.push(
      `    - type: g-eval\n      value: ${yamlStr(c.rubric)}\n      threshold: ${c.threshold}`
    );
    return [
      `- description: ${yamlStr(c.description)}`,
      `  metadata:`,
      `    skill: ${system}`,
      `    type: quality`,
      `    provenance: autogen`,
      `  vars:`,
      `    skill_path: ${yamlStr(skillPath)}`,
      `    prompt: ${yamlStr(c.prompt)}`,
      `  assert:`,
      asserts.join("\n"),
    ].join("\n");
  });
  const header =
    `# AUTOGEN quality tests for ${system} (provenance: autogen)\n` +
    `# Generated by aks-skills-eval-lab baseline-gate. Review before promoting to curated.\n` +
    `# judge-pin: ${judgePin.model} (api-version ${judgePin.apiVersion}) @ ${judgePin.at}\n` +
    `# Thresholds were calibrated against that judge; re-calibrate if the judge changes.\n`;
  return header + "\n" + blocks.join("\n\n") + "\n";
}

// Render deterministic routing/trigger tests (positives + reciprocal boundaries).
// These need no baseline gate — they are pure string-equality routing checks,
// reviewed by running them against the router in the target repo.
function renderTriggerYaml(system, triggers) {
  const rows = [];
  for (const p of triggers.positives ?? []) {
    rows.push({ prompt: p, expected: system, boundary: false });
  }
  for (const b of triggers.boundaries ?? []) {
    rows.push({ prompt: b.prompt, expected: b.expected, boundary: true });
  }
  const blocks = rows.map((r) => {
    const desc = r.boundary
      ? `Boundary: near-miss must route to ${r.expected}, not ${system}`
      : `Prompt must route to ${system}`;
    return [
      `- description: ${yamlStr(desc)}`,
      `  metadata:`,
      `    skill: ${system}`,
      `    type: trigger`,
      `    provenance: autogen`,
      `  vars:`,
      `    prompt: ${yamlStr(r.prompt)}`,
      `  assert:`,
      `    - type: equals\n      value: ${yamlStr(r.expected)}`,
    ].join("\n");
  });
  const header =
    `# AUTOGEN trigger tests for ${system} (provenance: autogen)\n` +
    `# Positives must route to ${system}; boundaries are reciprocal near-misses\n` +
    `# that must route elsewhere. Review before promoting to curated.\n`;
  return header + "\n" + blocks.join("\n\n") + "\n";
}

// The exact lines a maintainer adds to wire these tests into the eval configs.
function renderWiring(system) {
  const q = `  - file://tests/${system}/quality-tests.yaml`;
  return [
    `# Wiring for ${system} autogen tests`,
    ``,
    `Add the quality tests to BOTH the skill config and the baseline config:`,
    ``,
    `\`\`\`yaml`,
    `# evals/promptfooconfig.yaml  (under \`tests:\`)`,
    q,
    ``,
    `# evals/promptfoo-baseline.yaml  (under \`tests:\`)`,
    q,
    `\`\`\``,
    ``,
    `Trigger tests need NO wiring line: \`promptfoo-routing.yaml\` already`,
    `auto-discovers them via the \`tests/*/trigger-tests.yaml\` glob — just place`,
    `the file at \`evals/tests/${system}/trigger-tests.yaml\`.`,
    ``,
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.candidates || !args.skill) {
    console.error("error: --candidates and --skill are required");
    process.exit(2);
  }
  const spec = JSON.parse(fs.readFileSync(path.resolve(args.candidates), "utf8"));
  // Mirror evals/providers/skill-provider.js: load ONLY SKILL.md as skill
  // context so the gate's fail→pass decision matches the harness that runs
  // these tests. (scaffold-eval.mjs still generates from the full reference
  // bundle; a candidate that truly needs a reference simply won't clear this
  // gate — which is correct, since it would also fail in promptfoo today.)
  const skillContent = fs.readFileSync(path.resolve(args.skill), "utf8");
  const dry = !!args["dry-run"];
  const creds = dry ? null : resolveCreds();
  const judgePin = {
    model: dry ? "dry-run" : creds.model,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "default",
    at: new Date().toISOString(),
  };

  const results = [];
  for (const c of spec.candidates) {
    let withSkill, baseline;
    if (dry) {
      // canned, deterministic: skill passes, baseline fails
      withSkill = { answer: "(dry) skill answer", score: 0.95, reason: "dry-run" };
      baseline = { answer: "(dry) baseline answer", score: 0.3, reason: "dry-run" };
    } else {
      const skillResp = await chat({ system: SKILL_SYSTEM(skillContent), user: c.prompt, creds });
      const baseResp = await chat({ system: BASELINE_SYSTEM, user: c.prompt, creds });
      const sJudge = await judge({ prompt: c.prompt, answer: skillResp.text, rubric: c.rubric, creds });
      const bJudge = await judge({ prompt: c.prompt, answer: baseResp.text, rubric: c.rubric, creds });
      withSkill = { answer: skillResp.text, score: sJudge.score, reason: sJudge.reason };
      baseline = { answer: baseResp.text, score: bJudge.score, reason: bJudge.reason };
    }

    const kwOk = dry ? true : keywordsPass(withSkill.answer, c.keywords);
    const margin = withSkill.score - baseline.score;
    const discriminating = margin >= MIN_MARGIN;
    const skillStrong = withSkill.score >= MIN_SKILL;
    const kept = kwOk && skillStrong && discriminating;

    // Calibrate a committed threshold into the band between baseline and skill.
    const calibratedThreshold = kept
      ? calibrateThreshold(withSkill.score, baseline.score)
      : c.threshold;

    let verdict;
    if (kept) {
      verdict =
        withSkill.score < 0.9
          ? `keep (threshold ${calibratedThreshold.toFixed(2)}; skill ${withSkill.score.toFixed(
              2
            )} < 0.90 — possible skill gap)`
          : `keep (threshold ${calibratedThreshold.toFixed(2)})`;
    } else if (!kwOk) {
      verdict = "drop: skill answer missing required keyword(s)";
    } else if (!skillStrong) {
      verdict = `drop: skill answer too weak (${withSkill.score.toFixed(
        2
      )} < ${MIN_SKILL}) — possible skill gap`;
    } else {
      verdict = `drop: not discriminating (margin ${margin.toFixed(2)} < ${MIN_MARGIN})`;
    }

    results.push({
      description: c.description,
      threshold: calibratedThreshold,
      proposedThreshold: c.threshold,
      withSkillScore: withSkill.score,
      baselineScore: baseline.score,
      margin,
      keywordsPass: kwOk,
      kept,
      verdict,
      candidate: { ...c, threshold: calibratedThreshold },
    });
  }

  const kept = results.filter((r) => r.kept).map((r) => r.candidate);
  const yaml = renderTestYaml(spec.system, spec.skillPath, kept, judgePin);

  const outPath = path.resolve(args.out ?? `out/${spec.system}.autogen-tests.yaml`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, yaml);

  // Trigger tests + wiring are deterministic — render them straight through.
  const triggers = spec.triggers ?? { positives: [], boundaries: [] };
  const triggerCount = (triggers.positives?.length ?? 0) + (triggers.boundaries?.length ?? 0);
  const triggerOut = path.resolve(
    args["trigger-out"] ?? outPath.replace(/\.autogen-tests\.yaml$/, ".autogen-trigger-tests.yaml")
  );
  fs.writeFileSync(triggerOut, renderTriggerYaml(spec.system, triggers));

  const wiringOut = path.resolve(
    args["wiring-out"] ?? outPath.replace(/\.autogen-tests\.yaml$/, ".wiring.md")
  );
  fs.writeFileSync(wiringOut, renderWiring(spec.system));

  if (args.report) {
    const reportPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ system: spec.system, judgePin, results }, null, 2) + "\n"
    );
  }

  console.log(
    `gate: ${kept.length}/${results.length} kept → ${outPath}` +
      `\ntriggers: ${triggerCount} → ${triggerOut}` +
      `\nwiring → ${wiringOut}` +
      (args.report ? `\nreport → ${path.resolve(args.report)}` : "")
  );
  for (const r of results) {
    console.log(
      `  [${r.kept ? "keep" : "drop"}] ${r.description} ` +
        `(skill ${r.withSkillScore.toFixed(2)} / baseline ${r.baselineScore.toFixed(2)} / ` +
        `margin ${r.margin.toFixed(2)}) — ${r.verdict}`
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
