#!/usr/bin/env node
// Flash: hand Claude's bulk judgment calls to Jev (TypeSafe System One).
// Zero dependencies. Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitUnits, unitSource, textUnits } from './units.mjs';
import { agentBrowser, pageFile, sessionName, UNTRUSTED_NOTE, pickCriteria, refLabel, refLineSpan, UNSURE_P1, UNSURE_MARGIN, risky, saveRunState, loadRunState, cleanupExpiredRuns } from './web.mjs';

const HOME = process.env.FLASH_HOME || path.join(os.homedir(), '.flash');
const CONFIG = path.join(HOME, 'config.json');
const HISTORY = path.join(HOME, 'history.jsonl');
const CACHE = path.join(HOME, 'cache');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
// Jev is served by TypeSafe directly and by OpenRouter's Decisions endpoint; same request/answer shape.
const PROVIDERS = {
  typesafe: { base: 'https://api.typesafe.ai', decide: '/v1/systemone', model: 'jev-latest',
    keyUrl: 'https://console.typesafe.ai', env: ['JEV_API_KEY', 'TYPESAFE_API_KEY'] },
  openrouter: { base: 'https://openrouter.ai/api', decide: '/alpha/decisions', model: 'typesafe/jev-1.13',
    keyUrl: 'https://openrouter.ai/settings/keys', env: ['OPENROUTER_API_KEY'],
    headers: { 'HTTP-Referer': 'https://github.com/azamma/flash', 'X-Title': 'flash' } },
};
const PRICE_PER_TOKEN = 0.042 / 1e6;

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.turbo', '.cache', '.idea', '.vscode']);
const SECRET_RE = /(^|[\/\\])(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks|crt|cer)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const LOCK_RE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|\.min\.(js|css)|\.map)$/i;

// ---------- args ----------

function parseArgs(argv) {
  const pos = [], flags = {};
  const bools = new Set(['lines', 'json', 'all', 'remove', 'help', 'fast', 'verbose', 'no-collapse', 'no-secrets-guard', 'plain', 'no-cache', 'no-source', 'md']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      const optionalNumber = (name === 'context' || name === 'history') && !/^\d+$/.test(argv[i + 1] || '');
      if (bools.has(name) || optionalNumber || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[name] = true;
      else flags[name] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const die = (msg, code = 1) => { process.stderr.write(`flash: ${msg}\n`); process.exit(code); };
const num = (v, d) => (v === undefined || v === true ? d : Number(v));
const estTokens = (s) => Math.ceil(s.length / 4);
const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const f2 = (x) => x.toFixed(2);

// ---------- config / stats ----------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode });
  if (mode) try { fs.chmodSync(file, mode); } catch {}
}

const storedKey = (cfg, name) => cfg.keys?.[name] || '';
const envKey = (name) => PROVIDERS[name].env.find((v) => process.env[v]);

// --provider > FLASH_PROVIDER > saved choice > whichever provider has a key (TypeSafe first).
function provider(flags = {}) {
  const cfg = readJson(CONFIG, {});
  let name = flags.provider || process.env.FLASH_PROVIDER || cfg.provider;
  if (!name) name = Object.keys(PROVIDERS).find((n) => envKey(n) || storedKey(cfg, n)) || 'typesafe';
  if (!PROVIDERS[name]) die(`unknown provider "${name}". Use: ${Object.keys(PROVIDERS).join(', ')}`, 2);
  const p = PROVIDERS[name], env = envKey(name);
  return { ...p, name, base: (process.env.FLASH_API_BASE || p.base).replace(/\/$/, ''),
    key: env ? process.env[env] : storedKey(cfg, name), keySource: env ? `env ${env}` : CONFIG };
}

function modelName(flags) {
  const cfg = readJson(CONFIG, {}), p = provider(flags);
  return flags.model || process.env.FLASH_MODEL || cfg.models?.[p.name] || p.model;
}

// One line per run in history.jsonl, the only stats store. Besides counts, each command sets `audit`:
// what Claude asked (query, input paths) and where Jev pointed (ids, lines, scores), never file content.
let audit = {};
const GUARD_WINDOW_MS = 120_000;

// A run over a file the Read hook blocked in the last 2 minutes counts as triggered by the hook.
// ponytail: time + file-path heuristic; exact linking would need the hook to pass an id to Claude.
function afterGuard(inputs) {
  const now = Date.now(), abs = (inputs || []).map((i) => path.resolve(String(i)));
  const g = readHistory().slice(-200).reverse().find((r) => r.cmd === 'guard' && r.file && now - Date.parse(r.ts) < GUARD_WINDOW_MS &&
    abs.some((a) => a === path.resolve(r.file) || a.endsWith(path.sep + r.file)));
  return g?.ts;
}

// One line appended to history.jsonl, the only stats store; shared by every command that logs a
// row, one process-wide row from recordStats or one step-per-call row from `flash web`.
function logRow(row) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(HISTORY, JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch {}
}

function recordStats(run) {
  const row = { ts: new Date().toISOString(), cmd: process.argv[2], project: projectName(process.cwd()),
    provider: provider().name, items: run.items, requests: run.requests, cached: cacheHits, jev_tokens: run.jevTokens, saved: Math.max(0, run.saved),
    ...audit, results: audit.results?.slice(0, 50) };
  const g = afterGuard(audit.inputs);
  if (g) row.after_guard = g;
  logRow(row);
}

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The project a row belongs to: the git repo's root folder, or the working folder outside git.
function projectName(cwd) {
  try {
    return path.basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { return path.basename(cwd); }
}

// Answer cache. The request body carries the content, so an edited file is a new key and a miss.
// Only Jev's answers are stored, never the content. ponytail: expired entries are pruned on read and
// by `flash cache clear`, not by a size-capped sweep; add one if ~/.flash/cache ever grows large.
let cacheHits = 0;
const cacheFile = (p, body) => path.join(CACHE, crypto.createHash('sha256')
  .update(JSON.stringify(['flash-cache-v1', p.name, p.base, body])).digest('hex') + '.json');

function cacheGet(file) {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > CACHE_TTL_MS) { fs.rmSync(file, { force: true }); return null; }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function cachePut(file, res) {
  try {
    fs.mkdirSync(CACHE, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ model: res.model, answers: res.answers }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

const post = (p, key, body, ms) => fetch(p.base + p.decide, {
  method: 'POST', signal: AbortSignal.timeout(ms), body: JSON.stringify(body),
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...p.headers },
});

// Fail closed: every question must come back with an answer of its own type and in-range numbers.
// A malformed body is never used and never cached. (Checks adapted from jev-mcp, MIT © Joey Kudish.)
const unit = (x) => typeof x === 'number' && x >= 0 && x <= 1;

// A choice answer must name one of the offered criteria, carry a probability for each of them and
// no others, and that choice must actually be the argmax. (Ported from jev-ultrafast model.py:53-68,
// MIT © 2026 Browser Use.) Needed before any answer can safely trigger a click.
function validChoice(a, criteria) {
  const ids = Object.keys(criteria || {});
  if (!ids.includes(a.choice)) return false;
  const ps = a.probabilities || {};
  const keys = Object.keys(ps);
  if (keys.length !== ids.length || !keys.every((k) => ids.includes(k))) return false;
  const vals = Object.values(ps);
  if (!vals.every(unit)) return false;
  if (vals.length && Math.abs(vals.reduce((s, x) => s + x, 0) - 1) >= 0.02) return false;
  return ps[a.choice] >= Math.max(...vals) - 1e-6;
}

function validAnswers(body, json) {
  return Object.entries(body.questions || {}).every(([id, q]) => {
    const a = json?.answers?.[id];
    if (!a || a.type !== q.type) return false;
    if (q.type === 'noul') return unit(a.noul);
    if (q.type === 'score') return Number.isFinite(a.score);
    if (q.type === 'choice') return typeof a.choice === 'string' && validChoice(a, q.criteria);
    return false;
  });
}

const DEADLINE_MS = 180_000;
const MAX_BODY = 1_000_000;

async function decide(body, flags, { soft = false } = {}) {
  const p = provider(flags);
  const cached = !flags['no-cache'] && cacheFile(p, body);
  const hit = cached && cacheGet(cached);
  if (hit) { cacheHits++; return { ...hit, usage: { input_tokens: 0 } }; }
  if (!p.key) die(`no ${p.name} API key. Get one at ${p.keyUrl}, then run: node flash.mjs setup --provider ${p.name}`, 3);
  // Upstream bodies are never echoed: Claude reads this output, and a provider error is untrusted text.
  let lastErr;
  const end = Date.now() + DEADLINE_MS;
  for (let attempt = 0; attempt <= 5 && Date.now() < end; attempt++) {
    let res;
    try {
      res = await post(p, p.key, body, Math.min(60_000, end - Date.now()));
    } catch (e) {
      // A timeout may have reached Jev and been billed; don't pay for it twice.
      if (e.name === 'TimeoutError' || e.name === 'AbortError') { lastErr = 'timed out waiting for Jev'; break; }
      lastErr = `network error (${e.cause?.code || e.name})`;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    // ponytail: size checked after reading, not streamed; Jev answers are a few KB.
    const text = await res.text();
    if (text.length > MAX_BODY) { lastErr = 'response over 1 MB'; break; }
    if (res.ok) {
      let json;
      try { json = JSON.parse(text); } catch {}
      if (validAnswers(body, json)) { if (cached) cachePut(cached, json); return json; }
      lastErr = 'malformed answer from Jev';
      continue;
    }
    if (res.status === 401 || res.status === 403) die(`${p.name} rejected the API key (${res.status}). Get a new one at ${p.keyUrl} and run: node flash.mjs setup --provider ${p.name}`, 3);
    if (res.status === 422 || res.status === 400 || res.status === 413) {
      if (soft) return null;
      die(`Jev rejected the request (HTTP ${res.status}). The input may be too large or malformed: try fewer items, or drop --fast.`, 4);
    }
    lastErr = `HTTP ${res.status}`;
    if (![408, 409, 429, 500, 502, 503, 504, 520, 522, 524, 529].includes(res.status)) break;
    const ra = Number(res.headers.get('retry-after'));
    await sleep(Math.min(ra > 0 ? ra * 1000 : 500 * 2 ** attempt + Math.random() * 250, Math.max(0, end - Date.now())));
  }
  if (soft) return null;
  die(`Jev request failed: ${lastErr}`, 5);
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

// ---------- inputs ----------

function gitFiles(dir) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '.'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean).map((f) => path.join(dir, f));
  } catch { return null; }
}

// Patterns from .gitignore/.ignore for the non-git walk. Git repos go through `git ls-files` instead.
// ponytail: no negation (!), no ** — enough for the usual "dist/", "*.log", "tmp"; git handles the rest.
function ignoreRules(dir) {
  const lines = ['.gitignore', '.ignore'].flatMap((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/); } catch { return []; } });
  return lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!')).map((l) => {
    const body = l.replace(/^\//, '').replace(/\/$/, '').replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    return new RegExp(`^${body}$`);
  });
}

// Symlinks are never followed: e.isFile() and e.isDirectory() are false for them.
function walk(dir, acc = [], rules = []) {
  const here = [...rules, ...ignoreRules(dir)];
  const ignored = (name) => here.some((r) => r.test(name));
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored(e.name)) continue;
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), acc, here); }
    else if (e.isFile()) acc.push(path.join(dir, e.name));
  }
  return acc;
}

