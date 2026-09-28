#!/usr/bin/env node
// PreToolUse hook for Read: refuse whole-file reads of large text files so Claude goes through
// flash (find/filter/rank) first, then reads only the lines that matter with offset/limit.
// PostToolUse hook for Bash: when a flash command ran, show its Jev footer (time, tokens, cost) to the user.
// PostToolUse hook for mcp__*: when an MCP tool returns a big JSON list, Jev keeps the items relevant
// to the call and Claude gets those plus the path of the full response. Fails open: any problem and
// the original output passes through untouched.
// Set FLASH_GUARD=off to disable. Thresholds: FLASH_GUARD_LINES, FLASH_GUARD_BYTES, FLASH_MCP_BYTES; FLASH_MCP=off.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_LINES = Number(process.env.FLASH_GUARD_LINES) || 600;
const MAX_BYTES = Number(process.env.FLASH_GUARD_BYTES) || 60_000;
const BINARY = /\.(png|jpe?g|gif|webp|svg|pdf|ipynb|ico|bmp|tiff?)$/i;

// The footer flash prints last: "— 12 scanned · 0.6s · jev 2.1k tok ($0.0001) · ~9.8k Claude tokens not read".
function jevSummary(input) {
  if (input.tool_name !== 'Bash' || !/flash/.test(input.tool_input?.command || '')) return null;
  const r = input.tool_response || {};
  const out = typeof r === 'string' ? r : `${r.stdout || ''}\n${r.stderr || ''}`;
  return out.split('\n').reverse().find((l) => /^— .*jev .* tok/.test(l)) || null;
}

function verdict(input) {
  if (process.env.FLASH_GUARD === 'off') return null;
  const t = input.tool_input || {};
  if (input.tool_name !== 'Read' || !t.file_path || t.offset || t.limit || BINARY.test(t.file_path)) return null;
  let size, lines;
  try {
    size = fs.statSync(t.file_path).size;
    lines = size > MAX_BYTES ? Infinity : fs.readFileSync(t.file_path, 'utf8').split('\n').length;
  } catch { return null; }
  if (size <= MAX_BYTES && lines <= MAX_LINES) return null;
  const flash = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flash.mjs');
  const what = lines === Infinity ? `${Math.round(size / 1024)} KB` : `${lines} lines`;
  return `Flash guard: ${t.file_path} is ${what}. Don't read it whole. First locate what matters with ` +
    `node "${flash}" find "<what you need>" "${t.file_path}" --context (or filter --lines for logs). ` +
    `--context returns the source around each hit, so you may not need a Read at all; otherwise Read with offset/limit around the hits. Only read it whole if you really need every line: use offset 1 and an explicit limit.`;
}

const MCP_MIN = Number(process.env.FLASH_MCP_BYTES) || 16_000;
const FLASH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flash.mjs');
const HOME = process.env.FLASH_HOME || path.join(os.homedir(), '.flash');

// MCP output reaches hooks as a string, an array of content blocks, or { content: [...] }.
const blocks = (r) => (Array.isArray(r) ? r : Array.isArray(r?.content) ? r.content : null);
function mcpText(r) {
  if (typeof r === 'string') return r;
  const b = blocks(r);
  return b && b.every((x) => x?.type === 'text') ? b.map((x) => x.text).join('\n') : null;
}
const reshape = (r, text) => (typeof r === 'string' ? text
  : Array.isArray(r) ? [{ type: 'text', text }] : { ...r, content: [{ type: 'text', text }] });

// The list in a response: the top-level array, or the first array field of a top-level object.
function listOf(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (Array.isArray(j)) return { list: j, wrap: (kept) => kept };
  const key = j && typeof j === 'object' && Object.keys(j).find((k) => Array.isArray(j[k]) && j[k].length);
  return key ? { list: j[key], wrap: (kept) => ({ ...j, [key]: kept }) } : null;
}

function trimMcp(input) {
  if (process.env.FLASH_MCP === 'off' || !input.tool_name?.startsWith('mcp__')) return null;
  const text = mcpText(input.tool_response);
  if (!text || text.length < MCP_MIN) return null;
  const found = listOf(text);
  if (!found || found.list.length < 6) return null;
  const dir = path.join(HOME, 'mcp');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const full = path.join(dir, `${stamp}-${input.tool_name.replace(/[^\w-]/g, '_')}.json`);
  const items = path.join(dir, `${stamp}.items.jsonl`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(full, text, { mode: 0o600 });
    fs.writeFileSync(items, found.list.map((x, i) => JSON.stringify({ id: i, text: JSON.stringify(x) })).join('\n'), { mode: 0o600 });
  } catch { return null; }
  const q = `Does this item help answer the request that called the tool \`${input.tool_name}\` with arguments ${JSON.stringify(input.tool_input || {})}?`;
  const r = spawnSync(process.execPath, [FLASH, 'filter', q, '--items', items, '--json', '--threshold', '0.35'],
    { cwd: input.cwd || process.cwd(), encoding: 'utf8', timeout: 50_000 });
  fs.rmSync(items, { force: true });
  let out;
  try { out = JSON.parse(r.stdout); } catch { return null; }
  const keep = new Set([...out.matched, ...out.borderline].map((m) => Number(m.id)));
  if (keep.size === found.list.length) return null;
  const kept = found.list.filter((_, i) => keep.has(i));
  const body = JSON.stringify(found.wrap(kept));
  const note = `[flash: Jev kept ${kept.length} of ${found.list.length} items as relevant to this call. ` +
    `The full response is saved at ${full}; Read it with offset/limit if something you need seems missing.]`;
  return {
    systemMessage: `⚡ flash → Jev trimmed ${input.tool_name}: kept ${kept.length}/${found.list.length} items (~${Math.round((text.length - body.length) / 4 / 100) / 10}k Claude tokens not read)`,
    hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: reshape(input.tool_response, `${note}\n${body}`) },
  };
}

// The project a row belongs to: the git repo's root folder, or the working folder outside git.
function projectName(cwd) {
  try {
    return path.basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { return path.basename(cwd); }
}

let raw = '';
for await (const c of process.stdin) raw += c;
let input = {};
try { input = JSON.parse(raw); } catch {}
if (input.hook_event_name === 'PostToolUse' && input.tool_name?.startsWith('mcp__')) {
  const t = trimMcp(input);
  if (t) process.stdout.write(JSON.stringify(t));
} else if (input.hook_event_name === 'PostToolUse') {
  const s = jevSummary(input);
  if (s) process.stdout.write(JSON.stringify({ systemMessage: `⚡ flash → Jev ${s.slice(2)}` }));
} else {
  const reason = verdict(input);
  if (reason) {
    // One counts-only row in the same history `flash gain` reads, so blocked reads show up as cmd "guard".
    const cwd = input.cwd || process.cwd(), home = HOME;
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({ ts: new Date().toISOString(), cmd: 'guard',
        project: projectName(cwd), file: path.relative(cwd, input.tool_input.file_path), items: 1, requests: 0, jev_tokens: 0, saved: 0 }) + '\n', { mode: 0o600 });
    } catch {}
  }
  if (reason) process.stdout.write(JSON.stringify({
    systemMessage: `⚡ flash: blocked whole Read of ${path.basename(input.tool_input.file_path)}, routing Claude to Jev`,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}
