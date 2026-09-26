import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from scripts import migrate_date_only_output as migration
from scripts.migrate_date_only_output import plan, apply, rollback, recover, MigrationError


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.year = self.root / 'Photos' / '2018'
        self.year.mkdir(parents=True)
        self.ledger = self.root / 'migration.jsonl'

    def test_plan_allocates_collision_suffix_without_mutation(self):
        first = self.year / '2018-01-02.jpeg'
        second = self.year / '2018-01-02_1.jpeg'
        first.write_bytes(b'first')
        second.write_bytes(b'second')
        (self.year / '2018-01-02_12-34-56.jpeg').write_bytes(b'occupied')
        result = plan(self.root, [
            {'source': str(first), 'selectedValue': '2018-01-02T12:34:56'},
            {'source': str(second), 'selectedValue': '2018-01-02T12:34:56'},
        ])
        self.assertEqual([pathlib.Path(row['target']).name for row in result['entries']], [
            '2018-01-02_12-34-56_1.jpeg', '2018-01-02_12-34-56_2.jpeg'])
        self.assertTrue(first.exists())
        with self.assertRaises(MigrationError):
            plan(self.root, [{'source': str(first), 'selectedValue': '2018-01-02'}])

    def test_apply_revalidates_entire_manifest_before_first_move(self):
        first = self.year / '2018-01-02.jpeg'
        second = self.year / '2018-01-02_1.jpeg'
        first.write_bytes(b'first')
        second.write_bytes(b'second')
        manifest = plan(self.root, [
            {'source': str(first), 'selectedValue': '2018-01-02T12:34:56'},
            {'source': str(second), 'selectedValue': '2018-01-02T12:34:57'},
        ])
        pathlib.Path(manifest['entries'][1]['target']).write_bytes(b'occupied')
        with self.assertRaises(MigrationError):
            apply(manifest, self.ledger)
        self.assertTrue(first.exists())

    def test_apply_and_inverse_rollback_keep_receipts(self):
        source = self.year / '2018-01-02.jpeg'
        source.write_bytes(b'original')
        manifest = plan(self.root, [{'source': str(source), 'selectedValue': '2018-01-02T12:34:56'}])
        target = pathlib.Path(manifest['entries'][0]['target'])
        apply(manifest, self.ledger)
        self.assertFalse(source.exists())
        self.assertEqual(target.read_bytes(), b'original')
        rollback(manifest, self.ledger)
        self.assertEqual(source.read_bytes(), b'original')
        self.assertFalse(target.exists())
        self.assertIn('rolled-back', self.ledger.read_text())

    def test_apply_rejects_replaced_source_identity(self):
        source = self.year / '2018-01-02.jpeg'
        source.write_bytes(b'original')
        manifest = plan(self.root, [{'source': str(source), 'selectedValue': '2018-01-02T12:34:56'}])
        source.unlink()
        source.write_bytes(b'original')
        with self.assertRaises(MigrationError):
            apply(manifest, self.ledger)

    def test_recover_before_and_after_rename_before_receipt(self):
        for after_rename in (False, True):
            with self.subTest(after_rename=after_rename):
                source = self.year / f'2018-01-0{3 if after_rename else 4}.jpeg'
                source.write_bytes(b'data')
                date = source.name[:10]
                manifest = plan(self.root, [{'source': str(source),
                                             'selectedValue': date + 'T12:34:56'}])
                ledger = self.root / f'ledger-{after_rename}.jsonl'
                original = migration._rename_no_replace

                def interrupted(*args):
                    if after_rename:
                        original(*args)
                    raise RuntimeError('simulated crash')

                with patch.object(migration, '_rename_no_replace', side_effect=interrupted):
                    with self.assertRaises(RuntimeError):
                        apply(manifest, ledger)
                recover(manifest, ledger)
                target = pathlib.Path(manifest['entries'][0]['target'])
                self.assertFalse(source.exists())
                self.assertEqual(target.read_bytes(), b'data')

    def test_manifest_tampering_and_rollback_conflict_are_rejected(self):
        source = self.year / '2018-01-02.jpeg'
        source.write_bytes(b'data')
        manifest = plan(self.root, [{'source': str(source),
                                     'selectedValue': '2018-01-02T12:34:56'}])
        apply(manifest, self.ledger)
        forged = json.loads(json.dumps(manifest))
        forged['entries'][0]['selectedValue'] = '2018-01-02T12:34:57'
        with self.assertRaises(MigrationError):
            rollback(forged, self.ledger)
        source.write_bytes(b'new data')
        with self.assertRaises(MigrationError):
            rollback(manifest, self.ledger)

    def test_symlinked_output_parent_is_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        real = outside / '2018-01-02.jpeg'
        real.write_bytes(b'data')
        alias = self.root / 'Photos' / 'alias'
        alias.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(MigrationError):
            plan(self.root, [{'source': str(alias / real.name),
                              'selectedValue': '2018-01-02T12:34:56'}])

    def test_recover_partial_rollback_and_torn_final_journal_line(self):
        sources = [self.year / '2018-01-02.jpeg', self.year / '2018-01-03.jpeg']
        for source in sources:
            source.write_bytes(source.name.encode())
        manifest = plan(self.root, [{'source': str(source),
                                     'selectedValue': source.name[:10] + 'T12:34:56'}
                                    for source in sources])
        apply(manifest, self.ledger)
        original = migration._rename_no_replace
        calls = 0

        def interrupted(*args):
            nonlocal calls
            calls += 1
            original(*args)
            if calls == 2:
                raise RuntimeError('simulated crash after inverse rename')

        with patch.object(migration, '_rename_no_replace', side_effect=interrupted):
            with self.assertRaises(RuntimeError):
                rollback(manifest, self.ledger)
        with open(self.ledger, 'ab') as handle:
            handle.write(b'{"status":"tor')
        recover(manifest, self.ledger)
        for source in sources:
            self.assertEqual(source.read_bytes(), source.name.encode())
        self.assertEqual(self.ledger.read_text().count('"status":"rolled-back"'), 2)

    def test_recover_rejects_changed_manifest(self):
        source = self.year / '2018-01-02.jpeg'
        source.write_bytes(b'data')
        manifest = plan(self.root, [{'source': str(source),
                                     'selectedValue': '2018-01-02T12:34:56'}])
        apply(manifest, self.ledger)
        forged = json.loads(json.dumps(manifest))
        forged['entries'][0]['identity']['ino'] += 1
        with self.assertRaises(MigrationError):
            recover(forged, self.ledger)

    def test_plan_accepts_resolved_evidence_and_rejects_calendar_only(self):
        source = self.year / '2018-01-02.jpeg'
        source.write_bytes(b'data')
        decision = {'sourcePath': str(source), 'selectedValue': {
            'localIso': '2018-01-02T12:34:56', 'precision': 'second',
            'zoneBasis': 'floating-local'}, 'status': 'resolved',
            'confidence': 'medium', 'decisionSha256': 'a' * 64,
            'evidenceSha256': 'b' * 64}
        manifest = plan(self.root, [decision])
        self.assertEqual(manifest['entries'][0]['decisionEvidence']['decisionSha256'], 'a' * 64)
        decision['selectedValue']['precision'] = 'date'
        with self.assertRaises(MigrationError):
            plan(self.root, [decision])


if __name__ == '__main__':
    unittest.main()