function expand(spec) {
  if (/[*?[\]{}]/.test(spec)) {
    if (!fs.globSync) die('glob patterns need Node 22+; pass a directory instead', 2);
    return fs.globSync(spec, { exclude: (p) => IGNORE_DIRS.has(path.basename(p)) }).filter((f) => fs.statSync(f).isFile());
  }
  if (!fs.existsSync(spec)) die(`no such file or directory: ${spec}`, 2);
  const st = fs.statSync(spec);
  if (st.isFile()) return [spec];
  const tracked = gitFiles(spec);
  return (tracked?.length ? tracked : walk(spec)).filter((f) => { try { return fs.lstatSync(f).isFile(); } catch { return false; } });
}

// Control bytes other than tab, newline, CR, form feed and ESC (ANSI colours in logs) mean binary.
const CONTROL_RE = /[\x00-\x08\x0b\x0e-\x1a\x1c-\x1f\x7f]/;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Returns { text } or { skip: reason }.
function readText(file, maxBytes) {
  if (fs.statSync(file).size > maxBytes) return { skip: `>${maxBytes / 1024 / 1024}MB` };
  let text;
  try { text = utf8.decode(fs.readFileSync(file)); } catch { return { skip: 'binary' }; }
  if (CONTROL_RE.test(text)) return { skip: 'binary' };
  if (PRIVATE_KEY_RE.test(text)) return { skip: 'contains a private key, never sent' };
  return { text };
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// Returns [{id, text, truncated}] plus a list of skipped paths.
function collect(pos, flags) {
  const maxChars = num(flags['max-chars'], 60000);
  const exts = flags.ext ? String(flags.ext).split(',').map((e) => '.' + e.replace(/^\./, '').toLowerCase()) : null;
  const items = [], skipped = [];
  const push = (id, text) => {
    const truncated = text.length > maxChars;
    items.push({ id, text: truncated ? text.slice(0, maxChars) : text, truncated });
  };
  const pushLines = (name, text) => text.split(/\r?\n/).forEach((l, i) => { if (l.trim()) push(`${name}:${i + 1}`, l); });

  if (flags.items) {
    const raw = flags.items === '-' ? readStdin() : fs.readFileSync(flags.items, 'utf8');
    raw.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          const { id, text, content, ...rest } = o;
          const body = text ?? content ?? JSON.stringify(rest);
          return push(String(id ?? i + 1), typeof body === 'string' ? body : JSON.stringify(body));
        }
      } catch {}
      push(String(i + 1), line);
    });
  }

  const files = [];
  for (const spec of pos) {
    if (spec === '-') { const t = readStdin(); flags.lines ? pushLines('stdin', t) : push('stdin', t); continue; }
    files.push(...expand(spec));
  }
  const seen = new Set();
  for (const f of files) {
    const abs = path.resolve(f);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const r = rel(abs);
    if (exts && !exts.includes(path.extname(f).toLowerCase())) continue;
    if (!flags['no-secrets-guard'] && SECRET_RE.test(r)) { skipped.push(`${r} (secret-like, never sent)`); continue; }
    if (LOCK_RE.test(r)) continue;
    if ((abs + path.sep).startsWith(path.resolve(HOME) + path.sep)) { skipped.push(`${r} (flash config, never sent)`); continue; }
    const { text, skip } = readText(abs, 2 * 1024 * 1024);
    if (skip) { skipped.push(`${r} (${skip})`); continue; }
    if (!text.trim()) continue;
    flags.lines ? pushLines(r, text) : push(r, text);
  }
  const limit = num(flags.limit, 5000);
  if (items.length > limit) die(`${items.length} items exceeds --limit ${limit}. Narrow the input or raise --limit.`, 2);
  return { items, skipped };
}

// One item per request by default: packing items into a shared state measurably hurts accuracy
// (bench: CI triage 76% packed vs 100% unpacked). --fast packs up to 40 small items (~12 KB).
// makeQ(ref, packed) builds the question; ref is how the item is addressed in state.
async function runPerItem(items, flags, makeQ) {
  const run = { requests: 0, jevTokens: 0, max: Infinity, failed: 0 };
  const entries = items.map((it) => ({ state: { source: it.id, content: it.text },
    questions: (r) => ({ q: makeQ(r ? `\`${r.slice(0, -1)}\`` : '`content`', Boolean(r)) }) }));
  const answers = await askAll(entries, flags, run, { maxItems: flags.fast ? 40 : 1, maxBytes: 12_000, soft: false });
  return { rows: items.map((item, k) => ({ item, answer: answers[k].q })), stats: run };
}

// ---------- output ----------

function footer(t0, items, extra, stats, outText, skipped) {
  const contentTok = items.reduce((a, it) => a + estTokens(it.text), 0);
  const saved = contentTok - estTokens(outText);
  const parts = [`${items.length} scanned`, ...extra, ...(cacheHits ? [`${cacheHits} cached`] : []), `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    `jev ${fmtK(stats.jevTokens)} tok (${cost(stats.jevTokens)})`,
    `~${fmtK(Math.max(0, saved))} Claude tokens not read`];
  let s = `— ${parts.join(' · ')}`;
  if (skipped.length) s += `\n— skipped ${skipped.length}: ${clip(skipped.join(', '), 400)}`;
  recordStats({ requests: stats.requests, items: items.length, jevTokens: stats.jevTokens, saved });
  return s;
}

const cost = (t) => `$${(t * PRICE_PER_TOKEN).toFixed(4)}`;
const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

function emit(flags, jsonObj, lines, foot) {
  const out = flags.json ? JSON.stringify(jsonObj, null, 2) : lines.join('\n');
  if (out) process.stdout.write(out + '\n');
  process.stderr.write(foot + '\n');
}

function label(it, flags) {
  const t = it.truncated ? '~' : '';
  return flags.lines || flags.items ? `${it.id}${t}  ${clip(it.text.trim().replace(/\s+/g, ' '), num(flags.width, 160))}` : `${it.id}${t}`;
}

function requireInputs(items, cmd) {
  if (!items.length) die(`nothing to ${cmd}: pass files, directories, globs, --items FILE, or - for stdin`, 2);
}

// ---------- commands ----------

// Log lines repeat with different numbers/ids; collapse them so Claude reads each pattern once.
const template = (t) => t.replace(/0x[0-9a-f]+/gi, '#').replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

// [3,4,5,9] -> "3-5,9"; stops after `max` numbers and points at --save for the rest.
function ranges(nums, max) {
  const parts = [];
  let shown = 0;
  for (let i = 0; i < nums.length && shown < max; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    shown += j - i + 1;
    i = j;
  }
  return parts.join(',') + (shown < nums.length ? `,… (+${nums.length - shown}; use --save for all)` : '');
}

function renderRows(rs, flags, score) {
  if (!flags.lines || flags['no-collapse']) return rs.map((r) => `${f2(score(r))}  ${label(r.item, flags)}`);
  const groups = new Map();
  for (const r of rs) {
    const k = template(r.item.text);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return `${f2(score(g[0]))}  ${label(g[0].item, flags)}`;
    const rest = g.slice(1).map((r) => Number(r.item.id.split(':').pop())).sort((a, b) => a - b);
    return `${f2(score(g[0]))}  ×${g.length}  ${label(g[0].item, flags)}\n        also lines ${ranges(rest, 300)}`;
  });
}

function save(flags, data) {
  if (!flags.save) return '';
  fs.writeFileSync(flags.save, JSON.stringify(data, null, 2));
  return `\n— full results saved to ${flags.save}`;
}

async function cmdFilter({ pos, flags }) {
  const question = pos.shift();
  if (!question) die('usage: filter "<yes/no question>" <paths...>', 2);
  const t0 = Date.now();
  const { items, skipped } = collect(pos, flags);
  requireInputs(items, 'filter');
  const thr = num(flags.threshold, 0.5), band = num(flags.band, 0.15);
  const { rows, stats } = await runPerItem(items, flags, (ref, packed) => ({
    type: 'noul',
    instructions: packed ? { question, answer_about: `Answer only about ${ref}; ignore the other items.` } : question,
  }));
  rows.sort((a, b) => b.answer.noul - a.answer.noul);
  const p = (r) => r.answer.noul;
  const hits = rows.filter((r) => p(r) >= thr);
  const sure = rows.filter((r) => p(r) >= thr + band);
  const unsure = rows.filter((r) => Math.abs(p(r) - thr) < band);
  const lines = [
    ...renderRows(sure, flags, p),
    ...(unsure.length ? [`? borderline (${f2(thr - band)}–${f2(thr + band)}) — check these yourself:`, ...renderRows(unsure, flags, p)] : []),
  ];
  if (!sure.length && !unsure.length) lines.push('(no matches)');
  const saved = save(flags, rows.map((r) => ({ id: r.item.id, p: p(r) })));
  audit = { query: question, inputs: pos, results: hits.map((r) => ({ id: r.item.id, p: +f2(p(r)) })) };
  const foot = footer(t0, items, [`${hits.length} matched`, `${unsure.length} borderline`], stats, lines.join('\n'), skipped) + saved;
  emit(flags, { matched: hits.map((r) => ({ id: r.item.id, p: p(r) })), borderline: unsure.map((r) => ({ id: r.item.id, p: p(r) })) }, lines, foot);
}

function parseLabels(flags) {
  if (flags['labels-json']) {
    const raw = String(flags['labels-json']);
    return JSON.parse(raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw);
  }
  if (!flags.labels) die('classify needs --labels "a,b,c" or --labels-json \'{"a":"description"}\'', 2);
  return Object.fromEntries(String(flags.labels).split(',').map((s) => s.trim()).filter(Boolean).map((l) => {
    const [k, ...d] = l.split(':');
    return [k.trim(), d.length ? d.join(':').trim() : null];
  }));
}

async function cmdClassify({ pos, flags }) {
  const criteria = parseLabels(flags);
  const n = Object.keys(criteria).length;
  if (n < 2 || n > 255) die('classify needs 2–255 labels', 2);
  const question = flags.question || 'Which label best describes this item?';
  const t0 = Date.now();
  const { items, skipped } = collect(pos, flags);
  requireInputs(items, 'classify');
  const minConf = num(flags['min-confidence'], 0.6);
  const { rows, stats } = await runPerItem(items, flags, (ref, packed) => ({
    type: 'choice',
    instructions: packed ? { question, answer_about: `Answer only about ${ref}; ignore the other items.` } : question,
    criteria,
  }));
  const groups = {};
  for (const r of rows) (groups[r.answer.choice] ||= []).push(r);
  const only = flags.only ? new Set(String(flags.only).split(',')) : null;
  const low = rows.filter((r) => r.answer.confidence < minConf);
  const lines = [Object.keys(criteria).map((k) => `${k} ${groups[k]?.length || 0}`).join(' · ')];
  for (const k of Object.keys(criteria)) {
    if (!groups[k] || (only && !only.has(k))) continue;
    const g = groups[k].sort((a, b) => b.answer.confidence - a.answer.confidence);
    if (flags.verbose) {
      lines.push(`[${k}]`);
      for (const r of g) lines.push(`${r.answer.confidence < minConf ? '?' : ' '}${f2(r.answer.confidence)}  ${label(r.item, flags)}`);
    } else {
      const ok = g.filter((r) => r.answer.confidence >= minConf).map((r) => r.item.id);
      if (ok.length) lines.push(`[${k}] ${ok.join(' ')}`);
    }
  }
  if (!flags.verbose && low.length) {
    lines.push('? low confidence — check these yourself:');
    for (const r of low.filter((r) => !only || only.has(r.answer.choice))) {
      const [second] = Object.entries(r.answer.probabilities).sort((a, b) => b[1] - a[1]).slice(1);
      lines.push(`?${f2(r.answer.confidence)}  ${r.answer.choice} (or ${second?.[0]})  ${r.item.id}  ${clip(r.item.text.trim().replace(/\s+/g, ' '), num(flags.width, 160))}`);
    }
  }
  const saved = save(flags, rows.map((r) => ({ id: r.item.id, label: r.answer.choice, confidence: r.answer.confidence })));
  audit = { query: question, labels: Object.keys(criteria), inputs: pos,
    results: rows.map((r) => ({ id: r.item.id, label: r.answer.choice, p: +f2(r.answer.confidence) })) };
  const foot = footer(t0, items, [`${low.length} low-confidence (?)`], stats, lines.join('\n'), skipped) + saved;
  emit(flags, rows.map((r) => ({ id: r.item.id, label: r.answer.choice, confidence: r.answer.confidence, probabilities: r.answer.probabilities })), lines, foot);
}

const RANK_LEVELS = [
  'Unrelated to the query',
  'Shares a topic with the query but does not help answer it',
  'Partially relevant: contains some useful information for the query',
  'Relevant: substantially addresses the query',
  'Directly and specifically answers or matches the query',
];

async function cmdRank({ pos, flags }) {
  const query = pos.shift();
  if (!query) die('usage: rank "<query>" <paths...> [--top 10]', 2);
  const t0 = Date.now();
  const { items, skipped } = collect(pos, flags);
  requireInputs(items, 'rank');
  const { rows, stats } = await runPerItem(items, flags, (ref, packed) => ({
    type: 'score',
    instructions: { query, question: `How relevant is ${ref} to \`query\`?${packed ? ' Ignore the other items.' : ''}` },
    criteria: RANK_LEVELS,
  }));
  const top = num(flags.top, 10), max = RANK_LEVELS.length - 1;
  rows.sort((a, b) => b.answer.score - a.answer.score);
  const shown = flags.all ? rows : rows.slice(0, top);
  const lines = shown.map((r) => `${f2(r.answer.score / max)}  ${label(r.item, flags)}`);
  audit = { query, inputs: pos, results: shown.map((r) => ({ id: r.item.id, p: +f2(r.answer.score / max) })) };
  const foot = footer(t0, items, [`top ${shown.length}`], stats, lines.join('\n'), skipped);
  emit(flags, shown.map((r) => ({ id: r.item.id, relevance: r.answer.score / max, confidence: r.answer.confidence })), lines, foot);
}

