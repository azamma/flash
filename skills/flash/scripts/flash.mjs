#!/usr/bin/env node
// Flash: hand Claude's bulk judgment calls to Jev (TypeSafe System One).
// Zero dependencies. Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.FLASH_HOME || path.join(os.homedir(), '.flash');
const CONFIG = path.join(HOME, 'config.json');
const HISTORY = path.join(HOME, 'history.jsonl');
const CACHE = path.join(HOME, 'cache');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
// Jev is served by TypeSafe directly and by OpenRouter's Decisions endpoint; same request/answer shape.
const PROVIDERS = {
  typesafe: { base: 'https://api.typesafe.ai', decide: '/v1/systemone', check: '/v1/models', model: 'jev-latest',
    keyUrl: 'https://console.typesafe.ai', env: ['JEV_API_KEY', 'TYPESAFE_API_KEY'] },
  openrouter: { base: 'https://openrouter.ai/api', decide: '/alpha/decisions', check: '/v1/key', model: 'typesafe/jev-1.13',
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
  const bools = new Set(['lines', 'json', 'all', 'remove', 'help', 'fast', 'verbose', 'no-collapse', 'no-secrets-guard', 'plain', 'no-cache']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      if (bools.has(name) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[name] = true;
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

// One line per run in history.jsonl, the only stats store. Content never goes here, only counts.
function recordStats(run) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const row = { ts: new Date().toISOString(), cmd: process.argv[2], project: path.basename(process.cwd()),
      provider: provider().name, items: run.items, requests: run.requests, cached: cacheHits, jev_tokens: run.jevTokens, saved: Math.max(0, run.saved) };
    fs.appendFileSync(HISTORY, JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch {}
}

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ model: res.model, answers: res.answers }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

async function decide(body, flags) {
  const p = provider(flags);
  const cached = !flags['no-cache'] && cacheFile(p, body);
  const hit = cached && cacheGet(cached);
  if (hit) { cacheHits++; return { ...hit, usage: { input_tokens: 0 } }; }
  if (!p.key) die(`no ${p.name} API key. Get one at ${p.keyUrl}, then run: node flash.mjs setup --provider ${p.name}`, 3);
  let lastErr;
  for (let attempt = 0; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(p.base + p.decide, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json', ...p.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      lastErr = `network error: ${e.message}`;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) { const json = await res.json(); if (cached) cachePut(cached, json); return json; }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) die(`${p.name} rejected the API key (${res.status}). Get a new one at ${p.keyUrl} and run: node flash.mjs setup --provider ${p.name}`, 3);
    if (res.status === 422 || res.status === 400) die(`Jev rejected the request (${res.status}): ${clip(text, 800)}`, 4);
    lastErr = `HTTP ${res.status}: ${clip(text, 300)}`;
    if (![408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) break;
    const ra = Number(res.headers.get('retry-after'));
    await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt + Math.random() * 250);
  }
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
// (bench: CI triage 76% packed vs 100% unpacked). --fast packs small items for throughput.
function batches(items, flags) {
  const budget = num(flags['pack-tokens'], 3000), maxN = num(flags['pack-items'], flags.fast ? 40 : 1);
  const out = [];
  let cur = [], tok = 0;
  for (const it of items) {
    const t = estTokens(it.text) + 20;
    if (cur.length && (tok + t > budget || cur.length >= maxN)) { out.push(cur); cur = []; tok = 0; }
    cur.push(it); tok += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Run one question per item. makeQ(ref, packed) builds the question; ref is how the item is addressed in state.
async function runPerItem(items, flags, makeQ) {
  const model = modelName(flags);
  const groups = batches(items, flags);
  const stats = { requests: groups.length, jevTokens: 0 };
  const results = await pool(groups.map((g) => async () => {
    const packed = g.length > 1;
    const state = packed
      ? { items: Object.fromEntries(g.map((it, j) => [`i${j}`, { source: it.id, content: it.text }])) }
      : { source: g[0].id, content: g[0].text };
    const questions = Object.fromEntries(g.map((_, j) => [`q${j}`, makeQ(packed ? `\`items.i${j}\`` : '`content`', packed)]));
    const res = await decide({ model, state, questions }, flags);
    stats.jevTokens += res.usage?.input_tokens || 0;
    stats.model = res.model;
    return g.map((it, j) => ({ item: it, answer: res.answers[`q${j}`] }));
  }), num(flags.concurrency, 16));
  return { rows: results.flat(), stats };
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
  if (flags.json) { process.stdout.write(JSON.stringify(jsonObj, null, 2) + '\n'); process.stderr.write(foot + '\n'); return; }
  const body = lines.join('\n');
  if (body) process.stdout.write(body + '\n');
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
  const out = hits.map((h) => `${f2(h.score)}  ${h.file}:${h.line}  ${clip(h.text.trim(), num(flags.width, 160))}`);
  if (!out.length) out.push('(no matching lines)');
  const foot = footer(t0, files, [`${chunks.length} chunks`], stats, out.join('\n'), skipped);
  emit(flags, hits, out, foot);
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

const checkKey = (p, key) => fetch(p.base + p.check, { headers: { Authorization: `Bearer ${key}`, ...p.headers } });

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
  const res = await checkKey(p, key).catch((e) => die(`network error: ${e.message}`));
  if (res.status === 401 || res.status === 403) die(`that key was rejected by ${p.name} (${res.status}). Double-check it at ${p.keyUrl}`, 3);
  if (!res.ok) die(`could not verify key: HTTP ${res.status}`);
  cfg.keys = { ...cfg.keys, [p.name]: key };
  cfg.provider = p.name;
  if (flags.model) cfg.models = { ...cfg.models, [p.name]: flags.model };
  writeJson(CONFIG, cfg, 0o600);
  console.log(`✓ ${p.name} key verified and saved to ${CONFIG}. Flash is ready (provider ${p.name}).`);
}

async function cmdStatus({ flags }) {
  const p = provider(flags);
  if (!p.key) { console.log(`not configured for ${p.name} — get a key at ${p.keyUrl}, then run: node flash.mjs setup --provider ${p.name}`); process.exit(3); }
  const res = await checkKey(p, p.key).catch(() => null);
  const rows = readHistory();
  if (!res) console.log(`key found (${p.keySource}) but ${p.name} is unreachable right now`);
  else if (!res.ok) { console.log(`key found (${p.keySource}) but rejected by ${p.name} (HTTP ${res.status}) — run setup with a fresh key from ${p.keyUrl}`); process.exit(3); }
  else console.log(`ready · provider ${p.name} · key from ${p.keySource} · model ${modelName(flags)}`);
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

function cmdGain({ flags }) {
  const rows = readHistory();
  if (flags.json) return console.log(JSON.stringify({ history: rows }, null, 2));
  if (!flags.plain && !flags.history) console.log(banner());
  if (!rows.length) return console.log('no runs yet');
  const line = (k, t) => `  ${k.padEnd(16)} ${String(t.runs).padStart(5)} runs  ${fmtK(t.items).padStart(7)} items  ` +
    `jev ${fmtK(t.jev_tokens).padStart(7)} (${cost(t.jev_tokens)})  saved ~${fmtK(t.saved)}`;
  if (flags.history) {
    const n = num(flags.history, 20);
    for (const r of rows.slice(-n)) console.log(`${r.ts.slice(0, 16).replace('T', ' ')}  ${(r.cmd || '').padEnd(8)} ${(r.project || '').padEnd(18)} ` +
      `${fmtK(r.items).padStart(6)} items  jev ${fmtK(r.jev_tokens).padStart(6)}  saved ~${fmtK(r.saved)}  ${r.provider || ''}`);
    return;
  }
  console.log(`flash ${totalsLine(rows)}`);
  const show = (title, entries) => { console.log(`\n${title}`); for (const [k, t] of entries) console.log(line(k, t)); };
  const bySaved = (e) => e.sort((a, b) => b[1].saved - a[1].saved);
  show('by command', bySaved(groupBy(rows, (r) => r.cmd || '?')));
  show('by project', bySaved(groupBy(rows, (r) => r.project || '?')).slice(0, 10));
  show('last 7 days', groupBy(rows, (r) => r.ts.slice(0, 10)).sort().slice(-7));
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
  find: `flash find "<what you're looking for>" <files> [--top 5] [--chunk 150]
Locate the lines in large files that match a description. Read around the hits with offset/limit afterwards.
  flash find "where the session token is refreshed" src/auth.ts`,
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
  gain: `flash gain [--history [N]] [--plain] [--json]
Tokens saved by command, project and day, read from ~/.flash/history.jsonl.
--history lists the last N runs, --plain drops the banner, --json prints the raw history.`,
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
  flash find "where the session token is refreshed" src/auth.ts
  flash classify --labels "bug,feature,question" --items tickets.jsonl

Commands:
  filter    keep only items where the answer to a yes/no question is yes
  classify  put each item in one label
  rank      order items by relevance to a query
  find      locate the matching lines inside large files
  ask       one judgment over one document, or a raw spec.json request
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
    const trash = `${CACHE}.clearing-${process.pid}`;
    try { fs.renameSync(CACHE, trash); } catch { return console.log('cache already empty'); }
    fs.rmSync(trash, { recursive: true, force: true });
    return console.log(`cleared ${CACHE}`);
  }
  if (pos[0]) die(`unknown cache action "${pos[0]}". Use: flash cache [clear]`, 2);
  let n = 0, bytes = 0;
  try { for (const f of fs.readdirSync(CACHE)) { n++; bytes += fs.statSync(path.join(CACHE, f)).size; } } catch {}
  console.log(`${n} cached answers · ${fmtK(bytes)}B in ${CACHE} · entries expire after 7 days`);
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

const COMMANDS = { setup: cmdSetup, status: cmdStatus, gain: cmdGain, filter: cmdFilter, classify: cmdClassify, rank: cmdRank, find: cmdFind, ask: cmdAsk, skill: cmdSkill, cache: cmdCache };

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
