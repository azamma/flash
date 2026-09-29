#!/usr/bin/env node
// Task 13: a thin pass-through for the real agent-browser driver, used by BOTH arms of the E2E
// benchmark (directly by Claude in arm A, and via FLASH_AGENT_BROWSER inside flash.mjs in arm B) so
// "agent-browser call count" and "total driver time" are measured the same way regardless of which
// arm — or which layer within an arm — made the call. Every call is timed and appended as one JSON
// line to AB_LOG (skipped when AB_LOG is unset, e.g. for the benchmark's own outcome-check calls,
// which must not count toward a run's own driver-time total). AB_REAL_CMD is the real driver command
// ("agent-browser", or "npx -y agent-browser" when nothing is installed globally); defaults to
// "agent-browser" so this also works as a normal FLASH_AGENT_BROWSER outside the benchmark.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const real = process.env.AB_REAL_CMD || 'agent-browser';
const [cmd, ...pre] = real.trim().split(/\s+/);
const args = process.argv.slice(2);

const t0 = Date.now();
const r = spawnSync(cmd, [...pre, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const ms = Date.now() - t0;

if (process.env.AB_LOG) {
  try { fs.appendFileSync(process.env.AB_LOG, JSON.stringify({ ts: new Date().toISOString(), ms, args }) + '\n'); } catch {}
}
process.exit(r.status ?? 1);
