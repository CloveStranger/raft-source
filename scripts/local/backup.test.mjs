import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keygen, pack, unpack, encrypt, decrypt, split, join, validateBundle } from './archive.mjs';
import { writeJson, hash, run } from './common.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raft-files-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'files/.git'), { recursive: true });
  await fs.mkdir(path.join(dir, 'files/.runtime'), { recursive: true });
  await fs.writeFile(path.join(dir, 'files/.git/HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(dir, 'files/.runtime/auth.json'), '{"test":"credential"}', { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'files/avatar.webp'), Buffer.from([0,255,1,2,4]));
  await fs.writeFile(path.join(dir, 'files/work.sh'), '#!/bin/sh\necho test', { mode: 0o755 });
  await fs.symlink('avatar.webp', path.join(dir, 'files/avatar-link'));
  await writeJson(path.join(dir, 'spec.json'), { roots: [{name:'files',path:path.join(dir,'files')}], metadata: {} });
  await keygen(path.join(dir, 'key')); await keygen(path.join(dir, 'wrong'));
  return dir;
}
test('complete authenticated archive roundtrip preserves binary, hidden files, executable and links', async t => {
  const d = await fixture(t);
  await pack(d+'/spec.json', d+'/data.tar.gz');
  await encrypt(d+'/data.tar.gz', d+'/data.enc', d+'/key');
  await split(d+'/data.enc', d+'/bundle', 128);
  assert.ok((await validateBundle(d+'/bundle')).chunks.length > 1);
  await join(d+'/bundle', d+'/joined');
  await decrypt(d+'/joined', d+'/verified.tar.gz', d+'/key');
  await unpack(d+'/verified.tar.gz', d+'/restored');
  for (const f of ['avatar.webp','.git/HEAD','.runtime/auth.json','work.sh'])
    assert.equal(await hash(d+'/files/'+f), await hash(d+'/restored/files/'+f));
  assert.equal((await fs.stat(d+'/restored/files/work.sh')).mode & 0o777, 0o755);
  assert.equal(await fs.readlink(d+'/restored/files/avatar-link'), 'avatar.webp');
  await assert.rejects(unpack(d+'/verified.tar.gz', d+'/restored'));
});
test('wrong key and corrupted ciphertext never release unauthenticated plaintext', async t => {
  const d = await fixture(t);
  await pack(d+'/spec.json', d+'/data.tar.gz');
  await encrypt(d+'/data.tar.gz', d+'/data.enc', d+'/key');
  await assert.rejects(decrypt(d+'/data.enc', d+'/plain', d+'/wrong'));
  await assert.rejects(fs.access(d+'/plain')); await assert.rejects(fs.access(d+'/plain.unauthenticated'));
  const bytes = await fs.readFile(d+'/data.enc'); bytes[25] ^= 1; await fs.writeFile(d+'/data.enc', bytes);
  await assert.rejects(decrypt(d+'/data.enc', d+'/plain', d+'/key'));
  await fs.writeFile(d+'/data.enc', bytes.subarray(0, 30));
  await assert.rejects(decrypt(d+'/data.enc', d+'/plain', d+'/key'));
});
test('missing/damaged/reordered chunks fail before restore', async t => {
  const d = await fixture(t); await pack(d+'/spec.json', d+'/tar');
  await encrypt(d+'/tar', d+'/enc', d+'/key'); await split(d+'/enc', d+'/bundle', 128);
  await fs.unlink(d+'/bundle/data-0001.raftbackup');
  await assert.rejects(join(d+'/bundle', d+'/joined')); await assert.rejects(fs.access(d+'/joined'));
});
test('external symlinks and omitted worktree metadata cannot silently disappear', async t => {
  const d = await fixture(t);
  await fs.symlink('../key', d+'/files/outside');
  await assert.rejects(pack(d+'/spec.json', d+'/tar'));
  await fs.unlink(d+'/files/outside'); await fs.rm(d+'/files/.git', { recursive:true });
  await fs.writeFile(d+'/files/.git', 'gitdir: ../../unlisted/.git/worktrees/test\n');
  await assert.rejects(pack(d+'/spec.json', d+'/tar2'));
});
test('unsafe extraction paths and symlink escapes rejected before creating target', async t => {
  const d = await fixture(t);
  for (const [name, member, link] of [['traversal','../escaped',''],['symlink','link','../escaped']]) {
    await run('python3', ['-c', 'import tarfile,sys; a=tarfile.open(sys.argv[1],"w:gz"); t=tarfile.TarInfo(sys.argv[2]); t.type=tarfile.SYMTYPE if sys.argv[3] else tarfile.REGTYPE; t.linkname=sys.argv[3]; a.addfile(t); a.close()', d+'/'+name+'.tar',member,link]);
    await assert.rejects(unpack(d+'/'+name+'.tar', d+'/'+name));
    await assert.rejects(fs.access(d+'/'+name));
  }
});

test('unreadable registered directory fails the backup instead of silently omitting files', async t => {
  const d = await fixture(t);
  await assert.rejects(run(process.env.RAFT_PYTHON || 'python3', ['-c', `
import os,runpy,sys
from unittest.mock import patch
module=runpy.run_path(sys.argv[1])
with patch.object(os,'scandir',side_effect=PermissionError('fixture unreadable directory')):
    module['pack'](sys.argv[2],sys.argv[3])
`, path.resolve('scripts/local/archive.py'), d+'/spec.json', d+'/failed.tar']), error => {
    assert.match(error.details, /PermissionError: fixture unreadable directory/);
    return true;
  });
});
