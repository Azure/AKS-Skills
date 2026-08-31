import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = path.resolve(__dirname, "..");
const DEFAULT_SKILLS_ROOT = path.resolve(EVALS_DIR, "../skills");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readSkillProfile(skillFile) {
  const content = fs.readFileSync(skillFile, "utf8");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) throw new Error(`SKILL.md has no YAML frontmatter: ${skillFile}`);
  const parsed = yaml.load(frontmatter[1]);
  const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
  const description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
  if (!name || !description) {
    throw new Error(`SKILL.md frontmatter must define name and description: ${skillFile}`);
  }
  return { id: name, description };
}

function findFiles(root, filename) {
  const found = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name === filename) found.push(fullPath);
    }
  }
  walk(root);
  return found.sort();
}

function discoverSkillProfiles(skillsRoot, customSkillFile) {
  const profiles = new Map();
  for (const skillFile of findFiles(skillsRoot, "SKILL.md")) {
    const profile = readSkillProfile(skillFile);
    profiles.set(profile.id, profile);
  }
  const custom = readSkillProfile(customSkillFile);
  profiles.set(custom.id, custom);
  return { custom, skills: [...profiles.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

function personalizedRoutingTests(system, triggers) {
  const tests = [];
  for (const prompt of triggers.positives ?? []) {
    tests.push({
      description: `Personalized: prompt must route to ${system}`,
      metadata: { skill: system, type: "trigger", provenance: "autogen", personalized: true },
      vars: { prompt },
      assert: [{ type: "equals", value: system }],
    });
  }
  for (const boundary of triggers.boundaries ?? []) {
    tests.push({
      description: `Personalized boundary: must route to ${boundary.expected}, not ${system}`,
      metadata: { skill: system, type: "trigger", provenance: "autogen", personalized: true },
      vars: { prompt: boundary.prompt },
      assert: [{ type: "equals", value: boundary.expected }],
    });
  }
  return tests;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? __dirname,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${path.basename(command)} exited with status ${result.status}`);
  }
  return result.status;
}

function readPromptfooRows(resultFile) {
  const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  const rows = parsed?.results?.results;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`routing evaluation produced no results: ${resultFile}`);
  }
  return rows;
}

function resultDescription(row) {
  return row?.testCase?.description ?? row?.testCase?.vars?.prompt ?? "(unnamed)";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.skill || args.skill === true) {
    console.error("error: --skill /path/to/custom-skill/SKILL.md is required");
    process.exit(2);
  }

  const skillFile = path.resolve(String(args.skill));
  const skillsRoot = path.resolve(String(args["skills-root"] || DEFAULT_SKILLS_ROOT));
  if (!fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile()) {
    throw new Error(`skill file does not exist: ${skillFile}`);
  }
  if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
    throw new Error(`skills root is not a directory: ${skillsRoot}`);
  }

  const { custom, skills } = discoverSkillProfiles(skillsRoot, skillFile);
  const outDir = path.resolve(String(args.out || path.join(process.cwd(), "autogen-out", custom.id)));
  const focus = typeof args.focus === "string" ? args.focus.trim() : "";
  const dryRun = !!args["dry-run"];
  const noRouting = !!args["no-routing"];
  fs.mkdirSync(outDir, { recursive: true });

  const candidatesFile = path.join(outDir, "candidates.json");
  const scaffoldArgs = [
    path.join(__dirname, "scaffold-eval.mjs"),
    "--skill", skillFile,
    "--skill-path", `${custom.id}/SKILL.md`,
    "--system", custom.id,
    "--skills-root", skillsRoot,
    "--min", String(args.min || 4),
    "--max", String(args.max || 8),
    "--out", candidatesFile,
  ];
  if (focus) scaffoldArgs.push("--focus", focus);
  if (dryRun) scaffoldArgs.push("--dry-run");
  if (noRouting) scaffoldArgs.push("--no-triggers");
  run(process.execPath, scaffoldArgs);

  const qualityFile = path.join(outDir, "quality-tests.autogen.yaml");
  const triggerFile = path.join(outDir, "trigger-tests.autogen.yaml");
  const gateReportFile = path.join(outDir, "gate-report.json");
  const gateArgs = [
    path.join(__dirname, "baseline-gate.mjs"),
    "--candidates", candidatesFile,
    "--skill", skillFile,
    "--out", qualityFile,
    "--trigger-out", triggerFile,
    "--wiring-out", path.join(outDir, "autogen-wiring.md"),
    "--report", gateReportFile,
  ];
  if (dryRun) gateArgs.push("--dry-run");
  run(process.execPath, gateArgs);

  const candidates = JSON.parse(fs.readFileSync(candidatesFile, "utf8"));
  const gateReport = JSON.parse(fs.readFileSync(gateReportFile, "utf8"));
  const routingResultFile = path.join(outDir, "routing-results.json");
  const generatedRoutingTests = noRouting
    ? []
    : personalizedRoutingTests(custom.id, candidates.triggers ?? {});
  const routingTests = generatedRoutingTests;
  let routing = noRouting
    ? { status: "skipped-by-user" }
    : dryRun
      ? {
          status: "planned-dry-run",
          skillCount: skills.length,
          totalPlanned: routingTests.length,
          personalizedPlanned: generatedRoutingTests.length,
        }
      : { status: "pending" };

  if (!dryRun && !noRouting) {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aks-personalized-routing-"));
    const configFile = path.join(temporaryDirectory, "promptfoo-routing.json");
    const config = {
      providers: [{
        id: pathToFileURL(path.join(EVALS_DIR, "providers/router-provider.js")).href,
        label: "Personalized Skill Router",
        config: { skills },
      }],
      prompts: ["{{prompt}}"],
      tests: routingTests,
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    try {
      const promptfoo = path.join(EVALS_DIR, "node_modules", ".bin", "promptfoo");
      if (!fs.existsSync(promptfoo)) {
        throw new Error("promptfoo is not installed; run `npm ci` from evals/");
      }
      const exitCode = run(promptfoo, [
        "eval", "-c", configFile, "-o", routingResultFile, "--no-progress-bar",
      ], { cwd: EVALS_DIR, allowFailure: true });
      if (!fs.existsSync(routingResultFile)) {
        throw new Error(`promptfoo exited ${exitCode} without writing routing results`);
      }
      const rows = readPromptfooRows(routingResultFile);
      const personalizedRows = rows.filter((row) => resultDescription(row).startsWith("Personalized"));
      routing = {
        status: "completed",
        promptfooExitCode: exitCode,
        total: rows.length,
        passed: rows.filter((row) => row.success).length,
        personalizedTotal: personalizedRows.length,
        personalizedPassed: personalizedRows.filter((row) => row.success).length,
      };
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  const summary = {
    system: custom.id,
    skillFile,
    skillsRoot,
    focus: focus || null,
    dryRun,
    quality: gateReport.summary,
    routing,
    outputs: {
      candidates: candidatesFile,
      qualityTests: qualityFile,
      triggerTests: triggerFile,
      gateReport: gateReportFile,
      routingResults: fs.existsSync(routingResultFile) ? routingResultFile : null,
    },
  };
  const summaryFile = path.join(outDir, "personalized-summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");

  console.log(`\npersonalized eval: ${custom.id}`);
  console.log(`quality: ${summary.quality.kept}/${summary.quality.total} candidates kept`);
  if (routing.status === "completed") {
    console.log(
      `routing: ${routing.passed}/${routing.total} passed ` +
      `(personalized ${routing.personalizedPassed}/${routing.personalizedTotal})`
    );
  } else {
    console.log(`routing: ${routing.status}`);
  }
  console.log(`summary: ${summaryFile}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});