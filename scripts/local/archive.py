"""Full file inventory and safe tar extraction; Python >=3.12, stdlib only."""
import hashlib
import io
import json
import os
import posixpath
from pathlib import Path, PurePosixPath
import stat
import sys
import tarfile


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def scan_error(error):
    raise error


def pack(spec_path, output):
    spec = json.loads(Path(spec_path).read_text())
    roots = spec['roots']
    physical = [Path(r['path']).resolve(strict=True) for r in roots]
    inventory = []
    excluded = []
    with tarfile.open(output, 'x:gz', dereference=False) as archive:
        for root, base in zip(roots, physical):
            name = root['name']
            if not name.replace('-', '').isalnum():
                raise ValueError('Invalid archive root name')
            if not base.is_dir():
                raise ValueError(f'Required directory missing: {base}')
            for folder, dirs, files in os.walk(base, followlinks=False, onerror=scan_error):
                for leaf in sorted(dirs + files):
                    source = Path(folder) / leaf
                    relative = source.relative_to(base)
                    # Computer run/ consists of process identities, locks and IPC sockets.
                    if root.get('computer') and relative.parts[:2] == ('computer', 'run'):
                        excluded.append(f'{name}/{relative}')
                        if leaf in dirs:
                            dirs.remove(leaf)
                        continue
                    info = source.lstat()
                    arcname = f'{name}/{relative.as_posix()}'
                    if '\n' in arcname or info.st_mode & 0o6000:
                        raise ValueError(f'Unsupported name or privileged mode: {source}')
                    entry = {'path': arcname, 'mode': stat.S_IMODE(info.st_mode)}
                    if stat.S_ISLNK(info.st_mode):
                        target = os.readlink(source)
                        resolved = source.resolve()
                        if os.path.isabs(target) or not resolved.is_relative_to(base):
                            target_root = next((r for r, p in zip(roots, physical) if resolved.is_relative_to(p)), None)
                            if target_root is None or not resolved.exists():
                                raise ValueError(f'External symlink requires a registered data root: {source}')
                            target_base = physical[roots.index(target_root)]
                            relative_target = resolved.relative_to(target_base).as_posix()
                            archived_target = f"{target_root['name']}/{relative_target}"
                            entry.update(targetRoot=target_root['name'], targetPath=relative_target, originalTarget=target)
                            target = posixpath.relpath(archived_target, posixpath.dirname(arcname))
                        entry.update(type='symlink', target=target)
                    elif stat.S_ISDIR(info.st_mode):
                        entry.update(type='directory')
                    elif stat.S_ISREG(info.st_mode):
                        if leaf == '.git':
                            text = source.read_text()
                            if text.startswith('gitdir:'):
                                gitdir = (source.parent / text[7:].strip()).resolve()
                                if not any(gitdir.is_relative_to(p) for p in physical):
                                    raise ValueError(f'Git worktree metadata is outside registered roots: {source}')
                        entry.update(type='file', size=info.st_size, sha256=digest(source))
                    else:
                        raise ValueError(f'Unsupported active socket/device; stop its writer: {source}')
                    inventory.append(entry)
                    if entry['type'] == 'symlink':
                        member = archive.gettarinfo(source, arcname=arcname)
                        member.linkname = entry['target']
                        archive.addfile(member)
                    else:
                        archive.add(source, arcname=arcname, recursive=False)
        version = 2 if spec['metadata'].get('redisSnapshot') or any('targetRoot' in e for e in inventory) else 1
        manifest = {**spec['metadata'], 'format': version, 'roots': roots, 'files': inventory, 'excluded': excluded}
        payload = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
        info = tarfile.TarInfo('manifest.json')
        info.size, info.mode = len(payload), 0o600
        archive.addfile(info, io.BytesIO(payload))
    os.chmod(output, 0o600)


