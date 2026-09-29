// Tests for web.mjs: pure functions, so imported directly (unlike flash.mjs, which runs its CLI
// as a side effect of being loaded and must only ever be exercised as a subprocess).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentBrowser, parseTree, extractTreeText, sanitizeRef, pageFile, sessionName, risky, riskyBackstop, unsureThresholds, isPlainNav, UNSURE_NAV_P1, UNSURE_NAV_MARGIN, UNSURE_FORM_P1, UNSURE_FORM_MARGIN, deriveRegions, collapseDuplicates, pickCriteria } from '../skills/flash/scripts/web.mjs';

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

// ---------- risky-action gate ----------

const ref = (name, role = 'button', context = null) => ({ ref: 'e1', role, name, value: null, state: [], context });
const refuseAsk = async () => { throw new Error('ask should not be called when the backstop already fires'); };

test('risky: the keyword/role backstop stops "Comprar ahora", "Delete" and "Confirmar pago" even when Jev says 0.0', async () => {
  for (const r of [ref('Comprar ahora'), ref('Delete'), ref('Confirmar pago')]) {
    const zeroAsk = async () => 0.0;
    const result = await risky({}, r, zeroAsk);
    assert.equal(result.risky, true);
    assert.equal(result.reason, 'keyword/role backstop');
  }
});

test('risky: the backstop never calls `ask` once it already fires', async () => {
  const result = await risky({}, ref('Delete'), refuseAsk);
  assert.equal(result.risky, true);
});

test('risky: a Jev noul >= 0.3 stops a benign-looking label the backstop misses', async () => {
  const benign = ref('Continue');
  assert.equal(riskyBackstop(benign), false, 'sanity: "Continue" alone is not in the keyword list');
  const result = await risky({}, benign, async () => 0.35);
  assert.equal(result.risky, true);
  assert.equal(result.reason, 'jev noul');
  assert.equal(result.noul, 0.35);
});

test('risky: a benign label under the noul threshold is not risky', async () => {
  const result = await risky({}, ref('Continue'), async () => 0.1);
  assert.equal(result.risky, false);
  assert.equal(result.reason, null);
});

test('riskyBackstop also matches on role and on the enclosing container text, not just the name', () => {
  assert.equal(riskyBackstop(ref('OK', 'button', 'dialog "Confirm purchase"')), true, 'container text carries the risky word');
  assert.equal(riskyBackstop({ ref: 'e2', role: 'button', name: 'Unsubscribe', value: null, state: [], context: null }), true);
  assert.equal(riskyBackstop(ref('View details')), false);
});

// ---------- Task 12a: risky keywords with context ----------

test('riskyBackstop: plain prose containing "order" in a link does not trigger (Octopus false positive)', () => {
  const link = { ref: 'e1', role: 'link', name: 'Octopuses belong to the eight-limbed order of molluscs called Cephalopoda', value: null, state: [], context: 'main "About octopuses"' };
  assert.equal(riskyBackstop(link), false);
});

test('riskyBackstop: "confirm" in ordinary prose does not trigger', () => {
  const link = { ref: 'e1', role: 'link', name: 'Please confirm your details are correct before continuing', value: null, state: [], context: null };
  assert.equal(riskyBackstop(link), false);
});

test('riskyBackstop: context words still stop on an actionable control or next to a stronger word', () => {
  assert.equal(riskyBackstop(ref('Place order')), true, 'button, short imperative name');
  assert.equal(riskyBackstop(ref('Confirmar compra')), true, 'button, short imperative name');
  assert.equal(riskyBackstop(ref('Delete account')), true, 'always-risky word');
  assert.equal(riskyBackstop(ref('Pagar')), true, 'always-risky word');
});

test('riskyBackstop: a long descriptive link with "order" next to a stronger word still triggers via adjacency', () => {
  const link = { ref: 'e1', role: 'link', name: 'Track your order status and delivery details', value: null, state: [], context: null };
  assert.equal(riskyBackstop(link), false, 'no adjacent trigger word here, still not risky');
  const withPay = { ref: 'e2', role: 'link', name: 'Review and pay for your pending order today', value: null, state: [], context: null };
  assert.equal(riskyBackstop(withPay), true, '"pay" sits next to "order"');
});

// ---------- Task 12b: unsure threshold by consequence ----------

test('unsureThresholds: a plain nav link/tab/menuitem gets the looser pair', () => {
  for (const role of ['link', 'tab', 'menuitem']) {
    assert.deepEqual(unsureThresholds(ref('View details', role), 'click'), { p1: UNSURE_NAV_P1, margin: UNSURE_NAV_MARGIN });
  }
});

test('unsureThresholds: a form control, a button, or anything about to be typed into gets the strict pair', () => {
  assert.deepEqual(unsureThresholds(ref('Origin', 'textbox'), 'click'), { p1: UNSURE_FORM_P1, margin: UNSURE_FORM_MARGIN });
  assert.deepEqual(unsureThresholds(ref('Continue', 'button'), 'click'), { p1: UNSURE_FORM_P1, margin: UNSURE_FORM_MARGIN });
  assert.deepEqual(unsureThresholds(ref('Origin', 'link'), 'type'), { p1: UNSURE_FORM_P1, margin: UNSURE_FORM_MARGIN }, 'a `type` operation is never plain nav, whatever the role');
});