async function cmdFind({ pos, flags }) {
  const query = pos.shift();
  if (!query || !pos.length) die('usage: find "<what you are looking for>" <files...> [--top 5]', 2);
  const t0 = Date.now();
  const model = modelName(flags);
  const chunkLines = Math.min(num(flags.chunk, 150), 250);
  const { items: files, skipped } = collect(pos, { ...flags, lines: false, 'max-chars': Infinity });
  requireInputs(files, 'find');
  const chunks = [];
  for (const f of files) {
    const all = f.text.split(/\r?\n/).map((t, i) => [String(i + 1), t]).filter(([, t]) => t.trim());
    for (let i = 0; i < all.length; i += chunkLines) chunks.push({ file: f.id, lines: all.slice(i, i + chunkLines) });
  }
  const stats = { requests: chunks.length, jevTokens: 0 };
  const perChunk = await pool(chunks.map((c) => async () => {
    const lines = Object.fromEntries(c.lines.map(([n, t]) => [n, clip(t, 400)]));
    const res = await decide({
      model,
      state: { query, lines },
      questions: {
        where: {
          type: 'choice',
          instructions: 'Which line number in `lines` best matches `query`?',
          criteria: { ...Object.fromEntries(c.lines.map(([n]) => [n, null])), none: 'No line matches `query`' },
        },
        exists: { type: 'noul', instructions: 'Does any line in `lines` match `query`?' },
      },
    }, flags);
    stats.jevTokens += res.usage?.input_tokens || 0;
    const ex = res.answers.exists.noul;
    return Object.entries(res.answers.where.probabilities)
      .filter(([n]) => n !== 'none')
      .map(([n, p]) => ({ file: c.file, line: n, text: lines[n], score: p * ex }));
  }), num(flags.concurrency, 16));
  const top = num(flags.top, 5), minScore = num(flags['min-score'], 0.05);
  const hits = perChunk.flat().filter((h) => h.score >= minScore).sort((a, b) => b.score - a.score).slice(0, top);
  let out = hits.map((h) => `${f2(h.score)}  ${h.file}:${h.line}  ${clip(h.text.trim(), num(flags.width, 160))}`);
  let json = hits;
  if (flags.context && hits.length) {
    const blocks = contextBlocks(hits, files, num(flags.context === true ? undefined : flags.context, 3), num(flags['max-source-bytes'], 20000));
    out = [...out, '', ...blocks.flatMap(renderBlock), 'End context.'];
    json = { hits, blocks };
  }
  if (!out.length) out.push('(no matching lines)');
  audit = { query, inputs: pos, results: hits.map((h) => ({ id: h.file, line: +h.line, p: +f2(h.score) })) };
  const foot = footer(t0, files, [`${chunks.length} chunks`], stats, out.join('\n'), skipped);
  emit(flags, json, out, foot);
}

// --context: turn hit lines into verbatim source blocks so Claude needs no follow-up Read.
const COMMENT_RE = /^\s*(\/\/|#|\*|\/\*|--|;|<!--|"""|''')/;

function contextBlocks(hits, files, pad, maxBytes) {
  const byFile = new Map();
  for (const h of hits) {
    const lines = files.find((f) => f.id === h.file).text.split(/\r?\n/);
    let a = Math.max(1, Number(h.line) - pad), b = Math.min(lines.length, Number(h.line) + pad);
    // Widen upward over the comment block (blank lines inside it included) that documents the hit.
    for (let i = a - 1; i >= 1 && (COMMENT_RE.test(lines[i - 1]) || (!lines[i - 1].trim() && COMMENT_RE.test(lines[i - 2] ?? ''))); i--) a = i;
    const f = byFile.get(h.file) || byFile.set(h.file, { file: h.file, lines, ranges: [] }).get(h.file);
    f.ranges.push([a, b]);
  }
  return sourceBlocks([...byFile.values()], maxBytes);
}

// files: [{ file, lines, ranges: [[start, end]] }]. Merges touching ranges per file and stops, with an
// `omitted` marker, once the total source would pass maxBytes.
function sourceBlocks(files, maxBytes) {
  const blocks = [];
  let bytes = 0;
  for (const { file, lines, ranges } of files) {
    const merged = ranges.sort((x, y) => x[0] - y[0]).reduce((acc, r) => {
      const last = acc.at(-1);
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else acc.push([...r]);
      return acc;
    }, []);
    for (const [a, b] of merged) {
      const source = lines.slice(a - 1, b).join('\n');
      if (bytes + source.length > maxBytes) return [...blocks, { omitted: true, maxBytes }];
      bytes += source.length;
      blocks.push({ file, start: a, end: b, source });
    }
  }
  return blocks;
}

function renderBlock(b) {
  if (b.omitted) return [`… more source omitted past --max-source-bytes ${b.maxBytes}. Raise it or Read the hit lines above.`];
  const fence = '`'.repeat(Math.max(3, ...(b.source.match(/`+/g) || []).map((m) => m.length + 1)));
  return [`Source block "${b.file}" lines ${b.start}-${b.end}:`, fence, b.source, fence, ''];
}

function fmtAnswer(id, a) {
  if (a.type === 'noul') return `${id}  noul ${f2(a.noul)}`;
  if (a.type === 'choice') return `${id}  choice ${a.choice} (conf ${f2(a.confidence)})`;
  if (a.type === 'score') {
    const lvl = a.legend?.[String(Math.round(a.score))];
    return `${id}  score ${f2(a.score)}/${Object.keys(a.legend || {}).length - 1}${lvl ? ` "${clip(lvl, 60)}"` : ''} (conf ${f2(a.confidence)})`;
  }
  return `${id}  ${JSON.stringify(a)}`;
}

function readStateArg(v) {
  if (v === undefined) return undefined;
  if (v === '-') return readStdin();
  if (typeof v === 'string' && v.startsWith('@')) return fs.readFileSync(v.slice(1), 'utf8');
  return v;
}

// ---------- search: folder → file → chunk traversal (after jevgrep, MIT, David Zhang) ----------

// 12 KB chunks cut at line boundaries: [{ start, end, text }].
function chunkLines(text) {
  const lines = text.split(/\r?\n/);
  return textUnits(lines, 1, lines.length, 'chunk', 12_000).map((u) => ({ ...u, text: unitSource(lines, u) }));
}

function preview(dir) {
  const names = [...dir.dirs.keys()].map((d) => d + '/').concat(dir.files.map((f) => path.basename(f.id)));
  const exts = {};
  for (const f of dir.all) { const e = path.extname(f.id) || '(none)'; exts[e] = (exts[e] || 0) + 1; }
  let shown = [], bytes = 0;
  for (const n of names) { if (shown.length >= 64 || bytes + n.length > 4000) break; shown.push(n); bytes += n.length + 1; }
  return { children: shown, more: names.length - shown.length, files_below: dir.all.length, extensions: exts };
}

// Ask every entry its questions. Entry: { state, questions(ref) -> {id: question} } where ref prefixes
// the state's fields. Returns one {id: answer} map per entry ({} when unanswered).
// Unpacked by default (more accurate); --fast packs up to maxItems entries or maxBytes per request.
// soft: a refused or failing pack is split in half and a failing single scores {} (search);
// otherwise any failure stops the run (filter, classify, rank). Stops sending past run.max requests.
async function askAll(entries, flags, run, { maxItems = flags.fast ? 128 : 1, maxBytes = 38_000, soft = true } = {}) {
  const model = modelName(flags);
  const groups = [];
  let cur = [], bytes = 0;
  for (const e of entries) {
    const b = JSON.stringify(e.state).length;
    if (cur.length && (cur.length >= maxItems || bytes + b > maxBytes)) { groups.push(cur); cur = []; bytes = 0; }
    cur.push(e); bytes += b;
  }
  if (cur.length) groups.push(cur);
  const scores = new Map();
  const send = async (g) => {
    if (run.requests >= run.max) { run.incomplete = true; return; }
    run.requests++;
    const packed = g.length > 1;
    const qs = g.map((e, j) => e.questions(packed ? `items.i${j}.` : ''));
    const body = {
      model,
      state: packed ? { items: Object.fromEntries(g.map((e, j) => [`i${j}`, e.state])) } : g[0].state,
      questions: Object.fromEntries(qs.flatMap((q, j) => Object.entries(q).map(([id, spec]) => [`${id}_${j}`, spec]))),
    };
    const res = await decide(body, flags, { soft });
    if (!res && packed) { const h = Math.ceil(g.length / 2); await send(g.slice(0, h)); await send(g.slice(h)); return; }
    if (!res) { run.failed++; return; } // one unanswerable item scores 0 instead of sinking the search
    run.jevTokens += res.usage?.input_tokens || 0;
    g.forEach((e, j) => scores.set(e, Object.fromEntries(Object.keys(qs[j]).map((id) => [id, res.answers[`${id}_${j}`]]))));
  };
  await pool(groups.map((g) => () => send(g)), num(flags.concurrency, 16));
  return entries.map((e) => scores.get(e) ?? {});
}

// Second pass over the candidate files, as in jevgrep: judge each declaration twice (does it implement
// or test the behaviour; is it the queried API rather than a look-alike) and take the lower answer.
// Above 0.5 it is selected and shown as source, 0.25–0.5 is listed as a reading lead. One more
// question per file labels its role, which orders the output.
const ROLES = { implementation: 'Implements the behaviour the query asks about', caller: 'Calls, routes to or wires up that implementation',
  helper: 'Utility code the implementation relies on', test: 'Tests that behaviour', fixture: 'Test data, mocks or fixtures', other: 'None of these' };

async function describeCandidates(query, cands, flags, run) {
  if (!cands.length) return { out: ['(no relevant files)'], json: [] };
  const entries = [];
  for (const c of cands) {
    const lines = (c.lines = c.text.split(/\r?\n/));
    c.units = splitUnits(c.text, c.id);
    entries.push({ file: c, state: { query, path: c.id, head: c.text.slice(0, 3000) },
      questions: (r) => ({ role: { type: 'choice', instructions: `What role does the file \`${r}path\` (it starts with \`${r}head\`) play for \`${r}query\`?`, criteria: ROLES } }) });
    for (const u of c.units) {
      const state = { query, path: c.id, declaration: u.name, lines: `${u.start}-${u.end}`, code: unitSource(lines, u),
        ...(u.start > 20 ? { file_head: lines.slice(0, 20).join('\n') } : {}) };
      entries.push({ file: c, unit: u, state, questions: (r) => ({
        q: { type: 'noul', instructions: `Does \`${r}code\` (\`${r}declaration\` in \`${r}path\`) directly implement, define or test the behaviour asked about in \`${r}query\`? Count code that is currently buggy.` },
        scope: { type: 'noul', instructions: `Is \`${r}code\` part of the API or feature that \`${r}query\` is about, rather than unrelated code that only looks similar?` },
      }) });
    }
  }
  const answers = await askAll(entries, flags, run);
  entries.forEach((e, i) => {
    const a = answers[i];
    if (!e.unit) { e.file.role = a.role?.choice || 'other'; return; }
    e.unit.value = Math.min(a.q?.noul ?? 0, a.scope?.noul ?? 0);
  });
  const rank = Object.keys(ROLES);
  cands.sort((x, y) => rank.indexOf(x.role) - rank.indexOf(y.role) || y.score - x.score);
  const span = ({ name, start, end, value }) => ({ name, start, end, value });
  const out = [];
  for (const c of cands) {
    c.picked = c.units.filter((u) => u.value > 0.5);
    c.leads = c.units.filter((u) => u.value > 0.25 && u.value <= 0.5);
    out.push(`${f2(c.score)}  ${c.id}  ${c.role}${c.picked.length ? '' : '; locations only'}`);
    for (const u of c.picked) out.push(`      ${f2(u.value)}  ${u.name}@${u.start}-${u.end}`);
    if (c.leads.length) out.push(`      leads: ${c.leads.map((u) => `${u.name}@${u.start}-${u.end}`).join(', ')}`);
  }
  const json = cands.map((c) => ({ id: c.id, score: c.score, role: c.role, selected: c.picked.map(span), leads: c.leads.map(span) }));
  if (flags['no-source']) return { out, json };
  const blocks = sourceBlocks(cands.map((c) => ({ file: c.id, lines: c.lines, ranges: c.picked.map((u) => [u.start, u.end]) })),
    num(flags['max-source-bytes'], 20000));
  if (blocks.length) out.push('', ...blocks.flatMap(renderBlock), 'End context.');
  return { out, json: { files: json, blocks } };
}

