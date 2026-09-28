// Tests for web.mjs: pure functions, so imported directly (unlike flash.mjs, which runs its CLI
// as a side effect of being loaded and must only ever be exercised as a subprocess).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentBrowser, parseTree, extractTreeText, sanitizeRef, pageFile, sessionName } from '../skills/flash/scripts/web.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, 'test/fixtures/web');

// ---------- parser: real --json capture, and the 4 plain-tree captures ----------

test('parseTree reads a real `snapshot -i --json` capture', () => {
  const raw = fs.readFileSync(path.join(FIXTURES, 'json-wikipedia.json'), 'utf8');
  const refs = parseTree(extractTreeText(raw));
  assert.ok(refs.length > 100, 'wikipedia has well over 100 interactive refs');
  const search = refs.find((r) => r.ref === 'e29');
  assert.deepEqual(search, { ref: 'e29', role: 'searchbox', name: 'Search Wikipedia', value: null, state: [], context: null });
  const radio = refs.find((r) => r.ref === 'e174');
  assert.equal(radio.role, 'radio');
  assert.ok(radio.state.includes('checked=true'));
  assert.equal(radio.context, 'navigation "Appearance"');
});

test('extractTreeText falls back to raw text when input is not the --json wrapper', () => {
  const raw = fs.readFileSync(path.join(FIXTURES, 'plain-wikipedia.txt'), 'utf8');
  assert.equal(extractTreeText(raw), raw);
  assert.equal(extractTreeText('not json at all'), 'not json at all');
});

for (const [name, file] of [['wikipedia', 'plain-wikipedia.txt'], ['github', 'plain-github.txt'], ['hn', 'plain-hn.txt'], ['amazon', 'plain-amazon.txt']]) {
  test(`parseTree reads the plain-tree capture: ${name}`, () => {
    const raw = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    const refs = parseTree(raw);
    assert.ok(refs.length > 0, `${name} should yield refs`);
    for (const r of refs) {
      assert.equal(typeof r.ref, 'string');
      assert.equal(typeof r.role, 'string');
      assert.ok(Array.isArray(r.state));
    }
  });
}

test('parseTree unescapes quotes inside names and keeps a nested value', () => {
  const raw = fs.readFileSync(path.join(FIXTURES, 'plain-amazon.txt'), 'utf8');
  const refs = parseTree(raw);
  const heading = refs.find((r) => r.ref === 'e618');
  assert.match(heading.name, /resultados para "usb c cable"/);
  const combo = refs.find((r) => r.ref === 'e996');
  assert.equal(combo.value, 'Todos los departamentos');
  assert.ok(combo.state.includes('expanded=false'));
  const disabled = refs.find((r) => r.ref === 'e684');
  assert.ok(disabled.state.includes('disabled'));
});

// ---------- secrets: password masking never leaks a value ----------

test('sanitizeRef redacts a masked password value and a name-matched password field', () => {
  const masked = sanitizeRef({ ref: 'e1', role: 'textbox', name: 'Password', value: '••••••••', state: [], context: null });
  assert.equal(masked.role, 'password');
  assert.equal(masked.value, null);
  const byName = sanitizeRef({ ref: 'e2', role: 'textbox', name: 'Contraseña', value: null, state: [], context: null });
  assert.equal(byName.role, 'textbox', 'no value yet, nothing to redact, role left alone');
  const filled = sanitizeRef({ ref: 'e2', role: 'textbox', name: 'Contraseña', value: '••••', state: [], context: null });
  assert.equal(filled.role, 'password');
  const file = sanitizeRef({ ref: 'e3', role: 'button', name: '', value: 'Seleccionar archivo: Ningún archivo seleccionado', state: [], context: null });
  assert.equal(file.value, null);
  const normal = sanitizeRef({ ref: 'e4', role: 'searchbox', name: 'Search', value: 'usb c cable', state: [], context: null });
  assert.equal(normal.value, 'usb c cable');
});

// ---------- adapter: fake agent-browser on PATH ----------

let bin, oldPath, log;

beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-ab-bin-'));
  const wrapper = path.join(bin, 'agent-browser');
  fs.copyFileSync(path.join(FIXTURES, 'fake-agent-browser.mjs'), wrapper);
  fs.chmodSync(wrapper, 0o755);
  log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flash-ab-log-')), 'log.jsonl');
  process.env.FAKE_AB_LOG = log;
  process.env.FAKE_AB_SNAPSHOT = path.join(FIXTURES, 'json-wikipedia.json');
  oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + process.env.PATH;
});

afterEach(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_AB_LOG;
  delete process.env.FAKE_AB_SNAPSHOT;
  delete process.env.FAKE_AB_URL;
  delete process.env.FAKE_AB_TITLE;
  delete process.env.FAKE_AB_FAIL;
});

const logged = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('available() finds the fake binary on PATH', () => {
  assert.equal(agentBrowser.available(), true);
});

test('available() gives an install hint when nothing is on PATH', () => {
  process.env.PATH = oldPath;
  const r = agentBrowser.available();
  assert.equal(typeof r, 'string');
  assert.match(r, /not found/);
  assert.match(r, /npm i -g agent-browser/);
});

test('snapshot() calls the driver with --session on every invocation and returns the common format', () => {
  process.env.FAKE_AB_URL = 'https://en.wikipedia.org/wiki/Main_Page';
  process.env.FAKE_AB_TITLE = 'Wikipedia, the free encyclopedia';
  const r = agentBrowser.snapshot('flash-test-session');
  assert.equal(r.ok, true);
  assert.equal(r.page.driver, 'agent-browser');
  assert.equal(r.page.url, 'https://en.wikipedia.org/wiki/Main_Page');
  assert.equal(r.page.title, 'Wikipedia, the free encyclopedia');
  assert.ok(r.page.refs.length > 100);
  assert.ok(r.page.text.length > 0 && r.page.text.length <= 6000);
  assert.ok(/^\d{4}-\d\d-\d\dT/.test(r.page.taken));
  const calls = logged();
  assert.ok(calls.length >= 3, 'snapshot -i --json, get url, get title');
  for (const c of calls) assert.deepEqual(c.slice(0, 2), ['--session', 'flash-test-session']);
});

test('act() clicks with --session and never retries on failure', () => {
  const ok = agentBrowser.act('flash-test-session', { kind: 'click', ref: 'e5' });
  assert.equal(ok.ok, true);
  const [call] = logged();
  assert.deepEqual(call, ['--session', 'flash-test-session', 'click', '@e5']);
  process.env.FAKE_AB_FAIL = '1';
  const fail = agentBrowser.act('flash-test-session', { kind: 'fill', ref: 'e6', value: 'hi' });
  assert.equal(fail.ok, false);
  assert.match(fail.error, /forced failure/);
});

test('act() rejects an unsupported action kind without calling the driver', () => {
  const r = agentBrowser.act('flash-test-session', { kind: 'nope', ref: 'e1' });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '', '');
});

test('pageFile and sessionName build the ~/.flash/web/<session>/page.json path', () => {
  const p = pageFile('flash-quicksilver');
  assert.match(p, /\.flash[\\/]web[\\/]flash-quicksilver[\\/]page\.json$/);
  assert.equal(sessionName({ session: 'abc' }), 'flash-abc');
});
