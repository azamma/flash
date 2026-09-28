// S13: code retrieval on honojs/hono. Runs each question through three Flash modes, scores what
// Claude would read back against truth/s13.json, and appends every run (failures included) to
// results/retrieval-runs.jsonl. The Claude-alone baseline is frozen in results/baseline/s13.json.
//   node retrieval.mjs <path to a hono checkout at the commit in truth/s13.json>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FLASH = path.join(ROOT, '..', 'skills', 'flash', 'scripts', 'flash.mjs');
const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'truth', 's13.json'), 'utf8'));
const REPORT = process.argv[2] === '--report';
const repo = path.resolve(REPORT ? '.' : process.argv[2] || path.join(ROOT, 'data', 'raw', 'hono'));
if (!REPORT) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  if (head !== truth.commit) throw new Error(`hono checkout is at ${head}, truth needs ${truth.commit}`);
}
const tok = (s) => Math.ceil(s.length / 4);
const TOOL_CALL = 40;
const READ_PAD = 20; // a follow-up Read after plain `find` takes ±20 lines around each of the top 3 hits

const MODES = {
  find: (q) => ['find', q, truth.root, '--top', '5'],
  'find --context': (q) => ['find', q, truth.root, '--top', '5', '--context'],
  search: (q) => ['search', q, truth.root],
};

// Spans Claude gets to see: [file, start, end].
function spans(mode, out) {
  if (mode === 'search') {
    const found = [];
    let file;
    for (const l of out.split('\n')) {
      const f = /^\d\.\d\d {2}(\S+) {2}/.exec(l); if (f) { file = f[1]; continue; }
      const u = /^ {6}\d\.\d\d {2}\S+@(\d+)-(\d+)$/.exec(l); if (u) found.push([file, +u[1], +u[2]]);
    }
    return found;
  }
  const blocks = [...out.matchAll(/^Source block "(.+)" lines (\d+)-(\d+):$/gm)].map((m) => [m[1], +m[2], +m[3]]);
  if (blocks.length) return blocks;
  return [...out.matchAll(/^\d\.\d\d {2}(\S+):(\d+) /gm)].slice(0, 3).map((m) => [m[1], +m[2] - READ_PAD, +m[2] + READ_PAD]);
}

export function score(found, want) {
  const overlaps = (t) => found.some(([f, a, b]) => f === t.file && a <= t.end && b >= t.start);
  const files = [...new Set(want.map((t) => t.file))];
  return {
    fileRecall: files.filter((f) => found.some(([g]) => g === f)).length / files.length,
    rangeHit: want.filter(overlaps).length / want.length,
  };
}

function readCost(found) {
  let n = 0;
  for (const [f, a, b] of found) n += tok(fs.readFileSync(path.join(repo, f), 'utf8').split('\n').slice(Math.max(0, a - 1), b).join('\n'));
  return n;
}