test('unsureThresholds: a risky-flagged link is not plain nav even though its role is `link`', () => {
  const dangerous = ref('Delete account', 'link');
  assert.equal(isPlainNav(dangerous, 'click'), false);
  assert.deepEqual(unsureThresholds(dangerous, 'click'), { p1: UNSURE_FORM_P1, margin: UNSURE_FORM_MARGIN });
});

// ---------- Task 12c: regions for the two-step pick ----------

const navRef = (ref, name) => ({ ref, role: 'link', name, value: null, state: [], context: 'navigation "Main"' });
const mainRef = (ref, name) => ({ ref, role: 'link', name, value: null, state: [], context: 'main "Results"' });

test('deriveRegions groups refs by their own context into more than one bucket', () => {
  const refs = [...Array(10)].flatMap((_, i) => [navRef(`n${i}`, `Nav ${i}`), mainRef(`m${i}`, `Result ${i}`)]);
  const regions = deriveRegions(refs);
  assert.ok(regions);
  assert.equal(regions.size, 2);
  assert.equal(regions.get('navigation "Main"').length, 10);
  assert.equal(regions.get('main "Results"').length, 10);
});

test('deriveRegions returns null when every ref shares one context (nothing to partition)', () => {
  const refs = [...Array(20)].map((_, i) => navRef(`n${i}`, `Item ${i}`));
  assert.equal(deriveRegions(refs), null);
});

test('deriveRegions returns null when one region swallows almost everything (> 90%)', () => {
  const refs = [...Array(95)].map((_, i) => navRef(`n${i}`, `Item ${i}`)).concat([...Array(5)].map((_, i) => mainRef(`m${i}`, `Result ${i}`)));
  assert.equal(deriveRegions(refs), null, '95/100 = 95% in one region, above the 90% cutoff');
});

// ---------- Task 12d: collapse duplicate refs before pick ----------

test('collapseDuplicates: the Wikipedia search-suggestion duplicate (link + its ARIA option mirror) collapses to one candidate', () => {
  const refs = [
    { ref: 'e50', role: 'link', name: 'Octopus', value: null, state: [], context: 'listbox "suggestions"' },
    { ref: 'e51', role: 'option', name: 'Octopus', value: null, state: [], context: 'listbox "suggestions"' },
    { ref: 'e52', role: 'link', name: 'Octopoda', value: null, state: [], context: 'listbox "suggestions"' },
  ];
  const collapsed = collapseDuplicates(refs);
  assert.equal(collapsed.length, 2, 'the link/option pair for "Octopus" collapses to one');
  assert.deepEqual(collapsed.map((r) => r.ref), ['e50', 'e52'], 'keeps the link (more directly actionable than its ARIA option mirror)');
});

test('collapseDuplicates: pickCriteria only offers one candidate for the duplicate pair, not two competing for probability', () => {
  const refs = [
    { ref: 'e50', role: 'link', name: 'Octopus', value: null, state: [], context: 'listbox "suggestions"' },
    { ref: 'e51', role: 'option', name: 'Octopus', value: null, state: [], context: 'listbox "suggestions"' },
  ];
  const criteria = pickCriteria(refs);
  assert.deepEqual(Object.keys(criteria).sort(), ['e50', 'none']);
});

test('collapseDuplicates: same name but not adjacent, and no href on either, does not collapse', () => {
  const refs = [
    { ref: 'e1', role: 'link', name: 'Octopus', value: null, state: [], context: null },
    { ref: 'e2', role: 'link', name: 'Unrelated', value: null, state: [], context: null },
    { ref: 'e3', role: 'option', name: 'Octopus', value: null, state: [], context: null },
  ];
  assert.equal(collapseDuplicates(refs).length, 3);
});

test('collapseDuplicates: adjacent refs with different hrefs do not collapse even if the name matches', () => {
  const refs = [
    { ref: 'e1', role: 'link', name: 'More', href: '/a', value: null, state: [], context: null },
    { ref: 'e2', role: 'link', name: 'More', href: '/b', value: null, state: [], context: null },
  ];
  assert.equal(collapseDuplicates(refs).length, 2);
});

test('collapseDuplicates: adjacent refs with the same href collapse even without an identical role', () => {
  const refs = [
    { ref: 'e1', role: 'link', name: 'More', href: '/a', value: null, state: [], context: null },
    { ref: 'e2', role: 'option', name: 'More', href: '/a', value: null, state: [], context: null },
  ];
  assert.equal(collapseDuplicates(refs).length, 1);
});

test('pageFile and sessionName build the ~/.flash/web/<session>/page.json path', () => {
  const p = pageFile('flash-quicksilver');
  assert.match(p, /\.flash[\\/]web[\\/]flash-quicksilver[\\/]page\.json$/);
  assert.equal(sessionName({ session: 'abc' }), 'flash-abc');
});

test('riskyBackstop: a nav link does not inherit a risky word from its sibling links', () => {
  const link = { ref: 'n3', role: 'link', name: 'new', value: null, state: [], context: 'Hacker Newsnew | past | comments | ask | show | jobs | submit\tlogin' };
  assert.equal(riskyBackstop(link), false);
  assert.equal(riskyBackstop({ ...link, ref: 'n9', name: 'submit' }), true);
});
