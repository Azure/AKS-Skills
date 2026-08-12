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
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chat, parseJsonLoose, resolveCreds, AZURE_API_VERSION } from "./lib/llm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = { name: "baseline-gate.mjs", version: "1.0.0" };

// Best-effort repository commit SHA so a gate report is bound to the exact source
// tree it graded. Falls back to the CI-provided SHA, then null.
function repoCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: __dirname, encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA || null;
  }
}

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

// The judge contract: a score that is a finite JSON NUMBER in [0,1]. Exported so
// the fail-closed decision can be checked deterministically without an LLM call.
export function scoreIsValid(s) {
  return typeof s === "number" && Number.isFinite(s) && s >= 0 && s <= 1;
}

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
  // Fail closed: the judge contract is a score that is a finite JSON NUMBER in
  // [0,1]. Anything else — missing, null, boolean, string, NaN, out of range — is
  // INVALID (valid:false), never coerced. `Number(false)` is 0 and `Number("x")`
  // is NaN; coercing either would let malformed evidence silently drive the
  // margin/keep decision. The caller drops any candidate with an invalid score.
  const s = parsed.score;
  const valid = scoreIsValid(s);
  return { score: valid ? s : null, reason: parsed.reason ?? "", valid };
}

function keywordsPass(answer, keywords) {
  const lc = answer.toLowerCase();
  return (keywords ?? []).every((k) => lc.includes(String(k).toLowerCase()));
}

// --- Lever 2: margin-based keep decision against a FIXED committed threshold ---
// A single fixed pass bar throws away a candidate's strongest signal: the *gap*
// between the skill answer and the no-skill baseline. So the keep decision is
// margin-based. But the committed g-eval threshold must NOT be fitted to the same
// run's judge scores that selected the candidate — deriving the bar from those
// scores is circular (it guarantees a pass). Instead we commit a FIXED authoring
// bar and keep a candidate only if the skill clears it AND the baseline fails it,
// each by the SAFETY margin. Fixed bar + straddle test = no same-sample fitting.
const SAFETY = 0.1; // robustness buffer against g-eval run-to-run noise
const MIN_MARGIN = 2 * SAFETY; // 0.2 — skill must clear baseline by a real gap
const MIN_SKILL = 0.7; // floor on skill answer quality (else it's a skill gap)
const COMMITTED_THRESHOLD = 0.8; // fixed authoring-contract bar (0.80–0.95 min)

function yamlStr(s) {
  // JSON double-quoted scalars are valid YAML double-quoted scalars.
  return JSON.stringify(s);
}

function renderTestYaml(system, skillPath, kept, judgePin, dry = false) {
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
  const dryBanner = dry
    ? `# ⚠️ DRY-RUN OUTPUT — NOT PROMOTABLE. Fixed samples, no LLM calls. Do not merge.\n`
    : "";
  const header =
    dryBanner +
    `# AUTOGEN quality tests for ${system} (provenance: autogen)\n` +
    `# Generated by aks-skills-eval-lab baseline-gate. Review before promoting to curated.\n` +
    `# judge-pin: ${judgePin.model} (api-version ${judgePin.apiVersion}) @ ${judgePin.at}\n` +
    `# Thresholds were calibrated against that judge; re-calibrate if the judge changes.\n`;
  return header + "\n" + blocks.join("\n\n") + "\n";
}

// Render deterministic routing/trigger tests (positives + reciprocal boundaries).
// These need no baseline gate — they are pure string-equality routing checks,
// reviewed by running them against the router in the target repo.
function renderTriggerYaml(system, triggers, dry = false) {
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
  const dryBanner = dry
    ? `# ⚠️ DRY-RUN OUTPUT — NOT PROMOTABLE. Fixed samples, no LLM calls. Do not merge.\n`
    : "";
  const header =
    dryBanner +
    `# AUTOGEN trigger tests for ${system} (provenance: autogen)\n` +
    `# Positives must route to ${system}; boundaries are reciprocal near-misses\n` +
    `# that must route elsewhere. Review before promoting to curated.\n`;
  return header + "\n" + blocks.join("\n\n") + "\n";
}

// Does a promptfoo config already reference this skill's autogen quality tests?
// Returns true/false, or null when the config can't be read (detection is advisory).
function configHasWiring(configPath, system) {
  try {
    const body = fs.readFileSync(configPath, "utf8");
    const needle = `file://tests/${system}/quality-tests.yaml`;
    return body.split(/\r?\n/).some((l) => l.includes(needle));
  } catch {
    return null;
  }
}

