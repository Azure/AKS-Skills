#!/usr/bin/env node
// Generate a readable, committable eval report from the latest eval artifacts.
//
// Consumes existing artifacts (does NOT run evals itself), so the workflow is
// always "run evals, then generate report" — the same locally and in CI.
//
//   promptfoo : evals/results.json, routing-results.json, baseline-results.json
//   vally     : evals/vally-results/<timestamp>/{results.jsonl,eval-results.md}
//
// Writes:  evals/history/<YYYY-MM-DD>-<type>/report.md
//          evals/history/README.md   (regenerated newest-first index)
//
// Usage:   node scripts/generate-report.mjs [--type manual|weekly] [--date YYYY-MM-DD]
//
// Local `npm run report` defaults to type=manual and is meant for PREVIEW —
// only weekly (CI) and deliberate reports should be committed.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(EVALS_DIR, '..');
const HISTORY_DIR = join(EVALS_DIR, 'history');

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const args = { type: 'manual', date: new Date().toISOString().slice(0, 10) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') args.type = argv[++i];
    else if (a === '--date') args.date = argv[++i];
  }
  if (!/^[a-z0-9-]+$/i.test(args.type)) {
    throw new Error(`Invalid --type "${args.type}" (use letters, digits, hyphens)`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`Invalid --date "${args.date}" (expected YYYY-MM-DD)`);
  }
  return args;
}

