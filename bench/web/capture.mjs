#!/usr/bin/env node
// Captures a list of real pages (plus local fixtures) into bench/web/snapshots/*.json, in the
// common page format, reusing the agent-browser adapter's own snapshot() so the bench corpus is
// captured exactly the way `flash web snapshot` would. One shared, isolated session for the whole
// run (never agent-browser's default session).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentBrowser } from '../../skills/flash/scripts/web.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'snapshots');
const SESSION = 'flash-bench-web-capture';

const PAGES = JSON.parse(fs.readFileSync(path.join(HERE, 'pages.json'), 'utf8'));

function driverCmd() {
  const custom = process.env.FLASH_AGENT_BROWSER;
  if (custom) { const [cmd, ...pre] = custom.trim().split(/\s+/); return { cmd, pre }; }
  return { cmd: 'agent-browser', pre: [] };
}

function openUrl(url) {
  const { cmd, pre } = driverCmd();
  execFileSync(cmd, [...pre, '--session', SESSION, 'open', url], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
}

fs.mkdirSync(OUT, { recursive: true });
const results = [];
for (const p of PAGES) {
  const dest = path.join(OUT, `${p.slug}.json`);
  if (fs.existsSync(dest) && !process.argv.includes('--force')) { console.log(`skip (exists): ${p.slug}`); results.push({ slug: p.slug, ok: true, skipped: true }); continue; }
  try {
    openUrl(p.url);
    const snap = agentBrowser.snapshot(SESSION);
    if (!snap.ok) throw new Error(snap.error);
    fs.writeFileSync(dest, JSON.stringify(snap.page, null, 2));
    console.log(`ok: ${p.slug}  (${snap.page.refs.length} refs)  ${snap.page.url}`);
    results.push({ slug: p.slug, ok: true, refs: snap.page.refs.length });
  } catch (e) {
    console.error(`FAIL: ${p.slug}: ${e.message}`);
    results.push({ slug: p.slug, ok: false, error: e.message });
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} captured.`);
if (failed.length) console.log('failed: ' + failed.map((f) => f.slug).join(', '));
