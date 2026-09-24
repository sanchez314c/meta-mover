import {
  buildMetadataNormalizationPlan,
  isMetadataNormalizationSupported,
} from '../../../src/main/core/metadata/MetadataNormalizationPolicy';

const selectedDate = {
  localIso: '2024-03-04T05:06:07',
  instantUtc: '2024-03-04T10:06:07.000Z',
  offsetMinutes: -300,
  zoneBasis: 'explicit-offset' as const,
  precision: 'second' as const,
};

describe('MetadataNormalizationPolicy', () => {
  it('refuses to invent time metadata for a calendar-date-only resolution', () => {
    expect(() =>
      buildMetadataNormalizationPlan('/tmp/photo.jpg', {
        localIso: '2022-12-12',
        zoneBasis: 'date-only',
        precision: 'date',
      })
    ).toThrow(/calendar date.*must not be written/i);
  });
  it('reports the same explicit format allowlist used by the writer', () => {
    expect(isMetadataNormalizationSupported('/tmp/photo.JPG')).toBe(true);
    expect(isMetadataNormalizationSupported('/tmp/raw.cr3')).toBe(false);
  });
  it.each([
    ['photo.jpg', 'jpeg'],
    ['photo.jpeg', 'jpeg'],
    ['photo.heic', 'heic'],
    ['photo.heif', 'heic'],
    ['capture.png', 'png'],
    ['clip.mov', 'quicktime'],
    ['clip.mp4', 'quicktime'],
    ['clip.m4v', 'quicktime'],
    ['clip.3gp', 'quicktime'],
    ['clip.3g2', 'quicktime'],
    ['recording.wav', 'audio'],
    ['recording.bwf', 'audio'],
    ['song.mp3', 'audio'],
    ['song.m4a', 'audio'],
    ['song.aac', 'audio'],
  ] as const)('builds a deterministic, format-scoped plan for %s', (filePath, family) => {
    const first = buildMetadataNormalizationPlan(filePath, selectedDate);
    const second = buildMetadataNormalizationPlan(filePath.toUpperCase(), selectedDate);

    expect(first).toEqual(second);
    expect(first.family).toBe(family);
    expect(first.assignments.length).toBeGreaterThan(0);
    expect(new Set(first.assignments.map(({ tag }) => tag)).size).toBe(first.assignments.length);
    expect(first.assignments.every(({ tag }) => !/(?:ModifyDate|FileModifyDate)/i.test(tag))).toBe(
      true
    );
  });

  it('keeps namespaces scoped to the actual container', () => {
    const jpeg = buildMetadataNormalizationPlan('/tmp/photo.jpg', selectedDate);
    const video = buildMetadataNormalizationPlan('/tmp/clip.mov', selectedDate);

    expect(jpeg.assignments.some(({ tag }) => tag.startsWith('QuickTime:'))).toBe(false);
    expect(video.assignments.some(({ tag }) => tag.startsWith('EXIF:'))).toBe(false);
    expect(video.assignments.map(({ tag }) => tag)).toEqual([
      'QuickTime:CreateDate',
      'QuickTime:TrackCreateDate',
      'QuickTime:MediaCreateDate',
    ]);
  });

  it('stores EXIF local timestamps and offsets in their dedicated companion tags', () => {
    const jpeg = buildMetadataNormalizationPlan('/tmp/photo.jpg', selectedDate);
    expect(jpeg.assignments).toEqual(
      expect.arrayContaining([
        { tag: 'ExifIFD:DateTimeOriginal', value: '2024:03:04 05:06:07' },
        { tag: 'ExifIFD:OffsetTimeOriginal', value: '-05:00' },
        { tag: 'ExifIFD:OffsetTimeDigitized', value: '-05:00' },
      ])
    );
    expect(
      jpeg.assignments.find(({ tag }) => tag === 'ExifIFD:DateTimeOriginal')?.value
    ).not.toContain('-05:00');
  });

  it('refuses to fabricate a UTC container instant from a floating local timestamp', () => {
    expect(() =>
      buildMetadataNormalizationPlan('/tmp/clip.mov', {
        localIso: '2024-03-04T05:06:07',
        zoneBasis: 'floating-local',
        precision: 'second',
      })
    ).toThrow(/UTC instant/i);
  });

  it('does not convert a date-only value into a false midnight timestamp', () => {
    expect(() =>
      buildMetadataNormalizationPlan('/tmp/photo.heic', {
        localIso: '2024-03-04',
        zoneBasis: 'date-only',
        precision: 'date',
      })
    ).toThrow(/unknown time/i);
  });

  it.each([
    [{ ...selectedDate, localIso: '03/04/2024' }, /canonical local/i],
    [{ ...selectedDate, offsetMinutes: 841 }, /invalid UTC offset/i],
    [{ ...selectedDate, offsetMinutes: 1.5 }, /invalid UTC offset/i],
    [{ ...selectedDate, instantUtc: '2024-03-04 10:06:07' }, /invalid UTC instant/i],
  ])('fails closed for malformed temporal values', (value, expected) => {
    expect(() =>
      buildMetadataNormalizationPlan('/tmp/clip.mov', value as typeof selectedDate)
    ).toThrow(expected);
  });

  it('fails closed for raw, document, and unknown containers', () => {
    for (const filePath of ['/tmp/a.cr3', '/tmp/a.pdf', '/tmp/a.bin']) {
      expect(() => buildMetadataNormalizationPlan(filePath, selectedDate)).toThrow(
        /not supported for metadata normalization/i
      );
    }
  });
});
