"""Bounded HEIF item hashing, including grid descriptors and auxiliary images.

Physical item offsets and EXIF/XMP payloads may change during metadata repair.
Everything else in the meta structure and every nonmetadata item is protected.
Unsupported construction, protection, or external references fail closed.
"""
import hashlib
import struct


MAX_METADATA = 64 * 1024 * 1024
MAX_BOXES = 100000


class Reader:
    def __init__(self, value):
        self.value = value
        self.pos = 0

    def take(self, count):
        if count < 0 or self.pos + count > len(self.value):
            raise ValueError('Truncated HEIF item structure')
        result = self.value[self.pos:self.pos + count]
        self.pos += count
        return result

    def integer(self, count):
        return int.from_bytes(self.take(count), 'big')

    def string(self):
        end = self.value.find(b'\0', self.pos)
        if end < 0:
            raise ValueError('Unterminated HEIF item string')
        result = self.take(end - self.pos)
        self.take(1)
        return result

    def done(self):
        if self.pos != len(self.value):
            raise ValueError('Unexpected HEIF item structure tail')


def boxes(stream, start, end):
    count = 0
    while start < end:
        count += 1
        if count > MAX_BOXES or end - start < 8:
            raise ValueError('Invalid HEIF box bounds/count')
        stream.seek(start)
        header = stream.read(8)
        if len(header) != 8:
            raise ValueError('Truncated HEIF box header')
        size, kind = struct.unpack('>I4s', header)
        head = 8
        if size == 1:
            raw = stream.read(8)
            if len(raw) != 8:
                raise ValueError('Truncated HEIF extended box')
            size = int.from_bytes(raw, 'big')
            head = 16
        elif size == 0:
            size = end - start
        if size < head or size > end - start:
            raise ValueError('HEIF box exceeds container')
        yield kind, start + head, start + size
        start += size


def small(stream, start, end):
    if end - start > MAX_METADATA:
        raise ValueError('HEIF metadata exceeds bounded parser limit')
    stream.seek(start)
    value = stream.read(end - start)
    if len(value) != end - start:
        raise ValueError('Truncated HEIF metadata')
    return value


def item_information(stream, start, end):
    header = Reader(small(stream, start, min(start + 8, end)))
    version = header.integer(1)
    if header.take(3) != b'\0' * 3 or version not in (0, 1):
        raise ValueError('Unsupported HEIF iinf version/flags')
    count = header.integer(2 if version == 0 else 4)
    result = {}
    for kind, first, last in boxes(stream, start + header.pos, end):
        if kind != b'infe':
            raise ValueError('Unexpected HEIF item information box')
        data = Reader(small(stream, first, last))
        version = data.integer(1)
        data.take(3)  # infe flags are retained in the structural hash
        if version not in (2, 3):
            raise ValueError('Unsupported HEIF infe version')
        ident = data.integer(2 if version == 2 else 4)
        protected = data.integer(2)
        item_type = data.take(4)
        data.string()  # item name is retained in the structural hash
        content_type = data.string() if item_type == b'mime' else b''
        encoding = data.string() if item_type == b'mime' and data.pos < len(data.value) else b''
        if item_type == b'uri ':
            raise ValueError('External URI image item is unsupported')
        data.done()
        if protected or encoding or ident in result:
            raise ValueError('Protected, encoded, or duplicate HEIF item')
        result[ident] = item_type == b'Exif' or (item_type == b'mime' and content_type == b'application/rdf+xml')
    if count != len(result) or not result:
        raise ValueError('HEIF item count mismatch')
    return result


