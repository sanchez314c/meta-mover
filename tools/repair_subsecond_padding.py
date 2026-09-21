#!/usr/bin/env python3
"""User override: remove six-digit subsecond left padding from image metadata."""
import argparse
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import re
import select
import shutil
import stat
import subprocess
import sys
import threading
import tempfile
import time
import uuid
from functools import lru_cache
import xml.etree.ElementTree as ET


ORIGINAL = "ExifIFD:SubSecTimeOriginal"
DIGITIZED = "ExifIFD:SubSecTimeDigitized"
POLICY = "user_override_six_ascii_digits_strip_leading_zeros"
DEFAULT_TIME_TAGS = {ORIGINAL, DIGITIZED, "ExifIFD:SubSecTime", "XMP-xmp:CreateDate", "XMP-xmp:ModifyDate", "XMP-xmp:MetadataDate", "XMP-exif:DateTimeOriginal", "XMP-photoshop:DateCreated"}
FRACTIONAL_TIME = re.compile(r"(?P<head>(?:[0-9]{4}[:-][0-9]{2}[:-][0-9]{2}[ T])?[0-9]{2}:[0-9]{2}:[0-9]{2}\.)(?P<fraction>[0-9]{6})(?P<zone>Z|[+-][0-9]{2}:?[0-9]{2})?")
BENIGN_WARNING = "IPTCDigest is not current. XMP may be out of sync"
LARGE_ARRAY_WARNING = "[Minor] Not decoding some large array(s). Ignore minor errors to decode"


@lru_cache(maxsize=2)
def capabilities(executable):
    """Read the installed writer's semantic tag registry once, bounded on disk."""
    time_tags, writable_tags, structured_tags = set(), set(), set()
    with tempfile.TemporaryFile() as xml:
        subprocess.run([executable, "-listx", "-s", "-f"], stdout=xml, stderr=subprocess.PIPE, check=True, timeout=60)
        xml.seek(0)
        table = {}
        for event, element in ET.iterparse(xml, events=("start", "end")):
            if event == "start" and element.tag == "table":
                table = element.attrib.copy()
            elif event == "end" and element.tag == "tag":
                tag = element.attrib
                name = tag.get("name", "")
                group = tag.get("g1", table.get("g1", ""))
                if tag.get("g2", table.get("g2")) == "Time" or tag.get("type") == "date" or name.startswith("SubSecTime"):
                    key = group + ":" + name
                    time_tags.add(key)
                    if tag.get("writable") == "true":
                        writable_tags.add(key)
                    if tag.get("struct") or "Flattened" in tag.get("flags", "") or "List" in tag.get("flags", ""):
                        structured_tags.add(key)
                element.clear()
            elif event == "end" and element.tag == "table":
                element.clear()
    listed = subprocess.run([executable, "-listwf"], capture_output=True, text=True, check=True, timeout=30).stdout
    formats = set(listed.split(":", 1)[-1].upper().split())
    return time_tags, writable_tags, structured_tags, formats


def corrected_value(value, subsecond=False):
    if isinstance(value, dict):
        return {key: corrected_value(item, subsecond) for key, item in value.items()}
    if isinstance(value, list):
        return [corrected_value(item, subsecond) for item in value]
    if not isinstance(value, str):
        return value
    if subsecond:
        return (value.lstrip("0") or "0") if re.fullmatch(r"[0-9]{6}", value) else value
    match = FRACTIONAL_TIME.fullmatch(value)
    if not match:
        return value
    fraction = match.group("fraction").lstrip("0") or "0"
    return match.group("head") + fraction + (match.group("zone") or "")


def classify(tags):
    """Target semantic embedded times; report read-only/structured occurrences."""
    changes = {}
    old_values = {}
    unsupported = {}
    semantic = set(tags.get("_semantic_time_tags", DEFAULT_TIME_TAGS))
    writable = set(tags.get("_writable_time_tags", DEFAULT_TIME_TAGS))
    structured = set(tags.get("_structured_time_tags", []))
    for key in sorted(semantic):
        if key not in tags or key.split(":", 1)[0] in ("System", "File", "Composite", "ExifTool"):
            continue
        old = tags[key]
        is_subsecond = key.rsplit(":", 1)[-1].startswith("SubSecTime")
        if is_subsecond and isinstance(old, int):
            old = str(old)
        new = [corrected_value(item, is_subsecond) for item in old] if isinstance(old, list) else corrected_value(old, is_subsecond)
        if new != old:
            if key not in writable or key in structured or isinstance(old, (list, dict)):
                unsupported[key] = {"old": old, "proposed": new, "reason": "structured_or_duplicate_instance" if key in structured or isinstance(old, (list, dict)) else "read_only_tag"}
                continue
            changes[key] = new
            old_values[key] = old
    if not changes:
        if unsupported:
            return {"status": "unsupported", "reason": "unwritable_or_structured_time_targets", "policy": POLICY, "unsupported_targets": unsupported}
        return {"status": "unchanged", "reason": "no_six_ascii_digit_leading_zeros", "policy": POLICY}
    return {"status": "candidate", "reason": POLICY, "policy": POLICY, "old_values": old_values, "changes": changes, "unsupported_targets": unsupported}


