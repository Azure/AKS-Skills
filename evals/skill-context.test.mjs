import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);
const {
  buildSystemMessage,
  loadSkillContext,
} = require("./providers/skill-provider.js");

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(EVALS_DIR);
const SKILLS_DIR = path.join(REPO_DIR, "skills");
const PROMPTFOO_CONFIG = path.join(EVALS_DIR, "promptfooconfig.yaml");

test("skill provider defaults to the selected SKILL.md", () => {
  const context = loadSkillContext(
    { skill_path: "aks-known-issues/SKILL.md" },
    { skillsBase: SKILLS_DIR },
  );

  assert.deepEqual(
    context.files.map((file) => file.path),
    ["SKILL.md"],
  );
  assert.doesNotMatch(buildSystemMessage(context.files), /## Loaded skill file:/);
});

test("skill provider loads declared files in declaration order", async () => {
  const context = loadSkillContext(
    {
      skill_path: "aks-troubleshooting/SKILL.md",
      skill_files: ["pod-failures.md", "references/symptom-map.md"],
    },
    { skillsBase: SKILLS_DIR },
  );

  assert.deepEqual(
    context.files.map((file) => file.path),
    ["SKILL.md", "pod-failures.md", "references/symptom-map.md"],
  );
  assert.equal(
    context.files[1].content,
    await readFile(
      path.join(SKILLS_DIR, "aks-troubleshooting", "pod-failures.md"),
      "utf8",
    ),
  );

  const message = buildSystemMessage(context.files);
  assert.match(message, /## Loaded skill file: pod-failures\.md/);
  assert.match(message, /## Loaded skill file: references\/symptom-map\.md/);
  assert.doesNotMatch(message, /## Loaded skill file: networking\.md/);
});

test("skill provider rejects invalid paths and duplicate declarations", () => {
  const base = { skill_path: "aks-known-issues/SKILL.md" };
  const options = { skillsBase: SKILLS_DIR };

  assert.throws(
    () => loadSkillContext({ ...base, skill_files: ["references/missing.md"] }, options),
    /does not name a shipped file/,
  );
  assert.throws(
    () => loadSkillContext({ ...base, skill_files: ["references"] }, options),
    /must name a file/,
  );
  assert.throws(
    () =>
      loadSkillContext(
        { ...base, skill_files: ["../aks-troubleshooting/pod-failures.md"] },
        options,
      ),
    /traversal segment/,
  );
  assert.throws(
    () =>
      loadSkillContext(
        {
          ...base,
          skill_files: [
            "references/error-code-map.md",
            "references/error-code-map.md",
          ],
        },
        options,
      ),
    /Duplicate skill file declaration/,
  );
  assert.throws(
    () =>
      loadSkillContext(
        { ...base, skill_files: ["references/./error-code-map.md"] },
        options,
      ),
    /current-directory/,
  );
  assert.throws(
    () => loadSkillContext({ ...base, skill_files: ["/etc/passwd"] }, options),
    /portable relative path/,
  );
  assert.throws(
    () =>
      loadSkillContext(
        { ...base, skill_files: ["references\\error-code-map.md"] },
        options,
      ),
    /portable relative path/,
  );
  assert.throws(
    () =>
      loadSkillContext(
        { ...base, skill_files: ["references/error-code-map.md\0"] },
        options,
      ),
    /portable relative path/,
  );
  assert.throws(
    () =>
      loadSkillContext(
        { ...base, skill_files: "references/error-code-map.md" },
        options,
      ),
    /must be an array/,
  );
  assert.throws(
    () =>
      loadSkillContext(
        { skill_path: "aks-known-issues/references/SKILL.md" },
        options,
      ),
    /must have the form <skill>\/SKILL\.md/,
  );
});

test("skill provider rejects a deep-file symlink escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aks-skill-provider-"));
  try {
    const skills = path.join(root, "skills");
    const skill = path.join(skills, "aks-fixture");
    const outside = path.join(root, "outside.md");
    await mkdir(path.join(skill, "references"), { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# Fixture\n");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(skill, "references", "escape.md"));

    assert.throws(
      () =>
        loadSkillContext(
          {
            skill_path: "aks-fixture/SKILL.md",
            skill_files: ["references/escape.md"],
          },
          { skillsBase: skills },
        ),
      /resolves outside/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill provider rejects symlink aliases of an already loaded file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aks-skill-alias-provider-"));
  try {
    const skills = path.join(root, "skills");
    const references = path.join(skills, "aks-fixture", "references");
    await mkdir(references, { recursive: true });
    await writeFile(path.join(skills, "aks-fixture", "SKILL.md"), "# Fixture\n");
    await writeFile(path.join(references, "source.md"), "source\n");
    await symlink("source.md", path.join(references, "alias.md"));

    assert.throws(
      () =>
        loadSkillContext(
          {
            skill_path: "aks-fixture/SKILL.md",
            skill_files: ["references/source.md", "references/alias.md"],
          },
          { skillsBase: skills },
        ),
      /Ambiguous skill file declaration/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill provider rejects a selected skill symlink escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aks-skill-root-provider-"));
  try {
    const skills = path.join(root, "skills");
    const outsideSkill = path.join(root, "outside-skill");
    await mkdir(skills, { recursive: true });
    await mkdir(outsideSkill, { recursive: true });
    await writeFile(path.join(outsideSkill, "SKILL.md"), "# Outside fixture\n");
    await symlink(outsideSkill, path.join(skills, "aks-fixture"));

    assert.throws(
      () =>
        loadSkillContext(
          { skill_path: "aks-fixture/SKILL.md" },
          { skillsBase: skills },
        ),
      /resolves outside|may not be a symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wired quality cases have safe context and unique case IDs", async () => {
  const config = yaml.load(await readFile(PROMPTFOO_CONFIG, "utf8"));
  const qualityFiles = (config.tests || [])
    .filter(
      (entry) =>
        typeof entry === "string"
        && entry.startsWith("file://")
        && entry.endsWith("/quality-tests.yaml"),
    )
    .map((entry) => path.join(EVALS_DIR, entry.slice("file://".length)));

  assert.ok(qualityFiles.length > 0, "promptfooconfig.yaml must wire quality tests");
  const caseIds = new Set();

  for (const qualityFile of qualityFiles) {
    const cases = yaml.load(await readFile(qualityFile, "utf8"));
    assert.ok(Array.isArray(cases), `${qualityFile} must contain a YAML test list`);

    for (const qualityCase of cases) {
      const id = qualityCase.metadata?.case_id;
      assert.equal(typeof id, "string", `${qualityFile} quality case needs metadata.case_id`);
      assert.match(id, /\S/, `${qualityFile} quality case needs a non-empty metadata.case_id`);
      assert.ok(!caseIds.has(id), `duplicate quality case_id: ${id}`);
      caseIds.add(id);

      if (qualityCase.vars?.skill_files !== undefined) {
        assert.equal(
          qualityCase.options?.disableVarExpansion,
          true,
          `${id} must disable Promptfoo variable expansion so skill_files remains one ordered array`,
        );
      }
      loadSkillContext(qualityCase.vars, { skillsBase: SKILLS_DIR });
    }
  }
});