async function cmdSearch({ pos, flags }) {
  const [query, root = '.'] = pos;
  if (!query) die('usage: search "<what you are looking for>" [root] [--max-requests 1000] [--fast]', 2);
  const t0 = Date.now();
  const { items, skipped } = collect([root], { ...flags, lines: false, 'max-chars': Infinity, limit: flags.limit ?? Infinity });
  requireInputs(items, 'search');
  const rootAbs = path.resolve(root);
  // Directory tree relative to root: { dirs: Map(name -> node), files: [items directly here], all: [items below] }.
  const node = () => ({ dirs: new Map(), files: [], all: [] });
  const tree = node();
  for (const it of items) {
    const parts = path.relative(rootAbs, path.resolve(it.id)).split(path.sep);
    let n = tree;
    n.all.push(it);
    for (const d of parts.slice(0, -1)) { n = n.dirs.get(d) || n.dirs.set(d, node()).get(d); n.all.push(it); }
    n.files.push(it);
  }
  const run = { requests: 0, jevTokens: 0, max: num(flags['max-requests'], 1000), incomplete: false, failed: 0 };
  const best = new Map(); // file id -> { score, start, end }
  // Level 0 and 1 are listed without asking; deeper folders must pass a preview check first.
  let frontier = [['', tree, 0]];
  while (frontier.length) {
    const entries = [];
    const next = [];
    for (const [dirPath, dir, depth] of frontier) {
      for (const f of dir.files) for (const c of chunkLines(f.text)) {
        entries.push({ kind: 'file', file: f, chunk: c,
          state: { query, path: f.id, lines: `${c.start}-${c.end}`, content: c.text },
          questions: (r) => ({ rel: { type: 'noul', instructions: `Does \`${r}content\` (file \`${r}path\`, lines \`${r}lines\`) contain code or text that implements, defines or directly handles \`${r}query\`? Count code that is currently buggy.` } }) });
      }
      for (const [name, sub] of dir.dirs) {
        const p = dirPath ? `${dirPath}/${name}` : name;
        if (depth < 1) { next.push([p, sub, depth + 1]); continue; }
        entries.push({ kind: 'dir', dir: sub, path: p, depth,
          state: { query, folder: p, preview: preview(sub) },
          questions: (r) => ({ rel: { type: 'noul', instructions: `Could the folder \`${r}folder\`, judging by \`${r}preview\`, contain code or text that implements or directly handles \`${r}query\`?` } }) });
      }
    }
    const answers = await askAll(entries, flags, run);
    entries.forEach((e, i) => {
      const sc = answers[i].rel?.noul ?? 0;
      if (e.kind === 'dir') { if (sc > 0.5) next.push([e.path, e.dir, e.depth + 1]); return; }
      const prev = best.get(e.file.id);
      if (sc > 0.5 && (!prev || sc > prev.score)) best.set(e.file.id, { score: sc, start: e.chunk.start, end: e.chunk.end });
    });
    frontier = next;
  }
  const cands = [...best].sort((a, b) => b[1].score - a[1].score).slice(0, num(flags.top, 10))
    .map(([id, c]) => ({ id, score: c.score, text: items.find((it) => it.id === id).text }));
  const { out, json } = await describeCandidates(query, cands, flags, run);
  if (run.failed) process.stderr.write(`flash: ${run.failed} items got no answer after retries and were treated as not relevant.\n`);
  if (run.incomplete) process.stderr.write(`flash: stopped at --max-requests ${run.max}; results are partial. Raise it or narrow the root.\n`);
  audit = { query, inputs: [root], results: cands.map((c) => ({ id: c.id, role: c.role, p: +f2(c.score), picked: c.picked.map((u) => `${u.name}@${u.start}-${u.end}`) })) };
  const foot = footer(t0, items, [`${cands.length} relevant`, `${run.requests} requests`], run, out.join('\n'), skipped);
  emit(flags, json, out, foot);
}

async function cmdAsk({ pos, flags }) {
  const t0 = Date.now();
  let body;
  const first = pos[0];
  if (first && (first === '-' || first.endsWith('.json')) && !flags.state) {
    body = JSON.parse(first === '-' ? readStdin() : fs.readFileSync(first, 'utf8'));
  } else {
    const question = pos.join(' ');
    if (!question) die('usage: ask "<question>" --state @file|text|- [--choice "a,b" | --score "low|mid|high"]  or  ask spec.json', 2);
    const state = readStateArg(flags.state);
    if (state === undefined) die('ask needs --state (@file, literal text, or - for stdin)', 2);
    let q = { type: 'noul', instructions: question };
    if (flags.choice) q = { type: 'choice', instructions: question, criteria: parseLabels({ labels: flags.choice }) };
    if (flags.score) q = { type: 'score', instructions: question, criteria: String(flags.score).split('|').map((s) => s.trim()) };
    body = { state, questions: { answer: q } };
  }
  body.model ||= modelName(flags);
  if (!body.state || !body.questions) die('spec needs "state" and "questions"', 2);
  const res = await decide(body, flags);
  const lines = Object.entries(res.answers).map(([id, a]) => fmtAnswer(id, a));
  const stateText = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
  audit = { query: Object.values(body.questions).map((q) => (typeof q.instructions === 'string' ? q.instructions : JSON.stringify(q.instructions))).join(' | '),
    inputs: typeof flags.state === 'string' && flags.state.startsWith('@') ? [flags.state.slice(1)] : [], results: lines };
  const foot = footer(t0, [{ text: stateText }], [], { requests: 1, jevTokens: res.usage?.input_tokens || 0 }, lines.join('\n'), []);
  emit(flags, res, lines, foot.replace('1 scanned · ', ''));
}

async function promptHidden(q) {
  if (!process.stdin.isTTY) return readStdin().trim();
  process.stderr.write(q);
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData);
          process.stderr.write('\n'); return resolve(s.trim());
        }
        if (c === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { if (s.length) { s = s.slice(0, -1); process.stderr.write('\b \b'); } continue; }
        s += c; process.stderr.write('*');
      }
    });
  });
}

// Health check: one real decision with a known answer, the same way for every provider. It proves the
// key, the decision endpoint and the model at once. Returns { ok, status, detail }; never throws.
async function probe(p, key, model) {
  const redact = (t) => String(t).split(key).join('***');
  try {
    const res = await post(p, key, { model, state: { source: 'class Telemetry {\n  recordEvent(name) { this.events.push({ name, at: Date.now() }); }\n}' },
      questions: { probe: { type: 'noul', instructions: 'Does `source` implement recording an event?' } } }, 30_000);
    if (!res.ok) return { ok: false, status: res.status, detail: redact(clip(await res.text(), 200)) };
    const pYes = (await res.json()).answers?.probe?.noul;
    return pYes > 0.5 ? { ok: true, status: 200 } : { ok: false, status: 200, detail: `known-yes probe answered ${pYes}` };
  } catch (e) { return { ok: false, status: 0, detail: redact(e.message) }; }
}

async function cmdSetup({ pos, flags }) {
  const p = provider(flags);
  const cfg = readJson(CONFIG, {});
  if (flags.remove) {
    if (cfg.keys) delete cfg.keys[p.name];
    writeJson(CONFIG, cfg, 0o600);
    return console.log(`Removed saved ${p.name} key from ${CONFIG}`);
  }
  const key = (pos[0] || (await promptHidden(`Paste your ${p.name} API key (from ${p.keyUrl}): `))).trim();
  if (!key) die(`no key given. Get one at ${p.keyUrl}`, 2);
  const res = await probe(p, key, flags.model || p.model);
  if (res.status === 401 || res.status === 403) die(`that key was rejected by ${p.name} (${res.status}). Double-check it at ${p.keyUrl}`, 3);
  if (res.status === 0) die(`could not reach ${p.name}: ${res.detail}`, 5);
  if (!res.ok) die(`could not verify key: ${res.status === 200 ? res.detail : `HTTP ${res.status} ${res.detail}`}`, res.status === 200 ? 1 : 5);
  cfg.keys = { ...cfg.keys, [p.name]: key };
  cfg.provider = p.name;
  if (flags.model) cfg.models = { ...cfg.models, [p.name]: flags.model };
  writeJson(CONFIG, cfg, 0o600);
  console.log(`✓ ${p.name} key verified and saved to ${CONFIG}. Flash is ready (provider ${p.name}).`);
}

