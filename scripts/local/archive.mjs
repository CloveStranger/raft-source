import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { ROOT, run, hash, json, writeJson, emptyDirectory } from './common.mjs';
const MAGIC = Buffer.from('RAFTBK01');
export async function keygen(file) {
  await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
}
async function key(file) {
  const s = await fs.stat(file);
  if ((s.mode & 0o077) !== 0) throw new Error('Backup key must have mode 0600');
  const k = await fs.readFile(file);
  if (k.length !== 32) throw new Error('Expected a 32-byte backup key');
  return k;
}
export async function encrypt(source, dest, keyFile) {
  const header = Buffer.concat([MAGIC, randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', await key(keyFile), header.subarray(8));
  cipher.setAAD(header);
  await fs.writeFile(dest, header, { flag: 'wx', mode: 0o600 });
  await pipeline(createReadStream(source), cipher, createWriteStream(dest, { flags: 'a' }));
  await fs.appendFile(dest, cipher.getAuthTag());
}
export async function decrypt(source, dest, keyFile) {
  const s = await fs.stat(source);
  if (s.size <= 36) throw new Error('Truncated encrypted backup');
  const file = await fs.open(source, 'r');
  const header = Buffer.alloc(20), tag = Buffer.alloc(16);
  try { await file.read(header, 0, 20, 0); await file.read(tag, 0, 16, s.size - 16); }
  finally { await file.close(); }
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Unknown backup format');
  const cipher = createDecipheriv('aes-256-gcm', await key(keyFile), header.subarray(8));
  cipher.setAAD(header); cipher.setAuthTag(tag);
  // Authentication must finish before this file is ever passed to tar.
  const partial = dest + '.unauthenticated';
  try {
    await pipeline(createReadStream(source, { start: 20, end: s.size - 17 }), cipher,
      createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    await fs.link(partial, dest);
  } finally { await fs.rm(partial, { force: true }); }
}
export const pack = (spec, out) => run(process.env.RAFT_PYTHON || 'python3', [path.join(ROOT, 'scripts/local/archive.py'), 'pack', spec, out]);
export const unpack = (src, out) => run(process.env.RAFT_PYTHON || 'python3', [path.join(ROOT, 'scripts/local/archive.py'), 'unpack', src, out]);
export async function split(source, output, chunkBytes = 1024 ** 3) {
  await emptyDirectory(output);
  const chunks = [];
  const input = await fs.open(source, 'r');
  const size = (await input.stat()).size;
  if (Math.ceil(size / chunkBytes) > 999) throw new Error('Snapshot exceeds GitHub Release asset count');
  try {
    let position = 0;
    while (position < size) {
      const name = `data-${String(chunks.length).padStart(4, '0')}.raftbackup`;
      const target = path.join(output, name), bytes = Math.min(chunkBytes, size - position);
      await pipeline(createReadStream(source, { start: position, end: position + bytes - 1 }),
        createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      chunks.push({ name, bytes, sha256: await hash(target) });
      position += bytes;
    }
  } finally { await input.close(); }
  await writeJson(path.join(output, 'snapshot.json'), { format: 1, algorithm: 'aes-256-gcm', chunks });
}
export async function validateBundle(dir) {
  const m = await json(path.join(dir, 'snapshot.json'));
  if (m.format !== 1 || m.algorithm !== 'aes-256-gcm' || !m.chunks?.length || m.chunks.length > 999) throw new Error('Invalid snapshot manifest');
  for (const [i, c] of m.chunks.entries()) {
    if (c.name !== `data-${String(i).padStart(4, '0')}.raftbackup`) throw new Error('Invalid chunk order');
    const file = path.join(dir, c.name), st = await fs.lstat(file);
    if (!st.isFile() || st.size !== c.bytes || c.bytes > 1024 ** 3 || await hash(file) !== c.sha256) throw new Error('Missing or damaged backup chunk');
  }
  const first = await fs.open(path.join(dir, m.chunks[0].name), 'r');
  const header = Buffer.alloc(8);
  try { await first.read(header, 0, 8, 0); } finally { await first.close(); }
  if (!header.equals(MAGIC)) throw new Error('Snapshot is not an encrypted Raft backup');
  if ((await fs.readdir(dir)).sort().join('\n') !== ['snapshot.json', ...m.chunks.map(c => c.name)].sort().join('\n')) throw new Error('Unexpected snapshot files');
  return m;
}
export async function join(dir, dest) {
  const m = await validateBundle(dir);
  await fs.writeFile(dest, '', { flag: 'wx', mode: 0o600 });
  for (const c of m.chunks) await pipeline(createReadStream(path.join(dir, c.name)), createWriteStream(dest, { flags: 'a' }));
}
