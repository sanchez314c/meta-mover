"""Behavior tests for the one-time legacy padding repair."""
import importlib.util
import base64
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import shutil
import tempfile
import sys
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[2] / "tools/repair_subsecond_padding.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("repair_padding", SCRIPT)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def evidence(fraction="000065", alternate="65"):
    return {
        "File:FileType": "JPEG", "File:MIMEType": "image/jpeg", "File:ImageDataHash": "a" * 64,
        "ExifIFD:DateTimeOriginal": "2018:06:03 09:05:00",
        "ExifIFD:SubSecTimeOriginal": fraction,
        "XMP-photoshop:DateCreated": "2018:06:03 09:05:00." + alternate,
    }


class ClassificationTests(unittest.TestCase):
    def test_user_override_strips_only_leading_zeros(self):
        for original, expected in [("000065", "65"), ("000016", "16"), ("000093", "93"), ("001200", "1200"), ("010000", "10000"), ("000000", "0")]:
            with self.subTest(original=original):
                result = repair.classify({repair.ORIGINAL: original})
                self.assertEqual(result["status"], "candidate")
                self.assertEqual(result["changes"], {repair.ORIGINAL: expected})
                self.assertEqual(result["reason"], "user_override_six_ascii_digits_strip_leading_zeros")

    def test_other_lengths_and_non_ascii_digits_untouched(self):
        for original in ["", "0", "65", "00065", "0000065", "123456", "00006x", "00006٦", "００００６５", " 000065", "000065 ", "000065\n"]:
            with self.subTest(original=original):
                self.assertEqual(repair.classify({repair.ORIGINAL: original})["status"], "unchanged")

    def test_corroboration_and_conflicts_do_not_change_override(self):
        data = evidence()
        data["XMP-photoshop:DateCreated"] = "2001:02:03 04:05:06.12+03:00"
        data["XMP-exif:DateTimeOriginal"] = "2018:06:03 09:05:00.000065"
        data["ExifIFD:OffsetTimeOriginal"] = "+02:00"
        self.assertEqual(repair.classify(data)["changes"], {repair.ORIGINAL: "65", "XMP-exif:DateTimeOriginal": "2018:06:03 09:05:00.65"})

    def test_absent_subseconds_untouched(self):
        self.assertEqual(repair.classify({})["status"], "unchanged")

    def test_duplicate_json_metadata_blocks(self):
        with self.assertRaises(ValueError):
            repair.unique_json([("ExifIFD:SubSecTimeOriginal", "65"), ("ExifIFD:SubSecTimeOriginal", "000065")])

    def test_digitized_rule_is_independent(self):
        data = {repair.ORIGINAL: "000065", repair.DIGITIZED: "000093", "ExifIFD:SubSecTime": "000016"}
        self.assertEqual(repair.classify(data)["changes"], {repair.ORIGINAL: "65", repair.DIGITIZED: "93", "ExifIFD:SubSecTime": "16"})
        self.assertEqual(repair.classify({repair.DIGITIZED: "000000"})["changes"], {repair.DIGITIZED: "0"})

    def test_short_digitized_value_not_expanded_or_copied(self):
        data = {repair.ORIGINAL: "000065", repair.DIGITIZED: "065"}
        self.assertEqual(repair.classify(data)["changes"], {repair.ORIGINAL: "65"})

    def test_all_regular_files_discovered_without_extension_filter(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.jpg").write_bytes(b"a")
            (root / "b.png").write_bytes(b"b")
            (root / "extensionless").write_bytes(b"b")
            (root / "link.jpg").symlink_to(root / "a.jpg")
            (root / "nested").mkdir()
            (root / "nested" / "c.JPEG").write_bytes(b"c")
            self.assertEqual({p.name for p in repair.discover(root)}, {"a.jpg", "b.png", "extensionless", "c.JPEG"})

    def test_semantic_embedded_date_fractions_only(self):
        data = {
            "XMP-xmp:CreateDate": "2020:01:02 03:04:05.000065+02:00",
            "XMP-xmp:ModifyDate": "2020:01:02 03:04:05.001200Z",
            "XMP-dc:Description": "2020:01:02 03:04:05.000065",
            "EXIF:ImageUniqueID": "000065",
            "System:FileModifyDate": "2020:01:02 03:04:05.000065Z",
        }
        self.assertEqual(repair.classify(data)["changes"], {"XMP-xmp:CreateDate": "2020:01:02 03:04:05.65+02:00", "XMP-xmp:ModifyDate": "2020:01:02 03:04:05.1200Z"})

    def test_readonly_and_structured_dates_are_explicit_unsupported(self):
        data = {"MakerNotes:DateTimeOriginal": "2020:01:02 03:04:05.000065", "XMP-xmpMM:HistoryWhen": ["2020:01:02 03:04:05.000065"], "_semantic_time_tags": ["MakerNotes:DateTimeOriginal", "XMP-xmpMM:HistoryWhen"], "_writable_time_tags": ["XMP-xmpMM:HistoryWhen"], "_structured_time_tags": ["XMP-xmpMM:HistoryWhen"]}
        result = repair.classify(data)
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(set(result["unsupported_targets"]), {"MakerNotes:DateTimeOriginal", "XMP-xmpMM:HistoryWhen"})

    def test_nested_structured_time_is_reported_not_silently_unchanged(self):
        data = {"XMP-custom:Event": {"When": "2020:01:02 03:04:05.000065"}, "_semantic_time_tags": ["XMP-custom:Event"], "_writable_time_tags": ["XMP-custom:Event"]}
        self.assertEqual(repair.classify(data)["status"], "unsupported")

    def test_readonly_native_subsecond_variant_is_accounted_for(self):
        data = {"MakerNotes:SubSecTime2": "000065", "_semantic_time_tags": ["MakerNotes:SubSecTime2"], "_writable_time_tags": []}
        self.assertEqual(repair.classify(data)["status"], "unsupported")


class TransactionTests(unittest.TestCase):
    def test_backup_and_stage_artifacts_are_never_read_or_written(self):
        tool = Mock()
        for name in ("photo.png_original", ".subsecond-abcd.repair-stage"):
            self.assertEqual(repair.process_file(tool, Path(name), True)["status"], "artifact")
        tool.read.assert_not_called()
        tool.write.assert_not_called()

    def test_actual_nonimage_content_is_not_written(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "misleading.jpg"
            path.write_bytes(b"not an image")
            tool = Mock()
            tool.read.return_value = {**evidence(), "File:MIMEType": "application/pdf", "File:FileType": "PDF"}
            self.assertEqual(repair.process_file(tool, path, True)["status"], "not_image")
            tool.write.assert_not_called()

    def test_only_exact_stale_digest_warning_is_allowed(self):
        tool = object.__new__(repair.ExifTool)
        tool.registry = (set(), set(), set(), {"JPEG"})
        tool.execute = Mock(return_value=json.dumps([{**evidence(), "ExifTool:Warning": repair.BENIGN_WARNING}]))
        self.assertTrue(tool.read(Path("fixture"))["_warnings"])
        tool.execute.return_value = json.dumps([{**evidence(), "ExifTool:Warning": repair.BENIGN_WARNING + "; structural damage"}])
        with self.assertRaises(ValueError):
            tool.read(Path("fixture"))
        tool.execute.return_value = "Error: " + repair.BENIGN_WARNING + "\n1 image files updated\n"
        with self.assertRaises(RuntimeError):
            tool.write(Path("fixture"), {repair.ORIGINAL: "65"})

    def test_singleton_copy_label_is_writable_but_true_duplicates_are_not(self):
        tool = object.__new__(repair.ExifTool)
        key = "XMP-exif:DateTimeOriginal"
        tool.registry = ({key}, {key}, set(), {"JPEG"})
        tool.execute = Mock(return_value=json.dumps([{"File:FileType": "JPEG", "XMP-exif:Copy1:DateTimeOriginal": "2020:01:02 03:04:05.000065"}]))
        single = tool.read(Path("fixture"))
        self.assertEqual(repair.classify(single)["changes"], {key: "2020:01:02 03:04:05.65"})
        tool.execute.return_value = json.dumps([{key: "2020:01:02 03:04:05.000065", "XMP-exif:Copy1:DateTimeOriginal": "2021:01:02 03:04:05.000065"}])
        self.assertEqual(repair.classify(tool.read(Path("fixture")))["status"], "unsupported")

    def test_large_arrays_only_retried_after_exact_preflight_warning(self):
        tool = object.__new__(repair.ExifTool)
        tool.registry = (set(), set(), set(), {"DNG"})
        tool.execute = Mock(side_effect=[json.dumps([{"ExifTool:Warning": repair.LARGE_ARRAY_WARNING}]), json.dumps([{"File:FileType": "DNG", "IFD0:Table": [1, 2, 3]}])])
        tags = tool.read(Path("fixture"))
        self.assertTrue(tags["_large_arrays_decoded"])
        self.assertIn("-m", tool.execute.call_args.args[0])
        self.assertEqual(tags["_warnings"]["ExifTool:Warning"], repair.LARGE_ARRAY_WARNING)
        tool.execute = Mock(return_value=json.dumps([{"ExifTool:Warning": repair.LARGE_ARRAY_WARNING, "ExifTool:Copy1:Warning": "Truncated data"}]))
        with self.assertRaises(ValueError):
            tool.read(Path("fixture"))
        self.assertEqual(tool.execute.call_count, 1)
    def test_verified_embedded_image_offsets_may_relocate(self):
        for pointer, image in [("IFD1:ThumbnailOffset", "IFD1:ThumbnailImage"), ("PreviewIFD:PreviewImageStart", "PreviewIFD:PreviewImage"), ("MPImage2:MPImageStart", "MPImage2:MPImage2"), ("MPImage3:MPImageStart", "MPImage3:MPImage3"), ("IFD0:PreviewImageStart", "IFD0:PreviewImage"), ("SubIFD1:OtherImageStart", "SubIFD1:OtherImage"), ("SubIFD3:OtherImageStart", "SubIFD3:OtherImage")]:
            with self.subTest(pointer=pointer):
                before = {pointer: 100, image: "base64:YWJj"}
                after = {pointer: 110, image: "base64:YWJj"}
                self.assertEqual(repair.stable_metadata(before), repair.stable_metadata(after))
                after[image] = "base64:ZGVm"
                self.assertNotEqual(repair.stable_metadata(before), repair.stable_metadata(after))

    def test_heif_mdat_layout_changes_only_with_native_integrity(self):
        before = {"File:FileType": "HEIC", "File:ImageDataHash": "a" * 64, "QuickTime:MediaDataSize": 100}
        after = {**before, "QuickTime:MediaDataSize": 110}
        self.assertEqual(repair.stable_metadata(before), repair.stable_metadata(after))
        before.pop("File:ImageDataHash")
        after.pop("File:ImageDataHash")
        self.assertNotEqual(repair.stable_metadata(before), repair.stable_metadata(after))
        before.update({"File:FileType": "JPEG", "File:ImageDataHash": "a" * 64})
        after.update({"File:FileType": "JPEG", "File:ImageDataHash": "a" * 64})
        self.assertNotEqual(repair.stable_metadata(before), repair.stable_metadata(after))

    def test_ifd_preview_pointer_requires_its_own_extracted_bytes(self):
        before = {"IFD0:PreviewImageStart": 100, "SubIFD1:OtherImageStart": 200, "File:ImageDataHash": "a" * 64}
        after = {**before, "IFD0:PreviewImageStart": 110, "SubIFD1:OtherImageStart": 210}
        self.assertNotEqual(repair.stable_metadata(before), repair.stable_metadata(after))

    def test_offset_exceptions_require_actual_binary_values(self):
        for value in [None, "(Binary data 3 bytes, use -b option to extract)", "base64:"]:
            with self.subTest(value=value):
                before = {"IFD1:ThumbnailOffset": 100, "IFD1:ThumbnailImage": value}
                after = {**before, "IFD1:ThumbnailOffset": 110}
                self.assertNotEqual(repair.stable_metadata(before), repair.stable_metadata(after))

    def test_jpeg_digest_covers_tables_but_allows_metadata_edits(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a.jpg"
            prefix = b"\xff\xd8\xff\xe1\x00\x04AB\xff\xdb\x00\x04CD\xff\xda\x00\x02scan\xff\xd9"
            path.write_bytes(prefix)
            original = repair.jpeg_payload_digest(path)
            path.write_bytes(prefix.replace(b"AB", b"XY"))
            self.assertEqual(repair.jpeg_payload_digest(path), original)
            path.write_bytes(prefix.replace(b"CD", b"XY"))
            self.assertNotEqual(repair.jpeg_payload_digest(path), original)

    def test_dry_run_never_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a.jpg"
            path.write_bytes(b"original")
            tool = Mock()
            tool.read.return_value = evidence()
            self.assertEqual(repair.process_file(tool, path)["status"], "candidate")
            tool.write.assert_not_called()

    def test_existing_backup_blocks_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a.jpg"
            path.write_bytes(b"original")
            backup = Path(str(path) + "_original")
            backup.write_bytes(b"important")
            tool = Mock()
            tool.read.return_value = evidence()
            self.assertEqual(repair.process_file(tool, path, True)["status"], "blocked")
            tool.write.assert_not_called()
            self.assertEqual(backup.read_bytes(), b"important")

    def test_readback_detects_unrelated_metadata_change(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a.jpg"
            path.write_bytes(b"original")
            tool = Mock()
            before = evidence()
            after = {**before, repair.ORIGINAL: "65", "EXIF:Artist": "unexpected"}
            tool.read.side_effect = [before, before, after]

            def write(target, changes):
                target.write_bytes(b"changed")

            tool.write.side_effect = write
            with patch.object(repair, "jpeg_payload_digest", return_value="digest"):
                with self.assertRaisesRegex(RuntimeError, "Metadata verification failed"):
                    repair.process_file(tool, path, True)
            self.assertEqual(path.read_bytes(), b"original")
            self.assertFalse(Path(str(path) + "_original").exists())

    def test_success_verifies_then_publishes_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a.jpg"
            path.write_bytes(b"original")
            tool = Mock()
            tool.read.side_effect = [evidence(), evidence(), {**evidence(), repair.ORIGINAL: "65"}]
            tool.write.side_effect = lambda target, changes: target.write_bytes(b"repaired")
            with patch.object(repair, "jpeg_payload_digest", return_value="digest"):
                self.assertEqual(repair.process_file(tool, path, True)["status"], "repaired")
            self.assertEqual(path.read_bytes(), b"repaired")
            self.assertEqual(Path(str(path) + "_original").read_bytes(), b"original")

    def test_payload_change_blocks_publication(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a.jpg"
            path.write_bytes(b"original")
            tool = Mock()
            tool.read.side_effect = [evidence(), evidence(), {**evidence(), repair.ORIGINAL: "65"}]
            with patch.object(repair, "jpeg_payload_digest", side_effect=["before", "after"]):
                with self.assertRaisesRegex(RuntimeError, "Image-data verification failed"):
                    repair.process_file(tool, path, True)
            self.assertEqual(path.read_bytes(), b"original")

    def test_exiftool_timeout_terminates_own_child(self):
        import shutil
        executable = shutil.which("exiftool")
        if not executable:
            self.skipTest("ExifTool not available")
        tool = repair.ExifTool(executable, 0)
        with self.assertRaises(TimeoutError):
            tool.execute(["-ver"])
        self.assertIsNotNone(tool.process.poll())


class RealExifToolTests(unittest.TestCase):
    JPEG = base64.b64decode("/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==")

    def setUp(self):
        executable = shutil.which("exiftool")
        if not executable:
            self.skipTest("ExifTool not available")
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "fixture.jpg"
        self.path.write_bytes(self.JPEG)
        self.tool = repair.ExifTool(executable, 10)
        self.addCleanup(self.tool.close)

    def test_all_zero_and_trailing_zero_values_round_trip(self):
        self.tool.write(self.path, {repair.ORIGINAL: "000000", repair.DIGITIZED: "001200", "ExifIFD:SubSecTime": "000016"})
        before = self.path.read_bytes()
        tags = self.tool.read(self.path)
        self.assertEqual(tags[repair.ORIGINAL], "000000")
        self.assertEqual(tags[repair.DIGITIZED], "001200")
        result = repair.process_file(self.tool, self.path, True)
        self.assertEqual(result["status"], "repaired")
        after = self.tool.read(self.path)
        self.assertEqual(after[repair.ORIGINAL], "0")
        self.assertEqual(after[repair.DIGITIZED], "1200")
        self.assertEqual(str(after["ExifIFD:SubSecTime"]), "16")
        self.assertEqual(Path(str(self.path) + "_original").read_bytes(), before)
        self.assertEqual(repair.process_file(self.tool, self.path, True)["status"], "unchanged")

    def test_digitized_only_without_dates_or_corroboration(self):
        self.tool.write(self.path, {repair.DIGITIZED: "000016"})
        self.assertEqual(repair.process_file(self.tool, self.path, True)["status"], "repaired")
        after = self.tool.read(self.path)
        self.assertEqual(after[repair.DIGITIZED], "16")
        self.assertNotIn(repair.ORIGINAL, after)

    def test_other_lengths_and_no_leading_zeros_are_byte_unchanged(self):
        self.tool.write(self.path, {repair.ORIGINAL: "00065", repair.DIGITIZED: "123456"})
        before = self.path.read_bytes()
        self.assertEqual(repair.process_file(self.tool, self.path, True)["status"], "unchanged")
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(Path(str(self.path) + "_original").exists())

    def test_cli_dry_run_apply_and_resume_records_explicit_policy(self):
        self.tool.write(self.path, {repair.ORIGINAL: "000000", repair.DIGITIZED: "001200"})
        root = Path(self.directory.name)
        source = root / "input"
        source.mkdir()
        self.path = self.path.rename(source / "fixture.jpg")
        before = self.path.read_bytes()
        audit = root / "audit.jsonl"
        arguments = [str(source), "--audit", str(audit), "--workers", "2", "--timeout", "10"]
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(repair.main(arguments + ["--limit", "1"]), 0)
            self.assertEqual(self.path.read_bytes(), before)
            self.assertEqual(repair.main(arguments + ["--apply"]), 0)
            self.assertEqual(repair.main(arguments + ["--apply"]), 0)
        records = [json.loads(line) for line in audit.read_text().splitlines()]
        files = [record for record in records if "path" in record and record["status"] != "artifact"]
        self.assertEqual([record["status"] for record in files], ["candidate", "repaired", "unchanged"])
        self.assertTrue(all(record["policy"] == repair.POLICY for record in files))
        self.assertEqual(files[1]["old_values"], {repair.ORIGINAL: "000000", repair.DIGITIZED: "001200"})
        self.assertEqual(files[1]["changes"], {repair.ORIGINAL: "0", repair.DIGITIZED: "1200"})
        self.assertEqual(Path(str(self.path) + "_original").read_bytes(), before)

    def test_native_multiformat_metadata_repairs(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow fixture generator not available")
        for format_name, suffix in [("PNG", ".png"), ("TIFF", ".tif"), ("WEBP", ".webp"), ("GIF", ".gif")]:
            with self.subTest(format=format_name):
                path = Path(self.directory.name) / ("fixture" + suffix)
                first = Image.new("RGB", (4, 3), "red")
                second = Image.new("RGB", (4, 3), "blue")
                first.save(path, format=format_name, save_all=True, append_images=[second], duration=100, loop=0)
                changes = {"XMP-xmp:CreateDate": "2020:01:02 03:04:05.000065"}
                if format_name != "GIF":
                    changes["ExifIFD:SubSecTime"] = "000016"
                self.tool.write(path, changes)
                before = path.read_bytes()
                result = repair.process_file(self.tool, path, True)
                self.assertEqual(result["status"], "repaired")
                after = self.tool.read(path)
                self.assertEqual(after["XMP-xmp:CreateDate"], "2020:01:02 03:04:05.65")
                if format_name != "GIF":
                    self.assertEqual(after["ExifIFD:SubSecTime"], "16")
                self.assertEqual(Path(str(path) + "_original").read_bytes(), before)
                with Image.open(path) as image:
                    self.assertEqual(image.n_frames, 2)


if __name__ == "__main__":
    unittest.main()
