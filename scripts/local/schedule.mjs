#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, load } from './common.mjs';
import { backup } from './backup.mjs';
const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function plist(args, env, state) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>local.raft.backup</string>
<key>ProgramArguments</key><array>${args.map(x => `<string>${xml(x)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>StartInterval</key><integer>86400</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(state, 'backup.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(state, 'backup.log'))}</string>
</dict></plist>\n`;
}
export async function main([command, state, key, outputs, file]) {
  if (!state || !key || !outputs) throw new Error('Usage: schedule.mjs render STATE KEY OUTPUT_BASE PLIST | run STATE KEY OUTPUT_BASE');
  const ctx = await load(state);
  if (!ctx.config.backupRepo) throw new Error('Set backupRepo to your independent private repository');
  key = path.resolve(key); outputs = path.resolve(outputs);
  if (command === 'run') {
    await fs.mkdir(outputs, { recursive: true, mode: 0o700 });
    await backup(ctx.state, key, path.join(outputs, new Date().toISOString().replace(/[:.]/g, '-')), { upload: true });
  } else if (command === 'render' && file) {
    const args = [process.execPath, path.join(ROOT, 'scripts/local/schedule.mjs'), 'run', ctx.state, key, outputs];
    const env = { PATH: process.env.PATH, ...(process.env.RAFT_DOCKER ? { RAFT_DOCKER: process.env.RAFT_DOCKER } : {}),
      ...(process.env.RAFT_GH ? { RAFT_GH: process.env.RAFT_GH } : {}), ...(process.env.RAFT_PYTHON ? { RAFT_PYTHON: process.env.RAFT_PYTHON } : {}) };
    await fs.writeFile(file, plist(args, env, ctx.state), { flag: 'wx', mode: 0o600 });
    console.log('Schedule written, not activated. Review it, then use launchctl bootstrap.');
  } else throw new Error('Unknown schedule command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
