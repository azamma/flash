// Declaration spans from the heuristic splitter, on fixtures with known answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitUnits } from '../skills/flash/scripts/units.mjs';

const spans = (units) => Object.fromEntries(units.map((u) => [u.name, [u.start, u.end]]));

test('python: decorators and comments attach, classes split into header plus members', () => {
  const src = [
    'import os',                    // 1
    '',                             // 2
    '# Load the config.',           // 3
    '@cache',                       // 4
    'def load(path):',              // 5
    '    return open(path).read()', // 6
    '',                             // 7
    'class Store:',                 // 8
    '    """Keeps items."""',       // 9
    '    limit = 10',               // 10
    '',                             // 11
    '    def get(self, k):',        // 12
    '        return self.d[k]',     // 13
    '',                             // 14
    '    class Meta:',              // 15
    '        ordering = ["k"]',     // 16
    '',                             // 17
    '    @property',                // 18
    '    def size(self):',          // 19
    '        return len(self.d)',   // 20
    '',                             // 21
    'async def main():',            // 22
    '    await load("x")',          // 23
  ].join('\n');
  assert.deepEqual(spans(splitUnits(src, 'store.py')), {
    load: [3, 6],
    'Store.context': [8, 11],
    'Store.get': [12, 13],
    'Store.Meta': [15, 16],
    'Store.size': [18, 20],
    main: [22, 23],
  });
});

test('js/ts: top-level functions, classes, arrow consts and exports, with their comments', () => {
  const src = [
    "import x from 'x';",                     // 1
    '',                                       // 2
    '/** Verify a token. */',                 // 3
    'export async function verify(t) {',      // 4
    '  return check(t);',                     // 5
    '}',                                      // 6
    '',                                       // 7
    'export const sign = (p) => {',           // 8
    '  return enc(p);',                       // 9
    '};',                                     // 10
    '',                                       // 11
    '// Keeps keys.',                         // 12
    'class KeyStore {',                       // 13
    '  get(k) { return this.m[k]; }',         // 14
    '}',                                      // 15
    '',                                       // 16
    'export default function handler() {}',   // 17
    'export interface Opts { a: number }',    // 18
  ].join('\n');
  assert.deepEqual(spans(splitUnits(src, 'jwt.ts')), {
    verify: [3, 6], sign: [8, 10], KeyStore: [12, 15], handler: [17, 17], Opts: [18, 18],
  });
});

test('files the scan cannot split fall back to text chunks covering every line', () => {
  const md = Array.from({ length: 400 }, (_, i) => `line ${i + 1} of the guide`).join('\n');
  const units = splitUnits(md, 'README.md');
  assert.ok(units.length > 1);
  assert.equal(units[0].start, 1);
  assert.equal(units.at(-1).end, 400);
  for (let k = 1; k < units.length; k++) assert.equal(units[k].start, units[k - 1].end + 1);
  const noDecls = splitUnits('console.log("hi");\nrun();', 'script.js');
  assert.deepEqual(noDecls.map((u) => [u.start, u.end]), [[1, 2]]);
});

test('an oversized declaration is cut into text windows', () => {
  const body = Array.from({ length: 600 }, (_, i) => `  step${i}();`).join('\n');
  const units = splitUnits(`function big() {\n${body}\n}`, 'big.js');
  assert.ok(units.length > 1 && units.every((u) => u.name.startsWith('big@')));
  assert.equal(units.at(-1).end, 602);
});