def locations(value):
    data = Reader(value)
    version = data.integer(1)
    if data.take(3) != b'\0' * 3 or version not in (0, 1, 2):
        raise ValueError('Unsupported HEIF iloc version/flags')
    sizes = data.integer(1)
    offset_size, length_size = sizes >> 4, sizes & 15
    sizes = data.integer(1)
    base_size, index_size = sizes >> 4, sizes & 15
    if any(size not in (0, 4, 8) for size in (offset_size, length_size, base_size, index_size)):
        raise ValueError('Unsupported HEIF extent integer width')
    if version == 0 and index_size:
        raise ValueError('Nonzero reserved HEIF extent size')
    count = data.integer(2 if version < 2 else 4)
    if count > MAX_BOXES:
        raise ValueError('Excessive HEIF item count')
    result = {}
    for _ in range(count):
        ident = data.integer(2 if version < 2 else 4)
        method = data.integer(2) if version else 0
        reference = data.integer(2)
        base = data.integer(base_size)
        extent_count = data.integer(2)
        if method not in (0, 1) or reference or ident in result or not extent_count:
            raise ValueError('Unsupported HEIF item construction/reference/count')
        extents = []
        for _ in range(extent_count):
            index = data.integer(index_size) if version else 0
            offset = data.integer(offset_size)
            length = data.integer(length_size)
            if index or not length:
                raise ValueError('Indexed or unbounded HEIF extent unsupported')
            extents.append((base + offset, length))
        result[ident] = method, extents
    data.done()
    return result


def heif_payload_digest(path):
    """Return SHA256 protecting all image items plus interpretation structures."""
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        stream.seek(0, 2)
        size = stream.tell()
        top = list(boxes(stream, 0, size))
        metas = [(start, end) for kind, start, end in top if kind == b'meta']
        if len(metas) != 1 or not any(kind == b'ftyp' for kind, _, _ in top):
            raise ValueError('HEIF requires one meta box and file type')
        # Timed image sequences need a separate sample-table validator.
        if any(kind == b'moov' for kind, _, _ in top):
            raise ValueError('Timed HEIF sequences are unsupported by item validator')
        for kind, start, end in top:
            if kind not in (b'meta', b'mdat', b'free', b'skip'):
                value = small(stream, start, end)
                digest.update(kind + struct.pack('>Q', len(value)) + value)
        start, end = metas[0]
        if small(stream, start, start + 4) != b'\0' * 4:
            raise ValueError('Unsupported HEIF meta version/flags')
        children = list(boxes(stream, start + 4, end))
        selected = {}
        for kind, first, last in children:
            if kind in (b'iinf', b'iloc', b'idat'):
                if kind in selected:
                    raise ValueError('Duplicate HEIF metadata structure')
                selected[kind] = first, last
            if kind not in (b'iloc', b'idat', b'free', b'skip'):
                value = small(stream, first, last)
                digest.update(kind + struct.pack('>Q', len(value)) + value)
        if b'iinf' not in selected or b'iloc' not in selected:
            raise ValueError('HEIF item information/location missing')
        info = item_information(stream, *selected[b'iinf'])
        offsets = locations(small(stream, *selected[b'iloc']))
        if info.keys() != offsets.keys():
            raise ValueError('HEIF item information/location mismatch')
        media_ranges = [(first, last) for kind, first, last in top if kind == b'mdat']
        image_count = 0
        for ident in sorted(info):
            method, extents = offsets[ident]
            if method == 1 and b'idat' not in selected:
                raise ValueError('HEIF idat construction lacks idat')
            ranges = [selected[b'idat']] if method == 1 else media_ranges
            resolved = []
            for offset, length in extents:
                absolute = offset + selected[b'idat'][0] if method == 1 else offset
                if not any(first <= absolute and absolute + length <= last for first, last in ranges):
                    raise ValueError('HEIF item extent outside data box')
                resolved.append((absolute, length))
            if info[ident]:
                continue
            image_count += 1
            digest.update(struct.pack('>IQ', ident, sum(length for _, length in resolved)))
            for absolute, length in resolved:
                stream.seek(absolute)
                while length:
                    block = stream.read(min(length, 1024 * 1024))
                    if not block:
                        raise ValueError('Truncated HEIF image payload')
                    digest.update(block)
                    length -= len(block)
        if not image_count:
            raise ValueError('HEIF has no verifiable image items')
    return digest.hexdigest()
