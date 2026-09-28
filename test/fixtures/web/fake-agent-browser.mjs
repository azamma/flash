#!/usr/bin/env node
// A stand-in for the real `agent-browser` CLI. Logs every invocation (so tests can assert
// --session was passed) and answers snapshot/get/act calls from env vars set by the test.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_AB_LOG) fs.appendFileSync(process.env.FAKE_AB_LOG, JSON.stringify(args) + '\n');

if (process.env.FAKE_AB_FAIL) { process.stderr.write('fake-agent-browser: forced failure\n'); process.exit(1); }

// --session <name> may precede the real subcommand, so match past it.
const rest = args[0] === '--session' ? args.slice(2) : args;

if (rest[0] === '--version' || args[0] === '--version') { console.log('agent-browser 0.0.0 (fake)'); process.exit(0); }
if (rest[0] === 'snapshot') {
  process.stdout.write(fs.readFileSync(process.env.FAKE_AB_SNAPSHOT, 'utf8'));
  process.exit(0);
}
if (rest[0] === 'get' && rest[1] === 'url') { console.log(process.env.FAKE_AB_URL || 'https://example.com'); process.exit(0); }
if (rest[0] === 'get' && rest[1] === 'title') { console.log(process.env.FAKE_AB_TITLE || 'Example'); process.exit(0); }
if (['click', 'fill', 'select', 'press'].includes(rest[0])) { console.log('ok'); process.exit(0); }
process.stderr.write(`fake-agent-browser: unhandled args ${JSON.stringify(args)}\n`);
process.exit(1);
