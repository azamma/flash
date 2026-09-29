#!/usr/bin/env node
// Task 19: a thin pass-through for the real `browser-harness` binary, used by BOTH arms of the bh
// E2E benchmark (directly by Claude in arm A via a heredoc, and via FLASH_BROWSER_HARNESS inside
// flash.mjs in arm B) so "driver call count" and "total driver time" are measured the same way
// regardless of which arm made the call — same pattern as ab-shim.mjs (Task 13), adapted for
// browser-harness's stdin-script calling convention instead of argv. Every call is timed and
// appended as one JSON line to BH_LOG (skipped when BH_LOG is unset, e.g. the benchmark's own
// outcome-check calls, which must not count toward a run's own driver-time total).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const real = process.env.BH_REAL_CMD || 'browser-harness';
const [cmd, ...pre] = real.trim().split(/\s+/);
const args = process.argv.slice(2);
const stdin = args.includes('--version') ? '' : fs.readFileSync(0, 'utf8');

const t0 = Date.now();
const r = spawnSync(cmd, [...pre, ...args], { input: stdin, stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
const ms = Date.now() - t0;

if (process.env.BH_LOG) {
  try { fs.appendFileSync(process.env.BH_LOG, JSON.stringify({ ts: new Date().toISOString(), ms, args, stdinLen: stdin.length }) + '\n'); } catch {}
}
process.exit(r.status ?? 1);
