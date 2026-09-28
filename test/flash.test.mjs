// Runs flash.mjs and guard.mjs as subprocesses against a fake Jev server. No network, no real key.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeJev } from './fake-jev.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FLASH = path.join(ROOT, 'skills/flash/scripts/flash.mjs');
const GUARD = path.join(ROOT, 'skills/flash/scripts/guard.mjs');
// Same pattern guard.mjs uses to find the footer; the footer format is a contract with the hook.
const FOOTER = /^— .*jev .* tok/;

let jev, work, home;

function run(script, args, { input = '', env = {} } = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(FLASH_|JEV_|TYPESAFE_|OPENROUTER_)/.test(k)));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: work,
      env: { ...clean, FLASH_HOME: home, FLASH_API_BASE: jev.url, FLASH_PROVIDER: 'typesafe', JEV_API_KEY: 'test-key', ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const flash = (args, opts) => run(FLASH, args, opts);
const write = (name, text) => { const f = path.join(work, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const history = () => { try { return fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };

before(async () => { jev = await startFakeJev(); });
after(() => jev.close());
beforeEach(() => {
  jev.reset();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-work-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-home-'));
});

test('filter keeps matching files, prints results on stdout and the footer on stderr', async () => {
  write('src/auth.ts', 'export function login() {} // MATCH');
  write('src/util.ts', 'export const add = (a, b) => a + b;');
  const r = await flash(['filter', 'Does this file handle auth?', 'src']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^0\.95 {2}src\/auth\.ts$/m);
  assert.doesNotMatch(r.stdout, /util\.ts/);
  assert.doesNotMatch(r.stdout, /—/, 'footer must not reach stdout');
  assert.match(r.stderr.trim().split('\n').at(-1), FOOTER);
  assert.equal(jev.requests.length, 2);
  assert.equal(jev.requests[0].auth, 'Bearer test-key');
});

test('filter --lines judges each stdin line', async () => {
  const r = await flash(['filter', 'Is this an error?', '-', '--lines'], { input: 'ok\nERROR MATCH boom\nfine\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /stdin:2 {2}ERROR MATCH boom/);
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('--json puts valid JSON alone on stdout', async () => {
  write('a.txt', 'MATCH');
  const r = await flash(['filter', 'q?', 'a.txt', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.ok(Array.isArray(data) || typeof data === 'object');
});

test('classify puts each item in the label its text names', async () => {
  write('items.jsonl', '{"id":"T1","text":"crash: this is a bug"}\n{"id":"T2","text":"please add a feature"}\n');
  const r = await flash(['classify', '--labels', 'bug,feature', '--items', 'items.jsonl']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[bug\] T1/);
  assert.match(r.stdout, /\[feature\] T2/);
});

test('find points at the matching line number', async () => {
  write('big.py', Array.from({ length: 20 }, (_, i) => (i === 11 ? 'def refresh(): # MATCH' : `x${i} = ${i}`)).join('\n'));
  const r = await flash(['find', 'the token refresh', 'big.py']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.split('\n')[0], /big\.py:12 {2}def refresh/);
});

test('a 429 is retried and the run still succeeds', async () => {
  write('a.txt', 'MATCH');
  jev.force({ status: 429, headers: { 'retry-after': '0' } });
  const r = await flash(['filter', 'q?', 'a.txt']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(jev.requests.length, 2);
});

test('a rejected key exits 3 with a fix', async () => {
  write('a.txt', 'MATCH');
  jev.force({ status: 401 });
  const r = await flash(['filter', 'q?', 'a.txt']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /rejected the API key/);
  assert.match(r.stderr, /setup --provider typesafe/);
});

test('a missing key exits 3 before any request', async () => {
  write('a.txt', 'x');
  const r = await flash(['filter', 'q?', 'a.txt'], { env: { JEV_API_KEY: '' } });
  assert.equal(r.code, 3);
  assert.equal(jev.requests.length, 0);
});

test('bad usage exits 2 and never calls Jev', async () => {
  for (const args of [['filter'], ['find', 'x'], ['classify', 'a.txt'], ['filtr']]) {
    const r = await flash(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(r.stderr.length, 'non-zero exit needs an explanation');
  }
  assert.match((await flash(['filtr'])).stderr, /Did you mean "filter"/);
  assert.equal(jev.requests.length, 0);
});

test('help works globally and per command', async () => {
  assert.match((await flash(['--help'])).stdout, /Exit codes:/);
  assert.match((await flash(['help', 'find'])).stdout, /^flash find/);
  assert.match((await flash(['rank', '--help'])).stdout, /^flash rank/);
});

test('secret files never reach a request body', async () => {
  write('src/app.ts', 'MATCH app');
  write('src/.env', 'API_KEY=DO_NOT_UPLOAD');
  write('src/server.pem', 'DO_NOT_UPLOAD');
  write('src/credentials.json', '{"k":"DO_NOT_UPLOAD"}');
  const r = await flash(['filter', 'q?', 'src']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(jev.requests.length >= 1);
  assert.doesNotMatch(JSON.stringify(jev.requests.map((q) => q.body)), /DO_NOT_UPLOAD/);
});

test('each run appends one counts-only row to history, and gain reads it', async () => {
  write('a.txt', 'MATCH secret-content');
  await flash(['filter', 'q?', 'a.txt']);
  const rows = history();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cmd, 'filter');
  assert.equal(rows[0].items, 1);
  assert.equal(rows[0].jev_tokens, 100);
  assert.doesNotMatch(JSON.stringify(rows), /secret-content/);
  const g = await flash(['gain', '--plain']);
  assert.match(g.stdout, /1 runs · 1 items/);
});

test('skill prints SKILL.md with this install path filled in', async () => {
  const r = await flash(['skill']);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /<base directory of this skill>/);
  assert.ok(r.stdout.includes(path.join(ROOT, 'skills/flash')));
});

test('guard blocks a whole Read of a large file and allows a ranged one', async () => {
  const big = write('big.txt', Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n'));
  const whole = await run(GUARD, [], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: big } }) });
  assert.equal(JSON.parse(whole.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const ranged = await run(GUARD, [], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: big, offset: 1, limit: 20 } }) });
  assert.equal(ranged.stdout, '');
  const small = await run(GUARD, [], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: write('s.txt', 'hi') } }) });
  assert.equal(small.stdout, '');
});

test('guard turns the footer of a real run into a UI message', async () => {
  write('a.txt', 'MATCH');
  const r = await flash(['filter', 'q?', 'a.txt']);
  const post = await run(GUARD, [], { input: JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: `node ${FLASH} filter "q?" a.txt` },
    tool_response: { stdout: r.stdout, stderr: r.stderr },
  }) });
  assert.match(JSON.parse(post.stdout).systemMessage, /^⚡ flash → Jev 1 scanned/);
});