// The exact lines a maintainer adds to wire these tests into the eval configs.
// `wired` records whether each config already references the file (true/false/null
// = couldn't read); already-wired configs are reported as no-ops.
function renderWiring(system, wired = {}, dry = false) {
  const title = `# Wiring for ${system} autogen tests`;
  if (dry) {
    return [
      title,
      ``,
      `> ⚠️ DRY-RUN artifact — do not wire or promote. Regenerate without \`--dry-run\`.`,
      ``,
    ].join("\n");
  }
  const q = `  - file://tests/${system}/quality-tests.yaml`;
  const block = (file, present) => {
    if (present === true) return `- \`${file}\`: ✓ already wired — no action needed.`;
    const note =
      present === null || present === undefined
        ? ` (could not read to verify — add if missing)`
        : ``;
    return `- \`${file}\`: add under \`tests:\`${note}:\n\n\`\`\`yaml\n${q}\n\`\`\``;
  };
  return [
    title,
    ``,
    `Add the quality tests to BOTH configs (skip any already wired):`,
    ``,
    block("evals/promptfooconfig.yaml", wired.config),
    ``,
    block("evals/promptfoo-baseline.yaml", wired.baseline),
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
  const candidatesPath = path.resolve(args.candidates);
  const candidatesText = fs.readFileSync(candidatesPath, "utf8");
  const spec = JSON.parse(candidatesText);
  const candidatesSha256 = crypto.createHash("sha256").update(candidatesText).digest("hex");
  const contextTruncated = !!(spec.context && spec.context.truncated);
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
    apiVersion: dry ? "dry-run" : AZURE_API_VERSION,
    at: new Date().toISOString(),
  };

  const results = [];
  for (const c of spec.candidates) {
    let withSkill, baseline;
    if (dry) {
      // canned, deterministic: skill passes, baseline fails
      withSkill = { answer: "(dry) skill answer", score: 0.95, reason: "dry-run", valid: true };
      baseline = { answer: "(dry) baseline answer", score: 0.3, reason: "dry-run", valid: true };
    } else {
      const skillResp = await chat({ system: SKILL_SYSTEM(skillContent), user: c.prompt, creds });
      const baseResp = await chat({ system: BASELINE_SYSTEM, user: c.prompt, creds });
      const sJudge = await judge({ prompt: c.prompt, answer: skillResp.text, rubric: c.rubric, creds });
      const bJudge = await judge({ prompt: c.prompt, answer: baseResp.text, rubric: c.rubric, creds });
      withSkill = { answer: skillResp.text, score: sJudge.score, reason: sJudge.reason, valid: sJudge.valid };
      baseline = { answer: baseResp.text, score: bJudge.score, reason: bJudge.reason, valid: bJudge.valid };
    }

    // Decision state, resolved below. `quarantined` means a skill-gap candidate
    // that is recorded for review but NOT promoted into the kept YAML.
    let kept = false;
    let quarantined = false;
    let verdict;
    let margin = null;
    let kwOk = null;
    let committedThreshold = COMMITTED_THRESHOLD;

    const judgeValid = withSkill.valid && baseline.valid;
    if (!judgeValid) {
      // R1: fail closed on malformed judge evidence — never coerce/clamp.
      verdict = "drop: judge returned invalid/missing score (fail-closed)";
    } else {
      kwOk = dry ? true : keywordsPass(withSkill.answer, c.keywords);
      margin = withSkill.score - baseline.score;
      const discriminating = margin >= MIN_MARGIN;
      const skillStrong = withSkill.score >= MIN_SKILL;
      // R3: fixed-bar straddle test — NOT fitted to this sample. The skill must
      // clear the committed threshold and the baseline must fail it, each by SAFETY.
      const skillClears = withSkill.score >= COMMITTED_THRESHOLD + SAFETY;
      const baselineFails = baseline.score <= COMMITTED_THRESHOLD - SAFETY;

      if (!kwOk) {
        verdict = "drop: skill answer missing required keyword(s)";
      } else if (!skillStrong) {
        quarantined = true;
        verdict = `quarantine: skill answer too weak (${withSkill.score.toFixed(
          2
        )} < ${MIN_SKILL}) — skill gap, not promotable`;
      } else if (!discriminating) {
        verdict = `drop: not discriminating (margin ${margin.toFixed(2)} < ${MIN_MARGIN})`;
      } else if (!skillClears || !baselineFails) {
        // Not separable at the fixed committed bar with the safety margin: the
        // skill can't reliably clear it, or the baseline also clears it.
        quarantined = true;
        verdict =
          `quarantine: not separable at committed threshold ${COMMITTED_THRESHOLD.toFixed(2)} ` +
          `(need skill ≥ ${(COMMITTED_THRESHOLD + SAFETY).toFixed(2)} and baseline ≤ ` +
          `${(COMMITTED_THRESHOLD - SAFETY).toFixed(2)}) — skill gap, not promotable`;
      } else {
        committedThreshold = COMMITTED_THRESHOLD;
        kept = true;
        verdict = `keep (threshold ${COMMITTED_THRESHOLD.toFixed(2)})`;
      }
    }

    results.push({
      description: c.description,
      threshold: committedThreshold,
      proposedThreshold: c.threshold,
      withSkillScore: withSkill.score,
      baselineScore: baseline.score,
      margin,
      keywordsPass: kwOk,
      judgeValid,
      kept,
      quarantined,
      verdict,
      withSkillAnswer: withSkill.answer,
      baselineAnswer: baseline.answer,
      skillReason: withSkill.reason,
      baselineReason: baseline.reason,
      candidate: { ...c, threshold: committedThreshold },
    });
  }

  const kept = results.filter((r) => r.kept).map((r) => r.candidate);
  const quarantinedCount = results.filter((r) => r.quarantined).length;
  const yaml = renderTestYaml(spec.system, spec.skillPath, kept, judgePin, dry);

  const outPath = path.resolve(args.out ?? `out/${spec.system}.autogen-tests.yaml`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, yaml);

  // Trigger tests + wiring are deterministic — render them straight through.
  const triggers = spec.triggers ?? { positives: [], boundaries: [] };
  const triggerCount = (triggers.positives?.length ?? 0) + (triggers.boundaries?.length ?? 0);
  // Derive distinct sibling names from --out regardless of its extension, so a
  // custom --out can never make these defaults collide with the quality YAML.
  const outBase = /\.autogen-tests\.yaml$/.test(outPath)
    ? outPath.replace(/\.autogen-tests\.yaml$/, "")
    : outPath.replace(/\.[^./]+$/, "");
  const triggerOut = path.resolve(args["trigger-out"] ?? `${outBase}.autogen-trigger-tests.yaml`);
  fs.writeFileSync(triggerOut, renderTriggerYaml(spec.system, triggers, dry));

  // Detect whether the eval configs already reference these tests (advisory).
  const wired = {
    config: configHasWiring(path.join(__dirname, "..", "promptfooconfig.yaml"), spec.system),
    baseline: configHasWiring(path.join(__dirname, "..", "promptfoo-baseline.yaml"), spec.system),
  };
  const wiringOut = path.resolve(args["wiring-out"] ?? `${outBase}.wiring.md`);
  fs.writeFileSync(wiringOut, renderWiring(spec.system, wired, dry));

  if (args.report) {
    // B5: bind the report to the exact source/context so a human reviewer can
    // audit and reproduce why each candidate was kept — answers, judge reasons,
    // skill SHA, the generation context manifest, generator identity, dry state.
    const skillSha256 = crypto.createHash("sha256").update(skillContent).digest("hex");
    // R4: a report is promotable only if it is a real (non-dry) run AND the
    // generation bundle was NOT truncated — truncation means mandatory reference
    // material (e.g. a constraint spec) was omitted, so the tests aren't fully
    // grounded and must not be promoted regardless of per-candidate verdicts.
    const promotable = !dry && !contextTruncated;
    const notPromotableReason = dry
      ? "dry-run"
      : contextTruncated
        ? "generation context truncated — mandatory reference material omitted at cost budget"
        : null;
    const report = {
      system: spec.system,
      generator: GENERATOR,
      scaffold: spec.generator ?? null,
      dryRun: dry,
      promotable,
      notPromotableReason,
      source: {
        repoCommit: repoCommit(),
        skillPath: spec.skillPath,
        skillFile: path.resolve(args.skill),
        skillSha256,
        candidatesFile: candidatesPath,
        candidatesSha256,
        generatedAt: spec.generatedAt ?? null,
        context: spec.context ?? null,
      },
      judgePin,
      summary: { total: results.length, kept: kept.length, quarantined: quarantinedCount },
      results,
    };
    const reportPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  }

  const fmt = (x) => (typeof x === "number" ? x.toFixed(2) : "n/a");
  const promoteNote = dry
    ? " (DRY-RUN — not promotable)"
    : contextTruncated
      ? " (context truncated — not promotable)"
      : "";
  console.log(
    `gate: ${kept.length}/${results.length} kept` +
      (quarantinedCount ? `, ${quarantinedCount} quarantined` : "") +
      promoteNote +
      ` → ${outPath}` +
      `\ntriggers: ${triggerCount} → ${triggerOut}` +
      `\nwiring → ${wiringOut}` +
      (args.report ? `\nreport → ${path.resolve(args.report)}` : "")
  );
  for (const r of results) {
    const tag = r.kept ? "keep" : r.quarantined ? "quar" : "drop";
    console.log(
      `  [${tag}] ${r.description} ` +
        `(skill ${fmt(r.withSkillScore)} / baseline ${fmt(r.baselineScore)} / ` +
        `margin ${fmt(r.margin)}) — ${r.verdict}`
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