async function cmdStatus({ flags }) {
  const p = provider(flags);
  if (!p.key) die(`not configured for ${p.name} — get a key at ${p.keyUrl}, then run: node flash.mjs setup --provider ${p.name}`, 3);
  const model = modelName(flags);
  const res = await probe(p, p.key, model);
  if (res.status === 401 || res.status === 403) die(`key found (${p.keySource}) but rejected by ${p.name} (HTTP ${res.status}). Run setup with a fresh key from ${p.keyUrl}`, 3);
  if (res.status === 0) die(`key found (${p.keySource}) but ${p.name} is unreachable: ${res.detail}`, 5);
  if (!res.ok && res.status !== 200) die(`${p.name} answered HTTP ${res.status}: ${res.detail}`, 5);
  if (!res.ok) die(`${p.name} is reachable but Jev looks wrong: ${res.detail}. Check --model (${model})`, 1);
  console.log(`ready · provider ${p.name} · key from ${p.keySource} · model ${model} · decision check passed`);
  const rows = readHistory();
  if (rows.length) console.log(totalsLine(rows));
}

function readHistory() {
  try { return fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

// Sum rows per key: { key: { runs, items, jev_tokens, saved } }, largest savings first.
function groupBy(rows, key) {
  const g = {};
  for (const r of rows) {
    const t = (g[key(r)] ??= { runs: 0, items: 0, requests: 0, cached: 0, jev_tokens: 0, saved: 0 });
    t.runs += 1; t.items += r.items; t.requests += r.requests || 0; t.cached += r.cached || 0; t.jev_tokens += r.jev_tokens; t.saved += r.saved;
  }
  return Object.entries(g);
}

// Per project: whole-file Reads the hook blocked, and how many of them Claude followed with a flash run.
function guardStats(rows) {
  const followed = new Set(rows.map((r) => r.after_guard).filter(Boolean));
  const g = {};
  for (const r of rows.filter((x) => x.cmd === 'guard')) {
    const t = (g[r.project || '?'] ??= { blocked: 0, followed: 0 });
    t.blocked++; if (followed.has(r.ts)) t.followed++;
  }
  return Object.entries(g).sort((a, b) => b[1].blocked - a[1].blocked);
}

// Per project: `flash web` command calls vs direct Reads of a captured page.json (guard.mjs logs
// every such Read, blocked or ranged, as cmd "web-read"). Adoption metric for Task 11's gate.
function webStats(rows) {
  const g = {};
  for (const r of rows) {
    if (typeof r.cmd !== 'string' || !r.cmd.startsWith('web-')) continue;
    const t = (g[r.project || '?'] ??= { calls: 0, reads: 0 });
    if (r.cmd === 'web-read') t.reads++; else t.calls++;
  }
  return Object.entries(g).sort((a, b) => (b[1].calls + b[1].reads) - (a[1].calls + a[1].reads));
}

// One history row as a line: what was asked and where Jev pointed.
function describeRun(r) {
  if (r.cmd === 'guard') return `blocked whole Read of ${r.file}`;
  if (r.cmd === 'web-read') return `${r.blocked ? 'blocked whole' : 'allowed ranged'} Read of ${r.file}`;
  const top = (r.results || []).slice(0, 3).map((x) => (typeof x === 'string' ? x
    : `${x.id}${x.line ? ':' + x.line : ''}${x.label ? ' [' + x.label + ']' : ''}${x.picked?.length ? ' ' + x.picked[0] : ''} ${x.p ?? ''}`.trim()));
  return `${r.query ? JSON.stringify(clip(r.query, 70)) : ''}${top.length ? ' → ' + top.join(', ') : ''}${r.after_guard ? '  (after hook)' : ''}`;
}

function totalsLine(rows) {
  const [[, t]] = groupBy(rows, () => 'all');
  return `since ${rows[0].ts.slice(0, 10)}: ${t.runs} runs · ${fmtK(t.items)} items · jev ${fmtK(t.jev_tokens)} tok (${cost(t.jev_tokens)}) · ~${fmtK(t.saved)} Claude tokens not read` +
    (t.cached ? ` · ${Math.round((100 * t.cached) / t.requests)}% answered from cache` : '');
}

// Banner for `flash gain`: a bolt and FLASH in block letters. Colored only on a TTY without NO_COLOR.
const BOLT = ['    ▄▄▄▄', '   ███▀ ', '  ███   ', ' ██████▀', '   ▄██▀ ', '  ▄█▀   ', ' ▀▀     '];
const GLYPHS = {
  F: ['█████', '██   ', '████ ', '██   ', '██   '],
  L: ['██   ', '██   ', '██   ', '██   ', '█████'],
  A: [' ███ ', '██ ██', '█████', '██ ██', '██ ██'],
  S: [' ████', '██   ', ' ███ ', '   ██', '████ '],
  H: ['██ ██', '██ ██', '█████', '██ ██', '██ ██'],
};

function banner() {
  const tty = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const paint = (code) => (t) => (tty ? `\x1b[${code}m${t}\x1b[0m` : t);
  const gold = paint('38;5;179'), cream = paint('1;38;5;230'), dim = paint('38;5;245');
  const word = (r) => [...'FLASH'].map((c) => GLYPHS[c][r]).join('  ');
  const rows = BOLT.map((b, i) => `  ${gold(b)}   ${i >= 1 && i <= 5 ? cream(word(i - 1)) : ''}`.trimEnd());
  return [...rows, `  ${gold('────────── ◆ ──────────')}  ${dim('CLAUDE THINKS · JEV SKIMS')}`, ''].join('\n');
}

// Savings report as Markdown tables, for a README, a PR or a team update. Estimates from history.jsonl,
// not a quality benchmark: accuracy is measured in the repo's bench/.
function gainMarkdown(rows) {
  if (!rows.length) return '# Flash savings\n\nNo runs yet.';
  const [[, all]] = groupBy(rows, () => 'all');
  const table = (title, key, entries) => [`## ${title}`, '', `| ${key} | runs | items | Jev tokens | Jev cost | Claude tokens not read |`, '|---|---:|---:|---:|---:|---:|',
    ...entries.map(([k, t]) => `| ${k} | ${t.runs} | ${fmtK(t.items)} | ${fmtK(t.jev_tokens)} | ${cost(t.jev_tokens)} | ~${fmtK(t.saved)} |`), ''];
  const bySaved = (e) => e.sort((a, b) => b[1].saved - a[1].saved);
  return [`# Flash savings, ${rows[0].ts.slice(0, 10)} to ${rows.at(-1).ts.slice(0, 10)}`, '',
    `**~${fmtK(all.saved)} Claude tokens not read** across ${all.runs} runs and ${fmtK(all.items)} items, for ${cost(all.jev_tokens)} of Jev` +
      (all.cached ? ` (${((100 * all.cached) / all.requests).toFixed(1)}% of requests answered from cache).` : '.'), '',
    ...table('By command', 'command', bySaved(groupBy(rows, (r) => r.cmd || '?'))),
    ...table('By project', 'project', bySaved(groupBy(rows, (r) => r.project || '?'))),
    ...table('By day', 'day', groupBy(rows, (r) => r.ts.slice(0, 10)).sort()),
    ...(guardStats(rows).length ? ['## Read hook', '', '| project | whole-file Reads blocked | followed by a flash run |', '|---|---:|---:|',
      ...guardStats(rows).map(([k, t]) => `| ${k} | ${t.blocked} | ${t.followed} |`), ''] : []),
    ...(webStats(rows).length ? ['## flash web adoption', '', '| project | web calls | direct page.json reads |', '|---|---:|---:|',
      ...webStats(rows).map(([k, t]) => `| ${k} | ${t.calls} | ${t.reads} |`), ''] : []),
    '_Claude tokens not read = estimated size of the content Jev judged (chars ÷ 4) minus what Flash printed back._'].join('\n');
}

function cmdGain({ flags }) {
  const rows = readHistory();
  if (flags.json) return console.log(JSON.stringify({ history: rows }, null, 2));
  if (flags.md) return console.log(gainMarkdown(rows));
  if (!flags.plain && !flags.history) console.log(banner());
  if (!rows.length) return console.log('no runs yet');
  const line = (k, t) => `  ${k.padEnd(16)} ${String(t.runs).padStart(5)} runs  ${fmtK(t.items).padStart(7)} items  ` +
    `jev ${fmtK(t.jev_tokens).padStart(7)} (${cost(t.jev_tokens)})  saved ~${fmtK(t.saved)}`;
  if (flags.history) {
    const n = num(flags.history, 20);
    for (const r of rows.slice(-n)) console.log(`${r.ts.slice(0, 16).replace('T', ' ')}  ${(r.cmd || '').padEnd(8)} ${(r.project || '').padEnd(18)} ` +
      `${fmtK(r.items).padStart(6)} items  jev ${fmtK(r.jev_tokens).padStart(6)}  saved ~${fmtK(r.saved)}  ${r.provider || ''}\n      ${describeRun(r)}`);
    return;
  }
  console.log(`flash ${totalsLine(rows)}`);
  const show = (title, entries) => { console.log(`\n${title}`); for (const [k, t] of entries) console.log(line(k, t)); };
  const bySaved = (e) => e.sort((a, b) => b[1].saved - a[1].saved);
  show('by command', bySaved(groupBy(rows, (r) => r.cmd || '?')));
  show('by project', bySaved(groupBy(rows, (r) => r.project || '?')).slice(0, 10));
  show('last 7 days', groupBy(rows, (r) => r.ts.slice(0, 10)).sort().slice(-7));
  const hook = guardStats(rows);
  if (hook.length) {
    console.log('\nhook: whole-file Reads blocked, and how many Claude followed with flash within 2 min');
    for (const [k, t] of hook) console.log(`  ${k.padEnd(16)} ${String(t.blocked).padStart(5)} blocked  ${String(t.followed).padStart(5)} followed`);
  }
  const web = webStats(rows);
  if (web.length) {
    console.log('\nweb: flash web calls vs direct Reads of a captured page.json');
    for (const [k, t] of web) console.log(`  ${k.padEnd(16)} ${String(t.calls).padStart(5)} web calls  ${String(t.reads).padStart(5)} direct reads`);
  }
}

const CMD_HELP = {
  filter: `flash filter "<yes/no question>" <inputs> [--threshold 0.5] [--lines] [--fast]
Keep only the items where Jev answers yes. Items between 0.35 and 0.65 are listed as borderline.
  flash filter "Does this file handle authentication?" src
  flash filter "Does this line report a failure?" app.log --lines`,
  classify: `flash classify --labels "a,b,c" <inputs> [--question "..."] [--only a] [--min-confidence 0.6] [--verbose]
Put each item in exactly one label. Labels can carry descriptions: --labels "bug:Something broken,feature:New behaviour"
or --labels-json '{"bug":"Something broken"}'. Add a catch-all label such as "other" when nothing may fit.
  flash classify --labels "bug,feature,question" --items tickets.jsonl`,
  rank: `flash rank "<query>" <inputs> [--top 10 | --all]
Order items by relevance to the query, best first.
  flash rank "retry logic for HTTP calls" src --top 5`,
  find: `flash find "<what you're looking for>" <files> [--top 5] [--chunk 150] [--context [N]] [--max-source-bytes 20000]
Locate the lines in large files that match a description. --context adds the source around each hit
(N lines each side, default 3, widened to the comment above it; nearby hits merge) so no follow-up Read is needed.
  flash find "where the session token is refreshed" src/auth.ts --context`,
  search: `flash search "<what you're looking for>" [root] [--top 10] [--max-requests 1000] [--fast] [--no-source]
Find the files in a repo that matter for a question, without reading the rest. Walks folder by folder:
first-level folders are always opened, deeper ones only when Jev says their contents could match;
files are judged in 12 KB chunks. The top files are then split into functions and classes; each is
judged on its own and the selected ones print as source. Files are ordered by role (implementation,
caller, helper, test, fixture).
  flash search "how are webhook signatures verified?" src`,
  ask: `flash ask "<question>" --state @file|"text"|- [--choice "a,b,c" | --score "low|mid|high"]
flash ask spec.json     raw {"state": ..., "questions": {"id": {"type": "noul|choice|score", ...}}}
One judgment over one document; the default answer is a yes/no probability.
  flash ask "Does this contract allow termination without notice?" --state @contract.txt`,
  setup: `flash setup [--provider typesafe|openrouter] [--remove]
Verify a key, save it to ~/.flash/config.json (mode 0600) and make that provider the default.
Reads the key from a hidden prompt, or from stdin when piped. Avoid passing it as an argument.
  printenv OPENROUTER_API_KEY | flash setup --provider openrouter`,
  status: `flash status [--provider P]
Check that the key works and show lifetime savings. Exit 3 means the key is missing or rejected.`,
  gain: `flash gain [--history [N]] [--plain] [--json] [--md]
Tokens saved by command, project and day, read from ~/.flash/history.jsonl. Reads the hook blocked count as "guard".
--history lists the last N runs with what was asked and where Jev pointed, --plain drops the banner,
--json prints the raw history (query, inputs, result ids/lines/scores; never file content),
--md prints a Markdown report: flash gain --md > flash-savings.md`,
  web: `flash web <snapshot|pick|check|click|run> [--session NAME]
Drive a browser through an adapter (agent-browser today) so Claude never reads the raw page.
  snapshot            capture the current page to ~/.flash/web/<session>/page.json, one summary line
  pick "<intent>"     choose the one element that best satisfies intent; never acts
  check "<question>"  yes/no judgement over the page's url, title and visible text
  click "<intent>"    pick, verify it's still there and not risky, click it, report what changed
  run "<goal>"        a click/type loop toward goal, up to --max-steps (default 8)
  run --resume ID     continue a run paused on a text field (value from stdin)
Pick prints the top choice with its probability, up to two runner-ups, and either the exact driver
command to act on it or "? unsure: read <page.json> lines a-b" when confidence is low (top p < 0.85
or margin to the runner-up < 0.2, tuned in Task 7b) — read exactly those lines yourself rather than the whole file.
Check prints "0.93 yes" (or "no"), labelled "? borderline" within --band of --threshold (defaults
0.5/0.15, same as filter).
Click snapshots itself, picks, re-snapshots to check the chosen element hasn't gone stale (its own
role/name/enclosing text unchanged — unrelated page churn is ignored), runs a separate risky-action
check (a keyword/role backstop plus a Jev noul), then clicks and re-snapshots once more to report
what changed: "clicked @e852 link \"…\" · page changed: url|title|elements". Unsure, stale or risky
stops before acting and never retries. Prints each step's own wall time.
Run repeats click's own choose/verify/act loop toward a goal (not a single intent), asking each step
"click, type, is the goal already done, or are you stuck" in the same request as which element to
act on, so a decision never costs a second round-trip. It stops and prints why on: done, stuck,
? unsure, a stale or risky target, a failed act, --max-steps, or 3 steps in a row with no page
change. Never retries a mutating act.
When the next step is typing, Jev never writes the text itself — it only names the field. Run
pauses and prints "needs input: @e5 textbox \"Origin\" · resume: echo \"<text>\" | flash web run
--resume <id>" (or "needs secret input" for a password field, which never echoes its name either).
Pipe the value in rather than passing it as an argument: echo "Paris" | flash web run --resume abc12.
--resume re-verifies the field is still the same one before typing (a changed field is re-picked
from scratch, never typed into blind), then continues the loop. Resume state lives 1h in
~/.flash/web/runs/<id>.json (0600), is deleted once used, and expired files are swept automatically.
Every call uses an isolated browser session, flash-<session> (default: this git project's name),
never agent-browser's shared default session. Needs agent-browser on PATH, or FLASH_AGENT_BROWSER
set to a command that runs it (e.g. "npx -y agent-browser").`,
  cache: `flash cache [clear]
Show or delete the answer cache in ~/.flash/cache. Repeat runs over unchanged content are answered from it
for free; edited content misses automatically. Answers only are stored, never content. Skip it per run with --no-cache.`,
  skill: `flash skill
Print the agent instructions (SKILL.md) with this install's paths filled in.`,
};

const HELP = `flash — hand Claude's bulk judgment calls to Jev, read only what survives

Examples:
  flash filter "Does this file handle authentication?" src
  flash filter "Does this line report a failure?" app.log --lines
  flash find "where the session token is refreshed" src/auth.ts --context
  flash search "how are webhook signatures verified?" src
  flash classify --labels "bug,feature,question" --items tickets.jsonl

Commands:
  filter    keep only items where the answer to a yes/no question is yes
  classify  put each item in one label
  rank      order items by relevance to a query
  find      locate the matching lines inside large files
  search    find the relevant files in a repo, folder by folder, with their source
  ask       one judgment over one document, or a raw spec.json request
  web       drive a browser through an adapter (snapshot/pick/check/click/run)
  setup     save and verify a key, pick the default provider
  status    check the key, show lifetime savings
  gain      savings by command, project and day
  cache     show or clear the answer cache
  skill     print the agent instructions (SKILL.md)
Run "flash help <command>" or "flash <command> --help" for flags and examples.

Inputs: files, directories (respects .gitignore), globs, - for stdin, --items FILE.jsonl
Common flags:
  --lines            judge each line separately (logs, CSVs, lists)
  --ext ts,tsx       only these file types
  --json             machine-readable output on stdout
  --save FILE        write every per-item result to FILE
  --no-cache         always ask Jev, ignore cached answers (kept 7 days)
  --fast             pack small items per request: about 10x faster, less accurate
  --provider P       typesafe or openrouter (default: FLASH_PROVIDER, then the saved choice, then whichever has a key)
  --model M          override the provider's default model
  --concurrency 16 --max-chars 60000 --limit 5000 --threshold 0.5
Output: results on stdout; the summary footer, skipped files and errors on stderr.
Environment: FLASH_PROVIDER, FLASH_HOME (default ~/.flash), JEV_API_KEY / TYPESAFE_API_KEY, OPENROUTER_API_KEY
Exit codes: 0 ok · 1 error · 2 bad usage · 3 key missing or rejected · 4 Jev rejected the request · 5 network or unexpected error
Issues: https://github.com/azamma/flash/issues`;

function cmdCache({ pos }) {
  if (pos[0] === 'clear') {
    if (!fs.existsSync(CACHE)) return console.log('cache already empty');
    fs.rmSync(CACHE, { recursive: true, force: true });
    return console.log(`cleared ${CACHE}`);
  }
  if (pos[0]) die(`unknown cache action "${pos[0]}". Use: flash cache [clear]`, 2);
  let n = 0, bytes = 0;
  try { for (const f of fs.readdirSync(CACHE)) { n++; bytes += fs.statSync(path.join(CACHE, f)).size; } } catch {}
  console.log(`${n} cached answers · ${fmtK(bytes)}B in ${CACHE} · entries expire after 7 days`);
}

// ---------- web: drive a browser through an adapter, Jev makes the bulk decisions ----------

const WEB_DRIVERS = { 'agent-browser': agentBrowser };

// One driver today; a new one is one more entry here, commands never branch on it (plan.md).
function webDriver() {
  return WEB_DRIVERS['agent-browser'];
}

function requireDriver() {
  const driver = webDriver();
  const avail = driver.available();
  if (avail !== true) die(avail, 3);
  return driver;
}

function writePageFile(file, page) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(page, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

async function cmdWebSnapshot({ flags }) {
  const driver = requireDriver();
  const session = sessionName(flags);
  const t0 = Date.now();
  const r = driver.snapshot(session);
  if (!r.ok) die(`flash web snapshot failed: ${r.error}`, 5);
  writePageFile(pageFile(session), r.page);
  console.log(`snapshot saved: ${pageFile(session)} · ${r.page.url} · "${r.page.title}" · ${r.page.refs.length} elements`);
  logRow({ ts: new Date().toISOString(), cmd: 'web-snapshot', project: projectName(process.cwd()), session,
    items: r.page.refs.length, requests: 0, jev_tokens: 0, saved: 0, ms: Date.now() - t0 });
}

function loadPage(flags) {
  const session = sessionName(flags);
  const file = pageFile(session);
  const page = readJson(file, null);
  if (!page) die(`no snapshot for this session yet. Run: flash web snapshot --session ${session.replace(/^flash-/, '')}`, 2);
  return { session, file, page };
}

// Footer + history row shared by pick/check: no "items scanned"/skipped concept (that's the
// batch-judgment commands), just time, Jev cost and one step-per-call history row.
function webFooter(t0, cmd, session, page, stats, outText) {
  const saved = Math.max(0, estTokens(JSON.stringify(page)) - estTokens(outText));
  logRow({ ts: new Date().toISOString(), cmd, project: projectName(process.cwd()), session, provider: provider().name,
    items: page.refs.length, requests: stats.requests, jev_tokens: stats.jevTokens, saved, ...audit });
  return `— ${((Date.now() - t0) / 1000).toFixed(1)}s · jev ${fmtK(stats.jevTokens)} tok (${cost(stats.jevTokens)}) · ~${fmtK(saved)} Claude tokens not read`;
}

const PICK_CHUNK = 150;

// Shared by pick, click and run: ranks `page.refs` (+`none`) by how well they satisfy `intent`,
// chunking above PICK_CHUNK refs (`find`'s merge pattern: per-chunk choice + `exists` noul, scaled
// and merged). Returns { ranked, real, stats }: `ranked` is [[ref|'none', p], ...] sorted desc
// (only the unchunked path can return 'none' inside it — the chunked path already drops it, same
// asymmetry as before this was factored out); `real` is `ranked` with 'none' filtered out.
async function pickRanked(page, intent, flags) {
  const model = modelName(flags);
  const stats = { requests: 0, jevTokens: 0 };
  let ranked;
  if (page.refs.length <= PICK_CHUNK) {
    const body = { model, state: { intent }, questions: { pick: {
      type: 'choice',
      instructions: { question: 'Choose the single element that best satisfies `intent`. Choose `none` if nothing on the page matches.', untrusted: UNTRUSTED_NOTE },
      criteria: pickCriteria(page.refs),
    } } };
    const res = await decide(body, flags);
    stats.requests = 1; stats.jevTokens = res.usage?.input_tokens || 0;
    ranked = Object.entries(res.answers.pick.probabilities).sort((a, b) => b[1] - a[1]);
  } else {
    const chunks = [];
    for (let i = 0; i < page.refs.length; i += PICK_CHUNK) chunks.push(page.refs.slice(i, i + PICK_CHUNK));
    const perChunk = await pool(chunks.map((chunk) => async () => {
      const body = { model, state: { intent }, questions: {
        pick: { type: 'choice', instructions: { question: 'Choose the single element that best satisfies `intent`. Choose `none` if nothing among these matches.', untrusted: UNTRUSTED_NOTE }, criteria: pickCriteria(chunk) },
        exists: { type: 'noul', instructions: { question: 'Does any element among these choices satisfy `intent`?', untrusted: UNTRUSTED_NOTE } },
      } };
      const res = await decide(body, flags);
      stats.requests++; stats.jevTokens += res.usage?.input_tokens || 0;
      const ex = res.answers.exists.noul;
      return Object.entries(res.answers.pick.probabilities).filter(([id]) => id !== 'none').map(([id, p]) => [id, p * ex]);
    }), num(flags.concurrency, 16));
    ranked = perChunk.flat().sort((a, b) => b[1] - a[1]);
  }
  return { ranked, real: ranked.filter(([id]) => id !== 'none'), stats };
}

async function cmdWebPick({ pos, flags }) {
  const intent = pos.shift();
  if (!intent) die('usage: flash web pick "<intent>" [--session NAME]', 2);
  const { session, file, page } = loadPage(flags);
  const t0 = Date.now();
  const { ranked, real, stats } = await pickRanked(page, intent, flags);
  const byRef = Object.fromEntries(page.refs.map((r) => [r.ref, r]));
  const lines = [];
  const match = !!real.length && ranked[0][0] !== 'none';
  let command = null, unsure = false;
  if (!match) {
    lines.push(`(no element on the page matches "${clip(intent, 80)}")`);
  } else {
    const [topId, topP] = real[0];
    lines.push(`${f2(topP)}  ${topId}  ${refLabel(byRef[topId])}`);
    for (const [id, p] of real.slice(1, 3)) lines.push(`  runner-up ${f2(p)}  ${id}  ${refLabel(byRef[id])}`);
    const p1 = ranked[0][1], p2 = ranked[1]?.[1] ?? 0;
    unsure = p1 < UNSURE_P1 || p1 - p2 < UNSURE_MARGIN;
    if (unsure) {
      const span = refLineSpan(fs.readFileSync(file, 'utf8'), topId);
      lines.push(`? unsure: read ${file}${span ? ` lines ${span[0]}-${span[1]}` : ''}`);
    } else {
      command = `${agentBrowser.name} --session ${session} click @${topId}`;
      lines.push(command);
    }
  }
  audit = { query: intent, session, results: real.slice(0, 3).map(([id, p]) => ({ id, p: +f2(p) })) };
  const foot = webFooter(t0, 'web-pick', session, page, stats, lines.join('\n'));
  emit(flags, { intent, match, top: real.slice(0, 3).map(([id, p]) => ({ ref: id, p, ...byRef[id] })), unsure, command }, lines, foot);
}

async function cmdWebCheck({ pos, flags }) {
  const question = pos.shift();
  if (!question) die('usage: flash web check "<yes/no question>" [--session NAME]', 2);
  const { session, page } = loadPage(flags);
  const t0 = Date.now(), model = modelName(flags);
  const thr = num(flags.threshold, 0.5), band = num(flags.band, 0.15);
  const body = { model, state: { question, url: page.url, title: page.title, text: page.text },
    questions: { check: { type: 'noul', instructions: { context: 'Answer `question`, judging only by `url`, `title` and `text`.', untrusted: UNTRUSTED_NOTE } } } };
  const res = await decide(body, flags);
  const stats = { requests: 1, jevTokens: res.usage?.input_tokens || 0 };
  const p = res.answers.check.noul;
  const answer = p >= thr ? 'yes' : 'no';
  const borderline = Math.abs(p - thr) < band;
  const line = `${f2(p)} ${answer}${borderline ? `  ? borderline (${f2(thr - band)}-${f2(thr + band)})` : ''}`;
  audit = { query: question, session, results: [{ p: +f2(p) }] };
  const foot = webFooter(t0, 'web-check', session, page, stats, line);
  emit(flags, { question, p, answer, borderline }, [line], foot);
}

// Per-step wall time, shared by click and run (the whole point of both is speed — plan.md): every
// driver/Jev call is timed and reported, not just the total. Returns { steps, time(name, fn) }.
function stepper() {
  const steps = [];
  return { steps, time: async (name, fn) => { const s = Date.now(); const r = await fn(); steps.push([name, Date.now() - s]); return r; } };
}

const stepsLine = (steps) => steps.map(([n, ms]) => `${n} ${ms}ms`).join(' · ');

// Per-element freshness (plan.md): before any act, the target ref must still exist in the fresh
// snapshot with the same role, name and enclosing container text. Unrelated churn elsewhere on the
// page (an ad, a counter, a timestamp) never aborts — only a changed ref, or its own context, does.
function freshRef(before, after) {
  if (!after || after.role !== before.role || after.name !== before.name || after.context !== before.context) return null;
  return after;
}

// Builds the injected `ask` for web.mjs's risky(): a separate noul call about the one chosen target,
// never the fan-out that picked it (plan.md). Carries the untrusted-data note; judges only `target`.
function riskyAsk(flags, stats) {
  return async (page, ref) => {
    const body = { model: modelName(flags), state: { url: page.url, title: page.title,
      target: { element: ref.name || ref.role, role: ref.role, value: ref.value, context: ref.context } },
      questions: { risky: { type: 'noul', instructions: { question:
        'Would acting on `target` (clicking it, or submitting whatever value it already holds) perform a ' +
        'mutating, committing or hard-to-undo action — a purchase, payment, deletion, sending, posting, ' +
        'publishing, subscribing/unsubscribing, signing or accepting terms? Judge only `target`, not the rest of the page.',
        untrusted: UNTRUSTED_NOTE } } } };
    const res = await decide(body, flags);
    stats.requests++; stats.jevTokens += res.usage?.input_tokens || 0;
    return res.answers.risky.noul;
  };
}

// Shared by click and run: snapshots and persists page.json, dying with the command's own name on
// a driver failure.
function webSnap(driver, session, file, cmd) {
  return async () => {
    const r = driver.snapshot(session);
    if (!r.ok) die(`flash web ${cmd} failed: ${r.error}`, 5);
    writePageFile(file, r.page);
    return r.page;
  };
}

async function cmdWebClick({ pos, flags }) {
  const intent = pos.shift();
  if (!intent) die('usage: flash web click "<intent>" [--session NAME]', 2);
  const driver = requireDriver();
  const session = sessionName(flags);
  const file = pageFile(session);
  const t0 = Date.now();
  const stats = { requests: 0, jevTokens: 0 };
  const { steps, time } = stepper();
  const snap = webSnap(driver, session, file, 'click');

  const finish = (line, extra) => {
    audit = { query: intent, session };
    logRow({ ts: new Date().toISOString(), cmd: 'web-click', project: projectName(process.cwd()), session, provider: provider().name,
      requests: stats.requests, jev_tokens: stats.jevTokens, saved: 0, steps, ms: Date.now() - t0, ...extra, ...audit });
    const foot = `— ${stepsLine(steps)} · ${((Date.now() - t0) / 1000).toFixed(1)}s · jev ${fmtK(stats.jevTokens)} tok (${cost(stats.jevTokens)})`;
    emit(flags, { intent, session, steps: steps.map(([n, ms]) => ({ step: n, ms })), ...extra }, [line], foot);
  };

  const page1 = await time('snapshot', snap);
  const { ranked, real, stats: pickStats } = await time('pick', () => pickRanked(page1, intent, flags));
  stats.requests += pickStats.requests; stats.jevTokens += pickStats.jevTokens;

  const byRef1 = Object.fromEntries(page1.refs.map((r) => [r.ref, r]));
  const match = !!real.length && ranked[0][0] !== 'none';
  if (!match) return finish(`(no element on the page matches "${clip(intent, 80)}")`, { acted: false, stop: 'no-match' });

  const [topId, topP] = real[0];
  const p2 = ranked[1]?.[1] ?? 0;
  if (topP < UNSURE_P1 || topP - p2 < UNSURE_MARGIN) {
    const span = refLineSpan(fs.readFileSync(file, 'utf8'), topId);
    return finish(`? unsure: read ${file}${span ? ` lines ${span[0]}-${span[1]}` : ''}`, { acted: false, stop: 'unsure', ref: topId });
  }

  const target = byRef1[topId];
  const page2 = await time('freshness-snapshot', snap);
  const fresh = freshRef(target, page2.refs.find((r) => r.ref === topId));
  if (!fresh) return finish(`stale: @${topId} ${refLabel(target)} changed before acting — re-run pick`, { acted: false, stop: 'stale', ref: topId });

  const risk = await time('risky-check', () => risky(page2, fresh, riskyAsk(flags, stats)));
  if (risk.risky) return finish(`risky: stopped before clicking @${topId} ${refLabel(fresh)} (${risk.reason})`, { acted: false, stop: 'risky', ref: topId });

  const act = await time('act', async () => driver.act(session, { kind: 'click', ref: topId }));
  if (!act.ok) return finish(`click failed: ${act.error}`, { acted: false, stop: 'act-failed', ref: topId });

  const page3 = await time('post-act-snapshot', snap);
  const changed = [];
  if (page3.url !== page2.url) changed.push('url');
  if (page3.title !== page2.title) changed.push('title');
  if (page3.refs.length !== page2.refs.length) changed.push('elements');
  finish(`clicked @${topId} ${refLabel(fresh)} · page changed: ${changed.join('|') || 'none'}`, { acted: true, ref: topId, changed });
}

const MAX_STEPS_DEFAULT = 8;
const NO_CHANGE_LIMIT = 3;

// One `run` step's fan-out (plan.md's speculative pattern): `operation` (click|type|done|stuck) and
// `target` (which ref to act on, if any) are asked in the SAME request whenever the page fits in one
// chunk, so a decision never costs a second round-trip. Above PICK_CHUNK refs, target ranking reuses
// pickRanked's own chunked merge (one extra small request for `operation` alone — it doesn't need
// chunking). Jev is never asked for the text itself (plan.md: Jev never writes text) — only which
// field to type into; the value comes from `--resume`'s stdin (Task 11).
async function runStep(page, goal, flags) {
  const model = modelName(flags);
  const stats = { requests: 0, jevTokens: 0 };
  const operationQ = { type: 'choice',
    instructions: { question: 'Choose the next step toward `goal` on this page: `click` an element that makes progress, `type` to enter text into a field (do not invent the text, only choose the field), `done` if the goal is already achieved here, or `stuck` if nothing on this page can make progress.', untrusted: UNTRUSTED_NOTE },
    criteria: { click: 'Click an element that makes progress toward the goal.', type: 'Enter text into a field to make progress toward the goal.',
      done: 'The goal is already achieved on this page.', stuck: 'Nothing on this page can make progress toward the goal.' } };
  if (page.refs.length <= PICK_CHUNK) {
    const body = { model, state: { goal }, questions: { operation: operationQ,
      target: { type: 'choice', instructions: { question: 'If the operation is `click` or `type`, the single element to act on. Choose `none` otherwise.', untrusted: UNTRUSTED_NOTE }, criteria: pickCriteria(page.refs) } } };
    const res = await decide(body, flags);
    stats.requests = 1; stats.jevTokens = res.usage?.input_tokens || 0;
    const ranked = Object.entries(res.answers.target.probabilities).sort((a, b) => b[1] - a[1]);
    return { operation: res.answers.operation.choice, ranked, real: ranked.filter(([id]) => id !== 'none'), stats };
  }
  const opRes = await decide({ model, state: { goal }, questions: { operation: operationQ } }, flags);
  stats.requests++; stats.jevTokens += opRes.usage?.input_tokens || 0;
  const { ranked, real, stats: pickStats } = await pickRanked(page, goal, flags);
  stats.requests += pickStats.requests; stats.jevTokens += pickStats.jevTokens;
  return { operation: opRes.answers.operation.choice, ranked, real, stats };
}

const runFooter = (ctx) => `— ${stepsLine(ctx.steps)} · ${((Date.now() - ctx.t0) / 1000).toFixed(1)}s · jev ${fmtK(ctx.stats.jevTokens)} tok (${cost(ctx.stats.jevTokens)})`;

function finishRun(ctx, log, acted, reason) {
  audit = { query: ctx.goal, session: ctx.session };
  logRow({ ts: new Date().toISOString(), cmd: 'web-run', project: projectName(process.cwd()), session: ctx.session, provider: provider().name,
    requests: ctx.stats.requests, jev_tokens: ctx.stats.jevTokens, saved: 0, steps: acted, stop: reason, ms: Date.now() - ctx.t0, ...audit });
  emit(ctx.flags, { goal: ctx.goal, session: ctx.session, stop: reason, acted, log }, [...log, `stopped: ${reason}`], runFooter(ctx));
}

// Pauses on `type`: saves just enough to re-verify freshness and resume the loop from this exact
// step (Task 11) — never the typed value, which doesn't exist yet. Password fields never echo their
// name either, only the generic "needs secret input".
function pauseRun(ctx, log, acted, noChangeStreak, i, topId, target) {
  const id = saveRunState({ goal: ctx.goal, session: ctx.session, maxSteps: ctx.maxSteps, acted, noChangeStreak, log, i,
    ref: topId, role: target.role, name: target.name, context: target.context });
  audit = { query: ctx.goal, session: ctx.session };
  logRow({ ts: new Date().toISOString(), cmd: 'web-run', project: projectName(process.cwd()), session: ctx.session, provider: provider().name,
    requests: ctx.stats.requests, jev_tokens: ctx.stats.jevTokens, saved: 0, steps: acted, stop: 'needs-input', ms: Date.now() - ctx.t0, ...audit });
  const secret = target.role === 'password';
  const line = secret ? `needs secret input · resume: echo "<secret>" | flash web run --resume ${id}`
    : `needs input: @${topId} ${refLabel(target)} · resume: echo "<text>" | flash web run --resume ${id}`;
  log.push(`${i}. ${line}`);
  emit(ctx.flags, { goal: ctx.goal, session: ctx.session, stop: 'needs-input', ref: topId, secret, resumeId: id, acted, log }, [...log], runFooter(ctx));
}

// The loop proper, entered fresh (i=1) or from --resume (i = the paused step, possibly redone).
async function runLoop(ctx, { page, i, acted, noChangeStreak, log }) {
  for (; i <= ctx.maxSteps; i++) {
    const r = await ctx.time('run-step', () => runStep(page, ctx.goal, ctx.flags));
    ctx.stats.requests += r.stats.requests; ctx.stats.jevTokens += r.stats.jevTokens;

    if (r.operation === 'done') { log.push(`${i}. done`); return finishRun(ctx, log, acted, 'done'); }
    if (r.operation === 'stuck') { log.push(`${i}. stuck`); return finishRun(ctx, log, acted, 'stuck'); }

    const match = !!r.real.length && r.ranked[0][0] !== 'none';
    if (!match) { log.push(`${i}. ${r.operation}: no element matches the goal`); return finishRun(ctx, log, acted, 'no-match'); }
    const [topId, topP] = r.real[0];
    const p2 = r.ranked[1]?.[1] ?? 0;
    if (topP < UNSURE_P1 || topP - p2 < UNSURE_MARGIN) { log.push(`${i}. ? unsure @${topId}`); return finishRun(ctx, log, acted, 'unsure'); }

    const target = page.refs.find((x) => x.ref === topId);
    const page2 = await ctx.time('freshness-snapshot', ctx.snap);
    const fresh = freshRef(target, page2.refs.find((x) => x.ref === topId));
    if (!fresh) { log.push(`${i}. stale @${topId}`); return finishRun(ctx, log, acted, 'stale'); }

    if (r.operation === 'type') return pauseRun(ctx, log, acted, noChangeStreak, i, topId, fresh);

    const risk = await ctx.time('risky-check', () => risky(page2, fresh, riskyAsk(ctx.flags, ctx.stats)));
    if (risk.risky) { log.push(`${i}. risky @${topId} ${refLabel(fresh)} (${risk.reason})`); return finishRun(ctx, log, acted, 'risky'); }

    const act = await ctx.time('act', async () => ctx.driver.act(ctx.session, { kind: 'click', ref: topId }));
    if (!act.ok) { log.push(`${i}. click failed: ${act.error}`); return finishRun(ctx, log, acted, 'act-failed'); }

    const page3 = await ctx.time('post-act-snapshot', ctx.snap);
    const changed = page3.url !== page2.url || page3.title !== page2.title || page3.refs.length !== page2.refs.length;
    noChangeStreak = changed ? 0 : noChangeStreak + 1;
    acted++;
    log.push(`${i}. clicked @${topId} ${refLabel(fresh)} · page changed: ${changed ? 'yes' : 'no'}`);
    if (noChangeStreak >= NO_CHANGE_LIMIT) return finishRun(ctx, log, acted, 'no-change');
    page = page3; // reuse the post-act snapshot as the next step's starting page — no redundant re-snapshot
  }
  finishRun(ctx, log, acted, 'max-steps');
}

function runCtx(flags, goal, session, maxSteps, driver, file, cmdName) {
  const snap = webSnap(driver, session, file, cmdName);
  const { steps, time } = stepper();
  return { goal, session, file, driver, snap, time, steps, stats: { requests: 0, jevTokens: 0 }, maxSteps, t0: Date.now(), flags };
}

async function cmdWebRun({ pos, flags }) {
  cleanupExpiredRuns(); // "expires after 1h, expired files removed on the next run" (plan.md) -- every run, not just ones that pause
  if (flags.resume) return resumeWebRun(String(flags.resume), flags);
  const goal = pos.shift();
  if (!goal) die('usage: flash web run "<goal>" [--session NAME] [--max-steps 8] | flash web run --resume ID', 2);
  const driver = requireDriver();
  const session = sessionName(flags);
  const ctx = runCtx(flags, goal, session, num(flags['max-steps'], MAX_STEPS_DEFAULT), driver, pageFile(session), 'run');
  const page = await ctx.time('snapshot', ctx.snap);
  await runLoop(ctx, { page, i: 1, acted: 0, noChangeStreak: 0, log: [] });
}

// `--resume`: re-verifies the paused target is still fresh before typing anything (plan.md: "resume
// on a changed field re-picks instead of typing blind"). The value is read from stdin by default
// (`--value -`), never from argv, so it never lands in shell history; `--value <text>` is available
// for scripts/tests that accept that trade-off.
async function resumeWebRun(id, flags) {
  const st = loadRunState(id);
  if (!st) die(`no pending run "${id}" — it never existed, was already resumed, or expired after 1h. Start over: flash web run "<goal>"`, 2);
  const driver = requireDriver();
  const ctx = runCtx(flags, st.goal, st.session, st.maxSteps, driver, pageFile(st.session), 'run');
  const page = await ctx.time('snapshot', ctx.snap);
  const fresh = freshRef({ role: st.role, name: st.name, context: st.context }, page.refs.find((x) => x.ref === st.ref));

  if (!fresh) return runLoop(ctx, { page, i: st.i, acted: st.acted, noChangeStreak: st.noChangeStreak, log: st.log });

  // `echo "text" | ...` (the resume hint's own example) adds exactly one trailing newline; stripping
  // it once is the shell's own `$(...)` convention, not Jev or Flash inventing anything — everything
  // else in stdin is typed byte-for-byte.
  const value = flags.value && flags.value !== '-' ? String(flags.value) : readStdin().replace(/\r?\n$/, '');
  const act = await ctx.time('act', async () => driver.act(st.session, { kind: 'fill', ref: st.ref, value }));
  const log = [...st.log];
  if (!act.ok) { log.push(`${st.i}. type failed: ${act.error}`); return finishRun(ctx, log, st.acted, 'act-failed'); }

  const page2 = await ctx.time('post-act-snapshot', ctx.snap);
  const changed = page2.url !== page.url || page2.title !== page.title || page2.refs.length !== page.refs.length;
  const noChangeStreak = changed ? 0 : st.noChangeStreak + 1;
  const acted = st.acted + 1;
  log.push(`${st.i}. typed @${st.ref} ${refLabel(fresh)} · page changed: ${changed ? 'yes' : 'no'}`);
  if (noChangeStreak >= NO_CHANGE_LIMIT) return finishRun(ctx, log, acted, 'no-change');
  return runLoop(ctx, { page: page2, i: st.i + 1, acted, noChangeStreak, log });
}

async function cmdWeb({ pos, flags }) {
  const sub = pos.shift();
  if (sub === 'snapshot') return cmdWebSnapshot({ pos, flags });
  if (sub === 'pick') return cmdWebPick({ pos, flags });
  if (sub === 'check') return cmdWebCheck({ pos, flags });
  if (sub === 'click') return cmdWebClick({ pos, flags });
  if (sub === 'run') return cmdWebRun({ pos, flags });
  die(`unknown "flash web ${sub || ''}". Use: flash web snapshot|pick|check|click|run`, 2);
}

function cmdSkill() {
  const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n+/, '');
  process.stdout.write(md.replaceAll('<base directory of this skill>', dir));
}

// Levenshtein distance, only for "did you mean" on typos.
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] !== b[j - 1]));
  return d[a.length][b.length];
}

