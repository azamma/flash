#!/usr/bin/env node
// Task 19: the bh-driver speed benchmark. Two arms, alternating, N runs each (default 3):
//   A: headless `claude -p --model sonnet --output-format json` driving browser-harness directly
//      (a fair baseline: same driver as arm B, not agent-browser).
//   B: the same Claude, instructed to call `flash web run "<goal>" --driver bh` once and only
//      answer pauses (needs-input, unsure, risky) -- the product shape this whole phase is for.
// Every browser-harness call in both arms goes through bh-shim.mjs (BH_REAL_CMD/BH_LOG), so call
// count and total driver time are measured identically. Success is checked independently in code:
// arm A reads the live tab's own url/title after Claude exits; arm B reads flash's own page.json
// (its last write already reflects the final page) -- neither ever asks Claude or Jev.
// Reproduce: node bench/web/e2e-bh.mjs [runsPerArm]   (default 3, per plans/flash-web/todo.md Task 19)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS as SHORT_TASKS } from './e2e.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const FLASH = path.join(ROOT, 'skills/flash/scripts/flash.mjs');
const SHIM = path.join(HERE, 'bh-shim.mjs');

const RUNS = Number(process.argv[2]) || 3;
const CLAUDE_TIMEOUT_MS = 6 * 60_000; // longer tasks take more steps than Task 13's

const NEVER = 'Never log in, never submit a form, never buy/purchase/pay for anything, never post, publish or delete anything. This is read-only browsing only.';

// 4 new longer tasks (5-8 steps), per todo.md Task 19.
const LONG_TASKS = [
  { id: 'wiki-long', prompt: 'Go to https://en.wikipedia.org, search for "Octopus" and open the article, ' +
      'open a section link from the table of contents (any section such as "Anatomy" or "Behaviour"), ' +
      'then open that article\'s Talk page.',
    check: (url) => /\/wiki\/Talk:Octopus\b/i.test(url) },
  { id: 'hn-long', prompt: 'Go to https://news.ycombinator.com, open "newest", open the first story\'s comments page, ' +
      'then open the story submitter\'s user profile page (their username link at the top of the comments page).',
    check: (url) => /news\.ycombinator\.com\/user\?id=/.test(url) },
  { id: 'wiki-long-2', prompt: 'Go to https://en.wikipedia.org, search for "Zebra" and open the article, ' +
      'click a link within the article\'s first paragraph to another topic, then open that new article\'s Talk page.',
    check: (url) => /\/wiki\/Talk:/i.test(url) },
  { id: 'gh-long', prompt: 'Go to https://github.com, use the site search to search for "browser-harness", ' +
      'open the top repository result, open its Issues tab, then open its Pull requests tab.',
    check: (url) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pulls/i.test(url) },
];

export const TASKS = [...SHORT_TASKS, ...LONG_TASKS];
export const LONG_IDS = new Set(LONG_TASKS.map((t) => t.id));

function promptFor(arm, task, session) {
  const bhCmd = `node ${SHIM}`;
  if (arm === 'A') {
    return `${task.prompt} ${NEVER} Drive the browser directly with browser-harness: pipe your Python into ` +
      `\`${bhCmd} <<'PY' ... PY\` (heredoc), one call per logical step. First navigation for the task is ` +
      `new_tab(url), never goto_url on whatever tab is already attached. Read the accessibility tree with ` +
      `cdp("Accessibility.getFullAXTree")["nodes"] or js(...) to find elements, click_at_xy to act, wait_for_load() ` +
      `after navigation. Never call switch_tab, list_tabs, activate_tab or close_tab -- leave your tab open and ` +
      `attached when you're done; the harness reads and closes it after you finish. When you believe the task is ` +
      `complete, stop; do not keep navigating.`;
  }
  return `${task.prompt} ${NEVER} You have the "flash web" command: call it exactly once as ` +
    `\`node ${FLASH} web run "<goal>" --driver bh --url "<start URL>" --session ${session}\` (put the whole task, ` +
    `including where to start, into <goal>). It drives the browser itself. It returns to you only when it needs ` +
    `an input value ("needs input" -- reply with \`echo "<text>" | node ${FLASH} web run --resume <id> --session ${session}\`, ` +
    `piping the value, never as a bare argument), is unsure, thinks an action is risky, or is done/stuck. Keep ` +
    `resuming pauses until it stops with "done", "stuck", or an error; do not drive the browser yourself unless ` +
    `flash web genuinely cannot proceed after a few attempts. Always pass --session ${session} on every call.`;
}

// ---------- accounting ----------

