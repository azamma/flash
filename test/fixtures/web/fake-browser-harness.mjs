#!/usr/bin/env node
// A stand-in for the real `browser-harness` binary (Task 18). Doesn't run Python or touch a real
// browser: it speaks the exact file-based protocol web.mjs's `runBh` uses (read a JSON command from
// FLASH_BH_CMD, write a JSON result to FLASH_BH_OUT) — for `--version` alone it just answers on
// stdout, matching the real CLI's availability check.
//
// Scripted pages: FAKE_BH_PAGE_<n> (1-indexed) is a JSON file `{url,title,text,refs,marker?}`. A
// `round` counter (FAKE_BH_ROUND_FILE, created on first use) tracks "the current page": `snapshot`
// reads it without advancing; a `dispatch` that isn't stale advances it by one and returns the new
// round's page (mirroring the real driver's "post-act snapshot in the same call"). `resolve`/
// `dispatch` read the round too, UNLESS FAKE_BH_RESOLVE_PAGE is set — then they always read that
// one file instead, independent of the round: a live DOM has already moved on from whatever was
// snapshotted for the fan-out decision, which the round alone can't express (both would otherwise be
// reading the very same round-1 file on a run's first acting step). Freshness is a `guard` field
// compare (real driver: an in-page `cache.guard` tuple; here, whatever JSON value the test gave the
// ref), matching the ultrafast-faithful rewrite (web.mjs's `_guard_js`) rather than a role/name/
// context diff.
import fs from 'node:fs';

if (process.argv.includes('--version')) { console.log('browser-harness 0.0.0 (fake)'); process.exit(0); }
if (process.env.FAKE_BH_FAIL) { process.stderr.write('fake-browser-harness: forced failure\n'); process.exit(1); }

const cmdFile = process.env.FLASH_BH_CMD, outFile = process.env.FLASH_BH_OUT;
const cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
if (process.env.FAKE_BH_LOG) fs.appendFileSync(process.env.FAKE_BH_LOG, JSON.stringify(cmd) + '\n');

const roundFile = process.env.FAKE_BH_ROUND_FILE;
const round = () => (roundFile && fs.existsSync(roundFile)) ? Number(fs.readFileSync(roundFile, 'utf8')) : 1;
const setRound = (n) => roundFile && fs.writeFileSync(roundFile, String(n));
const page = (n) => JSON.parse(fs.readFileSync(process.env[`FAKE_BH_PAGE_${n}`] || process.env.FAKE_BH_PAGE, 'utf8'));

let out;
// Mirrors the real glue's tab pin: every op but init must carry the tab id init handed back.
// FAKE_BH_TAB_GONE simulates that tab having been closed underneath the run.
if (cmd.op !== 'init' && (cmd.tab !== 'fake-tab-1' || process.env.FAKE_BH_TAB_GONE === '1')) {
  out = { ok: false, error: 'flash-owned tab is gone; start a new run' };
} else if (cmd.op === 'init') {
  out = { ok: true, tab: 'fake-tab-1' };
} else if (cmd.op === 'snapshot') {
  out = { ok: true, page: page(round()) };
} else if (cmd.op === 'marker') {
  // FAKE_BH_MARKER_MISMATCH_ONCE: a flag-file path. The FIRST marker read while that file doesn't
  // exist yet returns a deliberately non-matching marker (simulating the page having moved on
  // during the Jev call) and creates the file; every read after returns the real current marker --
  // simulates run's re-snapshot resyncing on the very next recheck.
  const once = process.env.FAKE_BH_MARKER_MISMATCH_ONCE;
  if (once && !fs.existsSync(once)) { fs.writeFileSync(once, '1'); out = { ok: true, marker: null }; }
  else out = { ok: true, marker: page(round()).marker ?? null };
} else if (cmd.op === 'scroll') {
  // FAKE_BH_SCROLL_MOVED='1' simulates a scroll that revealed the next scripted page; unset (the
  // default) simulates the end of the page -- same round, moved: false.
  const moved = process.env.FAKE_BH_SCROLL_MOVED === '1';
  if (moved) setRound(round() + 1);
  out = { ok: true, moved, page: page(round()) };
} else if (cmd.op === 'close') {
  out = { ok: true };
} else if (cmd.op === 'resolve' || cmd.op === 'dispatch') {
  const p = process.env.FAKE_BH_RESOLVE_PAGE ? JSON.parse(fs.readFileSync(process.env.FAKE_BH_RESOLVE_PAGE, 'utf8')) : page(round());
  const target = (p.refs || []).find((r) => r.ref === cmd.ref);
  // FAKE_BH_COVERED simulates the real driver's occlusion check: the guard still matches (this
  // isn't a "the page changed" staleness), but resolve still fails because the in-page
  // elementFromPoint(x,y) check found something else on top.
  const covered = process.env.FAKE_BH_COVERED === cmd.ref;
  const stale = !target || covered || (cmd.guard !== undefined && JSON.stringify(target.guard) !== JSON.stringify(cmd.guard));
  if (stale || cmd.op === 'resolve') {
    out = { ok: !stale, stale: !!stale, page: p };
  } else {
    setRound(round() + 1);
    out = { ok: true, stale: false, page: page(round()) };
  }
} else {
  out = { ok: false, error: `fake-browser-harness: unknown op ${cmd.op}` };
}
fs.writeFileSync(outFile, JSON.stringify(out));
