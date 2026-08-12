// skill-context.mjs — load a skill's full authoring context for autogen.
//
// A SKILL.md is only half the skill: its reference files (Markdown and YAML)
// carry the error tables, command catalogs, constraint specs, and Azure-specific
// detail that candidate tests should be grounded in. Those references live in one
// of two layouts, so this loader discovers BOTH:
//   - sibling files next to SKILL.md (e.g. aks-cost-optimization/azure-aks-*.md)
//   - a references/ subdirectory   (e.g. aks-automatic-readiness/references/*.yaml)
// The bundle feeds the *generation* step (scaffold-eval.mjs).
//
// NOTE: the gate (baseline-gate.mjs) scores candidates against SKILL.md ONLY,
// to match the eval harness (evals/providers/skill-provider.js). A candidate
// that truly depends on a reference is therefore dropped by the gate — correct,
// since it would also fail in promptfoo until the provider loads references.
//
// A hard character budget keeps a large reference set from blowing up cost. The
// bundle is assembled file-by-file so `files` is an EXACT manifest of what was
// actually included; anything dropped for budget is reported in `omitted` rather
// than silently sliced mid-file (which would make the manifest lie).

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_CHARS = 20000; // ~5k tokens — cost guard for the bundle
const BUNDLE_SEP = "\n\n---\n\n";

// A reference file is any Markdown or YAML sibling/child (SKILL.md excluded).
const isRefFile = (f) => /\.(md|ya?ml)$/i.test(f);

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
 * Bundle a skill's SKILL.md with its reference files. References are discovered
 * as siblings of SKILL.md AND under a references/ subdirectory (Markdown + YAML).
 * Files are added whole, in order, until the character budget is reached; the
 * returned `files` manifest lists ONLY files fully included, and `omitted` lists
 * those dropped for budget — so the manifest never claims content it didn't load.
 *
 * @param {string} skillFile  path to SKILL.md
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  hard cap on the combined bundle size
 * @returns {{ text: string, name: string|null, files: string[], omitted: string[], truncated: boolean }}
 */
export function loadSkillBundle(skillFile, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const abs = path.resolve(skillFile);
  const skillContent = fs.readFileSync(abs, "utf8");
  const name = parseSkillName(skillContent);

  // SKILL.md is the core and is always included (even if it alone exceeds budget).
  const skillBlock = `# SKILL.md\n\n${skillContent.trim()}`;
  const parts = [skillBlock];
  const files = [abs];
  const omitted = [];
  let size = skillBlock.length;

  // Discover reference files in both supported layouts, labelled by their
  // location so the bundle text is unambiguous about provenance.
  const dir = path.dirname(abs);
  const refs = [];
  for (const f of fs.readdirSync(dir).filter(isRefFile).sort()) {
    const p = path.join(dir, f);
    if (path.resolve(p) === abs) continue; // skip SKILL.md itself
    if (!fs.statSync(p).isFile()) continue;
    refs.push({ label: f, p });
  }
  const refDir = path.join(dir, "references");
  if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
    for (const f of fs.readdirSync(refDir).filter(isRefFile).sort()) {
      const p = path.join(refDir, f);
      if (!fs.statSync(p).isFile()) continue;
      refs.push({ label: `references/${f}`, p });
    }
  }

  for (const { label, p } of refs) {
    const body = fs.readFileSync(p, "utf8").trim();
    const block = `# reference: ${label}\n\n${body}`;
    if (size + BUNDLE_SEP.length + block.length > maxChars) {
      omitted.push(path.resolve(p)); // record, keep scanning for smaller files
      continue;
    }
    parts.push(block);
    files.push(path.resolve(p));
    size += BUNDLE_SEP.length + block.length;
  }

  const text = parts.join(BUNDLE_SEP);
  return { text, name, files, omitted, truncated: omitted.length > 0 };
}
