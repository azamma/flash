#!/usr/bin/env node
// npx installer for the Flash Claude Code skill.
//   npx github:azamma/flash            install skill + set Jev key once (--provider openrouter to use OpenRouter)
//   npx github:azamma/flash uninstall  remove the skill
//   npx github:azamma/flash <cmd>      run any flash command (status, filter, classify, ...)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(PKG, 'skills', 'flash');
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DEST = path.join(CLAUDE, 'skills', 'flash');
const FLASH = path.join(DEST, 'scripts', 'flash.mjs');

const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const run = (args, opts = {}) => spawnSync(process.execPath, [FLASH, ...args], { stdio: 'inherit', ...opts }).status ?? 1;

const [cmd = 'install', ...rest] = process.argv.slice(2);

if (cmd === 'install') {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) { console.error('Flash needs Node 18 or newer.'); process.exit(1); }
  fs.mkdirSync(DEST, { recursive: true });
  fs.cpSync(SRC, DEST, { recursive: true });
  console.log(`${c('36', '⚡ flash')} skill installed → ${DEST}`);

  const flag = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : '');
  const keyFlag = flag('key');
  const prov = flag('provider') ? ['--provider', flag('provider')] : [];
  const ready = spawnSync(process.execPath, [FLASH, 'status', ...prov], { stdio: 'ignore' }).status === 0;
  const keyHelp = `TypeSafe key from https://console.typesafe.ai, or OpenRouter key from https://openrouter.ai/settings/keys with --provider openrouter`;
  if (keyFlag) run(['setup', keyFlag, ...prov]);
  else if (!ready) {
    if (process.stdin.isTTY) {
      console.log(`\nOne-time setup: paste your Jev API key (${keyHelp}).`);
      if (run(['setup', ...prov]) !== 0) console.log(`\nNo key saved. Run later: npx github:azamma/flash setup [--provider openrouter]`);
    } else {
      console.log(`\nNext: set your Jev key once →  npx github:azamma/flash setup [--provider openrouter]   (${keyHelp})`);
    }
  } else run(['status', ...prov]);
  console.log(`\n${c('32', 'Done.')} Restart Claude Code (or start a new session). Claude now delegates bulk judgment calls to Jev automatically.`);
  console.log(`Try asking: "which files in this repo handle auth?" or "find the errors in app.log".`);
} else if (cmd === 'uninstall') {
  fs.rmSync(DEST, { recursive: true, force: true });
  console.log(`Removed ${DEST}. Your key stays in ~/.flash/config.json. Delete that folder to remove it.`);
} else {
  if (!fs.existsSync(FLASH)) {
    const local = path.join(SRC, 'scripts', 'flash.mjs');
    process.exit(spawnSync(process.execPath, [local, cmd, ...rest], { stdio: 'inherit' }).status ?? 1);
  }
  process.exit(run([cmd, ...rest]));
}
