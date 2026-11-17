#!/usr/bin/env node
// Manages Session Factory's observe-only hooks in clean-room/.claude/settings.local.json.
//   node scripts/hooks.mjs status   show whether the hooks are installed
//   node scripts/hooks.mjs backup   save the current file to data/ (done automatically by install)
//   node scripts/hooks.mjs install  add the hooks block (the file must not already have a "hooks" key)
//   node scripts/hooks.mjs remove   restore the backup byte-for-byte, or, if the file was edited since
//                                   install, remove only the "hooks" key
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settings = path.resolve(repo, '..', '.claude', 'settings.local.json');
const backup = path.join(repo, 'data', 'settings.local.json.orig');
const command = path.join(repo, 'hooks', 'emit-event');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];

export function hooksBlock() {
  return Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command, timeout: 5 }] }]]));
}

function installed() {
  const cfg = JSON.parse(fs.readFileSync(settings, 'utf8'));
  return JSON.stringify(cfg.hooks ?? {}).includes(command);
}

function doBackup() {
  if (fs.existsSync(backup)) return console.log(`backup already exists: ${backup}`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(settings, backup);
  console.log(`saved ${settings} -> ${backup}`);
}

const cmd = process.argv[2] ?? 'status';
if (cmd === 'status') {
  console.log(`${settings}: hooks ${installed() ? 'INSTALLED' : 'not installed'}; backup ${fs.existsSync(backup) ? 'present' : 'absent'}`);
} else if (cmd === 'backup') {
  doBackup();
} else if (cmd === 'install') {
  const cfg = JSON.parse(fs.readFileSync(settings, 'utf8'));
  if (cfg.hooks) {
    console.error('settings.local.json already has a "hooks" key; not touching it.');
    process.exit(1);
  }
  doBackup();
  cfg.hooks = hooksBlock();
  fs.writeFileSync(settings, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`added ${EVENTS.length} hook entries to ${settings}`);
} else if (cmd === 'remove') {
  if (!fs.existsSync(backup)) {
    console.error(`no backup at ${backup}; remove the "hooks" key from ${settings} by hand.`);
    process.exit(1);
  }
  const current = JSON.parse(fs.readFileSync(settings, 'utf8'));
  delete current.hooks;
  const original = JSON.parse(fs.readFileSync(backup, 'utf8'));
  if (JSON.stringify(current) === JSON.stringify(original)) {
    fs.copyFileSync(backup, settings);
    console.log(`restored ${settings} byte-for-byte from backup`);
  } else {
    fs.writeFileSync(settings, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`${settings} changed since install; removed only the "hooks" key and kept your other edits`);
  }
  fs.unlinkSync(backup);
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
