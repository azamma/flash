#!/usr/bin/env node
// PreToolUse hook for Read: refuse whole-file reads of large text files so Claude goes through
// flash (find/filter/rank) first, then reads only the lines that matter with offset/limit.
// PostToolUse hook for Bash: when a flash command ran, show its Jev footer (time, tokens, cost) to the user.
// Only the first whole Read of a file per session is blocked. Set FLASH_GUARD=off to disable. Thresholds: FLASH_GUARD_LINES, FLASH_GUARD_BYTES.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  // Block only the first whole Read of a file per session: asking again means Claude needs every line
  // (usually to edit it), and a second block just costs it a turn of ranged reads.
  if (input.session_id && blockedBefore(input.session_id, t.file_path)) return null;
  const flash = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flash.mjs');
  const what = lines === Infinity ? `${Math.round(size / 1024)} KB` : `${lines} lines`;
  return `Flash guard: ${t.file_path} is ${what}. Don't read it whole. First locate what matters with ` +
    `node "${flash}" find "<what you need>" "${t.file_path}" --context (or filter --lines for logs). ` +
    `--context returns the source around each hit, so you may not need a Read at all; otherwise Read with offset/limit around the hits. Only read it whole if you really need every line: use offset 1 and an explicit limit.`;
}

const HOME = process.env.FLASH_HOME || path.join(os.homedir(), '.flash');

function blockedBefore(session, file) {
  try {
    return fs.readFileSync(path.join(HOME, 'history.jsonl'), 'utf8').split('\n').slice(-500).some((l) => {
      try { const r = JSON.parse(l); return r.cmd === 'guard' && r.session === session && r.path === file; } catch { return false; }
    });
  } catch { return false; }
}

// The project a row belongs to: the main repo's root folder (a worktree counts as its main repo,
// via the shared .git dir), or the working folder outside git.
function projectName(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.basename(path.dirname(common));
  } catch { return path.basename(cwd); }
}

let raw = '';
for await (const c of process.stdin) raw += c;
let input = {};
try { input = JSON.parse(raw); } catch {}
if (input.hook_event_name === 'PostToolUse') {
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
        project: projectName(cwd), file: path.relative(cwd, input.tool_input.file_path), path: input.tool_input.file_path, by: 'claude', session: input.session_id, items: 1, requests: 0, jev_tokens: 0, saved: 0 }) + '\n', { mode: 0o600 });
    } catch {}
  }
  if (reason) process.stdout.write(JSON.stringify({
    systemMessage: `⚡ flash: blocked whole Read of ${path.basename(input.tool_input.file_path)}, routing Claude to Jev`,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}