const COMMANDS = { setup: cmdSetup, status: cmdStatus, gain: cmdGain, filter: cmdFilter, classify: cmdClassify, rank: cmdRank, find: cmdFind, ask: cmdAsk, search: cmdSearch, web: cmdWeb, skill: cmdSkill, cache: cmdCache };

process.on('unhandledRejection', (e) => die(`unexpected error: ${e?.stack || e}`, 5));
process.on('uncaughtException', (e) => die(`unexpected error: ${e?.stack || e}`, 5));

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); process.exit(0); }
if (cmd === 'help') {
  if (!rest[0]) { console.log(HELP); process.exit(0); }
  if (!CMD_HELP[rest[0]]) die(`no help for "${rest[0]}". Commands: ${Object.keys(COMMANDS).join(', ')}`, 2);
  console.log(CMD_HELP[rest[0]]); process.exit(0);
}
if (!COMMANDS[cmd]) {
  const near = Object.keys(COMMANDS).find((c) => distance(c, cmd) <= 2);
  die(`unknown command "${cmd}".${near ? ` Did you mean "${near}"?` : ''} Run "flash --help" for the list.`, 2);
}
if (rest.includes('--help') || rest.includes('-h')) { console.log(CMD_HELP[cmd]); process.exit(0); }
await COMMANDS[cmd](parseArgs(rest));
