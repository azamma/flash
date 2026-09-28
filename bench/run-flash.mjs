// Runs every situation through Flash exactly as Claude would (human-readable output),
// scores it against ground truth, and records Jev cost + the tokens Claude would have to read.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prf, hitRate } from './metrics.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QS = path.join(ROOT, '..', 'skills', 'flash', 'scripts', 'flash.mjs');
const SKILL_TOKENS = Math.ceil(fs.readFileSync(path.join(ROOT, '..', 'skills', 'flash', 'SKILL.md'), 'utf8').length / 4);
const TOOL_CALL_OVERHEAD = 40; // tokens for the tool-call wrapper around each command
const tok = (s) => Math.ceil(s.length / 4);
const only = process.argv.slice(2);

const historyFile = path.join(process.env.FLASH_HOME || path.join(process.env.HOME || process.env.USERPROFILE, '.flash'), 'history.jsonl');
const jevTotal = () => { try { return fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + JSON.parse(l).jev_tokens, 0); } catch { return 0; } };

// withSave: also write full per-item results via --save so scoring doesn't depend on the display format.
// Claude is charged only for the display output it would actually read.
const SAVE = path.join(ROOT, 'results', '.last-save.json');
function qs(dir, args, withSave = false) {
  const t0 = Date.now(), before = jevTotal();
  if (withSave) fs.rmSync(SAVE, { force: true });
  const r = spawnSync(process.execPath, [QS, ...args, '--no-cache', ...(withSave ? ['--save', SAVE] : [])], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`qs ${args.join(' ')} failed: ${r.stderr}`);
  const out = r.stdout.replace(/\n— full results saved to .*/, '');
  const cmd = `node flash.mjs ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  const saved = withSave ? JSON.parse(fs.readFileSync(SAVE, 'utf8')) : null;
  return { out, saved, ms: Date.now() - t0, jev: jevTotal() - before, claudeTokens: tok(cmd) + tok(out) + tok(r.stderr) + TOOL_CALL_OVERHEAD };
}

const rows = (out) => out.split('\n').filter((l) => /^[ ?]?\d\.\d\d  /.test(l));
const idOf = (line) => line.replace(/^[ ?]?\d\.\d\d  /, '').split('  ')[0].replace(/~$/, '');
const lineNo = (id) => Number(id.split(':').pop());

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
const file = path.join(ROOT, 'results', 'flash.json');
const results = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
for (const id of fs.readdirSync(path.join(ROOT, 'data')).filter((d) => /^s\d+$/.test(d)).sort()) {
  if (only.length && !only.includes(id)) continue;
  const dir = path.join(ROOT, 'data', id);
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'truth', id + '.json'), 'utf8'));
  const runs = [];
  let score;
  if (m.kind === 'filter-lines' || m.kind === 'filter-items' || m.kind === 'filter-files') {
    const args = ['filter', m.question, ...(m.kind === 'filter-items' ? ['--items', m.input] : [m.input]), ...(m.kind === 'filter-lines' ? ['--lines'] : [])];
    const r = qs(dir, args, true); runs.push(r);
    const matched = r.saved.filter((x) => x.p >= 0.5).map((x) => x.id);
    const pred = m.kind === 'filter-lines' ? matched.map(lineNo) : matched;
    score = prf(pred, m.truth, m.neutral);
    score.metric = 'F1';
    score.value = score.f1;
  } else if (m.kind === 'classify') {
    const labels = m.labelDescriptions
      ? Object.entries(m.labelDescriptions).map(([k, v]) => `${k}:${v.replace(/,/g, ';')}`).join(',')
      : m.labels.join(',');
    const r = qs(dir, ['classify', '--labels', labels, '--question', m.question, '--items', m.input], true); runs.push(r);
    const pred = Object.fromEntries(r.saved.map((x) => [x.id, x.label]));
    const ids = Object.keys(m.truth);
    const correct = ids.filter((k) => pred[k] === m.truth[k]).length;
    score = { metric: 'accuracy', value: correct / ids.length, correct, total: ids.length };
  } else if (m.kind === 'find') {
    const h = hitRate(Object.entries(m.queries).map(([name, q]) => {
      const r = qs(dir, ['find', q, m.input, '--top', '5']); runs.push(r);
      const [lo, hi] = m.truth[name];
      return [rows(r.out).map((l) => lineNo(idOf(l))), (n) => n >= lo && n <= hi];
    }));
    score = { metric: 'hit@5', value: h.hitK, hit1: h.hit1, hit5: h.hitK };
  } else if (m.kind === 'rank') {
    const h = hitRate(Object.entries(m.queries).map(([qid, q]) => {
      const r = qs(dir, ['rank', q, m.input, '--top', '3']); runs.push(r);
      return [rows(r.out).map(idOf), (g) => m.truth[qid].includes(g)];
    }));
    score = { metric: 'hit@3', value: h.hitK, hit1: h.hit1, hit3: h.hitK };
  }
  const inputTokens = fs.readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile())
    .reduce((a, f) => a + tok(fs.readFileSync(f, 'utf8')), 0);
  results[id] = {
    title: m.title, kind: m.kind, score,
    inputTokens, // what Claude would have to read to do it itself
    claudeTokens: SKILL_TOKENS + runs.reduce((a, r) => a + r.claudeTokens, 0),
    seconds: runs.reduce((a, r) => a + r.ms, 0) / 1000,
    jevTokens: runs.reduce((a, r) => a + r.jev, 0),
    jevUsd: runs.reduce((a, r) => a + r.jev, 0) * 0.042 / 1e6,
    calls: runs.length,
    sampleOutput: runs[0].out.split('\n').slice(0, 12).join('\n'),
  };
  const r = results[id];
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`${id}  ${score.metric} ${(score.value * 100).toFixed(1)}%  claude ${r.claudeTokens} tok vs ${r.inputTokens} input tok  ${r.seconds.toFixed(1)}s  jev $${r.jevUsd.toFixed(4)}`);
}

