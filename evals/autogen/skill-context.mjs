// skill-context.mjs — load a skill's full authoring context for autogen.
//
// A SKILL.md is only half the skill: its `references/*` files (Markdown and
// YAML) carry the error tables, command catalogs, constraint specs, and
// Azure-specific detail that candidate tests should be grounded in. Proposing
// candidates from SKILL.md alone misses that distinctive edge, so this loader
// bundles SKILL.md + references for the *generation* step (scaffold-eval.mjs).
//
// NOTE: the gate (baseline-gate.mjs) scores candidates against SKILL.md ONLY,
// to match the eval harness (evals/providers/skill-provider.js). A candidate
// that truly depends on a reference is therefore dropped by the gate — correct,
// since it would also fail in promptfoo until the provider loads references.
//
// A hard character budget keeps a large reference set from blowing up cost.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_CHARS = 20000; // ~5k tokens — cost guard for the bundle

/**
 * Read the frontmatter `name:` from a SKILL.md body, falling back to null.
 * @param {string} skillContent
 * @returns {string|null}
 */
export function parseSkillName(skillContent) {
  const fm = skillContent.match(/^---\n([\s\S]*?)\n---/);
  const scope = fm ? fm[1] : skillContent;
  const m = scope.match(/^name:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m);
  return m ? m[1] : null;
}

/**
 * Bundle a skill's SKILL.md with its sibling references/*.md and *.yaml files.
 *
 * @param {string} skillFile  path to SKILL.md
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  hard cap on the combined bundle size
 * @returns {{ text: string, name: string|null, files: string[], truncated: boolean }}
 */
export function loadSkillBundle(skillFile, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const abs = path.resolve(skillFile);
  const skillContent = fs.readFileSync(abs, "utf8");
  const name = parseSkillName(skillContent);

  const parts = [`# SKILL.md\n\n${skillContent.trim()}`];
  const files = [abs];

  const refDir = path.join(path.dirname(abs), "references");
  if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
    const refs = fs
      .readdirSync(refDir)
      .filter((f) => /\.(md|ya?ml)$/i.test(f))
      .sort();
    for (const f of refs) {
      const p = path.join(refDir, f);
      const body = fs.readFileSync(p, "utf8").trim();
      parts.push(`# reference: references/${f}\n\n${body}`);
      files.push(p);
    }
  }

  let text = parts.join("\n\n---\n\n");
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n\n[...bundle truncated at cost budget...]";
    truncated = true;
  }
  return { text, name, files, truncated };
}