// --report: latest successful run per question and mode, against the frozen Claude-alone baseline.
if (REPORT) {
  const runs = fs.readFileSync(path.join(ROOT, 'results', 'retrieval-runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'baseline', 's13.json'), 'utf8'));
  const FLOOR = base._floor.tokens; // fixed per-agent overhead, measured with a control agent in the same harness
  // Like the main bench, each Flash arm pays for loading SKILL.md on every question.
  const SKILL = tok(fs.readFileSync(path.join(ROOT, '..', 'skills', 'flash', 'SKILL.md'), 'utf8'));
  const latest = {};
  for (const r of runs) if (!r.error) latest[`${r.id}|${r.mode}`] = r;
  const failed = runs.filter((r) => r.error).length;
  const arms = ['Claude alone', ...Object.keys(MODES)];
  const agg = Object.fromEntries(arms.map((a) => [a, { fileRecall: 0, rangeHit: 0, claudeTokens: 0, jevUsd: 0, jevKnown: true, ms: 0 }]));
  const lines = ['| question | ' + arms.join(' | ') + ' |', '|---|' + arms.map(() => '---|').join('')];
  for (const { id, truth: want } of truth.questions) {
    const b = base[id];
    if (!b) continue;
    const cells = [{ ...score(b.answers.map((x) => [x.file, x.start, x.end]), want), claudeTokens: b.tokens - FLOOR, jevUsd: 0, ms: b.ms }];
    for (const m of Object.keys(MODES)) { const r = latest[`${id}|${m}`]; cells.push({ ...r, claudeTokens: r.claudeTokens + SKILL }); }
    lines.push(`| ${id} | ` + cells.map((c, k) => {
      const a = agg[arms[k]];
      a.fileRecall += c.fileRecall; a.rangeHit += c.rangeHit; a.claudeTokens += c.claudeTokens; a.ms += c.ms;
      if (c.jevUsd == null) a.jevKnown = false; else a.jevUsd += c.jevUsd;
      return `files ${c.fileRecall.toFixed(2)} · ranges ${c.rangeHit.toFixed(2)} · ${(c.claudeTokens / 1000).toFixed(1)}k tok`;
    }).join(' | ') + ' |');
  }
  const n = truth.questions.length;
  const summary = arms.map((a) => { const t = agg[a];
    return `| ${a} | ${(t.fileRecall / n).toFixed(2)} | ${(t.rangeHit / n).toFixed(2)} | ${(t.claudeTokens / 1000).toFixed(1)}k | ${a === 'Claude alone' ? '—' : t.jevKnown ? '$' + t.jevUsd.toFixed(3) : 'unknown'} | ${(t.ms / 1000).toFixed(0)}s |`; });
  const md = [`# S13 code retrieval on honojs/hono @ ${truth.commit.slice(0, 7)}`, '',
    '| arm | file recall | range hit | Claude tokens (total) | Jev cost (total) | time (total) |', '|---|---|---|---|---|---|', ...summary, '',
    ...lines, '', `Runs logged: ${runs.length} (${failed} failed, kept in retrieval-runs.jsonl). Claude-alone baseline frozen in baseline/s13.json; tokens are the agent total minus the ${(FLOOR / 1000).toFixed(1)}k floor. Flash arms include ${(SKILL / 1000).toFixed(1)}k for SKILL.md per question.`].join('\n');
  fs.writeFileSync(path.join(ROOT, 'results', 'retrieval.md'), md + '\n');
  console.log(md);
} else {
  const log = path.join(ROOT, 'results', 'retrieval-runs.jsonl');
  const rows = [];
  for (const { id, q, truth: want } of truth.questions) {
    for (const [mode, args] of Object.entries(MODES)) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [FLASH, ...args(q), '--no-cache'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
      const row = { ts: new Date().toISOString(), id, mode, exit: r.status, ms: Date.now() - t0 };
      const foot = /jev ([\d.]+[kM]?) tok \(\$([\d.]+)\)/.exec(r.stderr);
      row.jevUsd = foot ? Number(foot[2]) : null; // missing cost is unknown, never zero
      if (r.status === 0) {
        const found = spans(mode, r.stdout);
        const followUp = mode === 'find' ? readCost(found) : 0;
        Object.assign(row, score(found, want), { claudeTokens: tok(r.stdout) + tok(r.stderr) + TOOL_CALL + followUp + (followUp ? TOOL_CALL * found.length : 0) });
      } else row.error = r.stderr.slice(-300);
      fs.appendFileSync(log, JSON.stringify(row) + '\n');
      rows.push(row);
      console.error(`${id.padEnd(6)} ${mode.padEnd(15)} ${row.error ? 'FAILED' : `files ${row.fileRecall.toFixed(2)} ranges ${row.rangeHit.toFixed(2)} ~${row.claudeTokens} Claude tok`}  jev $${row.jevUsd ?? '?'}  ${(row.ms / 1000).toFixed(1)}s`);
    }
  }
}