// ---------------------------------------------------------------- helpers
function git(cmd, fallback) {
  try {
    return execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function num(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n ?? '');
}

function duration(ms) {
  if (typeof ms !== 'number' || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function pct(pass, total) {
  return total > 0 ? `${Math.round((pass / total) * 100)}%` : '—';
}

// Strip the absolute repo path so committed reports are portable and leak no
// local usernames/paths. Also scrub secrets that can appear in judge/model
// error bodies (Azure OpenAI endpoints and key-like tokens) so committed,
// public reports never carry them.
function sanitize(text) {
  return String(text)
    .split(REPO_ROOT + '/').join('').split(REPO_ROOT).join('')
    .replace(/https?:\/\/[a-z0-9.-]*openai\.azure\.com[^\s"']*/gi, '[endpoint]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted-key]');
}

// A failing case can be an *infrastructure* error (judge/API 5xx, rate limit,
// timeout) rather than a real quality regression. These are noise on a trend
// line, and their bodies can leak internal details, so we detect and bucket
// them separately instead of counting them as skill failures.
function isInfraError(reason) {
  if (!reason) return false;
  return /\bAPI error\b|\berror \(5\d\d\)|"type":\s*"server_error"|rate.?limit|ECONNRESET|ETIMEDOUT|\btimeout\b|fetch failed/i.test(
    String(reason),
  );
}

// ---------------------------------------------------------------- promptfoo
const PROMPTFOO_SOURCES = [
  { file: 'results.json', label: 'Quality' },
  { file: 'routing-results.json', label: 'Routing / Trigger' },
  { file: 'baseline-results.json', label: 'Baseline' },
];

function readPromptfoo() {
  const sections = [];
  for (const src of PROMPTFOO_SOURCES) {
    const path = join(EVALS_DIR, src.file);
    if (!existsSync(path)) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const r = json.results || {};
    const stats = r.stats || {};
    const rows = (r.results || []).map((t) => {
      const reason = t.gradingResult && t.gradingResult.reason;
      const isError = !!t.error || (!t.success && isInfraError(reason));
      return {
        name: (t.testCase && t.testCase.description) || '(unnamed test)',
        ok: !!t.success && !isError,
        isError,
        score: typeof t.score === 'number' ? t.score : null,
        reason,
      };
    });
    // Derive counts from the classified rows so the summary always matches the
    // per-row verdicts (infra errors excluded from the quality pass rate).
    const pass = rows.filter((row) => row.ok).length;
    const errors = rows.filter((row) => row.isError).length;
    const fail = rows.length - pass - errors;
    const total = rows.length;
    sections.push({
      label: src.label,
      file: src.file,
      timestamp: r.timestamp || null,
      pass,
      fail,
      errors,
      total,
      tokens: stats.tokenUsage && stats.tokenUsage.total,
      durationMs: stats.durationMs,
      rows,
    });
  }
  return sections;
}

// ---------------------------------------------------------------- vally
// vally records the tier on each stimulus at trajectory.stimulus.tags.tier.
// A run dir may cover one tier (tag-filtered) or several (unfiltered). We group
// trials by tier and, for each tier, keep the trials from the NEWEST run that
// covers it — so the report reflects the latest result per tier and labels each
// correctly, instead of showing only the single newest run hardcoded as "Mock".
const TIER_ORDER = ['smoke', 'mock'];

// The current, valid tiers are whatever .vally.yaml defines as suite filters.
// Constraining to these keeps retired tiers (e.g. a removed `full`) and legacy
// untagged runs in old artifacts from leaking back into the report.
function knownTiers() {
  try {
    const cfg = yaml.load(readFileSync(resolve(REPO_ROOT, '.vally.yaml'), 'utf8'));
    const tiers = new Set();
    for (const suite of Object.values((cfg && cfg.suites) || {})) {
      const t = suite && suite.filter && suite.filter.tier;
      if (t) tiers.add(t);
    }
    if (tiers.size) return tiers;
  } catch {
    /* fall through to defaults */
  }
  return new Set(TIER_ORDER);
}

function vallyDisplayTimestamp(runId) {
  // dir name like 2026-06-30T19-47-29-376Z -> 2026-06-30T19:47:29
  const m = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}` : runId;
}

function readVally() {
  const base = join(EVALS_DIR, 'vally-results');
  if (!existsSync(base)) return [];
  const dirs = readdirSync(base)
    .filter((d) => existsSync(join(base, d, 'results.jsonl')))
    .sort(); // ascending (dir name is an ISO timestamp): oldest -> newest

  // tier -> { runId, trials[] }; a newer run covering a tier overwrites older.
  const byTier = new Map();
  for (const runId of dirs) {
    let sawSummary = false;
    const trials = [];
    for (const line of readFileSync(join(base, runId, 'results.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === 'run-summary') sawSummary = true;
      if (o.type !== 'trial-result') continue;
      const tier =
        (o.trajectory &&
          o.trajectory.stimulus &&
          o.trajectory.stimulus.tags &&
          o.trajectory.stimulus.tags.tier) ||
        'untagged';
      trials.push({
        tier,
        evalName: o.evalName || '(unknown eval)',
        stimulus: o.stimulus || '(unnamed stimulus)',
        passed: !!(o.gradeResult && o.gradeResult.passed),
        score: o.gradeResult && typeof o.gradeResult.score === 'number' ? o.gradeResult.score : null,
        graders: (o.gradeResult && o.gradeResult.evidence) || '',
      });
    }
    // Only trust complete runs (those that wrote a run-summary line).
    if (!sawSummary || trials.length === 0) continue;
    const tiersInRun = new Map();
    for (const t of trials) {
      if (!tiersInRun.has(t.tier)) tiersInRun.set(t.tier, []);
      tiersInRun.get(t.tier).push(t);
    }
    for (const [tier, tierTrials] of tiersInRun) {
      byTier.set(tier, { runId, trials: tierTrials });
    }
  }

  const groups = [...byTier.entries()].map(([tier, { runId, trials }]) => ({
    tier,
    runId,
    timestamp: vallyDisplayTimestamp(runId),
    pass: trials.filter((t) => t.passed).length,
    total: trials.length,
    rows: trials,
  }));
  const known = knownTiers();
  const filtered = groups.filter((g) => known.has(g.tier));
  filtered.sort((a, b) => {
    const ia = TIER_ORDER.indexOf(a.tier);
    const ib = TIER_ORDER.indexOf(b.tier);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.tier.localeCompare(b.tier);
  });
  return filtered;
}

// ---------------------------------------------------------------- build
function buildReport({ type, date }, promptfoo, vally) {
  const sha = git('rev-parse --short HEAD', 'unknown');
  const branch = git('rev-parse --abbrev-ref HEAD', 'unknown');
  const generated = new Date().toISOString();

  const out = [];
  out.push('# AKS Skills — Eval Report');
  out.push('');
  out.push(`- **Date:** ${date}`);
  out.push(`- **Type:** ${type}`);
  out.push(`- **Commit:** \`${sha}\` (${branch})`);
  out.push(`- **Eval model:** ${process.env.EVAL_MODEL || 'unknown'}`);
  out.push(`- **Judge model:** ${process.env.JUDGE_MODEL || process.env.EVAL_MODEL || 'unknown'}`);
  out.push(`- **Generated:** ${generated}`);
  out.push('');
  out.push('> Auto-generated by `scripts/generate-report.mjs` from the latest');
  out.push('> eval artifacts. Do not edit by hand.');
  out.push('');

  // Summary table
  out.push('## Summary');
  out.push('');
  out.push('| System | Suite | Passed | Errors | Total | Pass % |');
  out.push('|---|---|---|---|---|---|');
  for (const s of promptfoo) {
    const errs = s.errors ?? 0;
    // Pass % excludes infra/judge errors so a 5xx can't read as a skill regression.
    out.push(`| promptfoo | ${s.label} | ${s.pass} | ${errs} | ${s.total} | ${pct(s.pass, s.total - errs)} |`);
  }
  for (const g of vally) {
    out.push(`| vally (agentic) | ${g.tier} | ${g.pass} | 0 | ${g.total} | ${pct(g.pass, g.total)} |`);
  }
  out.push('');

  // Skill value-add: Quality (skill on) vs Baseline (skill off) on the SAME
  // quality tests, joined by test name. Both suites load
  // tests/*/quality-tests.yaml, so descriptions line up one-to-one.
  const quality = promptfoo.find((s) => s.label === 'Quality');
  const baseline = promptfoo.find((s) => s.label === 'Baseline');
  if (quality && baseline) {
    const den = (s) => s.total - (s.errors || 0); // exclude infra errors
    const qDen = den(quality);
    const bDen = den(baseline);
    const delta =
      qDen > 0 && bDen > 0 ? Math.round((quality.pass / qDen - baseline.pass / bDen) * 100) : null;
    out.push('## Skill value-add (vs. no-skill baseline)');
    out.push('');
    out.push('> Same quality tests with the skill loaded vs. the bare model.');
    out.push('> Infra/judge errors are excluded from both rates.');
    out.push('');
    out.push(`- **With skill:** ${quality.pass}/${qDen} (${pct(quality.pass, qDen)})`);
    out.push(`- **Baseline (no skill):** ${baseline.pass}/${bDen} (${pct(baseline.pass, bDen)})`);
    out.push(`- **Delta:** ${delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta} pts`}`);
    out.push('');
    const cell = (row) => {
      if (!row) return '—';
      const icon = row.isError ? '⚠️' : row.ok ? '✅' : '❌';
      return row.score === null ? icon : `${icon} ${row.score}`;
    };
    const byName = new Map(baseline.rows.map((r) => [r.name, r]));
    out.push('| Test | With skill | Baseline |');
    out.push('|---|---|---|');
    for (const row of quality.rows) {
      out.push(`| ${row.name} | ${cell(row)} | ${cell(byName.get(row.name))} |`);
    }
    out.push('');
  }

  // promptfoo sections
  for (const s of promptfoo) {
    out.push(`## promptfoo — ${s.label}`);
    out.push('');
    const meta = [`Source: \`${s.file}\``];
    if (s.timestamp) meta.push(`run: ${s.timestamp}`);
    if (typeof s.tokens === 'number') meta.push(`tokens: ${num(s.tokens)}`);
    if (typeof s.durationMs === 'number') meta.push(`duration: ${duration(s.durationMs)}`);
    out.push(`> ${meta.join(' · ')}`);
    out.push('');
    out.push('| Test | Result | Score | Notes |');
    out.push('|---|---|---|---|');
    for (const row of s.rows) {
      const verdict = row.isError ? '⚠️' : row.ok ? '✅' : '❌';
      const score = row.score === null ? '' : row.score;
      // Never print raw error bodies (leak risk); infra errors get a fixed note.
      const notes = row.isError
        ? 'Infra/judge error — excluded from pass rate'
        : row.ok
          ? ''
          : sanitize(row.reason || '').replace(/\s+/g, ' ').slice(0, 160);
      out.push(`| ${row.name} | ${verdict} | ${score} | ${notes} |`);
    }
    out.push('');
  }

  // vally sections — one per tier, using the newest run that covers that tier
  for (const g of vally) {
    out.push(`## vally (agentic) — ${g.tier}`);
    out.push('');
    out.push(`> Source: \`vally-results/${g.runId}/\` · run: ${g.timestamp}`);
    out.push('');
    out.push('| Eval | Stimulus | Graders | Score | Verdict |');
    out.push('|---|---|---|---|---|');
    for (const r of g.rows) {
      const verdict = r.passed ? '✅' : '❌';
      const score = r.score === null ? '' : r.score;
      const graders = sanitize(r.graders).replace(/\s+/g, ' ').slice(0, 80);
      out.push(`| ${r.evalName} | ${r.stimulus} | ${graders} | ${score} | ${verdict} |`);
    }
    out.push('');
  }

  if (promptfoo.length === 0 && vally.length === 0) {
    out.push('_No eval artifacts found. Run the evals first, then regenerate._');
    out.push('');
  }

  return out.join('\n');
}

// ---------------------------------------------------------------- index
function rebuildIndex() {
  const entries = readdirSync(HISTORY_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}-.+$/.test(d) && existsSync(join(HISTORY_DIR, d, 'report.md')))
    .sort()
    .reverse();

  const out = [];
  out.push('# Eval Report History');
  out.push('');
  out.push('Readable eval reports, generated by `scripts/generate-report.mjs`.');
  out.push('Weekly (CI) and deliberate reports are committed here; local previews are not.');
  out.push('');
  out.push('| Date | Type | Report |');
  out.push('|---|---|---|');
  for (const dir of entries) {
    const m = dir.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    out.push(`| ${m[1]} | ${m[2]} | [report](${dir}/report.md) |`);
  }
  out.push('');
  writeFileSync(join(HISTORY_DIR, 'README.md'), out.join('\n'));
}

// ---------------------------------------------------------------- main
function main() {
  const args = parseArgs(process.argv.slice(2));
  const promptfoo = readPromptfoo();
  const vally = readVally();

  const dirName = `${args.date}-${args.type}`;
  const outDir = join(HISTORY_DIR, dirName);
  mkdirSync(outDir, { recursive: true });

  const report = buildReport(args, promptfoo, vally);
  const reportPath = join(outDir, 'report.md');
  writeFileSync(reportPath, report);
  rebuildIndex();

  const sources = [...promptfoo.map((s) => `promptfoo:${s.label}`), ...vally.map((g) => `vally:${g.tier}`)]
    .filter(Boolean)
    .join(', ') || 'none';
  console.log(`Wrote ${reportPath.replace(REPO_ROOT + '/', '')}`);
  console.log(`Sources: ${sources}`);
}

main();