function driverAccounting(log) {
  let calls = 0, ms = 0;
  try {
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    calls = lines.length;
    for (const l of lines) ms += l.ms;
  } catch {}
  return { calls, ms };
}

const JEV_STEPS = new Set(['risky-check', 'run-step', 'resolve']);
function flashAccounting(home) {
  let jevMs = 0, jevTokens = 0, flashCalls = 0;
  let hist = [];
  try { hist = fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  for (const row of hist) {
    if (typeof row.cmd !== 'string' || !row.cmd.startsWith('web-')) continue;
    flashCalls++;
    jevTokens += row.jev_tokens || 0;
    if (Array.isArray(row.steps)) for (const [name, ms] of row.steps) if (JEV_STEPS.has(name)) jevMs += ms;
  }
  return { jevMs, jevTokens, flashCalls };
}

// Unlogged shim call: reads the currently-attached tab's url/title (arm A's outcome check), then
// closes it. Never counted toward the run's own driver time (BH_LOG unset).
function readAndCloseTab(env) {
  const script = 'import json\ntry:\n  t = current_tab()\n  print(json.dumps({"url": t.get("url",""), "title": t.get("title","")}))\nexcept Exception:\n  print(json.dumps({"url":"","title":""}))\nfinally:\n  try:\n    close_tab()\n  except Exception:\n    pass\n';
  const r = spawnSync('node', [SHIM], { input: script, env, encoding: 'utf8', timeout: 20_000 });
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { return { url: '', title: '' }; }
}

function runOnce(arm, task, runIdx) {
  const runId = `${task.id}-${arm}-${runIdx}`;
  const session = `flash-bench-${runId}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-e2ebh-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-e2ebh-work-'));
  const bhLog = path.join(os.tmpdir(), `flash-e2ebh-log-${runId}-${Date.now()}.jsonl`);
  const startUrl = /^Go to (https?:\/\/\S+)/.exec(task.prompt)?.[1]?.replace(/,$/, '') || '';
  const prompt = promptFor(arm, task, session);

  const env = { ...process.env, BH_LOG: bhLog, FLASH_BROWSER_HARNESS: `node ${SHIM}`, FLASH_HOME: home, BH_TAB_MARKER: '0' };
  const noLogEnv = { ...env, BH_LOG: '' };

  const t0 = Date.now();
  const r = spawnSync('claude', ['-p', '--model', 'sonnet', '--output-format', 'json', '--allowedTools', 'Bash'], {
    input: prompt, cwd: work, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: CLAUDE_TIMEOUT_MS,
  });
  const wallMs = Date.now() - t0;

  let claudeResult = null;
  try { claudeResult = JSON.parse(r.stdout); } catch {}

  let finalUrl = '', finalTitle = '';
  if (arm === 'A') {
    const t = readAndCloseTab(noLogEnv);
    finalUrl = t.url; finalTitle = t.title;
  } else {
    try {
      // sessionName() (web.mjs) always prepends "flash-" to whatever --session is given.
      const page = JSON.parse(fs.readFileSync(path.join(home, 'web', `flash-${session}`, 'page.json'), 'utf8'));
      finalUrl = page.url || ''; finalTitle = page.title || '';
    } catch {}
    readAndCloseTab(noLogEnv); // safety net: close a tab left attached if the run paused unresolved
  }
  const success = !!finalUrl && task.check(finalUrl, finalTitle);

  const driver = driverAccounting(bhLog);
  const flash = flashAccounting(home);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(bhLog, { force: true });

  const usage = claudeResult?.usage;
  const claudeTokens = usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) : null;

  return {
    task: task.id, long: LONG_IDS.has(task.id), arm, run: runIdx, session, success, finalUrl, finalTitle, wallMs,
    bhCalls: driver.calls, bhMs: driver.ms,
    jevMs: flash.jevMs, jevTokens: flash.jevTokens, flashCalls: flash.flashCalls,
    claudeTokens, claudeCost: claudeResult?.total_cost_usd ?? null, claudeTurns: claudeResult?.num_turns ?? null,
    error: claudeResult ? (claudeResult.is_error ? claudeResult.result : null) : (r.stderr?.slice(0, 300) || 'no JSON result (timeout or crash)'),
    startUrl,
  };
}

function median(nums) { const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; }
function summarize(rows, arm, long) {
  const arows = rows.filter((r) => r.arm === arm && r.long === long);
  const n = arows.length;
  const successes = arows.filter((r) => r.success).length;
  return {
    n, successes, successRate: n ? successes / n : 0,
    medianWallMs: median(arows.map((r) => r.wallMs)),
    medianTurns: median(arows.map((r) => r.claudeTurns || 0)),
    medianBhMs: median(arows.map((r) => r.bhMs)),
    totalBhCalls: arows.reduce((a, r) => a + r.bhCalls, 0),
    medianJevMs: median(arows.map((r) => r.jevMs)),
    totalJevTokens: arows.reduce((a, r) => a + r.jevTokens, 0),
    totalClaudeTokens: arows.reduce((a, r) => a + (r.claudeTokens || 0), 0),
    totalClaudeCost: arows.reduce((a, r) => a + (r.claudeCost || 0), 0),
    errors: arows.filter((r) => r.error).length,
  };
}

export { promptFor, runOnce, summarize };

function main() {
  const rows = [];
  for (let run = 1; run <= RUNS; run++) {
    for (const task of TASKS) {
      for (const arm of ['A', 'B']) {
        process.stderr.write(`[${new Date().toISOString()}] run ${run}/${RUNS} · ${task.id} · arm ${arm} ... `);
        const row = runOnce(arm, task, run);
        process.stderr.write(`${row.success ? 'OK' : 'FAIL'} ${row.wallMs}ms\n`);
        rows.push(row);
      }
    }
  }

  fs.mkdirSync(path.join(HERE, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(HERE, 'runs', 'e2e-bh-rows.json'), JSON.stringify(rows, null, 2) + '\n');

  const lines = [];
  lines.push(`## Task 19 run ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`${TASKS.length} tasks (${SHORT_TASKS.length} short + ${LONG_TASKS.length} long) x ${RUNS} run(s)/arm, alternating.`);
  lines.push('');
  lines.push('| arm | scope | n | success | median wall | median turns | median driver (bh) time | driver calls | median Jev time | Jev tokens | Claude tokens | Claude $ | errors |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const scope of [false, true]) {
    for (const [name, arm] of [['A: browser-harness directly', 'A'], ['B: + flash web run --driver bh', 'B']]) {
      const s = summarize(rows, arm, scope);
      lines.push(`| ${name} | ${scope ? 'long' : 'short'} | ${s.n} | ${s.successes}/${s.n} (${(s.successRate * 100).toFixed(0)}%) | ${s.medianWallMs}ms | ${s.medianTurns} | ${s.medianBhMs}ms | ${s.totalBhCalls} | ${s.medianJevMs}ms | ${s.totalJevTokens} | ${s.totalClaudeTokens} | $${s.totalClaudeCost.toFixed(4)} | ${s.errors} |`);
    }
  }
  lines.push('');
  lines.push('Per-task/run:');
  for (const r of rows) lines.push(`- ${r.task}${r.long ? ' (long)' : ''} · arm ${r.arm} · run ${r.run}: ${r.success ? 'OK' : 'FAIL'} (${r.finalUrl || 'no url'}) · ${r.wallMs}ms wall · ${r.claudeTurns ?? 'n/a'} turns · ${r.bhCalls} bh calls / ${r.bhMs}ms · jev ${r.jevMs}ms/${r.jevTokens}tok · claude ${r.claudeTokens ?? 'n/a'}tok/$${(r.claudeCost ?? 0).toFixed(4)}${r.error ? ` · ERROR: ${r.error}` : ''}`);
  lines.push('');

  const A = summarize(rows, 'A', false), B = summarize(rows, 'B', false);
  const Al = summarize(rows, 'A', true), Bl = summarize(rows, 'B', true);
  const successOk = B.successRate >= A.successRate && Bl.successRate >= Al.successRate;
  const wallOk = B.medianWallMs < A.medianWallMs && Bl.medianWallMs < Al.medianWallMs;
  lines.push('### Gate (reported, not decided here)');
  lines.push(`- success rate not lower (B vs A) -- short: ${(B.successRate * 100).toFixed(0)}% vs ${(A.successRate * 100).toFixed(0)}%, long: ${(Bl.successRate * 100).toFixed(0)}% vs ${(Al.successRate * 100).toFixed(0)}% -- ${successOk ? 'PASS' : 'FAIL'}`);
  lines.push(`- median wall time lower (B vs A) -- short: ${B.medianWallMs}ms vs ${A.medianWallMs}ms, long: ${Bl.medianWallMs}ms vs ${Al.medianWallMs}ms -- ${wallOk ? 'PASS' : 'FAIL'}`);
  lines.push(`- no harmful action: checked manually against the per-task/run list above (no buy/pay/delete/submit goal in any task)`);
  lines.push('');

  const resultsFile = path.join(HERE, 'E2E.md');
  const existing = fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8') : '# flash web end-to-end benchmark\n\n';
  fs.writeFileSync(resultsFile, existing + lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) main();