def discover(root):
    """Depth-first streaming enumeration, never following links."""
    stack = [os.scandir(root)]
    try:
        while stack:
            try:
                entry = next(stack[-1])
            except StopIteration:
                stack.pop().close()
                continue
            if entry.is_dir(follow_symlinks=False):
                stack.append(os.scandir(entry.path))
            elif entry.is_file(follow_symlinks=False):
                yield Path(entry.path)
    finally:
        for iterator in stack:
            iterator.close()


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result and result[key] != value:
            raise ValueError("Conflicting duplicate metadata field: " + key)
        result[key] = value
    return result


class ExifTool:
    """One persistent subprocess per worker; Linux pipe deadlines prevent hangs."""
    def __init__(self, executable, timeout):
        self.timeout = timeout
        self.registry = capabilities(executable)
        self.process = subprocess.Popen([executable, "-stay_open", "True", "-@", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
        self.sequence = 0

    def execute(self, arguments):
        if any("\n" in value or "\r" in value for value in arguments):
            raise ValueError("ExifTool argument protocol cannot safely handle newline filenames")
        self.sequence += 1
        marker = ("{ready%d}" % self.sequence).encode()
        command = "\n".join(arguments + ["-execute%d" % self.sequence]) + "\n"
        self.process.stdin.write(command.encode("utf-8"))
        self.process.stdin.flush()
        deadline = time.monotonic() + self.timeout
        output = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                self.close()
                raise TimeoutError("ExifTool operation exceeded %.1fs" % self.timeout)
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("ExifTool exited before command completion")
            output.extend(chunk)
            # Match a complete standalone protocol line, never image metadata text.
            lines = output.splitlines(keepends=True)
            if lines and lines[-1].rstrip(b"\r\n") == marker and lines[-1].endswith(b"\n"):
                return b"".join(lines[:-1]).decode("utf-8", errors="replace")

    def read(self, path, deep=False, decode_large=False):
        extra = ["-api", "RequestAll=3", "-api", "ImageHashType=SHA256", "-ImageDataHash"] if deep else []
        if decode_large:
            extra.append("-m")
        raw = self.execute(["-j", "-G1:4", "-s", "-a", "-n", "-b", "-all"] + extra + [str(path)])
        values = json.loads(raw, object_pairs_hook=unique_json)
        issues = {key: value for item in values for key, value in item.items() if key.endswith(":Error") or key.endswith(":Warning")}
        allowed = (BENIGN_WARNING, LARGE_ARRAY_WARNING)
        bad = {key: value for key, value in issues.items() if not (key.endswith(":Warning") and value in allowed)}
        if len(values) != 1 or bad:
            raise ValueError("ExifTool reported ambiguous or damaged metadata: " + json.dumps(issues))
        if not decode_large and LARGE_ARRAY_WARNING in issues.values():
            decoded = self.read(path, deep=deep, decode_large=True)
            decoded["_warnings"].update(issues)
            decoded["_large_arrays_decoded"] = True
            return decoded
        tags = values[0]
        semantic, writable, structured, formats = self.registry
        aliases = {}
        for key in tags:
            parts = key.split(":")
            alias = parts[0] + ":" + parts[-1] if ":" in key else key
            aliases.setdefault(alias, []).append(key)
        tags = {alias if len(keys) == 1 else key: tags[key] for alias, keys in aliases.items() for key in keys}
        aliases = {alias: [alias] if len(keys) == 1 else keys for alias, keys in aliases.items()}
        tags["_semantic_time_tags"] = [key for alias, keys in aliases.items() if alias in semantic for key in keys]
        tags["_writable_time_tags"] = [key for alias, keys in aliases.items() if alias in writable and len(keys) == 1 and keys[0] == alias for key in keys]
        tags["_structured_time_tags"] = [key for alias, keys in aliases.items() if alias in structured or len(keys) != 1 or keys[0] != alias for key in keys]
        tags["_format_writable"] = any(str(tags.get(key, "")).upper() in formats for key in ("File:FileType", "File:FileTypeExtension"))
        tags["_warnings"] = issues
        for key in list(tags):
            if key.rsplit(":", 1)[-1].startswith("SubSecTime"):
                tags[key] = str(tags[key])
        return tags

    def write(self, path, changes, decode_large=False):
        output = self.execute(["-P", "-overwrite_original"] + (["-m"] if decode_large else []) + ["-%s=%s" % item for item in changes.items()] + [str(path)])
        harmless = re.compile(r"^Warning: " + re.escape(BENIGN_WARNING) + r"(?: - .*)?$")
        failures = [line for line in output.splitlines() if re.search(r"\b(?:Error|Warning):", line) and not harmless.fullmatch(line)]
        if not re.search(r"\b1 image files updated\b", output) or failures:
            raise RuntimeError("ExifTool write not clean: " + output.strip())

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        for stream in (self.process.stdin, self.process.stdout):
            if stream and not stream.closed:
                stream.close()


def identity(path):
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode):
        raise ValueError("Not a regular file")
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def stable_metadata(tags):
    # Physical pointers can relocate when EXIF length changes. Each exception
    # requires its actual -b image bytes, which remain in this comparison.
    image_pointers = {
        "IFD1:ThumbnailOffset": "IFD1:ThumbnailImage",
        "PreviewIFD:PreviewImageStart": "PreviewIFD:PreviewImage",
        "MPImage2:MPImageStart": "MPImage2:MPImage2",
        "MPImage3:MPImageStart": "MPImage3:MPImage3",
    }
    for key in tags:
        if re.fullmatch(r"(?:IFD[0-9]+|SubIFD[0-9]*):(?:PreviewImageStart|OtherImageStart)", key):
            image_pointers[key] = key.removesuffix("Start")
    relocated = {
        pointer for pointer, image in image_pointers.items()
        if isinstance(tags.get(pointer), int) and tags[pointer] >= 0
        and isinstance(tags.get(image), str) and tags[image].startswith("base64:")
        and len(tags[image]) > len("base64:")
    }
    if any(key.rsplit(":", 1)[-1] == "ImageDataHash" and re.fullmatch(r"[0-9a-fA-F]{64}", str(value)) for key, value in tags.items()):
        relocated.update(key for key in tags if re.fullmatch(r"(?:IFD[0-9]+|SubIFD[0-9]*):(?:StripOffsets|TileOffsets)", key))
        if str(tags.get("File:FileType", "")).upper() in ("HEIC", "HEIF", "AVIF", "HIF"):
            # The transaction also verifies every nonmetadata HEIF item and
            # interpretation box through heif_payload_digest before publishing.
            relocated.update({"QuickTime:MediaDataSize", "QuickTime:MediaDataOffset"})
    return {key: value for key, value in tags.items() if ":" in key and key not in relocated and key.split(":", 1)[0] not in ("File", "System", "ExifTool", "Composite")}


def jpeg_payload_digest(path):
    """Hash coding tables, frame headers and scans; exclude APP/COM metadata."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        if stream.read(2) != b"\xff\xd8":
            raise ValueError("JPEG SOI marker missing")
        while True:
            marker = stream.read(1)
            if marker != b"\xff":
                raise ValueError("Invalid JPEG segment")
            code = stream.read(1)
            while code == b"\xff":
                code = stream.read(1)
            if code == b"\xda":
                digest.update(b"\xff\xda")
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
                return digest.hexdigest()
            if not code or code == b"\xd9":
                raise ValueError("JPEG scan data missing")
            if code in (b"\x01", b"\xd8") or 0xD0 <= code[0] <= 0xD7:
                continue
            length = stream.read(2)
            if len(length) != 2 or int.from_bytes(length, "big") < 2:
                raise ValueError("Invalid JPEG segment length")
            payload_length = int.from_bytes(length, "big") - 2
            payload = stream.read(payload_length)
            if len(payload) != payload_length:
                raise ValueError("Truncated JPEG segment")
            if not 0xE0 <= code[0] <= 0xEF and code != b"\xfe":
                digest.update(b"\xff" + code + length + payload)


class UnsupportedImageError(Exception):
    """An image cannot be transformed with a complete integrity proof here."""


def image_integrity(path, tags):
    kind = str(tags.get("File:FileType", "")).upper()
    hashes = [str(value) for key, value in tags.items() if key.rsplit(":", 1)[-1] == "ImageDataHash"]
    result = {"format": kind}
    if hashes and all(re.fullmatch(r"[0-9a-fA-F]{64}", value) for value in hashes):
        result["native_sha256"] = sorted(hashes)
    elif kind != "GIF":
        raise UnsupportedImageError("Installed ExifTool did not provide an image-data SHA256 for " + kind)
    if kind == "JPEG":
        result["jpeg_coding_sha256"] = jpeg_payload_digest(path)
    elif kind in ("HEIC", "HEIF", "AVIF", "HIF"):
        from repair_heif_integrity import heif_payload_digest
        try:
            result["all_item_sha256"] = heif_payload_digest(path)
        except (ValueError, OSError) as error:
            raise UnsupportedImageError("Unsupported HEIF item layout: " + str(error)) from error
    elif kind == "GIF":
        try:
            from PIL import Image
        except ImportError as error:
            raise UnsupportedImageError("GIF all-frame verification requires Pillow") from error
        digest = hashlib.sha256()
        with Image.open(path) as picture:
            frames = picture.n_frames
            for index in range(frames):
                picture.seek(index)
                digest.update(json.dumps({"index": index, "size": picture.size, "mode": picture.mode, "palette": picture.getpalette(), "duration": picture.info.get("duration"), "transparency": picture.info.get("transparency"), "disposal": getattr(picture, "disposal_method", None), "loop": picture.info.get("loop")}, sort_keys=True).encode())
                digest.update(picture.tobytes())
        result["gif_frames"] = frames
        result["gif_pixels_sha256"] = digest.hexdigest()
    return result


def process_file(tool, path, apply=False):
    if path.name.endswith("_original") or (path.name.startswith(".subsecond-") and path.name.endswith(".repair-stage")):
        return {"path": str(path), "status": "artifact", "reason": "repair_backup_or_private_stage"}
    before_identity = identity(path)
    before = tool.read(path)
    mime = str(before.get("File:MIMEType", ""))
    if not mime.startswith("image/"):
        return {"path": str(path), "status": "not_image", "mime": mime, "reason": "actual_content_is_not_image"}
    result = classify(before)
    result["path"] = str(path)
    result["format"] = before.get("File:FileType")
    result["warnings"] = before.get("_warnings", {})
    if before.get("_format_writable") is False:
        result.update(status="unsupported", reason="installed_exiftool_cannot_write_this_image_format")
        return result
    if result["status"] != "candidate":
        return result
    result["evidence"] = {key: before[key] for key in result["changes"]}
    if not apply:
        return result
    backup = Path(str(path) + "_original")
    if backup.exists() or backup.is_symlink():
        result.update(status="blocked", reason="existing_backup_requires_review", backup=str(backup))
        return result
    if identity(path) != before_identity:
        raise RuntimeError("File changed while metadata was being inspected")
    before = tool.read(path, deep=True)
    try:
        payload_before = image_integrity(path, before)
    except UnsupportedImageError as error:
        result.update(status="unsupported", reason=str(error))
        return result
    descriptor, staging_name = tempfile.mkstemp(prefix=".subsecond-", suffix=".repair-stage", dir=path.parent)
    os.close(descriptor)
    staging = Path(staging_name)
    try:
        shutil.copy2(path, staging)
        if before.get("_large_arrays_decoded"):
            tool.write(staging, result["changes"], decode_large=True)
        else:
            tool.write(staging, result["changes"])
        after = tool.read(staging, deep=True)
        expected = stable_metadata(before)
        expected.update(result["changes"])
        if stable_metadata(after) != expected:
            actual = stable_metadata(after)
            differences = [key for key in expected.keys() | actual.keys() if expected.get(key) != actual.get(key)]
            raise RuntimeError("Metadata verification failed; source unchanged; differing tags=" + ",".join(sorted(differences)))
        if image_integrity(staging, after) != payload_before:
            raise RuntimeError("Image-data verification failed; source unchanged")
        with staging.open("rb") as stream:
            os.fsync(stream.fileno())
        if identity(path) != before_identity:
            raise RuntimeError("Source changed before publish")
        # Exclusive backup creation, same filesystem, original inode preserved.
        os.link(path, backup, follow_symlinks=False)
        if identity(backup)[:4] != before_identity[:4]:
            raise RuntimeError("Original backup identity mismatch")
        os.replace(staging, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if staging.exists():
            staging.unlink()
    result.update(status="repaired_partial" if result["unsupported_targets"] else "repaired", backup=str(backup), verified=True, integrity=payload_before)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Inspect all regular files; detect image content regardless of extension")
    parser.add_argument("--apply", action="store_true", help="Apply the explicit six-digit zero-stripping override with _original backups; default is dry-run")
    parser.add_argument("--workers", type=int, default=min(16, os.cpu_count() or 4))
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--limit", type=int, default=0, help="Stop discovery after N files; 0 means all")
    parser.add_argument("--audit", type=Path, required=True, help="Append JSONL result records (one per file)")
    parser.add_argument("--exiftool", default="exiftool")
    args = parser.parse_args(argv)
    if args.workers < 1 or args.workers > 256 or args.timeout <= 0 or args.limit < 0:
        parser.error("workers must be 1..256, timeout positive, limit nonnegative")
    if args.input.is_symlink() or not args.input.is_dir():
        parser.error("input must be a real directory, not a symlink")
    executable = shutil.which(args.exiftool)
    if not executable:
        parser.error("ExifTool executable was not found")
    root = args.input.resolve()
    capabilities(executable)
    if args.audit.is_symlink() or args.audit.suffix.lower() != ".jsonl":
        parser.error("audit must be a .jsonl file, not a symlink")
    if args.audit.exists() and (not args.audit.is_file() or args.audit.stat().st_nlink != 1):
        parser.error("existing audit must be a regular file without hardlinks")
    if args.audit.resolve().is_relative_to(root):
        parser.error("audit must be outside the input directory")
    thread_state = threading.local()
    all_tools = {}
    lock = threading.Lock()
    run_id = str(uuid.uuid4())

    def work(path):
        try:
            if not getattr(thread_state, "tool", None) or thread_state.tool.process.poll() is not None:
                thread_state.tool = ExifTool(executable, args.timeout)
                with lock:
                    all_tools[threading.get_ident()] = thread_state.tool
            return process_file(thread_state.tool, path, args.apply)
        except Exception as error:
            if getattr(thread_state, "tool", None):
                thread_state.tool.close()
            return {"path": str(path), "status": "error", "error": str(error), "backup": str(path) + "_original"}

    counts = Counter()
    started = time.monotonic()
    last_progress = 0.0
    submitted = 0
    files = discover(root)
    args.audit.parent.mkdir(parents=True, exist_ok=True)
    try:
        with args.audit.open("a", encoding="utf-8") as audit, ThreadPoolExecutor(max_workers=args.workers) as pool:
            audit.write(json.dumps({"event": "start", "run_id": run_id, "utc": datetime.now(timezone.utc).isoformat(), "input": str(root), "apply": args.apply, "workers": args.workers, "policy": POLICY}) + "\n")
            audit.flush()
            pending = set()
            exhausted = False
            current = ""
            while pending or not exhausted:
                while not exhausted and len(pending) < args.workers * 2:
                    if args.limit and submitted >= args.limit:
                        exhausted = True
                        break
                    path = next(files, None)
                    if path is None:
                        exhausted = True
                        break
                    pending.add(pool.submit(work, path))
                    submitted += 1
                if not pending:
                    break
                done, pending = wait(pending, timeout=1, return_when=FIRST_COMPLETED)
                for future in done:
                    result = future.result()
                    result["run_id"] = run_id
                    counts[result["status"]] += 1
                    current = result["path"]
                    audit.write(json.dumps(result, ensure_ascii=True) + "\n")
                now = time.monotonic()
                if now - last_progress >= 1:
                    audit.flush()
                    completed = sum(counts.values())
                    print("processed=%d queued=%d rate=%.1f/s elapsed=%.1fs counts=%s file=%s" % (completed, len(pending), completed / max(now - started, .001), now - started, dict(counts), current), file=sys.stderr, flush=True)
                    last_progress = now
            summary = {"event": "complete", "run_id": run_id, "counts": dict(counts), "elapsed_seconds": round(time.monotonic() - started, 3)}
            audit.write(json.dumps(summary) + "\n")
            audit.flush()
            os.fsync(audit.fileno())
            print(json.dumps(summary), flush=True)
    finally:
        files.close()
        for tool in all_tools.values():
            tool.close()
    return 1 if any(counts[key] for key in ("error", "blocked", "unsupported", "repaired_partial")) else 0


if __name__ == "__main__":
    raise SystemExit(main())