def unpack(source, destination):
    destination = Path(destination)
    if destination.exists():
        raise ValueError('Restore target must not exist')
    with tarfile.open(source, 'r:gz') as archive:
        members = archive.getmembers()
        names = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or member.name in names:
                raise ValueError('Unsafe or duplicate archive path')
            names.add(member.name)
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Unsupported archive member')
            if member.mode & 0o6000:
                raise ValueError('Privileged archive member')
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                if target.is_absolute():
                    raise ValueError('Absolute archive link')
                origin = destination / member.name
                resolved = (origin.parent / member.linkname).resolve() if member.issym() else (destination / member.linkname).resolve()
                if not resolved.is_relative_to(destination.resolve()):
                    raise ValueError('Escaping archive link')
        destination.mkdir(mode=0o700)
        archive.extractall(destination, filter='data')
    manifest = json.loads((destination / 'manifest.json').read_text())
    if manifest['format'] not in (1, 2):
        raise ValueError('Unsupported inventory')
    expected = {f['path'] for f in manifest['files']} | {'manifest.json'}
    # Root directories are implicit and can be absent for an empty data root.
    actual = {str(p.relative_to(destination)) for p in destination.rglob('*')}
    root_names = {r['name'] for r in manifest['roots']}
    if len(root_names) != len(manifest['roots']) or any(not n.replace('-', '').isalnum() for n in root_names):
        raise ValueError('Invalid inventory root')
    if actual - root_names != expected:
        raise ValueError('Inventory does not match archive contents')
    for entry in manifest['files']:
        p = destination / entry['path']
        if entry['type'] == 'file':
            if p.is_symlink() or not p.is_file() or digest(p) != entry['sha256']:
                raise ValueError('Restored file hash mismatch')
            os.chmod(p, entry['mode'])
        elif entry['type'] == 'symlink':
            if not p.is_symlink() or os.readlink(p) != entry['target']:
                raise ValueError('Restored symlink mismatch')
        elif not p.is_dir() or p.is_symlink():
            raise ValueError('Restored directory mismatch')
    for name in root_names:
        (destination / name).mkdir(mode=0o700, exist_ok=True)
    # The authenticated mapping must describe precisely the same link as tar.
    for entry in manifest['files']:
        keys = {'targetRoot', 'targetPath', 'originalTarget'}
        if not keys.intersection(entry):
            if entry['type'] == 'symlink':
                source_root = PurePosixPath(entry['path']).parts[0]
                archive_target = posixpath.normpath(posixpath.join(posixpath.dirname(entry['path']), entry['target']))
                if PurePosixPath(archive_target).parts[0] != source_root:
                    raise ValueError('Missing registered link mapping')
            continue
        if not keys.issubset(entry) or entry['type'] != 'symlink' or any(not isinstance(entry[k], str) for k in keys):
            raise ValueError('Invalid registered link mapping')
        target_root = entry['targetRoot']
        relative = PurePosixPath(entry['targetPath'])
        if target_root not in root_names or relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Invalid registered link target')
        actual_target = posixpath.normpath(posixpath.join(posixpath.dirname(entry['path']), entry['target']))
        expected_target = posixpath.normpath(f"{target_root}/{relative}")
        if actual_target != expected_target:
            raise ValueError('Registered link contradicts archive target')
        root = (destination / target_root).resolve()
        resolved = (destination / entry['path']).resolve(strict=True)
        if not resolved.is_relative_to(root) or not root.is_relative_to(destination.resolve()):
            raise ValueError('Registered link escapes target root')
    # Preserve directory modes after their children have been written.
    for entry in reversed(manifest['files']):
        if entry['type'] == 'directory':
            os.chmod(destination / entry['path'], entry['mode'])


if __name__ == '__main__':
    if not hasattr(tarfile, 'data_filter'):
        raise RuntimeError('Python 3.12+ is required')
    {'pack': pack, 'unpack': unpack}[sys.argv[1]](*sys.argv[2:])
