import {
  DATE_RESOLUTION_POLICY_VERSION,
  DateCandidateInput,
  ResolveDateRequest,
  resolveDateCandidates,
} from '../../../src/main/core/date';

const FILE_ID = 'sha256:media-file';
const EVALUATION_TIME = '2026-08-29T12:00:00.000Z';

function candidate(
  overrides: Partial<DateCandidateInput> &
    Pick<DateCandidateInput, 'id' | 'mediaKind' | 'semantic' | 'sourceKind' | 'tag'>
): DateCandidateInput {
  return {
    fileId: FILE_ID,
    sourceFamily: overrides.sourceKind,
    rawValue: '2024:03:04 05:06:07.7-05:00',
    value: {
      localIso: '2024-03-04T05:06:07.7',
      instantUtc: '2024-03-04T10:06:07.700Z',
      offsetMinutes: -300,
      zoneBasis: 'explicit-offset',
      precision: 'millisecond',
      fractionalDigits: '7',
    },
    ...overrides,
  };
}

function request(candidates: DateCandidateInput[]): ResolveDateRequest {
  return {
    fileId: FILE_ID,
    mediaKind: candidates[0]?.mediaKind ?? 'image',
    evaluationTimeUtc: EVALUATION_TIME,
    candidates,
  };
}

