#!/usr/bin/env node
// A stand-in for the real `browser-harness` binary (Task 18). Doesn't run Python or touch a real
// browser: it speaks the exact file-based protocol web.mjs's `runBh` uses (read a JSON command from
// FLASH_BH_CMD, write a JSON result to FLASH_BH_OUT) — for `--version` alone it just answers on
// stdout, matching the real CLI's availability check.
//
// Scripted pages: FAKE_BH_PAGE_<n> (1-indexed) is a JSON file `{url,title,text,refs}`. A `round`
// counter (FAKE_BH_ROUND_FILE, created on first use) tracks "the current page": `snapshot` reads it
// without advancing; a `dispatch` that isn't stale advances it by one and returns the new round's
// page (mirroring the real driver's "post-act snapshot in the same call"). `resolve`/`dispatch`
// read the round too, UNLESS FAKE_BH_RESOLVE_PAGE is set — then they always read that one file
// instead, independent of the round: a live DOM has already moved on from whatever was snapshotted
// for the fan-out decision, which the round alone can't express (both would otherwise be reading
// the very same round-1 file on a run's first acting step).
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
if (cmd.op === 'init') {
  out = { ok: true };
} else if (cmd.op === 'snapshot') {
  out = { ok: true, page: page(round()) };
} else if (cmd.op === 'close') {
  out = { ok: true };
} else if (cmd.op === 'resolve' || cmd.op === 'dispatch') {
  const p = process.env.FAKE_BH_RESOLVE_PAGE ? JSON.parse(fs.readFileSync(process.env.FAKE_BH_RESOLVE_PAGE, 'utf8')) : page(round());
  const target = (p.refs || []).find((r) => r.ref === cmd.ref);
  // FAKE_BH_COVERED simulates the real driver's occlusion check: role/name/context all match (this
  // isn't a "the page changed" staleness), but resolve still fails because the in-page
  // elementFromPoint(x,y) check found something else on top.
  const covered = process.env.FAKE_BH_COVERED === cmd.ref;
  const stale = !target || covered || (cmd.role && target.role !== cmd.role) || (cmd.name && target.name !== cmd.name) || (cmd.context && target.context !== cmd.context);
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
