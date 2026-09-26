#!/usr/bin/env python3
"""Audited, same-directory migration of proven whole-second photo names.

Input decisions are JSON [{"source": absolute_path, "selectedValue": "YYYY-MM-DDTHH:MM:SS"}].
Only decisions established by the current metadata review should be supplied.
No time is inferred from a date-only name. Historical META Mover journals stay untouched.
"""

import argparse
import ctypes
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
from contextlib import contextmanager


class MigrationError(RuntimeError):
    pass


DATE_ONLY = re.compile(r'^(\d{4}-\d{2}-\d{2})(?:_\d+)?(\.[A-Za-z0-9]+)$')
SECOND = re.compile(r'^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$')
RENAME_NOREPLACE = 1
LIBC = ctypes.CDLL(None, use_errno=True)
RENAMEAT2 = getattr(LIBC, 'renameat2', None)
if RENAMEAT2 is not None:
    RENAMEAT2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    RENAMEAT2.restype = ctypes.c_int


def _identity(info):
    return {'dev': info.st_dev, 'ino': info.st_ino, 'nlink': info.st_nlink,
            'size': info.st_size, 'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns,
            'mode': info.st_mode}


STABLE_IDENTITY_KEYS = ('dev', 'ino', 'nlink', 'size', 'mtimeNs', 'mode')


def _same_identity(observed, expected, moved):
    keys = STABLE_IDENTITY_KEYS if moved else tuple(expected)
    return observed is not None and all(observed[key] == expected[key] for key in keys)


def _same_parent(observed, expected):
    return all(observed[key] == expected[key] for key in ('dev', 'ino', 'mode'))


def _digest(manifest):
    encoded = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest()


