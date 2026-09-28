// Scores the Claude-native baseline, merges it with the Flash run, and writes results.md + results.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prf, hitRate } from './metrics.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(ROOT, 'results');
const qs = JSON.parse(fs.readFileSync(path.join(R, 'flash.json'), 'utf8'));
const usage = JSON.parse(fs.readFileSync(path.join(R, 'baseline', 'usage.json'), 'utf8'));
// Fixed floor every subagent pays (system prompt + tools), measured with a trivial control task.
const FLOOR = usage.control;

function scoreBaseline(id, m) {
  const f = path.join(R, 'baseline', `${id}.json`);
  if (!fs.existsSync(f)) return null;
  const a = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (m.kind.startsWith('filter')) {
    const s = prf(m.kind === 'filter-lines' ? a.lines : a.ids, m.truth, m.neutral);
    return { metric: 'F1', value: s.f1, ...s };
  }
  if (m.kind === 'classify') {
    const ids = Object.keys(m.truth);
    const correct = ids.filter((k) => a.labels?.[k] === m.truth[k]).length;
    return { metric: 'accuracy', value: correct / ids.length };
  }
  if (m.kind === 'find') {
    const h = hitRate(Object.entries(m.truth).map(([name, [lo, hi]]) => [(a.hits?.[name] || []).slice(0, 5).map(Number), (n) => n >= lo && n <= hi]));
    return { metric: 'hit@5', value: h.hitK, hit1: h.hit1 };
  }
  if (m.kind === 'rank') {
    const h = hitRate(Object.entries(m.truth).map(([q, t]) => [(a.top3?.[q] || []).slice(0, 3), (g) => t.includes(g)]));
    return { metric: 'hit@3', value: h.hitK, hit1: h.hit1 };
  }
}

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const rows = [];
for (const id of Object.keys(qs).sort()) {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'truth', `${id}.json`), 'utf8'));
  const q = qs[id], b = scoreBaseline(id, m), u = usage[id];
  if (!b || !u) { console.warn(`missing baseline for ${id}`); continue; }
  rows.push({
    id, title: m.title, metric: q.score.metric,
    qsScore: q.score.value, baseScore: b.value,
    baseTokens: u.tokens - FLOOR.tokens, qsTokens: q.claudeTokens,
    tokenReduction: 1 - q.claudeTokens / (u.tokens - FLOOR.tokens),
    baseSeconds: u.seconds - FLOOR.seconds, qsSeconds: q.seconds, speedup: (u.seconds - FLOOR.seconds) / q.seconds,
    jevUsd: q.jevUsd, baseToolCalls: u.toolUses,
  });
}

const sum = (f, rs = rows) => rs.reduce((a, r) => a + f(r), 0);
const agg = (rs) => ({
  n: rs.length,
  tokenReduction: 1 - sum((r) => r.qsTokens, rs) / sum((r) => r.baseTokens, rs),
  medianTokenReduction: rs.map((r) => r.tokenReduction).sort((a, b) => a - b)[Math.floor(rs.length / 2)],
  speedup: sum((r) => r.baseSeconds, rs) / sum((r) => r.qsSeconds, rs),
  qsScore: sum((r) => r.qsScore, rs) / rs.length,
  baseScore: sum((r) => r.baseScore, rs) / rs.length,
  jevUsd: sum((r) => r.jevUsd, rs),
  baseTokens: sum((r) => r.baseTokens, rs), qsTokens: sum((r) => r.qsTokens, rs),
});
const all = agg(rows);

let md = `| # | Situation | Metric | Claude alone | Flash | Claude tokens (alone → QS) | Token cut | Time (alone → QS) | Speed-up | Jev cost |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.id.slice(1)} | ${r.title.split(' — ')[0]} | ${r.metric} | ${pct(r.baseScore)} | ${pct(r.qsScore)} | ${k(r.baseTokens)} → ${k(r.qsTokens)} | **${pct(r.tokenReduction)}** | ${r.baseSeconds.toFixed(0)}s → ${r.qsSeconds.toFixed(1)}s | ${r.speedup.toFixed(1)}× | $${r.jevUsd.toFixed(4)} |\n`;
}
md += `\n**All 12 situations:** ${pct(all.tokenReduction)} fewer Claude tokens overall (median ${pct(all.medianTokenReduction)}), ${all.speedup.toFixed(1)}× faster, avg quality ${pct(all.qsScore)} vs ${pct(all.baseScore)} for Claude alone, total Jev spend $${all.jevUsd.toFixed(3)}.\n`;
fs.writeFileSync(path.join(R, 'results.md'), md);
fs.writeFileSync(path.join(R, 'results.json'), JSON.stringify({ rows, all }, null, 2));
console.log(md);
console.log(JSON.stringify(all, null, 2));
