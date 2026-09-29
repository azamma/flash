#!/usr/bin/env node
// Task 13: end-to-end benchmark. Two arms, alternating, N runs each (default 3):
//   A: headless `claude -p --model sonnet --output-format json` driving agent-browser directly.
//   B: the same Claude, with `flash web` (snapshot/pick/check/click/run) also available.
// Every agent-browser call in both arms — Claude's own direct calls, and flash.mjs's internal
// ones — goes through ab-shim.mjs (AB_REAL_CMD/AB_LOG), so call count and total driver time are
// measured identically in both arms. Success is checked independently in code (a URL/title regex
// against the session's own final state, queried directly, never asked of Claude or Jev).
// Reproduce: node bench/web/e2e.mjs [runsPerArm]   (default 3, per plans/flash-web/todo.md Task 13)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const FLASH = path.join(ROOT, 'skills/flash/scripts/flash.mjs');
const SHIM = path.join(HERE, 'ab-shim.mjs');

const HAS_GLOBAL_AB = (() => { try { execFileSync('which', ['agent-browser'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const AB_REAL_CMD = HAS_GLOBAL_AB ? 'agent-browser' : 'npx -y agent-browser';

const RUNS = Number(process.argv[2]) || 3;
const CLAUDE_TIMEOUT_MS = 5 * 60_000;

// ---------- the ~8 harmless public tasks (never log in, submit, buy, post or delete) ----------
const NEVER = 'Never log in, never submit a form, never buy/purchase/pay for anything, never post, publish or delete anything. This is read-only browsing only.';

const TASKS = [
  { id: 'wiki-search', prompt: 'Go to https://en.wikipedia.org and use the search box to find and open the article for "Octopus".',
    check: (url, title) => /\/wiki\/Octopus\b/i.test(url) || /Octopus/i.test(title) },
  { id: 'wiki-talk', prompt: 'Go to https://en.wikipedia.org/wiki/Octopus and open its Talk page (the "Talk" tab/link near the top).',
    check: (url) => /\/wiki\/Talk:Octopus\b/i.test(url) },
  { id: 'wiki-random', prompt: 'Go to https://en.wikipedia.org/wiki/Main_Page and use the "Random article" link to open a random article.',
    check: (url) => /^https:\/\/en\.wikipedia\.org\/wiki\//i.test(url) && !/Main_Page/i.test(url) },
  { id: 'hn-comments', prompt: 'Go to https://news.ycombinator.com and open the comments page for the first (top) story on the front page.',
    check: (url) => /news\.ycombinator\.com\/item\?id=\d+/.test(url) },
  { id: 'hn-newest', prompt: 'Go to https://news.ycombinator.com and open the "new" page (newest submissions).',
    check: (url) => /news\.ycombinator\.com\/newest/.test(url) },
  // github.com/facebook/react 301-redirects to github.com/react/react (checked live 2026-09-29) —
  // both org names accepted so a correct navigation isn't scored as a failure either way.
  { id: 'gh-issues', prompt: 'Go to https://github.com/facebook/react and open its Issues tab.',
    check: (url) => /^https:\/\/github\.com\/(facebook|react)\/react\/issues/i.test(url) },
  { id: 'gh-search', prompt: 'Go to https://github.com and use the site search to search for "agent-browser", then open the top repository result.',
    check: (url) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(url) },
  { id: 'wiki-lang', prompt: 'Go to https://en.wikipedia.org/wiki/Octopus and switch to the Spanish-language version of the article using the language links in the sidebar.',
    check: (url) => /^https:\/\/es\.wikipedia\.org\/wiki\//i.test(url) },
];

function promptFor(arm, task, session) {
  const abCmd = `node ${SHIM} --session ${session}`;
  const common = `${task.prompt} ${NEVER} Use exactly this command in place of "agent-browser" for every browser action ` +
    `(e.g. \`${abCmd} goto <url>\`, \`${abCmd} snapshot -i\`, \`${abCmd} click @eN\`, \`${abCmd} get url\`). ` +
    `Always pass --session ${session} on every call — never omit it, never use a different session name. ` +
    `When you believe the task is complete, stop; do not keep navigating.`;
  if (arm === 'A') return `${common} Drive the browser yourself: goto/snapshot/click/fill/get, reading each snapshot to decide the next action.`;
  return `${common} You also have the "flash web" command: \`node ${FLASH} web <snapshot|pick|check|click|run> --session ${session} ...\` ` +
    `— it captures the page and lets a second, cheaper model pick and act on elements, reporting back in a few lines instead of a ` +
    `full page snapshot. Prefer \`flash web run "<goal>"\` or \`flash web click "<intent>"\` over reading raw snapshots yourself, for ` +
    `speed. If flash web says "? unsure", stops on a risky action, or you disagree with it, fall back to a direct snapshot/click.`;
}

// ---------- per-run history accounting (arm B only; arm A never calls flash.mjs) ----------
const JEV_STEPS = new Set(['pick', 'risky-check', 'run-step']);
const DRIVER_STEPS = new Set(['snapshot', 'freshness-snapshot', 'act', 'post-act-snapshot']);

function flashAccounting(home) {
  let jevMs = 0, jevTokens = 0, flashCalls = 0;
  let hist = [];
  try { hist = fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  for (const row of hist) {
    if (typeof row.cmd !== 'string' || !row.cmd.startsWith('web-')) continue;
    flashCalls++;
    jevTokens += row.jev_tokens || 0;
    if (row.cmd === 'web-pick' || row.cmd === 'web-check') jevMs += row.ms || 0;
    else if (Array.isArray(row.steps)) for (const [name, ms] of row.steps) if (JEV_STEPS.has(name)) jevMs += ms;
  }
  return { jevMs, jevTokens, flashCalls };
}

function driverAccounting(abLog) {
  let calls = 0, ms = 0, riskyLooking = [];
  const RISKY_ARG_RE = /\b(buy|pay|purchase|checkout|delete|remove|cancel|unsubscribe|submit|confirm)\b/i;
  try {
    const lines = fs.readFileSync(abLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    calls = lines.length;
    for (const l of lines) {
      ms += l.ms;
      const joined = l.args.join(' ');
      if ((l.args[0] === 'click' || l.args[0] === 'fill') && RISKY_ARG_RE.test(joined)) riskyLooking.push(joined);
    }
  } catch {}
  return { calls, ms, riskyLooking };
}

function runOnce(arm, task, runIdx) {
  const runId = `${task.id}-${arm}-${runIdx}`;
  const session = `flash-bench-${runId}`; // explicit, never the default session
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-e2e-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-e2e-work-'));
  const abLog = path.join(os.tmpdir(), `flash-e2e-ablog-${runId}-${Date.now()}.jsonl`);
  const prompt = promptFor(arm, task, session);

  const env = { ...process.env, AB_REAL_CMD, AB_LOG: abLog, FLASH_AGENT_BROWSER: `node ${SHIM}`, FLASH_HOME: home };
  const noLogEnv = { ...env, AB_LOG: '' };

  const t0 = Date.now();
  const r = spawnSync('claude', ['-p', '--model', 'sonnet', '--output-format', 'json', '--allowedTools', 'Bash'], {
    input: prompt, cwd: work, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: CLAUDE_TIMEOUT_MS,
  });
  const wallMs = Date.now() - t0;

  let claudeResult = null;
  try { claudeResult = JSON.parse(r.stdout); } catch {}

  // Independent outcome check: query the same session directly (not logged — AB_LOG unset here).
  const urlR = spawnSync('node', [SHIM, '--session', session, 'get', 'url'], { env: noLogEnv, encoding: 'utf8', timeout: 30_000 });
  const titleR = spawnSync('node', [SHIM, '--session', session, 'get', 'title'], { env: noLogEnv, encoding: 'utf8', timeout: 30_000 });
  const finalUrl = (urlR.stdout || '').trim();
  const finalTitle = (titleR.stdout || '').trim();
  const success = !!finalUrl && task.check(finalUrl, finalTitle);
  spawnSync('node', [SHIM, '--session', session, 'close'], { env: noLogEnv, encoding: 'utf8', timeout: 30_000 });

  const driver = driverAccounting(abLog);
  const flash = flashAccounting(home);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(abLog, { force: true });

  const usage = claudeResult?.usage;
  const claudeTokens = usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) : null;

  return {
    task: task.id, arm, run: runIdx, session, success, finalUrl, finalTitle, wallMs,
    abCalls: driver.calls, abMs: driver.ms, riskyLooking: driver.riskyLooking,
    jevMs: flash.jevMs, jevTokens: flash.jevTokens, flashCalls: flash.flashCalls,
    claudeTokens, claudeCost: claudeResult?.total_cost_usd ?? null, claudeTurns: claudeResult?.num_turns ?? null,
    error: claudeResult ? (claudeResult.is_error ? claudeResult.result : null) : (r.stderr?.slice(0, 300) || 'no JSON result (timeout or crash)'),
  };
}

function median(nums) { const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function summarizeArm(rows, arm) {
  const arows = rows.filter((r) => r.arm === arm);
  const n = arows.length;
  const successes = arows.filter((r) => r.success).length;
  return {
    n, successes, successRate: n ? successes / n : 0,
    medianWallMs: median(arows.map((r) => r.wallMs)),
    medianAbMs: median(arows.map((r) => r.abMs)),
    totalAbCalls: arows.reduce((a, r) => a + r.abCalls, 0),
    medianJevMs: median(arows.map((r) => r.jevMs)),
    totalJevTokens: arows.reduce((a, r) => a + r.jevTokens, 0),
    totalClaudeTokens: arows.reduce((a, r) => a + (r.claudeTokens || 0), 0),
    totalClaudeCost: arows.reduce((a, r) => a + (r.claudeCost || 0), 0),
    errors: arows.filter((r) => r.error).length,
  };
}

// Exported for reuse/smoke-testing; only `main()` (guarded below) actually spends money and time.
export { TASKS, promptFor, runOnce, summarizeArm };

function main() {
  const rows = [];
  for (let run = 1; run <= RUNS; run++) {
    for (const task of TASKS) {
      for (const arm of ['A', 'B']) { // alternating within each task/run, per todo.md
        process.stderr.write(`[${new Date().toISOString()}] run ${run}/${RUNS} · ${task.id} · arm ${arm} ... `);
        const row = runOnce(arm, task, run);
        process.stderr.write(`${row.success ? 'OK' : 'FAIL'} ${row.wallMs}ms\n`);
        rows.push(row);
      }
    }
  }

  fs.mkdirSync(path.join(HERE, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(HERE, 'runs', 'e2e-rows.json'), JSON.stringify(rows, null, 2) + '\n');

  const A = summarizeArm(rows, 'A'), B = summarizeArm(rows, 'B');
  const riskyHits = rows.flatMap((r) => r.riskyLooking.map((x) => `${r.task}/${r.arm}/${r.run}: ${x}`));

  const lines = [];
  lines.push(`## Run ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`${TASKS.length} tasks x ${RUNS} run(s)/arm, alternating. Driver: ${HAS_GLOBAL_AB ? 'global agent-browser' : `FLASH_AGENT_BROWSER="${AB_REAL_CMD}" (no global binary — npx cold starts included in driver time below)`}.`);
  lines.push('');
  lines.push('| arm | n | success | median wall | median driver (agent-browser) time | agent-browser calls | median Jev time | Jev tokens | Claude tokens | Claude $ | errors |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [name, s] of [['A: agent-browser directly', A], ['B: + flash web', B]]) {
    lines.push(`| ${name} | ${s.n} | ${s.successes}/${s.n} (${(s.successRate * 100).toFixed(0)}%) | ${s.medianWallMs}ms | ${s.medianAbMs}ms | ${s.totalAbCalls} | ${s.medianJevMs}ms | ${s.totalJevTokens} | ${s.totalClaudeTokens} | $${s.totalClaudeCost.toFixed(4)} | ${s.errors} |`);
  }
  lines.push('');
  lines.push('Per-task/run:');
  for (const r of rows) lines.push(`- ${r.task} · arm ${r.arm} · run ${r.run}: ${r.success ? 'OK' : 'FAIL'} (${r.finalUrl || 'no url'}) · ${r.wallMs}ms wall · ${r.abCalls} ab calls / ${r.abMs}ms · jev ${r.jevMs}ms/${r.jevTokens}tok · claude ${r.claudeTokens ?? 'n/a'}tok/$${(r.claudeCost ?? 0).toFixed(4)}${r.error ? ` · ERROR: ${r.error}` : ''}`);
  lines.push('');
  lines.push(`No harmful action: ${riskyHits.length === 0 ? 'PASS (no click/fill in any driver log matched a risky keyword)' : `NEEDS REVIEW (${riskyHits.length} flagged): ${riskyHits.join('; ')}`}`);
  lines.push('');
  lines.push('### Gate (reported, not decided here)');
  lines.push(`- success rate not lower (B vs A): ${(B.successRate * 100).toFixed(0)}% vs ${(A.successRate * 100).toFixed(0)}% — ${B.successRate >= A.successRate ? 'PASS' : 'FAIL'}`);
  lines.push(`- wall time lower (B vs A, median): ${B.medianWallMs}ms vs ${A.medianWallMs}ms — ${B.medianWallMs < A.medianWallMs ? 'PASS' : 'FAIL'}`);
  lines.push(`- no harmful action: ${riskyHits.length === 0 ? 'PASS' : 'NEEDS REVIEW'}`);
  lines.push(`- tokens/cost: reported only, not gated (Claude tokens ${A.totalClaudeTokens} vs ${B.totalClaudeTokens}; $${A.totalClaudeCost.toFixed(4)} vs $${B.totalClaudeCost.toFixed(4)})`);
  lines.push('');

  const resultsFile = path.join(HERE, 'E2E.md');
  const existing = fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8') : '# flash web end-to-end benchmark (Task 13)\n\n';
  fs.writeFileSync(resultsFile, existing + lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

// Only runs the (real-money, real-time) sweep when executed directly — `node bench/web/e2e.mjs` —
// never on a plain `import`, so a smoke test can import runOnce/TASKS without triggering it.
if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) main();
