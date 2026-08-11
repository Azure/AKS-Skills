// skill-context.mjs — load a skill's full authoring context for autogen.
//
// A SKILL.md is only half the skill: its `references/*.md` files carry the
// error tables, command catalogs, and Azure-specific detail that the tests
// should be grounded in. Generating (and gating) against SKILL.md alone means
// any test that hinges on a reference gets scored as a "skill gap" and dropped.
//
// This loader bundles SKILL.md + sibling references/*.md into one string, with
// a hard character budget so a large reference set can't blow up prompt cost.

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
 * Bundle a skill's SKILL.md with its sibling references/*.md files.
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
      .filter((f) => f.toLowerCase().endsWith(".md"))
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
