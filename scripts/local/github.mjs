import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gh, run, emptyDirectory } from './common.mjs';
import { validateBundle } from './archive.mjs';
export async function privateRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.toLowerCase().endsWith('/raft-source')) throw new Error('Use an independent private backup repository');
  const result = JSON.parse(await run(gh, ['repo', 'view', repo, '--json', 'nameWithOwner,isPrivate']));
  if (result.isPrivate !== true || result.nameWithOwner.toLowerCase() !== repo.toLowerCase()) throw new Error('Backup repository must be private');
}
export async function publish(dir, repo) {
  const manifest = await validateBundle(dir);
  await privateRepo(repo);
  const tag = 'backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
  await run(gh, ['release', 'create', tag, '--repo', repo, '--draft', '--title', tag, '--notes', 'Encrypted complete Raft snapshot. Keep the decryption key offline.']);
  const names = ['snapshot.json', ...manifest.chunks.map(c => c.name)];
  for (const name of names) await run(gh, ['release', 'upload', tag, path.join(dir, name), '--repo', repo]);
  const release = JSON.parse(await run(gh, ['release', 'view', tag, '--repo', repo, '--json', 'assets,isDraft']));
  if (!release.isDraft || release.assets.length !== names.length) throw new Error(`Incomplete draft retained: ${tag}`);
  for (const name of names) {
    const asset = release.assets.find(a => a.name === name);
    if (!asset || asset.size !== (await fs.stat(path.join(dir, name))).size) throw new Error(`Asset verification failed; draft retained: ${tag}`);
  }
  await privateRepo(repo);
  await run(gh, ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest=false']);
  return tag;
}
export async function download(repo, tag, output) {
  await privateRepo(repo);
  if (!/^backup-[A-Za-z0-9.-]+$/.test(tag)) throw new Error('Specify a backup release tag');
  const r = JSON.parse(await run(gh, ['release', 'view', tag, '--repo', repo, '--json', 'isDraft']));
  if (r.isDraft) throw new Error('Draft is not a complete backup');
  await emptyDirectory(output);
  await run(gh, ['release', 'download', tag, '--repo', repo, '--dir', output]);
  await validateBundle(output);
}