def _lstat(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def _regular_identity(path):
    info = _lstat(path)
    if info is None or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise MigrationError(f'Expected single-link regular source: {path}')
    return _identity(info)


def _canonical_root(root):
    root = pathlib.Path(root)
    if not root.is_absolute() or root.resolve() != root or not root.is_dir():
        raise MigrationError('Output root must be an existing canonical absolute directory')
    return root


def _bound_file(root, raw):
    file = pathlib.Path(raw)
    if not file.is_absolute() or file.parent == file or root not in file.parents:
        raise MigrationError(f'File is outside output root: {raw}')
    if file.resolve(strict=False) != file:
        raise MigrationError(f'Symlink or noncanonical path: {raw}')
    cursor = file.parent
    while cursor != root:
        info = _lstat(cursor)
        if info is None or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise MigrationError(f'Unsafe ancestor: {cursor}')
        cursor = cursor.parent
    return file


def _selected_name(source, selected):
    source_match = DATE_ONLY.fullmatch(source.name)
    selected_match = SECOND.fullmatch(selected)
    if not source_match or not selected_match or source_match.group(1) != selected_match.group(1):
        raise MigrationError(f'Whole-second selection does not match date-only source: {source}')
    try:
        datetime.datetime.strptime(selected, '%Y-%m-%dT%H:%M:%S')
    except ValueError as error:
        raise MigrationError(f'Invalid selected time: {selected}') from error
    return f'{source_match.group(1)}_{selected_match.group(2)}-{selected_match.group(3)}-{selected_match.group(4)}{source_match.group(2)}'


def _decision_value(decision):
    value = decision['selectedValue']
    if isinstance(value, dict):
        if (decision.get('status') != 'resolved' or
                decision.get('confidence') not in ('high', 'medium') or
                value.get('precision') != 'second' or
                value.get('zoneBasis') == 'date-only'):
            raise MigrationError(f'Decision is not a resolved whole-second time: {decision.get("sourcePath")}')
        return value['localIso']
    if isinstance(value, str):
        return value
    raise MigrationError('selectedValue must be a string or resolved value object')


def plan(root, decisions):
    root = _canonical_root(root)
    if not isinstance(decisions, list):
        raise MigrationError('Decisions must be a JSON list')
    entries = []
    reserved = set()
    seen = set()
    for decision in sorted(decisions, key=lambda item: item.get('sourcePath', item.get('source', ''))):
        source = _bound_file(root, decision.get('sourcePath', decision.get('source')))
        if str(source) in seen:
            raise MigrationError(f'Duplicate source: {source}')
        seen.add(str(source))
        selected = _decision_value(decision)
        base_name = _selected_name(source, selected)
        identity = _regular_identity(source)
        if 'sourceSize' in decision and decision['sourceSize'] != identity['size']:
            raise MigrationError(f'Decision source size is stale: {source}')
        if 'sourceMtimeNs' in decision and decision['sourceMtimeNs'] != identity['mtimeNs']:
            raise MigrationError(f'Decision source mtime is stale: {source}')
        if 'sourceMtimeMs' in decision and abs(
            decision['sourceMtimeMs'] - identity['mtimeNs'] / 1_000_000
        ) > 0.01:
            raise MigrationError(f'Decision source mtime is stale: {source}')
        stem, extension = os.path.splitext(base_name)
        counter = 0
        while True:
            name = base_name if counter == 0 else f'{stem}_{counter}{extension}'
            target = source.parent / name
            if str(target) not in reserved and _lstat(target) is None:
                break
            counter += 1
        reserved.add(str(target))
        evidence = {key: decision[key] for key in (
            'selectedCandidateId', 'selectedTag', 'reasonCodes', 'candidateCount',
            'evidenceSha256', 'decisionSha256', 'evaluationTimeUtc', 'policyVersion'
        ) if key in decision}
        entries.append({'source': str(source), 'target': str(target),
                        'selectedValue': selected, 'identity': identity,
                        'parentIdentity': _identity(os.lstat(source.parent)),
                        'decisionEvidence': evidence})
    return {'schemaVersion': 1, 'root': str(root), 'entries': entries}


def _validate_structure(manifest):
    if manifest.get('schemaVersion') != 1 or not isinstance(manifest.get('entries'), list):
        raise MigrationError('Unsupported manifest')
    root = _canonical_root(manifest['root'])
    sources = set()
    targets = set()
    for row in manifest['entries']:
        source = _bound_file(root, row['source'])
        target = _bound_file(root, row['target'])
        if source.parent != target.parent or target.name != _selected_name(source, row['selectedValue']) and not re.fullmatch(re.escape(os.path.splitext(_selected_name(source, row['selectedValue']))[0]) + r'_\d+' + re.escape(source.suffix), target.name):
            raise MigrationError(f'Invalid target: {target}')
        if not _same_parent(_identity(os.lstat(source.parent)), row['parentIdentity']):
            raise MigrationError(f'Directory changed: {source.parent}')
        if str(source) in sources or str(target) in targets or source == target:
            raise MigrationError('Duplicate or self-conflicting manifest paths')
        sources.add(str(source))
        targets.add(str(target))
    if sources & targets:
        raise MigrationError('Manifest source and target sets overlap')
    return root


def _validate_manifest(manifest, moved=False):
    _validate_structure(manifest)
    for row in manifest['entries']:
        source = pathlib.Path(row['source'])
        target = pathlib.Path(row['target'])
        present = target if moved else source
        if not _same_identity(_regular_identity(present), row['identity'], moved):
            raise MigrationError(f'Stale identity: {present}')
        other = source if moved else target
        if _lstat(other) is not None:
            raise MigrationError(f'No-clobber target exists: {other}')


def _rename_no_replace(root, source, target, identity, parent_identity, moved):
    if RENAMEAT2 is None or sys.platform != 'linux':
        raise MigrationError('Linux renameat2(RENAME_NOREPLACE) is unavailable')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent_fd = os.open(root, flags)
    try:
        if source.parent != target.parent:
            raise MigrationError('Cross-directory rename is forbidden')
        for component in source.parent.relative_to(root).parts:
            next_fd = os.open(component, flags, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = next_fd
        if not _same_parent(_identity(os.fstat(parent_fd)), parent_identity):
            raise MigrationError(f'Directory changed before rename: {source.parent}')
        observed = _identity(os.stat(source.name, dir_fd=parent_fd, follow_symlinks=False))
        if not stat.S_ISREG(observed['mode']) or not _same_identity(observed, identity, moved):
            raise MigrationError(f'Source changed before rename: {source}')
        result = RENAMEAT2(parent_fd, os.fsencode(source.name), parent_fd,
                           os.fsencode(target.name), RENAME_NOREPLACE)
        if result != 0:
            number = ctypes.get_errno()
            raise OSError(number, os.strerror(number), str(target))
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def _ledger_append(handle, record):
    handle.write(json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n')
    handle.flush()
    os.fsync(handle.fileno())


def _read_ledger(ledger):
    with open(ledger, 'r+b') as handle:
        raw = handle.read()
        if raw and not raw.endswith(b'\n'):
            complete = raw.rfind(b'\n') + 1
            handle.truncate(complete)
            handle.flush()
            os.fsync(handle.fileno())
            raw = raw[:complete]
    return [json.loads(line) for line in raw.splitlines() if line]


@contextmanager
def _exclusive_ledger(ledger):
    lock_path = str(ledger) + '.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _journaled_rename(manifest, ledger, reverse):
    _validate_manifest(manifest, moved=reverse)
    if RENAMEAT2 is None or sys.platform != 'linux':
        raise MigrationError('Linux renameat2(RENAME_NOREPLACE) is unavailable')
    ledger = pathlib.Path(ledger)
    if ledger.exists() and not reverse:
        raise MigrationError('Ledger already exists; recover or rollback before another apply')
    if reverse:
        events = _read_ledger(ledger)
        if not events or events[0].get('status') != 'start' or events[0].get('digest') != _digest(manifest):
            raise MigrationError('Ledger does not match exact manifest')
        moved = [event['index'] for event in events if event.get('status') == 'moved']
        if sorted(moved) != list(range(len(manifest['entries']))) or any(
            event.get('status') in ('rollback-intent', 'rolled-back') for event in events
        ):
            raise MigrationError('Ledger does not prove all manifest moves')
    flags = 'a' if reverse else 'x'
    with open(ledger, flags, encoding='utf-8') as handle:
        if not reverse:
            _ledger_append(handle, {'status': 'start', 'digest': _digest(manifest), 'manifest': manifest})
            directory_fd = os.open(ledger.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        for index, row in enumerate(manifest['entries']):
            source = pathlib.Path(row['target'] if reverse else row['source'])
            target = pathlib.Path(row['source'] if reverse else row['target'])
            _ledger_append(handle, {'status': 'rollback-intent' if reverse else 'intent', 'index': index})
            _bound_file(_canonical_root(manifest['root']), source)
            _bound_file(_canonical_root(manifest['root']), target)
            _rename_no_replace(_canonical_root(manifest['root']), source, target,
                               row['identity'], row['parentIdentity'], reverse)
            _ledger_append(handle, {'status': 'rolled-back' if reverse else 'moved', 'index': index})


def apply(manifest, ledger):
    with _exclusive_ledger(ledger):
        _journaled_rename(manifest, ledger, False)


def rollback(manifest, ledger):
    with _exclusive_ledger(ledger):
        _journaled_rename(manifest, ledger, True)


def _recover(manifest, ledger):
    """Resume an interrupted forward apply after reconciling each journal intent."""
    root = _validate_structure(manifest)
    events = _read_ledger(ledger)
    if not events or events[0].get('status') != 'start' or events[0].get('digest') != _digest(manifest):
        raise MigrationError('Ledger does not match exact manifest')
    states = {}
    for event in events[1:]:
        if event.get('status') not in ('intent', 'moved', 'rollback-intent', 'rolled-back') or event.get('index') not in range(len(manifest['entries'])):
            raise MigrationError('Ledger has unexpected state')
        states[event['index']] = event['status']
    if RENAMEAT2 is None or sys.platform != 'linux':
        raise MigrationError('Linux renameat2(RENAME_NOREPLACE) is unavailable')
    with open(ledger, 'a', encoding='utf-8') as handle:
        reverse = any(state in ('rollback-intent', 'rolled-back') for state in states.values())
        for index, row in enumerate(manifest['entries']):
            source = _bound_file(root, row['source'])
            target = _bound_file(root, row['target'])
            source_info = _lstat(source)
            target_info = _lstat(target)
            source_matches = source_info is not None and _same_identity(
                _identity(source_info), row['identity'], reverse
            )
            target_matches = target_info is not None and _same_identity(_identity(target_info), row['identity'], True)
            if reverse:
                if states.get(index) == 'rolled-back':
                    if not source_matches or target_info is not None:
                        raise MigrationError(f'Rolled-back row changed: {index}')
                    continue
                if states.get(index) == 'rollback-intent' and source_matches and target_info is None:
                    directory_fd = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                    _ledger_append(handle, {'status': 'rolled-back', 'index': index})
                    continue
                if source_info is not None or not target_matches:
                    raise MigrationError(f'Ambiguous interrupted rollback row: {index}')
                if states.get(index) != 'rollback-intent':
                    _ledger_append(handle, {'status': 'rollback-intent', 'index': index})
                _rename_no_replace(root, target, source, row['identity'], row['parentIdentity'], True)
                _ledger_append(handle, {'status': 'rolled-back', 'index': index})
                continue
            if states.get(index) == 'moved':
                if not target_matches or source_info is not None:
                    raise MigrationError(f'Committed row changed: {index}')
                continue
            if target_matches and source_info is None and states.get(index) == 'intent':
                directory_fd = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
                _ledger_append(handle, {'status': 'moved', 'index': index})
                continue
            if not source_matches or target_info is not None:
                raise MigrationError(f'Ambiguous interrupted row: {index}')
            if states.get(index) != 'intent':
                _ledger_append(handle, {'status': 'intent', 'index': index})
            _rename_no_replace(root, source, target, row['identity'], row['parentIdentity'], False)
            _ledger_append(handle, {'status': 'moved', 'index': index})


def recover(manifest, ledger):
    with _exclusive_ledger(ledger):
        _recover(manifest, ledger)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    dry = sub.add_parser('plan')
    dry.add_argument('--root', required=True)
    dry.add_argument('--decisions', required=True)
    dry.add_argument('--manifest', required=True)
    for action in ('apply', 'rollback', 'recover'):
        command = sub.add_parser(action)
        command.add_argument('--manifest', required=True)
        command.add_argument('--ledger', required=True)
    args = parser.parse_args()
    if args.action == 'plan':
        raw = pathlib.Path(args.decisions).read_text()
        decisions = json.loads(raw) if raw.lstrip().startswith('[') else [
            json.loads(line) for line in raw.splitlines() if line.strip()
        ]
        if any(not isinstance(item.get('selectedValue'), dict) or
               not re.fullmatch(r'[a-f0-9]{64}', item.get('decisionSha256', '')) or
               not re.fullmatch(r'[a-f0-9]{64}', item.get('evidenceSha256', ''))
               for item in decisions):
            raise MigrationError('CLI decisions require resolved values and evidence digests')
        result = plan(args.root, decisions)
        with open(args.manifest, 'x', encoding='utf-8') as handle:
            json.dump(result, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        print(f'Planned {len(result["entries"])} moves: {args.manifest}')
    else:
        manifest = json.loads(pathlib.Path(args.manifest).read_text())
        {'apply': apply, 'rollback': rollback, 'recover': recover}[args.action](manifest, args.ledger)
        print(f'{args.action}: {len(manifest["entries"])} moves')


if __name__ == '__main__':
    main()
