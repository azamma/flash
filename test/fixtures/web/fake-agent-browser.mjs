#!/usr/bin/env node
// A stand-in for the real `agent-browser` CLI. Logs every invocation (so tests can assert
// --session was passed) and answers snapshot/get/act calls from env vars set by the test.
// Multi-round tests (flash web click/run) need a different page per snapshot(): each call reads
// FAKE_AB_SNAPSHOT_<n>/FAKE_AB_URL_<n>/FAKE_AB_TITLE_<n> for its round n (1-indexed, falling back
// to the plain FAKE_AB_* names), where n = how many 'snapshot' calls this process's own log already
// holds after this call is appended — each call is a fresh process, so the shared log file (which
// every driver call already appends to) doubles as the round counter, no extra state file needed.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_AB_LOG) fs.appendFileSync(process.env.FAKE_AB_LOG, JSON.stringify(args) + '\n');

if (process.env.FAKE_AB_FAIL) { process.stderr.write('fake-agent-browser: forced failure\n'); process.exit(1); }

// --session <name> may precede the real subcommand, so match past it.
const rest = args[0] === '--session' ? args.slice(2) : args;

function snapshotRound() {
  if (!process.env.FAKE_AB_LOG || !fs.existsSync(process.env.FAKE_AB_LOG)) return 1;
  const lines = fs.readFileSync(process.env.FAKE_AB_LOG, 'utf8').trim().split('\n').filter(Boolean);
  let n = 0;
  for (const l of lines) {
    try { const a = JSON.parse(l); const r = a[0] === '--session' ? a.slice(2) : a; if (r[0] === 'snapshot') n++; } catch {}
  }
  return n || 1;
}

if (rest[0] === '--version' || args[0] === '--version') { console.log('agent-browser 0.0.0 (fake)'); process.exit(0); }
if (rest[0] === 'snapshot') {
  const n = snapshotRound();
  process.stdout.write(fs.readFileSync(process.env[`FAKE_AB_SNAPSHOT_${n}`] || process.env.FAKE_AB_SNAPSHOT, 'utf8'));
  process.exit(0);
}
if (rest[0] === 'get' && rest[1] === 'url') { console.log(process.env[`FAKE_AB_URL_${snapshotRound()}`] || process.env.FAKE_AB_URL || 'https://example.com'); process.exit(0); }
if (rest[0] === 'get' && rest[1] === 'title') { console.log(process.env[`FAKE_AB_TITLE_${snapshotRound()}`] || process.env.FAKE_AB_TITLE || 'Example'); process.exit(0); }
if (['click', 'fill', 'select', 'press'].includes(rest[0])) { console.log('ok'); process.exit(0); }
process.stderr.write(`fake-agent-browser: unhandled args ${JSON.stringify(args)}\n`);
process.exit(1);
