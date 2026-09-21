import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[2] / 'tools' / 'repair_heif_integrity.py'


def box(kind, payload):
    return struct.pack('>I', len(payload) + 8) + kind + payload


def fixture(pixel=b'pixels', grid=b'grid', exif=b'old-date', method=0, external=0, protected=0, idat=False):
    entries = []
    for ident, kind in ((1, b'hvc1'), (2, b'grid'), (3, b'Exif')):
        entries.append(box(b'infe', b'\x02\0\0\0' + struct.pack('>HH', ident, protected) + kind + b'\0'))
    iinf = box(b'iinf', b'\0' * 4 + struct.pack('>H', 3) + b''.join(entries))
    def meta(offset):
        records = b''
        for ident, start, payload in ((1, offset, pixel), (2, offset + len(pixel), grid), (3, offset + len(pixel) + len(grid), exif)):
            item_method = 1 if idat and ident == 2 else method
            start = 0 if idat and ident == 2 else start
            records += struct.pack('>HHHHII', ident, item_method, external, 1, start, len(payload))
        iloc = box(b'iloc', b'\x01\0\0\0\x44\x00' + struct.pack('>H', 3) + records)
        return box(b'meta', b'\0' * 4 + iinf + iloc + box(b'iprp', b'interpretation') + (box(b'idat', grid) if idat else b''))
    ftyp = box(b'ftyp', b'heic\0\0\0\0heic')
    offset = len(ftyp) + len(meta(0)) + 8
    return ftyp + meta(offset) + box(b'mdat', pixel + grid + exif)


class HeifIntegrityTests(unittest.TestCase):
    def digest(self, value):
        spec = importlib.util.spec_from_file_location('repair_heif_integrity', MODULE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.heic'
            path.write_bytes(value)
            return module.heif_payload_digest(path)

    def test_exif_change_and_relocation_preserved(self):
        self.assertEqual(self.digest(fixture()), self.digest(fixture(exif=b'longer-new-date')))

    def test_primary_and_grid_changes_detected(self):
        baseline = self.digest(fixture())
        self.assertNotEqual(baseline, self.digest(fixture(pixel=b'PIXELS')))
        self.assertNotEqual(baseline, self.digest(fixture(grid=b'GRID')))

    def test_interpretation_change_detected(self):
        self.assertNotEqual(self.digest(fixture()), self.digest(fixture().replace(b'interpretation', b'Interpretation')))

    def test_idat_grid_hashed_and_relocated(self):
        self.assertEqual(self.digest(fixture()), self.digest(fixture(idat=True)))
        self.assertNotEqual(self.digest(fixture(idat=True)), self.digest(fixture(idat=True, grid=b'GRID')))

    def test_extent_out_of_bounds_rejected(self):
        data = bytearray(fixture())
        index = data.index(b'iloc') + 4 + 8 + 8
        data[index:index + 4] = b'\xff' * 4
        with self.assertRaises(ValueError):
            self.digest(bytes(data))

    def test_timed_sequence_not_silently_accepted(self):
        with self.assertRaises(ValueError):
            self.digest(fixture() + box(b'moov', b''))

    def test_truncations_fail(self):
        data = fixture()
        for end in (0, 1, 7, 16, len(data) - 1):
            with self.subTest(end=end), self.assertRaises(ValueError):
                self.digest(data[:end])

    def test_external_protected_and_unsupported_construction_fail(self):
        for args in ({'external': 1}, {'protected': 1}, {'method': 2}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.digest(fixture(**args))

    def test_oversize_box_fail(self):
        with self.assertRaises(ValueError):
            self.digest(b'\xff\xff\xff\xffmeta' + b'\0' * 12)


if __name__ == '__main__':
    unittest.main()
