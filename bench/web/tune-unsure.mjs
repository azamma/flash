#!/usr/bin/env node
// Task 7b: tune pick's "? unsure" rule (top p < P1 or margin to runner-up < MARGIN) against the
// Task 7 pick runs already saved in bench/web/runs/pick-rows.json (no new Jev calls — that file is
// the raw p1/p2 per row dumped by run.mjs). Reports, for a grid of thresholds, the share of wrong
// top-1 picks flagged unsure vs the share of right ones flagged (a false-alarm cost), and prints the
// chosen defaults. Reproduce with: node bench/web/tune-unsure.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(fs.readFileSync(path.join(HERE, 'runs', 'pick-rows.json'), 'utf8'))
  .filter((r) => r.chosen != null); // only rows where pick actually named a ref have a p1/p2 to threshold

const wrong = rows.filter((r) => !r.top1);
const right = rows.filter((r) => r.top1);
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(0) : '0') + '%';
const flagged = (r, p1, margin) => r.p1 < p1 || r.p1 - r.p2 < margin;

const P1S = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
const MARGINS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35];

console.log(`${rows.length} picked rows (${wrong.length} wrong, ${right.length} right)\n`);
console.log('| p1 <  | margin < | wrong flagged | right flagged |');
console.log('|---|---|---|---|');
const table = [];
for (const p1 of P1S) for (const m of MARGINS) {
  const w = wrong.filter((r) => flagged(r, p1, m)).length;
  const rg = right.filter((r) => flagged(r, p1, m)).length;
  table.push({ p1, m, wrongPct: w / wrong.length, rightPct: rg / right.length, w, rg });
  console.log(`| ${p1} | ${m} | ${pct(w, wrong.length)} (${w}/${wrong.length}) | ${pct(rg, right.length)} (${rg}/${right.length}) |`);
}

// Chosen defaults: maximize wrong-flagged (catch almost every wrong pick), tie-broken by the
// lowest right-flagged rate. On this corpus the trade-off is nearly flat above p1=0.6 (right-flagged
// only rises 70%→73% while wrong-flagged rises 90%→100%), so the max is worth taking outright.
// margin never changes the outcome on this corpus (see table); tie-break toward the existing 0.2
// default rather than an arbitrary one.
const best = [...table].sort((a, b) => b.wrongPct - a.wrongPct || a.rightPct - b.rightPct || Math.abs(a.m - 0.2) - Math.abs(b.m - 0.2))[0];
console.log(`\nchosen: p1 < ${best.p1}, margin < ${best.m} — wrong flagged ${pct(best.w, wrong.length)}, right flagged ${pct(best.rg, right.length)}`);

const missed = wrong.filter((r) => !flagged(r, best.p1, best.m));
if (missed.length) console.log(`still missed (confidently wrong, no threshold catches this): ${missed.map((r) => `#${r.id} p1=${r.p1} margin=${(r.p1 - r.p2).toFixed(2)}`).join(', ')}`);

// Task 12b: one pair was too coarse for both a plain nav click and a form control. Classify each
// row's chosen ref by role (looked up from its frozen snapshot, the same file `flash web pick`
// captured) and report the two class-specific pairs actually shipped in web.mjs.
import { riskyBackstop } from '../../skills/flash/scripts/web.mjs';

const NAV_ROLES = new Set(['link', 'tab', 'menuitem']);
const snapCache = new Map();
function loadSnap(slug) {
  if (!snapCache.has(slug)) snapCache.set(slug, JSON.parse(fs.readFileSync(path.join(HERE, 'snapshots', `${slug}.json`), 'utf8')));
  return snapCache.get(slug);
}
function classOf(row) {
  const page = loadSnap(row.slug);
  const ref = page.refs.find((r) => r.ref === row.chosen);
  if (!ref) return 'form';
  return NAV_ROLES.has(ref.role) && !riskyBackstop(ref) ? 'nav' : 'form';
}

const CLASS_THRESHOLDS = { nav: { p1: 0.6, margin: 0.2 }, form: { p1: 0.85, margin: 0.2 } };
console.log('\n## Task 12b: unsure by consequence class (shipped thresholds)\n');
console.log('| class | n | wrong | right | wrong flagged | right flagged |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const cls of ['nav', 'form']) {
  const crows = rows.filter((r) => classOf(r) === cls);
  const cw = crows.filter((r) => !r.top1);
  const cr = crows.filter((r) => r.top1);
  const { p1, margin } = CLASS_THRESHOLDS[cls];
  const wf = cw.filter((r) => flagged(r, p1, margin)).length;
  const rf = cr.filter((r) => flagged(r, p1, margin)).length;
  console.log(`| ${cls} (p1<${p1}, margin<${margin}) | ${crows.length} | ${cw.length} | ${cr.length} | ${pct(wf, cw.length)} (${wf}/${cw.length}) | ${pct(rf, cr.length)} (${rf}/${cr.length}) |`);
}