describe('resolveDateCandidates', () => {
  it('exposes the active policy through the public date module', () => {
    expect(DATE_RESOLUTION_POLICY_VERSION).toBe('date-resolution/1');
  });

  it('resolves an exact screenshot timestamp from its structured filename', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'screenshot-filename',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'screenshot-filename',
          tag: 'filename:Screenshot_20240304_050607',
          value: {
            localIso: '2024-03-04T05:06:07',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('medium');
    expect(result.candidates[0].score).toMatchObject({ base: 82, semanticCap: 85, final: 82 });
  });

  it('keeps unknown image tags visible without treating them as selectable evidence', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'unknown-image-tag',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:VendorClock',
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0]).toMatchObject({
      eligibility: 'corroboration-only',
      score: { base: 0, final: 0 },
    });
  });

  it('selects an image capture timestamp and preserves its offset and exact fractional digits', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'create-date',
          mediaKind: 'image',
          semantic: 'digitized',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:CreateDate',
          value: {
            localIso: '2025-01-01T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'capture-date',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('high');
    expect(result.selectedCandidateId).toBe('capture-date');
    expect(result.selectedValue).toEqual({
      localIso: '2024-03-04T05:06:07.7',
      instantUtc: '2024-03-04T10:06:07.700Z',
      offsetMinutes: -300,
      zoneBasis: 'explicit-offset',
      precision: 'millisecond',
      fractionalDigits: '7',
    });
  });

  it('preserves legitimate twentieth-century dates without century mutation', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: '1995-photo',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
          rawValue: '1995:06:01 12:30:00',
          value: {
            localIso: '1995-06-01T12:30:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.selectedValue?.localIso).toBe('1995-06-01T12:30:00');
  });

  it.each([
    ['filesystem-modified', 'FileModifyDate'],
    ['filesystem-changed', 'ctime'],
  ] as const)('forbids %s from becoming ground truth', (semantic, tag) => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: semantic,
          mediaKind: 'image',
          semantic,
          sourceKind: 'filesystem',
          tag,
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.selectedCandidateId).toBeUndefined();
    expect(result.candidates[0].eligibility).toBe('forbidden');
  });

  it('retains filesystem birth as weak evidence with base 25 and cap 35', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'filesystem-birth',
          mediaKind: 'image',
          semantic: 'filesystem-birth',
          sourceKind: 'filesystem',
          tag: 'birthtime',
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0]).toMatchObject({
      eligibility: 'eligible',
      score: { base: 25, semanticCap: 35 },
    });
  });

  it('rejects a known tag when its semantic does not match the media target', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'semantic-spoof',
          mediaKind: 'image',
          semantic: 'recording',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0].eligibility).toBe('invalid');
    expect(result.candidates[0].resolutionIssues).toContain('SEMANTIC_TARGET_MISMATCH');
  });

  it('does not trust caller-authored sourceFamily names as independent corroboration', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-one',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'forged-family-one',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2024-03-04T05:06:07',
            instantUtc: '2024-03-04T10:06:07.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'exif-two',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'forged-family-two',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2024-03-04T05:06:07',
            instantUtc: '2024-03-04T10:06:07.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.selectedGroupScore).toBe(99);
    expect(result.reasonCodes).not.toContain('INDEPENDENT_CORROBORATION');
  });

  it('uses a valid UTC instant, not its wall clock, for the future boundary', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'utc-before-limit',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2026-08-31T01:00:00',
            instantUtc: '2026-08-30T11:00:00.000Z',
            offsetMinutes: 840,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.candidates[0].resolutionIssues).not.toContain('FUTURE_VALUE');
  });

  it('rejects an instant one nanosecond beyond the future boundary', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'one-nanosecond-future',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2026-08-30T12:00:00.000000001',
            instantUtc: '2026-08-30T12:00:00.000000001Z',
            offsetMinutes: 0,
            zoneBasis: 'explicit-offset',
            precision: 'nanosecond',
            fractionalDigits: '000000001',
          },
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0].resolutionIssues).toContain('FUTURE_VALUE');
  });

  it('does not truncate conflicting nanosecond instants to milliseconds', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'nano-one',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2024-03-04T05:06:07.1234567',
            instantUtc: '2024-03-04T05:06:07.1234567Z',
            offsetMinutes: 0,
            zoneBasis: 'explicit-offset',
            precision: 'nanosecond',
            fractionalDigits: '1234567',
          },
        }),
        candidate({
          id: 'nano-two',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2024-03-04T05:06:07.1234568',
            instantUtc: '2024-03-04T05:06:07.1234568Z',
            offsetMinutes: 0,
            zoneBasis: 'explicit-offset',
            precision: 'nanosecond',
            fractionalDigits: '1234568',
          },
        }),
      ])
    );

    expect(result.status).toBe('ambiguous');
    expect(result.contenderIds).toEqual(['nano-one', 'nano-two']);
  });

  it('resolves corroborated whole-second consensus despite conflicting fractional encodings', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-microseconds',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2009-10-18T05:07:46.000098',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000098',
          },
        }),
        candidate({
          id: 'filename-microseconds',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename',
          tag: 'filename:2009-10-18_05-07-46.000098.jpeg',
          value: {
            localIso: '2009-10-18T05:07:46.000098',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000098',
          },
        }),
        candidate({
          id: 'xmp-milliseconds',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          value: {
            localIso: '2009-10-18T05:07:46.098',
            zoneBasis: 'floating-local',
            precision: 'millisecond',
            fractionalDigits: '098',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('high');
    expect(result.selectedCandidateId).toBe('exif-microseconds');
    expect(result.reasonCodes).toContain('SUBSECOND_CONSENSUS');
  });

  it('keeps grouping independent of candidate ids and the first group member', () => {
    const inputs = [
      candidate({
        id: 'a-minute-bridge',
        mediaKind: 'image',
        semantic: 'filename-claim',
        sourceKind: 'filename',
        tag: 'filename:20240304_1200',
        value: {
          localIso: '2024-03-04T12:00',
          zoneBasis: 'floating-local',
          precision: 'minute',
        },
      }),
      candidate({
        id: 'b-exact-start',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        tag: 'EXIF:DateTimeOriginal',
        value: {
          localIso: '2024-03-04T12:00:00',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      }),
      candidate({
        id: 'c-exact-end',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        tag: 'EXIF:DateTimeOriginal',
        value: {
          localIso: '2024-03-04T12:00:59',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      }),
    ];

    const result = resolveDateCandidates(request(inputs));
    const renamed = resolveDateCandidates(
      request(inputs.map((input, index) => ({ ...input, id: `renamed-${2 - index}` })))
    );

    expect(result.status).toBe('ambiguous');
    expect(result.contenderIds).toEqual(['a-minute-bridge', 'b-exact-start', 'c-exact-end']);
    expect(renamed.status).toBe('ambiguous');
    expect(renamed.contenderIds).toHaveLength(3);
  });

  it('fails closed on non-JSON evidence, undefined properties, and non-finite offsets', () => {
    const base = candidate({
      id: 'malformed',
      mediaKind: 'image',
      semantic: 'capture',
      sourceKind: 'embedded-exif',
      tag: 'EXIF:DateTimeOriginal',
    });

    expect(() => resolveDateCandidates(request([{ ...base, rawValue: Number.NaN }]))).toThrow(
      'candidate rawValue must be JSON-safe'
    );
    expect(() =>
      resolveDateCandidates(
        request([
          {
            ...base,
            rawValue: { present: 'yes', missing: undefined },
          } as unknown as DateCandidateInput,
        ])
      )
    ).toThrow('candidate rawValue must be JSON-safe');

    expect(() =>
      resolveDateCandidates(
        request([
          {
            ...base,
            value: { ...base.value, offsetMinutes: Number.NaN },
          },
        ])
      )
    ).toThrow('candidate must be JSON-safe');
  });

  it.each([
    ['millisecond', '2024-03-04T05:06:07', undefined],
    ['microsecond', '2024-03-04T05:06:07.123', '123'],
    ['nanosecond', '2024-03-04T05:06:07.123456', '123456'],
  ] as const)(
    'rejects malformed %s fractional precision',
    (precision, localIso, fractionalDigits) => {
      const result = resolveDateCandidates(
        request([
          candidate({
            id: `${precision}-malformed`,
            mediaKind: 'image',
            semantic: 'capture',
            sourceKind: 'embedded-exif',
            tag: 'EXIF:DateTimeOriginal',
            value: {
              localIso,
              zoneBasis: 'floating-local',
              precision,
              ...(fractionalDigits === undefined ? {} : { fractionalDigits }),
            },
          }),
        ])
      );

      expect(result.status).toBe('unresolved');
      expect(result.candidates[0].resolutionIssues).toContain('PRECISION_FRACTION_MISMATCH');
    }
  );

  it('does not invent the evaluation time when no evidence exists', () => {
    const result = resolveDateCandidates(request([]));

    expect(result.status).toBe('unresolved');
    expect(result.selectedValue).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('current-time');
  });

  it('marks two strong conflicting capture claims ambiguous', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'EXIF:DateTimeOriginal',
        }),
        candidate({
          id: 'xmp',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP:DateCreated',
          rawValue: '2021-02-03T04:05:06Z',
          value: {
            localIso: '2021-02-03T04:05:06',
            instantUtc: '2021-02-03T04:05:06.000Z',
            offsetMinutes: 0,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('ambiguous');
    expect(result.confidence).toBe('none');
    expect(result.selectedCandidateId).toBeUndefined();
    expect(result.contenderIds).toEqual(['exif', 'xmp']);
  });

  it('corroborates matching local clocks when only one metadata value carries an offset', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-floating',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          rawValue: '2006:02:03 03:13:39',
          value: {
            localIso: '2006-02-03T03:13:39',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'xmp-offset',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          rawValue: '2006-02-03T03:13:39-05:00',
          value: {
            localIso: '2006-02-03T03:13:39',
            instantUtc: '2006-02-03T08:13:39.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('high');
    expect(result.selectedCandidateId).toBe('xmp-offset');
    expect(result.selectedValue).toMatchObject({
      localIso: '2006-02-03T03:13:39',
      instantUtc: '2006-02-03T08:13:39.000Z',
      offsetMinutes: -300,
    });
    expect(result.contenderIds).toEqual(['exif-floating', 'xmp-offset']);
  });

  it('forms one corroboration group across local-time and UTC evidence linked by an offset', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-floating',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2006-02-03T03:13:39',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'xmp-offset',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          value: {
            localIso: '2006-02-03T03:13:39',
            instantUtc: '2006-02-03T08:13:39.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'gps-utc',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'container-format',
          sourceFamily: 'gps',
          tag: 'GPS:GPSDateStamp+GPS:GPSTimeStamp',
          value: {
            localIso: '2006-02-03T08:13:39',
            instantUtc: '2006-02-03T08:13:39.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('high');
    expect(result.selectedCandidateId).toBe('xmp-offset');
    expect(result.contenderIds).toEqual(['exif-floating', 'gps-utc', 'xmp-offset']);
  });

  it('resolves a unanimous local capture time while retaining the strongest offset claim', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-offset',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2010-04-16T14:00:49',
            instantUtc: '2010-04-16T18:00:49.000Z',
            offsetMinutes: -240,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'gps-utc',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'container-format',
          sourceFamily: 'gps',
          tag: 'GPS:GPSDateStamp+GPS:GPSTimeStamp',
          value: {
            localIso: '2010-04-16T14:00:49',
            instantUtc: '2010-04-16T14:00:49.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('high');
    expect(result.selectedCandidateId).toBe('exif-offset');
    expect(result.selectedValue?.instantUtc).toBe('2010-04-16T18:00:49.000Z');
  });

  it('treats a standalone GPS timestamp as medium-confidence capture evidence', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'gps-only',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'container-format',
          sourceFamily: 'gps',
          tag: 'GPS:GPSDateStamp+GPS:GPSTimeStamp',
          value: {
            localIso: '2025-04-12T20:12:50',
            instantUtc: '2025-04-12T20:12:50.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('medium');
    expect(result.candidates[0].score).toMatchObject({ base: 75, final: 79 });
  });

  it('scores an XMP CreateDate emitted for video containers', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'video-xmp-create',
          mediaKind: 'video',
          semantic: 'content-created',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-xmp:CreateDate',
          value: {
            localIso: '2020-11-15T20:17:02',
            instantUtc: '2020-11-16T01:17:02.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('medium');
    expect(result.selectedCandidateId).toBe('video-xmp-create');
  });

  it('applies video-aware scoring instead of global tag order', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'media-create',
          mediaKind: 'video',
          semantic: 'container-created',
          sourceKind: 'container-stream',
          sourceFamily: 'quicktime-stream',
          tag: 'QuickTime:MediaCreateDate',
          rawValue: '2025-01-01T00:00:00Z',
          value: {
            localIso: '2025-01-01T00:00:00',
            instantUtc: '2025-01-01T00:00:00.000Z',
            offsetMinutes: 0,
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
        candidate({
          id: 'apple-capture',
          mediaKind: 'video',
          semantic: 'capture',
          sourceKind: 'container-format',
          sourceFamily: 'quicktime-keys',
          tag: 'QuickTime:Keys:CreationDate',
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.selectedCandidateId).toBe('apple-capture');
    expect(result.candidates.find((item) => item.id === 'apple-capture')?.score.final).toBe(100);
    expect(result.candidates.find((item) => item.id === 'media-create')?.score.final).toBe(82);
  });

  it('uses independent agreement as bounded corroboration', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'filename',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename',
          tag: 'filename:IMG_20240304_050607',
        }),
        candidate({
          id: 'xmp',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP:DateCreated',
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.selectedGroupScore).toBe(100);
    expect(result.reasonCodes).toContain('INDEPENDENT_CORROBORATION');
  });

  it('keeps a date-only audio release tag below automatic-resolution confidence', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'tdrc',
          mediaKind: 'audio',
          semantic: 'recording',
          sourceKind: 'audio-tag',
          tag: 'ID3:TDRC',
          rawValue: '1977',
          value: {
            localIso: '1977-01-01',
            zoneBasis: 'date-only',
            precision: 'date',
          },
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.selectedCandidateId).toBeUndefined();
  });

  it('invalidates future and zero-sentinel values rather than repairing them', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'zero',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
          rawValue: '0000:00:00 00:00:00',
          value: {
            localIso: '0000-00-00T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'future',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
          rawValue: '2095:01:01 00:00:00',
          value: {
            localIso: '2095-01-01T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates.every((item) => item.eligibility === 'invalid')).toBe(true);
  });

  it('is deterministic regardless of candidate collection order', () => {
    const candidates = [
      candidate({
        id: 'b',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-xmp',
        sourceFamily: 'xmp',
        tag: 'XMP:DateCreated',
      }),
      candidate({
        id: 'a',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        sourceFamily: 'exif',
        tag: 'EXIF:DateTimeOriginal',
      }),
    ];

    expect(resolveDateCandidates(request(candidates))).toEqual(
      resolveDateCandidates(request([...candidates].reverse()))
    );
  });

  it('returns a JSON-serializable provenance record containing every candidate', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'capture',
          mediaKind: 'raw',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
        }),
      ])
    );

    const roundTrip = JSON.parse(JSON.stringify(result));
    expect(roundTrip).toEqual(result);
    expect(roundTrip.candidates).toHaveLength(1);
    expect(roundTrip.policyVersion).toBe('date-resolution/1');
  });

  it('returns medium confidence for a credible but non-capture video container time', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'track-time',
          mediaKind: 'video',
          semantic: 'container-created',
          sourceKind: 'container-stream',
          tag: 'QuickTime:TrackCreateDate',
          value: {
            localIso: '2024-03-04T10:06:07',
            instantUtc: '2024-03-04T10:06:07.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('medium');
    expect(result.target).toBe('capture-time');
  });

  it('resolves an exact full-timestamp filename at medium confidence', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'filename-only',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename',
          tag: 'filename:IMG_20240304_050607',
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('medium');
    expect(result.selectedCandidateId).toBe('filename-only');
  });

  it('resolves a bounded date-only filename for calendar organization', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'filename-date-only',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-date-only',
          tag: 'filename:IMG_20210615.jpg',
          rawValue: '2021-06-15',
          value: {
            localIso: '2021-06-15',
            zoneBasis: 'date-only',
            precision: 'date',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('medium');
    expect(result.candidates[0].score).toMatchObject({ base: 100, final: 75 });
  });

  it.each([
    ['audio', 'recording-time', 'audio-tag', 'BWF:OriginationDateTime', 'recording'],
    ['document', 'content-created-time', 'embedded-xmp', 'XMP:CreateDate', 'content-created'],
    ['art', 'content-created-time', 'sidecar', 'sidecar:created', 'sidecar-claim'],
  ] as const)(
    'uses the %s resolution target and its media-specific evidence',
    (mediaKind, target, sourceKind, tag, semantic) => {
      const result = resolveDateCandidates(
        request([
          candidate({
            id: `${mediaKind}-date`,
            mediaKind,
            semantic,
            sourceKind,
            tag,
          }),
        ])
      );

      expect(result.target).toBe(target);
      expect(result.status).not.toBe('unresolved');
    }
  );

  it('caps corroboration after three independent source families', () => {
    const inputs = ['filename', 'xmp', 'sidecar'].map((sourceFamily, index) =>
      candidate({
        id: `source-${index}`,
        mediaKind: 'image',
        semantic: index === 0 ? 'filename-claim' : index === 1 ? 'capture' : 'sidecar-claim',
        sourceKind: index === 0 ? 'filename' : index === 1 ? 'embedded-xmp' : 'sidecar',
        sourceFamily,
        tag: index === 0 ? 'filename:date' : index === 1 ? 'XMP:DateCreated' : 'sidecar:capture',
      })
    );

    const result = resolveDateCandidates(request(inputs));
    expect(result.selectedGroupScore).toBe(100);
    expect(result.contenderIds).toEqual(['source-0', 'source-1', 'source-2']);
  });

  it.each([
    [
      'bad-format',
      {
        localIso: 'March 4, 2024',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
      'INVALID_CALENDAR_VALUE',
    ],
    [
      'bad-hour',
      {
        localIso: '2024-03-04T25:00:00',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
      'INVALID_CALENDAR_VALUE',
    ],
    [
      'fraction-mismatch',
      {
        localIso: '2024-03-04T05:06:07.7',
        zoneBasis: 'floating-local',
        precision: 'millisecond',
        fractionalDigits: '70',
      },
      'FRACTIONAL_DIGITS_MISMATCH',
    ],
    [
      'missing-offset',
      {
        localIso: '2024-03-04T05:06:07',
        zoneBasis: 'explicit-offset',
        precision: 'second',
      },
      'INCOMPLETE_EXPLICIT_OFFSET',
    ],
    [
      'missing-utc',
      {
        localIso: '2024-03-04T05:06:07',
        zoneBasis: 'spec-defined-utc',
        precision: 'second',
      },
      'MISSING_SPEC_UTC_INSTANT',
    ],
    [
      'floating-instant',
      {
        localIso: '2024-03-04T05:06:07',
        instantUtc: '2024-03-04T05:06:07.000Z',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
      'FLOATING_VALUE_HAS_INSTANT',
    ],
  ] as const)('rejects %s provenance values', (id, value, issue) => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id,
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
          value,
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0].resolutionIssues).toContain(issue);
  });

  it('rejects inconsistent explicit-offset math and invalid UTC instants', () => {
    const inputs = [
      candidate({
        id: 'offset-mismatch',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        tag: 'EXIF:DateTimeOriginal',
        value: {
          localIso: '2024-03-04T05:06:07',
          instantUtc: '2024-03-04T05:06:07.000Z',
          offsetMinutes: -300,
          zoneBasis: 'explicit-offset',
          precision: 'second',
        },
      }),
      candidate({
        id: 'invalid-instant',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        tag: 'EXIF:DateTimeOriginal',
        value: {
          localIso: '2024-03-04T05:06:07',
          instantUtc: 'not-a-time',
          offsetMinutes: 0,
          zoneBasis: 'explicit-offset',
          precision: 'second',
        },
      }),
    ];

    const result = resolveDateCandidates(request(inputs));
    expect(result.status).toBe('unresolved');
    expect(
      result.candidates.find((item) => item.id === 'offset-mismatch')?.resolutionIssues
    ).toContain('OFFSET_INSTANT_MISMATCH');
    expect(
      result.candidates.find((item) => item.id === 'invalid-instant')?.resolutionIssues
    ).toContain('INVALID_UTC_INSTANT');
  });

  it('rejects a spec-defined UTC wall clock that disagrees with its instant', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'spec-utc-mismatch',
          mediaKind: 'video',
          semantic: 'container-created',
          sourceKind: 'container-stream',
          tag: 'QuickTime:TrackCreateDate',
          value: {
            localIso: '2095-01-01T00:00:00',
            instantUtc: '2024-03-04T05:06:07.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0].resolutionIssues).toContain('UTC_LOCAL_MISMATCH');
  });

  it('does not treat video XMP ModifyDate as capture evidence', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'xmp-modify-date',
          mediaKind: 'video',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          tag: 'XMP:ModifyDate',
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.selectedCandidateId).toBeUndefined();
    expect(result.candidates[0].resolutionIssues).toContain('FORBIDDEN_EVIDENCE');
  });

  it('does not let delimiter-bearing ids overwrite a conflicting candidate group', () => {
    const at = (id: string, localIso: string): DateCandidateInput =>
      candidate({
        id,
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        tag: 'EXIF:DateTimeOriginal',
        value: {
          localIso,
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      });
    const result = resolveDateCandidates(
      request([
        at('a', '2024-03-04T05:06:07'),
        at('b|c', '2024-03-04T05:06:07'),
        at('a|b', '2025-03-04T05:06:07'),
        at('c', '2025-03-04T05:06:07'),
      ])
    );

    expect(result.status).toBe('ambiguous');
    expect(result.contenderIds).toEqual(['a', 'a|b', 'b|c', 'c']);
  });

  it('rejects sparse-array evidence instead of silently changing holes to null', () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const sparseWithFakeCount: unknown[] = [];
    sparseWithFakeCount.length = 1;
    Object.assign(sparseWithFakeCount, { metadata: 'not-an-array-index' });

    for (const [id, rawValue] of [
      ['sparse-evidence', sparse],
      ['sparse-fake-count', sparseWithFakeCount],
    ] as const) {
      expect(() =>
        resolveDateCandidates(
          request([
            candidate({
              id,
              mediaKind: 'image',
              semantic: 'capture',
              sourceKind: 'embedded-exif',
              tag: 'EXIF:DateTimeOriginal',
              rawValue: rawValue as DateCandidateInput['rawValue'],
            }),
          ])
        )
      ).toThrow('candidate rawValue must be JSON-safe');
    }
  });

  it('records inference, precision, and transcode penalties in the score', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'inferred',
          mediaKind: 'video',
          semantic: 'container-created',
          sourceKind: 'container-format',
          tag: 'QuickTime:ContentCreateDate',
          issues: ['KNOWN_EXPORT_OR_TRANSCODE'],
          value: {
            localIso: '2024-03-04T05:06',
            zoneBasis: 'device-zone-inferred',
            precision: 'minute',
          },
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0].score.modifiers).toEqual([
      { code: 'DEVICE_ZONE_INFERENCE', delta: -15 },
      { code: 'MINUTE_ONLY', delta: -5 },
      { code: 'KNOWN_EXPORT_OR_TRANSCODE', delta: -20 },
    ]);
  });

  it('keeps unknown tags as visible corroboration-only evidence', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'unknown',
          mediaKind: 'video',
          semantic: 'capture',
          sourceKind: 'container-format',
          tag: 'Vendor:MysteryClock',
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0].eligibility).toBe('corroboration-only');
    expect(result.rejected[0].reasons).toContain('NO_SELECTION_RULE');
  });

  it('rejects candidates collected for another file or media kind', () => {
    const result = resolveDateCandidates({
      fileId: FILE_ID,
      mediaKind: 'image',
      evaluationTimeUtc: EVALUATION_TIME,
      candidates: [
        candidate({
          id: 'wrong-file',
          fileId: 'sha256:other',
          mediaKind: 'video',
          semantic: 'capture',
          sourceKind: 'container-format',
          tag: 'QuickTime:Keys:CreationDate',
        }),
      ],
    });

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0].resolutionIssues).toEqual([
      'FILE_ID_MISMATCH',
      'MEDIA_KIND_MISMATCH',
    ]);
  });

  it('requires a deterministic UTC evaluation boundary', () => {
    expect(() =>
      resolveDateCandidates({
        fileId: FILE_ID,
        mediaKind: 'image',
        evaluationTimeUtc: 'invalid',
        candidates: [],
      })
    ).toThrow('evaluationTimeUtc must be a valid UTC timestamp');
  });

  it('rejects an evaluation boundary that omits its UTC designator', () => {
    expect(() =>
      resolveDateCandidates({
        fileId: FILE_ID,
        mediaKind: 'image',
        evaluationTimeUtc: '2026-08-29T12:00:00',
        candidates: [],
      })
    ).toThrow('evaluationTimeUtc must be a valid UTC timestamp');
  });

  it('does not merge a date-only claim with the previous calendar day', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'date-only',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename',
          tag: 'filename:2024-03-04',
          rawValue: '2024-03-04',
          value: {
            localIso: '2024-03-04',
            zoneBasis: 'date-only',
            precision: 'date',
          },
        }),
        candidate({
          id: 'previous-day',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'EXIF:DateTimeOriginal',
          rawValue: '2024:03:03 23:59:59',
          value: {
            localIso: '2024-03-03T23:59:59',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.contenderIds).toEqual(['previous-day']);
    expect(result.reasonCodes).not.toContain('INDEPENDENT_CORROBORATION');
  });

  it('rejects duplicate candidate identifiers', () => {
    const duplicate = candidate({
      id: 'duplicate',
      mediaKind: 'image',
      semantic: 'capture',
      sourceKind: 'embedded-exif',
      tag: 'EXIF:DateTimeOriginal',
    });

    expect(() => resolveDateCandidates(request([duplicate, { ...duplicate }]))).toThrow(
      'candidate ids must be unique'
    );
  });

  it('detaches JSON evidence from later caller mutation', () => {
    const input = candidate({
      id: 'detached',
      mediaKind: 'image',
      semantic: 'capture',
      sourceKind: 'embedded-exif',
      tag: 'EXIF:DateTimeOriginal',
      rawValue: { nested: { source: 'camera' } },
    });
    const result = resolveDateCandidates(request([input]));

    (input.rawValue as { nested: { source: string } }).nested.source = 'mutated';
    expect(result.candidates[0].rawValue).toEqual({ nested: { source: 'camera' } });
  });
});
