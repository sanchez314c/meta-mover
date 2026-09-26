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
    expect(DATE_RESOLUTION_POLICY_VERSION).toBe('date-resolution/2');
  });

  it('resolves a unanimous embedded calendar day while preserving unknown time', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'placeholder-original',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2022-12-12T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'iptc-day',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          tag: 'IPTC:DateCreated',
          value: { localIso: '2022-12-12', zoneBasis: 'date-only', precision: 'date' },
        }),
        candidate({
          id: 'filename-disagreement',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          tag: 'filename:date',
          value: { localIso: '2020-01-01', zoneBasis: 'date-only', precision: 'date' },
        }),
        candidate({
          id: 'filesystem-disagreement',
          mediaKind: 'image',
          semantic: 'filesystem-birth',
          sourceKind: 'filesystem',
          sourceFamily: 'filesystem-birth',
          tag: 'FileSystem:BirthTime',
          value: {
            localIso: '2026-01-01T02:03:04',
            instantUtc: '2026-01-01T02:03:04.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
        candidate({
          id: 'sidecar-same-day',
          mediaKind: 'image',
          semantic: 'sidecar-claim',
          sourceKind: 'sidecar',
          tag: 'Sidecar:DateCreated',
          value: { localIso: '2022-12-12', zoneBasis: 'date-only', precision: 'date' },
        }),
      ])
    );

    expect(result).toMatchObject({
      policyVersion: 'date-resolution/2',
      status: 'resolved',
      confidence: 'medium',
      selectedValue: { localIso: '2022-12-12', zoneBasis: 'date-only', precision: 'date' },
    });
    expect(result.selectedValue).not.toHaveProperty('instantUtc');
    expect(result.contenderIds).toEqual(
      expect.arrayContaining(['placeholder-original', 'iptc-day', 'sidecar-same-day'])
    );
    expect(result.contenderIds).not.toContain('filename-disagreement');
    expect(result.contenderIds).not.toContain('filesystem-disagreement');
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['CALENDAR_DATE_CONSENSUS', 'TIME_UNKNOWN', 'RESOLVED_DATE_ONLY'])
    );
  });

  it('preserves a trustworthy non-midnight EXIF time when same-day IPTC only confirms the date', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'trusted-original',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2022-12-12T14:15:16',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'iptc-day',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          tag: 'IPTC:DateCreated',
          value: { localIso: '2022-12-12', zoneBasis: 'date-only', precision: 'date' },
        }),
      ])
    );

    expect(result).toMatchObject({
      status: 'resolved',
      selectedCandidateId: 'trusted-original',
      selectedValue: {
        localIso: '2022-12-12T14:15:16',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
    });
    expect(result.reasonCodes).not.toContain('CALENDAR_DATE_CONSENSUS');
  });

  it('preserves historical calendar consensus before the review-only fallback', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'original-morning',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2022-12-12T08:09:10',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'iptc-afternoon',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          tag: 'IPTC:DateCreated',
          value: {
            localIso: '2022-12-12T14:15:16',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'iptc-day',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          tag: 'IPTC:DateCreated',
          value: { localIso: '2022-12-12', zoneBasis: 'date-only', precision: 'date' },
        }),
      ])
    );

    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'medium',
      selectedValue: { localIso: '2022-12-12', zoneBasis: 'date-only', precision: 'date' },
    });
    expect(result.reasonCodes).toContain('CALENDAR_DATE_CONSENSUS');
  });

  it('uses date precision for the audited same-second embedded fractional ambiguity', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'original-fraction',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2020-04-13T15:32:38.000411',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000411',
          },
        }),
        candidate({
          id: 'digitized-fraction',
          mediaKind: 'image',
          semantic: 'digitized',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:CreateDate',
          value: {
            localIso: '2020-04-13T15:32:38.000411',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000411',
          },
        }),
        candidate({
          id: 'editorial-fraction',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          value: {
            localIso: '2020-04-13T15:32:38.411',
            instantUtc: '2020-04-13T19:32:38.411Z',
            offsetMinutes: -240,
            zoneBasis: 'explicit-offset',
            precision: 'millisecond',
            fractionalDigits: '411',
          },
        }),
        candidate({
          id: 'xmp-original-seconds',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp-exif',
          tag: 'XMP-exif:DateTimeOriginal',
          value: {
            localIso: '2020-04-13T15:32:38',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'xmp-created-seconds',
          mediaKind: 'image',
          semantic: 'content-created',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-xmp:CreateDate',
          value: {
            localIso: '2020-04-13T15:32:38',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'filename-seconds',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename',
          tag: 'filename:2020-04-13_15-32-38.jpeg',
          value: {
            localIso: '2020-04-13T15:32:38',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'medium',
      selectedValue: { localIso: '2020-04-13', zoneBasis: 'date-only', precision: 'date' },
    });
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['CALENDAR_DATE_CONSENSUS', 'TIME_UNKNOWN', 'RESOLVED_DATE_ONLY'])
    );
  });

  it('does not generalize lifecycle fraction recovery to an unaudited XMP tag', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'original-fraction',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2020-04-13T15:32:38.000411',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000411',
          },
        }),
        candidate({
          id: 'digitized-fraction',
          mediaKind: 'image',
          semantic: 'digitized',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:CreateDate',
          value: {
            localIso: '2020-04-13T15:32:38.000411',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000411',
          },
        }),
        candidate({
          id: 'unaudited-editorial-fraction',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-dc:Date',
          value: {
            localIso: '2020-04-13T15:32:38.411',
            instantUtc: '2020-04-13T19:32:38.411Z',
            offsetMinutes: -240,
            zoneBasis: 'explicit-offset',
            precision: 'millisecond',
            fractionalDigits: '411',
          },
        }),
        candidate({
          id: 'xmp-original-seconds',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp-exif',
          tag: 'XMP-exif:DateTimeOriginal',
          value: {
            localIso: '2020-04-13T15:32:38',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'xmp-created-seconds',
          mediaKind: 'image',
          semantic: 'content-created',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-xmp:CreateDate',
          value: {
            localIso: '2020-04-13T15:32:38',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.reasonCodes).not.toContain('CALENDAR_DATE_CONSENSUS');
    expect(result.selectedValue).not.toMatchObject({ precision: 'date' });
  });

  it('uses the same calendar contract for valid embedded video capture tags', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'video-original',
          mediaKind: 'video',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp-video',
          tag: 'XMP-exif:DateTimeOriginal',
          value: {
            localIso: '2024-05-06T07:08:09',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'video-editorial',
          mediaKind: 'video',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp-photoshop',
          tag: 'XMP-photoshop:DateCreated',
          value: {
            localIso: '2024-05-06T17:18:19',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'medium',
      selectedValue: { localIso: '2024-05-06', zoneBasis: 'date-only', precision: 'date' },
    });
    expect(result.reasonCodes).toContain('CALENDAR_DATE_CONSENSUS');
  });

  it('refuses calendar-date resolution when a credible embedded capture field names another day', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'original',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2022-12-12T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'canon-veto',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'canon-makernote',
          tag: 'Canon:TimeStamp',
          value: {
            localIso: '2016-02-16T15:34:53',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );
    expect(result.reasonCodes).not.toContain('CALENDAR_DATE_CONSENSUS');
  });

  it.each([
    ['sidecar', 'Sidecar:DateCreated', 'sidecar', 'sidecar-claim'],
    ['container-format', 'QuickTime:CreateDate', 'quicktime', 'digitized'],
  ] as const)(
    'lets a credible %s creation claim on another day veto embedded calendar consensus',
    (sourceKind, tag, sourceFamily, semantic) => {
      const result = resolveDateCandidates(
        request([
          candidate({
            id: 'embedded-day',
            mediaKind: 'image',
            semantic: 'capture',
            sourceKind: 'embedded-exif',
            tag: 'ExifIFD:DateTimeOriginal',
            value: {
              localIso: '2022-12-12T00:00:00',
              zoneBasis: 'floating-local',
              precision: 'second',
            },
          }),
          candidate({
            id: `${sourceKind}-veto`,
            mediaKind: 'image',
            semantic,
            sourceKind,
            sourceFamily,
            tag,
            value: {
              localIso: '2021-04-05T06:07:08',
              zoneBasis: 'floating-local',
              precision: 'second',
            },
          }),
        ])
      );

      expect(result.reasonCodes).not.toContain('CALENDAR_DATE_CONSENSUS');
    }
  );

  it('keeps a manual calendar date explicit and medium confidence', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'manual-day',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'user-override',
          tag: 'UserOverride:CreationDate',
          value: { localIso: '2021-04-05', zoneBasis: 'date-only', precision: 'date' },
        }),
      ])
    );
    expect(result).toMatchObject({
      policyVersion: 'date-resolution/2',
      status: 'resolved',
      confidence: 'medium',
      selectedCandidateId: 'manual-day',
      selectedValue: { localIso: '2021-04-05', zoneBasis: 'date-only', precision: 'date' },
    });
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['NON_AUTHORITATIVE_SELECTION', 'RESOLVED_MEDIUM_CONFIDENCE'])
    );
    expect(result.reasonCodes).not.toContain('CALENDAR_DATE_CONSENSUS');
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

  it('does not treat words inside a valid filename timestamp as metadata tag provenance', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'filename-with-metadata-word',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'filename:ModifyDate_20240102_030405.jpg',
          value: {
            localIso: '2024-01-02T03:04:05',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'medium',
      selectedCandidateId: 'filename-with-metadata-word',
    });
  });

  it('rejects a non-filename tag relabeled as filename evidence', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'filesystem-relabeled-as-filename',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'FileSystem:ModifiedTime',
        }),
      ])
    );

    expect(result.status).toBe('unresolved');
    expect(result.candidates[0]).toMatchObject({
      eligibility: 'invalid',
      resolutionIssues: expect.arrayContaining(['PROVENANCE_MISMATCH']),
    });
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

  it('omits a lone fractional claim while preserving its supported offset and whole second', () => {
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
      localIso: '2024-03-04T05:06:07',
      instantUtc: '2024-03-04T10:06:07.000Z',
      offsetMinutes: -300,
      zoneBasis: 'explicit-offset',
      precision: 'second',
    });
    expect(result.reasonCodes).toContain('UNVERIFIED_SUBSECONDS_OMITTED');
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
    ['filesystem-modified', 'FileSystem:ModifiedTime'],
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

  it('preserves only the calendar day for conflicting nanosecond instants', () => {
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

    expect(result.status).toBe('resolved');
    expect(result.selectedValue).toEqual({
      localIso: '2024-03-04',
      zoneBasis: 'date-only',
      precision: 'date',
    });
    expect(result.reasonCodes).toContain('CALENDAR_DATE_CONSENSUS');
  });

  it('does not call conflicting fractional values subsecond consensus', () => {
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
    expect(result.confidence).toBe('medium');
    expect(result.selectedCandidateId).toBe('exif-microseconds');
    expect(result.reasonCodes).not.toContain('SUBSECOND_CONSENSUS');
  });

  it('omits EXIF and filename subseconds when authoritative XMP conflicts', () => {
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
            localIso: '2008-09-20T09:05:00.000065',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000065',
          },
        }),
        candidate({
          id: 'filename-microseconds',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename',
          tag: 'filename:2008-09-20_09-05-00.000065_03.jpeg',
          value: {
            localIso: '2008-09-20T09:05:00.000065',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000065',
          },
        }),
        candidate({
          id: 'xmp-conflicting-fraction',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          value: {
            localIso: '2008-09-20T09:05:00.65',
            zoneBasis: 'floating-local',
            precision: 'millisecond',
            fractionalDigits: '65',
          },
        }),
        candidate({
          id: 'iptc-offset-seconds',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc',
          tag: 'IPTC:DateCreated',
          value: {
            localIso: '2008-09-20T09:05:00',
            instantUtc: '2008-09-20T14:05:00.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'high',
      selectedCandidateId: 'iptc-offset-seconds',
      selectedValue: {
        localIso: '2008-09-20T09:05:00',
        precision: 'second',
      },
    });
    expect(result.selectedValue).not.toHaveProperty('fractionalDigits');
    expect(result.reasonCodes).not.toContain('SUBSECOND_CONSENSUS');
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['SUBSECOND_CONFLICT', 'UNVERIFIED_SUBSECONDS_OMITTED'])
    );
  });

  it('preserves a nonzero exact subsecond only across authoritative embedded families', () => {
    const exactValue = {
      localIso: '2019-05-06T07:08:09.123456',
      zoneBasis: 'floating-local' as const,
      precision: 'microsecond' as const,
      fractionalDigits: '123456',
    };
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-exact',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: exactValue,
        }),
        candidate({
          id: 'xmp-exact',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          value: exactValue,
        }),
        candidate({
          id: 'filename-exact',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename',
          tag: 'filename:2019-05-06_07-08-09.123456.jpg',
          value: exactValue,
        }),
      ])
    );

    expect(result.selectedValue).toEqual(exactValue);
    expect(result.reasonCodes).toContain('SUBSECOND_CONSENSUS');
    expect(result.reasonCodes).not.toContain('UNVERIFIED_SUBSECONDS_OMITTED');
  });

  it('omits zero-only fractional precision because it adds no supported information', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-zero-fraction',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2020-01-02T03:04:05.000',
            zoneBasis: 'floating-local',
            precision: 'millisecond',
            fractionalDigits: '000',
          },
        }),
      ])
    );

    expect(result.selectedValue).toEqual({
      localIso: '2020-01-02T03:04:05',
      zoneBasis: 'floating-local',
      precision: 'second',
    });
    expect(result.reasonCodes).toContain('UNVERIFIED_SUBSECONDS_OMITTED');
  });

  it('rejects subsecond authorization when another authoritative family conflicts', () => {
    const makeValue = (fractionalDigits: string) => ({
      localIso: `2020-01-02T03:04:05.${fractionalDigits}`,
      zoneBasis: 'floating-local' as const,
      precision: 'millisecond' as const,
      fractionalDigits,
    });
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-agreement',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: makeValue('123'),
        }),
        candidate({
          id: 'xmp-agreement',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          value: makeValue('123'),
        }),
        candidate({
          id: 'container-conflict',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'container-format',
          sourceFamily: 'container',
          tag: 'Composite:SubSecDateTimeOriginal',
          value: makeValue('456'),
        }),
      ])
    );

    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['SUBSECOND_CONFLICT', 'UNVERIFIED_SUBSECONDS_OMITTED'])
    );
    expect(result.reasonCodes).not.toContain('SUBSECOND_CONSENSUS');
    expect(result.status).toBe('ambiguous');
    expect(result.selectedValue).toBeUndefined();
  });

  it('keeps calendar recovery independent of candidate ids and the first group member', () => {
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

    expect(result.status).toBe('resolved');
    expect(result.selectedValue?.precision).toBe('date');
    expect(renamed.status).toBe('resolved');
    expect(renamed.selectedValue?.precision).toBe('date');
    expect(renamed.contenderIds).toHaveLength(2);
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
          rawValue: '2025-01-01T10:20:30Z',
          value: {
            localIso: '2025-01-01T10:20:30',
            instantUtc: '2025-01-01T10:20:30.000Z',
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
    expect(roundTrip.policyVersion).toBe('date-resolution/2');
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

  it.each([
    [
      'positive offset across the previous day',
      '2024-01-01T00:15:00.000001',
      '2023-12-31T23:15:00.000001Z',
      60,
      '000001',
    ],
    [
      'negative offset across the next day',
      '2024-12-31T23:45:00.999999999',
      '2025-01-01T00:45:00.999999999Z',
      -60,
      '999999999',
    ],
  ])(
    'accepts exact explicit-offset arithmetic for %s',
    (_name, localIso, instantUtc, offset, fraction) => {
      const result = resolveDateCandidates(
        request([
          candidate({
            id: `exact-${fraction}`,
            mediaKind: 'image',
            semantic: 'capture',
            sourceKind: 'embedded-exif',
            tag: 'EXIF:DateTimeOriginal',
            value: {
              localIso,
              instantUtc,
              offsetMinutes: offset,
              zoneBasis: 'explicit-offset',
              precision: fraction.length <= 6 ? 'microsecond' : 'nanosecond',
              fractionalDigits: fraction,
            },
          }),
        ])
      );

      expect(result.candidates[0].resolutionIssues).not.toContain('OFFSET_INSTANT_MISMATCH');
      expect(result.status).toBe('resolved');
    }
  );

  it('keeps a one-nanosecond explicit-offset mismatch rejected', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'true-nanosecond-mismatch',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2024-03-04T05:06:07.123456789',
            instantUtc: '2024-03-04T10:06:07.123456788Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'nanosecond',
            fractionalDigits: '123456789',
          },
        }),
      ])
    );

    expect(result.candidates[0].resolutionIssues).toContain('OFFSET_INSTANT_MISMATCH');
    expect(result.status).toBe('unresolved');
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

  it('resolves a QuickTime Keys capture time when the container dates are the same instant in UTC', () => {
    const utc = {
      localIso: '2024-06-19T03:05:31',
      instantUtc: '2024-06-19T03:05:31.000Z',
      zoneBasis: 'spec-defined-utc',
      precision: 'second',
    } as const;
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'keys',
          mediaKind: 'video',
          semantic: 'capture',
          sourceKind: 'container-format',
          sourceFamily: 'quicktime-keys',
          tag: 'Keys:CreationDate',
          rawValue: '2024:06:18 23:05:31-04:00',
          value: {
            localIso: '2024-06-18T23:05:31',
            instantUtc: '2024-06-19T03:05:31.000Z',
            offsetMinutes: -240,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'quicktime',
          mediaKind: 'video',
          semantic: 'container-created',
          sourceKind: 'container-format',
          sourceFamily: 'quicktime-format',
          tag: 'QuickTime:CreateDate',
          rawValue: '2024:06:19 03:05:31',
          value: utc,
        }),
        candidate({
          id: 'track',
          mediaKind: 'video',
          semantic: 'container-created',
          sourceKind: 'container-stream',
          sourceFamily: 'quicktime-media',
          tag: 'Track1:MediaCreateDate',
          rawValue: '2024:06:19 03:05:31',
          value: utc,
        }),
        candidate({
          id: 'xmp',
          mediaKind: 'video',
          semantic: 'content-created',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-xmp:CreateDate',
          rawValue: '2024:06:19 03:05:31',
          value: {
            localIso: '2024-06-19T03:05:31',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'filename',
          mediaKind: 'video',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'filename:2024-06-19_03-05-31.mov',
          rawValue: '2024-06-19_03-05-31.mov',
          value: {
            localIso: '2024-06-19T03:05:31',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('high');
    expect(result.selectedCandidateId).toBe('keys');
    expect(result.selectedValue?.localIso).toBe('2024-06-18T23:05:31');
    expect(result.reasonCodes).toContain('SAME_INSTANT_CONTENDER');
    expect(result.reasonCodes).not.toContain('STRONG_CONFLICT');
  });

  it('prefers a corroborated EXIF DateTimeOriginal over a later IPTC editorial date', () => {
    const original = {
      localIso: '2003-07-01T14:22:09',
      zoneBasis: 'floating-local',
      precision: 'second',
    } as const;
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'dto',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          rawValue: '2003:07:01 14:22:09',
          value: original,
        }),
        candidate({
          id: 'exif-create',
          mediaKind: 'image',
          semantic: 'digitized',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:CreateDate',
          rawValue: '2003:07:01 14:22:09',
          value: original,
        }),
        candidate({
          id: 'filename',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'filename:2003-07-01_14-22-09.jpeg',
          rawValue: '2003-07-01_14-22-09.jpeg',
          value: original,
        }),
        candidate({
          id: 'iptc',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc',
          tag: 'IPTC:DateCreated',
          rawValue: '2006:02:08 14:56:31-05:00',
          value: {
            localIso: '2006-02-08T14:56:31',
            instantUtc: '2006-02-08T19:56:31.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('medium');
    expect(result.selectedCandidateId).toBe('dto');
    expect(result.selectedValue?.localIso).toBe('2003-07-01T14:22:09');
    expect(result.reasonCodes).toContain('AUTHORITATIVE_ORIGINAL_PREFERRED');
    expect(result.reasonCodes).not.toContain('STRONG_CONFLICT');
  });

  it('keeps an uncorroborated Keys capture time ambiguous against a different container instant', () => {
    const container = {
      localIso: '2023-07-29T23:26:18',
      instantUtc: '2023-07-29T23:26:18.000Z',
      zoneBasis: 'spec-defined-utc',
      precision: 'second',
    } as const;
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'keys',
          mediaKind: 'video',
          semantic: 'capture',
          sourceKind: 'container-format',
          sourceFamily: 'quicktime-keys',
          tag: 'Keys:CreationDate',
          rawValue: '2021:06:04 20:52:30-04:00',
          value: {
            localIso: '2021-06-04T20:52:30',
            instantUtc: '2021-06-05T00:52:30.000Z',
            offsetMinutes: -240,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'quicktime',
          mediaKind: 'video',
          semantic: 'container-created',
          sourceKind: 'container-format',
          sourceFamily: 'quicktime-format',
          tag: 'QuickTime:CreateDate',
          rawValue: '2023:07:29 23:26:18',
          value: container,
        }),
        candidate({
          id: 'track',
          mediaKind: 'video',
          semantic: 'container-created',
          sourceKind: 'container-stream',
          sourceFamily: 'quicktime-media',
          tag: 'Track1:MediaCreateDate',
          rawValue: '2023:07:29 23:26:18',
          value: container,
        }),
        candidate({
          id: 'filename',
          mediaKind: 'video',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'filename:2023-07-29_23-26-18.MOV',
          rawValue: '2023-07-29_23-26-18.MOV',
          value: {
            localIso: '2023-07-29T23:26:18',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('ambiguous');
    expect(result.reasonCodes).toContain('STRONG_CONFLICT');
    expect(result.selectedCandidateId).toBeUndefined();
  });

  it('resolves the unanimous embedded calendar day without treating a derived filename as evidence', () => {
    const midnight = {
      localIso: '2022-01-01T00:00:00',
      zoneBasis: 'floating-local',
      precision: 'second',
    } as const;
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'dto',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          rawValue: '2022:01:01 00:00:00',
          value: midnight,
        }),
        candidate({
          id: 'xmp',
          mediaKind: 'image',
          semantic: 'content-created',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-xmp:CreateDate',
          rawValue: '2022:01:01 00:00:00',
          value: midnight,
        }),
        candidate({
          id: 'filename',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename',
          tag: 'filename:2022-01-01_00-00-00_131.jpg',
          rawValue: '2022-01-01_00-00-00_131.jpg',
          value: midnight,
        }),
      ])
    );

    const dto = result.candidates.find((entry) => entry.id === 'dto');
    expect(dto?.score.modifiers).toContainEqual({ code: 'MIDNIGHT_PLACEHOLDER', delta: -25 });
    expect(result.status).toBe('resolved');
    expect(result.confidence).toBe('medium');
    expect(result.selectedCandidateId).toBe('dto');
    expect(result.selectedValue).toEqual({
      localIso: '2022-01-01',
      zoneBasis: 'date-only',
      precision: 'date',
    });
    expect(result.reasonCodes).toContain('CALENDAR_DATE_CONSENSUS');
  });

  it('lets a real editorial timestamp beat an exact-midnight placeholder original', () => {
    const midnight = {
      localIso: '2022-01-01T00:00:00.000711',
      zoneBasis: 'floating-local',
      precision: 'microsecond',
      fractionalDigits: '000711',
    } as const;
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'dto',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          rawValue: '2022:01:01 00:00:00.000711',
          value: midnight,
        }),
        candidate({
          id: 'filename',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename',
          tag: 'filename:2022-01-01_00-00-00.000711_01.jpeg',
          rawValue: '2022-01-01_00-00-00.000711_01.jpeg',
          value: midnight,
        }),
        candidate({
          id: 'photoshop',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          rawValue: '2023:08:22 19:19:25',
          value: {
            localIso: '2023-08-22T19:19:25',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'iptc',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc',
          sourceFamily: 'iptc',
          tag: 'IPTC:DateCreated',
          rawValue: '2023:08:22 19:19:25',
          value: {
            localIso: '2023-08-22T19:19:25',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(['photoshop', 'iptc']).toContain(result.selectedCandidateId);
    expect(result.selectedValue?.localIso).toBe('2023-08-22T19:19:25');
    expect(result.reasonCodes).not.toContain('AUTHORITATIVE_ORIGINAL_PREFERRED');
  });

  it('does not penalize a genuine midnight date-only claim twice', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'date-only',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-date-only',
          tag: 'filename:2022-01-01.jpg',
          rawValue: '2022-01-01.jpg',
          value: { localIso: '2022-01-01', zoneBasis: 'date-only', precision: 'date' },
        }),
      ])
    );
    const only = result.candidates[0];
    expect(only.score.modifiers.map((modifier) => modifier.code)).not.toContain(
      'MIDNIGHT_PLACEHOLDER'
    );
  });

  it('caps a corroborated authoritative-original selection at medium when a real claim conflicts', () => {
    const original = {
      localIso: '2018-06-10T12:30:45',
      zoneBasis: 'floating-local',
      precision: 'second',
    } as const;
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'dto',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'EXIF:DateTimeOriginal',
          value: original,
        }),
        candidate({
          id: 'filename',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'filename:2018-06-10_12-30-45.jpg',
          value: original,
        }),
        candidate({
          id: 'editorial',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc',
          sourceFamily: 'iptc',
          tag: 'IPTC:DateCreated',
          value: {
            localIso: '2024-03-04T05:06:07',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'medium',
      selectedCandidateId: 'dto',
    });
    expect(result.reasonCodes).toContain('AUTHORITATIVE_ORIGINAL_PREFERRED');
  });

  it('keeps only the shared calendar day when equal wall clocks identify different instants', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'east',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2020-01-01T10:00:00',
            instantUtc: '2020-01-01T15:00:00.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'west',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP:DateCreated',
          value: {
            localIso: '2020-01-01T10:00:00',
            instantUtc: '2020-01-01T18:00:00.000Z',
            offsetMinutes: -480,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.selectedValue?.precision).toBe('date');
    expect(result.reasonCodes).toContain('CALENDAR_DATE_CONSENSUS');
  });

  it('ignores a matching filename while preserving only the shared embedded calendar day', () => {
    const wallClock = '2020-01-01T10:00:00';
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'east',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: wallClock,
            instantUtc: '2020-01-01T15:00:00.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'west',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP:DateTimeOriginal',
          value: {
            localIso: wallClock,
            instantUtc: '2020-01-01T18:00:00.000Z',
            offsetMinutes: -480,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'filename',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'filename:2020-01-01_10-00-00.jpg',
          value: {
            localIso: wallClock,
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.selectedValue?.precision).toBe('date');
    expect(result.reasonCodes).toContain('CALENDAR_DATE_CONSENSUS');
  });

  it('recovers a unanimous embedded local capture clock split only by UTC representation', () => {
    const localClock = '2005-04-01T01:01:01';
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-original',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: localClock,
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'xmp-capture',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          value: {
            localIso: localClock,
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'iptc-offset',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc',
          tag: 'IPTC:DateCreated',
          value: {
            localIso: localClock,
            instantUtc: '2005-04-01T06:01:01.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'gps-utc',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'gps',
          tag: 'GPS:GPSDateStamp+GPS:GPSTimeStamp',
          value: {
            localIso: localClock,
            instantUtc: '2005-04-01T01:01:01.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
        candidate({
          id: 'date-only',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc',
          tag: 'IPTC:DateCreated',
          value: {
            localIso: '2005-04-01',
            zoneBasis: 'date-only',
            precision: 'date',
          },
        }),
        candidate({
          id: 'filename-lineage',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'filename:2005-04-01_01-01-01.jpeg',
          value: {
            localIso: localClock,
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'medium',
      selectedCandidateId: 'exif-original',
      selectedValue: {
        localIso: localClock,
        zoneBasis: 'floating-local',
        precision: 'second',
      },
    });
    expect(result.reasonCodes).toContain('UNANIMOUS_LOCAL_CAPTURE_RECOVERY');
    expect(result.contenderIds).toEqual([
      'date-only',
      'exif-original',
      'filename-lineage',
      'gps-utc',
      'iptc-offset',
      'xmp-capture',
    ]);
  });

  it('does not require prior filename lineage for unanimous embedded recovery', () => {
    const localClock = '2005-04-01T01:01:01';
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-original',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: localClock,
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'xmp-capture',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          value: {
            localIso: localClock,
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'gps-utc',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'gps',
          tag: 'GPS:GPSDateStamp+GPS:GPSTimeStamp',
          value: {
            localIso: localClock,
            instantUtc: '2005-04-01T01:01:01.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
        candidate({
          id: 'iptc-offset-no-lineage',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc',
          tag: 'IPTC:DateCreated',
          value: {
            localIso: localClock,
            instantUtc: '2005-04-01T06:01:01.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'medium',
      selectedCandidateId: 'exif-original',
    });
    expect(result.reasonCodes).toContain('UNANIMOUS_LOCAL_CAPTURE_RECOVERY');
  });

  it.each([
    {
      name: 'an exact-midnight original',
      original: {
        localIso: '2005-04-01T00:00:00',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
      corroborating: {
        localIso: '2005-04-01T00:00:00',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
    },
    {
      name: 'a nonzero fractional claim',
      original: {
        localIso: '2005-04-01T01:01:01.123',
        fractionalDigits: '123',
        zoneBasis: 'floating-local',
        precision: 'millisecond',
      },
      corroborating: {
        localIso: '2005-04-01T01:01:01',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
    },
    {
      name: 'a mismatched date-only claim',
      original: {
        localIso: '2005-04-01T01:01:01',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
      corroborating: {
        localIso: '2005-04-01T01:01:01',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
      dateOnly: '2005-04-02',
    },
    {
      name: 'an explicit-offset original',
      original: {
        localIso: '2005-04-01T01:01:01',
        instantUtc: '2005-04-01T06:01:01.000Z',
        offsetMinutes: -300,
        zoneBasis: 'explicit-offset',
        precision: 'second',
      },
      corroborating: {
        localIso: '2005-04-01T01:01:01',
        zoneBasis: 'floating-local',
        precision: 'second',
      },
    },
  ] as const)('does not recover $name', ({ original, corroborating, dateOnly }) => {
    const inputs = [
      candidate({
        id: 'exif-original',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        sourceFamily: 'exif',
        tag: 'ExifIFD:DateTimeOriginal',
        value: original,
      }),
      candidate({
        id: 'xmp-capture',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-xmp',
        sourceFamily: 'xmp',
        tag: 'XMP-photoshop:DateCreated',
        value: corroborating,
      }),
      ...(dateOnly === undefined
        ? []
        : [
            candidate({
              id: 'date-only',
              mediaKind: 'image',
              semantic: 'capture',
              sourceKind: 'embedded-iptc',
              sourceFamily: 'iptc',
              tag: 'IPTC:DateCreated',
              value: {
                localIso: dateOnly,
                zoneBasis: 'date-only',
                precision: 'date',
              },
            }),
          ]),
    ];

    const result = resolveDateCandidates(request(inputs));
    expect(result.reasonCodes).not.toContain('UNANIMOUS_LOCAL_CAPTURE_RECOVERY');
  });

  it('does not recover without a different embedded capture source', () => {
    const localClock = '2005-04-01T01:01:01';
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'exif-original',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: localClock,
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'filename-only',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'filename:2005-04-01_01-01-01.jpeg',
          value: {
            localIso: localClock,
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.reasonCodes).not.toContain('UNANIMOUS_LOCAL_CAPTURE_RECOVERY');
  });

  it('does not let filename agreement choose between conflicting embedded clocks', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'original',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2002-01-04T05:35:38',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'editorial',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP:DateTimeOriginal',
          value: {
            localIso: '2002-01-04T17:35:38',
            instantUtc: '2002-01-04T22:35:38.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
        candidate({
          id: 'filename',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'filename-timestamp',
          tag: 'filename:2002-01-04_05-35-38.jpg',
          value: {
            localIso: '2002-01-04T05:35:38',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result.status).toBe('resolved');
    expect(result.selectedValue?.precision).toBe('date');
    expect(result.reasonCodes).toContain('CALENDAR_DATE_CONSENSUS');
  });

  it('prefers a corroborated original lifecycle date without letting an isolated ancient outlier win', () => {
    const original = {
      localIso: '2019-04-05T06:07:08',
      zoneBasis: 'floating-local',
      precision: 'second',
    } as const;
    const inputs = [
      candidate({
        id: 'dto',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        sourceFamily: 'exif',
        tag: 'EXIF:DateTimeOriginal',
        value: original,
      }),
      candidate({
        id: 'filename',
        mediaKind: 'image',
        semantic: 'filename-claim',
        sourceKind: 'filename',
        sourceFamily: 'filename-timestamp',
        tag: 'filename:2019-04-05_06-07-08.jpg',
        value: original,
      }),
      candidate({
        id: 'isolated-ancient',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-xmp',
        sourceFamily: 'xmp',
        tag: 'XMP:DateCreated',
        value: {
          localIso: '1904-01-01T00:00:01',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      }),
      candidate({
        id: 'digitized',
        mediaKind: 'image',
        semantic: 'digitized',
        sourceKind: 'embedded-exif',
        sourceFamily: 'exif',
        tag: 'EXIF:CreateDate',
        value: {
          localIso: '2021-02-03T04:05:06',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      }),
    ];

    const result = resolveDateCandidates(request(inputs));
    expect(result.selectedCandidateId).toBe('dto');
    expect(result.selectedValue?.localIso).toBe(original.localIso);
  });

  it('accepts a timezone-qualified legitimate midnight capture without a blanket penalty', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'midnight-capture',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'EXIF:DateTimeOriginal',
          value: {
            localIso: '2020-01-01T00:00:00',
            instantUtc: '2020-01-01T05:00:00.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        }),
      ])
    );

    expect(result).toMatchObject({ status: 'resolved', confidence: 'high' });
    expect(result.candidates[0].score.modifiers.map((modifier) => modifier.code)).not.toContain(
      'MIDNIGHT_PLACEHOLDER'
    );
  });

  it('is deterministic across every permutation of conflicting lifecycle evidence', () => {
    const inputs = [
      candidate({
        id: 'a',
        mediaKind: 'video',
        semantic: 'capture',
        sourceKind: 'container-format',
        sourceFamily: 'quicktime-keys',
        tag: 'Keys:CreationDate',
      }),
      candidate({
        id: 'b',
        mediaKind: 'video',
        semantic: 'container-created',
        sourceKind: 'container-stream',
        sourceFamily: 'quicktime-stream',
        tag: 'QuickTime:TrackCreateDate',
        value: {
          localIso: '2025-01-02T03:04:05',
          instantUtc: '2025-01-02T03:04:05.000Z',
          zoneBasis: 'spec-defined-utc',
          precision: 'second',
        },
      }),
      candidate({
        id: 'c',
        mediaKind: 'video',
        semantic: 'filename-claim',
        sourceKind: 'filename',
        sourceFamily: 'filename-timestamp',
        tag: 'filename:2024-03-04_05-06-07.mov',
        value: {
          localIso: '2024-03-04T05:06:07',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      }),
    ];
    const permutations = [
      inputs,
      [inputs[0], inputs[2], inputs[1]],
      [inputs[1], inputs[0], inputs[2]],
      [inputs[1], inputs[2], inputs[0]],
      [inputs[2], inputs[0], inputs[1]],
      [inputs[2], inputs[1], inputs[0]],
    ];
    const baseline = resolveDateCandidates(request(permutations[0]));
    for (const permutation of permutations.slice(1)) {
      expect(resolveDateCandidates(request(permutation))).toEqual(baseline);
    }
  });

  it.each([
    ['full timestamp', 'filename', '2024-03-04T05:06:07', 'second'],
    ['date only', 'filename-date-only', '2024-03-04', 'date'],
  ] as const)(
    'never marks a filename-only %s selection high-confidence',
    (_, family, localIso, precision) => {
      const result = resolveDateCandidates(
        request([
          candidate({
            id: 'filename-only-safety',
            mediaKind: 'image',
            semantic: 'filename-claim',
            sourceKind: 'filename',
            sourceFamily: family,
            tag: 'filename:2024-03-04.jpg',
            value: {
              localIso,
              zoneBasis: precision === 'date' ? 'date-only' : 'floating-local',
              precision,
            },
          }),
        ])
      );

      expect(result.confidence).not.toBe('high');
      expect(result.reasonCodes).toContain('NON_AUTHORITATIVE_SELECTION');
    }
  );

  it('resolves the audited Canon EOS 5D MakerNote capture over repeated midnight EXIF placeholders', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'canon',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'canon-makernote',
          tag: 'Canon:TimeStamp',
          value: {
            localIso: '2007-02-07T05:25:42',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'original-midnight',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2003-07-01T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'created-midnight',
          mediaKind: 'image',
          semantic: 'digitized',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:CreateDate',
          value: {
            localIso: '2003-07-01T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
      ])
    );
    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'high',
      selectedCandidateId: 'canon',
      selectedValue: { localIso: '2007-02-07T05:25:42' },
    });
  });

  it('resolves Samsung TimeStamp when its zone-bearing fractional value agrees at the whole second', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'samsung',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'samsung',
          tag: 'Samsung:TimeStamp',
          value: {
            localIso: '2020-01-02T03:04:05.236',
            instantUtc: '2020-01-02T08:04:05.236Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'millisecond',
            fractionalDigits: '236',
          },
        }),
        candidate({
          id: 'original',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2020-01-02T03:04:05.000236',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000236',
          },
        }),
      ])
    );
    expect(result.status).toBe('resolved');
    expect(result.selectedCandidateId).toBe('samsung');
    expect(result.selectedValue).toEqual({
      localIso: '2020-01-02T03:04:05',
      instantUtc: '2020-01-02T08:04:05.000Z',
      offsetMinutes: -300,
      zoneBasis: 'explicit-offset',
      precision: 'second',
    });
    expect(result.reasonCodes).toContain('SAMSUNG_FRACTION_REPRESENTATION_RECOVERY');
  });

  it('retains a true Samsung fractional conflict while selecting only the agreed whole second', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'samsung',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'samsung',
          tag: 'Samsung:TimeStamp',
          value: {
            localIso: '2020-01-02T03:04:05.1',
            instantUtc: '2020-01-02T08:04:05.1Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'millisecond',
            fractionalDigits: '1',
          },
        }),
        candidate({
          id: 'original',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2020-01-02T03:04:05.2',
            zoneBasis: 'floating-local',
            precision: 'millisecond',
            fractionalDigits: '2',
          },
        }),
      ])
    );
    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'medium',
      selectedCandidateId: 'samsung',
    });
    expect(result.selectedValue?.fractionalDigits).toBeUndefined();
    expect(result.reasonCodes).toContain('SUBSECOND_CONFLICT');
  });

  it.each([
    [
      'GPS spec UTC',
      candidate({
        id: 'gps-conflict',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        sourceFamily: 'gps',
        tag: 'GPS:GPSDateStamp+GPS:GPSTimeStamp',
        value: {
          localIso: '2020-01-02T08:04:06',
          instantUtc: '2020-01-02T08:04:06.000Z',
          zoneBasis: 'spec-defined-utc',
          precision: 'second',
        },
      }),
    ],
    [
      'XMP explicit offset',
      candidate({
        id: 'xmp-conflict',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-xmp',
        sourceFamily: 'xmp',
        tag: 'XMP-photoshop:DateCreated',
        value: {
          localIso: '2020-01-02T03:04:06',
          instantUtc: '2020-01-02T08:04:06.000Z',
          offsetMinutes: -300,
          zoneBasis: 'explicit-offset',
          precision: 'second',
        },
      }),
    ],
  ])('keeps only the shared day across a conflicting %s instant', (_name, conflicting) => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'samsung-zone',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'samsung',
          tag: 'Samsung:TimeStamp',
          value: {
            localIso: '2020-01-02T03:04:05.236',
            instantUtc: '2020-01-02T08:04:05.236Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'millisecond',
            fractionalDigits: '236',
          },
        }),
        candidate({
          id: 'original-fraction',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2020-01-02T03:04:05.000236',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000236',
          },
        }),
        conflicting,
      ])
    );
    expect(result.reasonCodes).not.toContain('SAMSUNG_FRACTION_REPRESENTATION_RECOVERY');
    expect(result.status).toBe('resolved');
    expect(result.selectedValue?.precision).toBe('date');
    expect(result.reasonCodes).toContain('CALENDAR_DATE_CONSENSUS');
  });

  it('accepts a GPS calendar rollover when its UTC instant matches Samsung at the whole second', () => {
    const result = resolveDateCandidates(
      request([
        candidate({
          id: 'samsung-rollover',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'samsung',
          tag: 'Samsung:TimeStamp',
          value: {
            localIso: '2020-01-01T23:30:00.236',
            instantUtc: '2020-01-02T04:30:00.236Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'millisecond',
            fractionalDigits: '236',
          },
        }),
        candidate({
          id: 'original-rollover',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2020-01-01T23:30:00.000236',
            zoneBasis: 'floating-local',
            precision: 'microsecond',
            fractionalDigits: '000236',
          },
        }),
        candidate({
          id: 'gps-rollover',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'gps',
          tag: 'GPS:GPSDateStamp+GPS:GPSTimeStamp',
          value: {
            localIso: '2020-01-02T04:30:00',
            instantUtc: '2020-01-02T04:30:00.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        }),
      ])
    );
    expect(result).toMatchObject({
      status: 'resolved',
      confidence: 'medium',
      selectedCandidateId: 'samsung-rollover',
    });
    expect(result.reasonCodes).toContain('SAMSUNG_FRACTION_REPRESENTATION_RECOVERY');
  });

  describe('audited synthetic midnight placeholder recovery', () => {
    const synthetic = (id: string, tag: string, semantic: 'capture' | 'digitized') =>
      candidate({
        id,
        mediaKind: 'image',
        semantic,
        sourceKind: 'embedded-exif',
        sourceFamily: 'exif',
        tag,
        value: {
          localIso: '2022-01-01T00:00:00.000123',
          fractionalDigits: '000123',
          zoneBasis: 'floating-local',
          precision: 'microsecond',
        },
      });
    const gps = candidate({
      id: 'gps',
      mediaKind: 'image',
      semantic: 'capture',
      sourceKind: 'embedded-exif',
      sourceFamily: 'gps',
      tag: 'GPS:GPSDateStamp+GPS:GPSTimeStamp',
      value: {
        localIso: '2023-10-17T09:51:44',
        instantUtc: '2023-10-17T09:51:44.000Z',
        zoneBasis: 'spec-defined-utc',
        precision: 'second',
      },
    });

    it('selects the exact embedded GPS UTC instant over matching synthetic EXIF fields', () => {
      const result = resolveDateCandidates(
        request([
          synthetic('dto', 'ExifIFD:DateTimeOriginal', 'capture'),
          synthetic('create', 'ExifIFD:CreateDate', 'digitized'),
          gps,
        ])
      );
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedCandidateId: 'gps',
        selectedValue: gps.value,
      });
      expect(result.reasonCodes).toContain('SYNTHETIC_EXIF_PLACEHOLDER_GPS_RECOVERY');
    });

    it('keeps safely compatible Photoshop local time as context but selects GPS UTC', () => {
      const result = resolveDateCandidates(
        request([
          synthetic('dto', 'ExifIFD:DateTimeOriginal', 'capture'),
          candidate({
            ...synthetic('create', 'ExifIFD:CreateDate', 'digitized'),
            value: {
              localIso: '2022-01-01T00:00:00.000123',
              instantUtc: '2022-01-01T04:00:00.000123Z',
              offsetMinutes: -240,
              fractionalDigits: '000123',
              zoneBasis: 'explicit-offset',
              precision: 'microsecond',
            },
          }),
          candidate({
            id: 'photoshop',
            mediaKind: 'image',
            semantic: 'capture',
            sourceKind: 'embedded-xmp',
            sourceFamily: 'xmp',
            tag: 'XMP-photoshop:DateCreated',
            value: {
              localIso: '2023-10-17T05:51:49',
              zoneBasis: 'floating-local',
              precision: 'second',
            },
          }),
          candidate({
            id: 'xmp-placeholder',
            mediaKind: 'image',
            semantic: 'content-created',
            sourceKind: 'embedded-xmp',
            sourceFamily: 'xmp',
            tag: 'XMP-xmp:CreateDate',
            value: {
              localIso: '2022-01-01T00:00:00',
              zoneBasis: 'floating-local',
              precision: 'second',
            },
          }),
          gps,
        ])
      );
      expect(result.selectedCandidateId).toBe('gps');
      expect(result.selectedValue).toEqual(gps.value);
      expect(result.contenderIds).toContain('photoshop');
    });

    it('does not apply GPS recovery to the separate 2003 editorial placeholder signature', () => {
      const oldOriginal = synthetic('dto', 'ExifIFD:DateTimeOriginal', 'capture');
      const oldCreated = synthetic('create', 'ExifIFD:CreateDate', 'digitized');
      oldOriginal.value.localIso = '2003-07-01T00:00:00.000123';
      oldCreated.value.localIso = '2003-07-01T00:00:00.000123';
      const result = resolveDateCandidates(request([oldOriginal, oldCreated, gps]));
      expect(result.reasonCodes).not.toContain('SYNTHETIC_EXIF_PLACEHOLDER_GPS_RECOVERY');
    });

    it.each([
      [
        'missing matching EXIF CreateDate',
        [synthetic('dto', 'ExifIFD:DateTimeOriginal', 'capture'), gps],
      ],
      [
        'GPS outside the audited 2023/2024 window',
        [
          synthetic('dto', 'ExifIFD:DateTimeOriginal', 'capture'),
          synthetic('create', 'ExifIFD:CreateDate', 'digitized'),
          candidate({
            ...gps,
            value: {
              localIso: '2025-10-17T09:51:44',
              instantUtc: '2025-10-17T09:51:44.000Z',
              zoneBasis: 'spec-defined-utc',
              precision: 'second',
            },
          }),
        ],
      ],
    ])('does not apply GPS recovery with %s', (_name, inputs) => {
      const result = resolveDateCandidates(request(inputs));
      expect(result.reasonCodes).not.toContain('SYNTHETIC_EXIF_PLACEHOLDER_GPS_RECOVERY');
    });
  });

  describe('audited editorial consensus over exact EXIF placeholder', () => {
    function editorialInputs(editorialTime = '2023-01-26T19:08:24') {
      return [
        candidate({
          id: 'dto-placeholder',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:DateTimeOriginal',
          value: {
            localIso: '2022-01-01T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'create-placeholder',
          mediaKind: 'image',
          semantic: 'digitized',
          sourceKind: 'embedded-exif',
          sourceFamily: 'exif',
          tag: 'ExifIFD:CreateDate',
          value: {
            localIso: '2022-01-01T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'photoshop',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          rawValue: editorialTime.replace(/-/g, ':').replace('T', ' '),
          value: { localIso: editorialTime, zoneBasis: 'floating-local', precision: 'second' },
        }),
        candidate({
          id: 'iptc-created',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc',
          tag: 'IPTC:DateCreated',
          value: { localIso: editorialTime, zoneBasis: 'floating-local', precision: 'second' },
        }),
        candidate({
          id: 'iptc-digital',
          mediaKind: 'image',
          semantic: 'digitized',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc-digital',
          tag: 'IPTC:DigitalCreationDate+IPTC:DigitalCreationTime',
          value: { localIso: editorialTime, zoneBasis: 'floating-local', precision: 'second' },
        }),
      ];
    }

    function xmpPlaceholder() {
      return candidate({
        id: 'xmp-create-placeholder',
        mediaKind: 'image',
        semantic: 'content-created',
        sourceKind: 'embedded-xmp',
        sourceFamily: 'xmp',
        tag: 'XMP-xmp:CreateDate',
        value: {
          localIso: '2022-01-01T00:00:00',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      });
    }

    it('selects exact nonmidnight XMP and IPTC consensus over the audited placeholder', () => {
      const result = resolveDateCandidates(request(editorialInputs()));
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedCandidateId: 'photoshop',
        selectedValue: { localIso: '2023-01-26T19:08:24' },
      });
      expect(result.reasonCodes).toContain('EDITORIAL_CAPTURE_CONSENSUS_RECOVERY');
    });

    it('does not apply editorial recovery when one IPTC time disagrees', () => {
      const inputs = editorialInputs();
      inputs[4] = candidate({
        ...inputs[4],
        value: {
          localIso: '2023-01-26T19:08:25',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      });
      const result = resolveDateCandidates(request(inputs));
      expect(result.reasonCodes).not.toContain('EDITORIAL_CAPTURE_CONSENSUS_RECOVERY');
    });

    it('recovers the exact 2022 batch placeholder from a sole Photoshop creation date', () => {
      const inputs = editorialInputs().slice(0, 3);
      inputs.push(xmpPlaceholder());
      const result = resolveDateCandidates(request(inputs));
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedCandidateId: 'photoshop',
        selectedValue: { localIso: '2023-01-26T19:08:24' },
      });
      expect(result.reasonCodes).toEqual(
        expect.arrayContaining([
          'EXACT_2022_BATCH_PLACEHOLDER_RECOVERY',
          'KNOWN_BATCH_PLACEHOLDER',
          'RESOLVED_MEDIUM_CONFIDENCE',
        ])
      );
    });

    it('preserves an existing narrow PNG resolution instead of overriding it', () => {
      const inputs = editorialInputs().slice(0, 3);
      inputs.push(
        candidate({
          id: 'png-native',
          mediaKind: 'image',
          semantic: 'content-created',
          sourceKind: 'container-format',
          sourceFamily: 'png-screenshot-native',
          tag: 'PNG:CreateDate',
          rawValue: {
            value: '2022:01:01 00:00:00',
            recoveryEvidence: {
              kind: 'png-screenshot-native-date',
              fileModifyDate: '2021:12:31 19:00:00-05:00',
              pngModifyDate: '2023:01:26 19:08:24',
              xmpDateCreated: '2023:01:26 19:08:24',
            },
          },
          value: {
            localIso: '2022-01-01T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        }),
        candidate({
          id: 'screenshot-name',
          mediaKind: 'image',
          semantic: 'filename-claim',
          sourceKind: 'filename',
          sourceFamily: 'screenshot-filename',
          tag: 'filename:2022-01-01_00-00-00-screen-shot.png',
          value: {
            localIso: '2022-01-01T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        })
      );
      const result = resolveDateCandidates(request(inputs));
      expect(result).toMatchObject({
        status: 'resolved',
        selectedCandidateId: 'png-native',
        selectedValue: { localIso: '2022-01-01T00:00:00' },
      });
      expect(result.reasonCodes).toContain('PNG_SCREENSHOT_NATIVE_DATE_RECOVERY');
      expect(result.reasonCodes).not.toContain('EXACT_2022_BATCH_PLACEHOLDER_RECOVERY');
    });

    it('recovers the exact 2022 batch placeholder from an agreeing IPTC creation pair', () => {
      const inputs = editorialInputs();
      inputs.splice(2, 1);
      inputs.push(xmpPlaceholder());
      const result = resolveDateCandidates(request(inputs));
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedCandidateId: 'iptc-created',
        selectedValue: { localIso: '2023-01-26T19:08:24' },
      });
      expect(result.reasonCodes).toContain('EXACT_2022_BATCH_PLACEHOLDER_RECOVERY');
    });

    it('recognizes the audited tiny subsecond signature across local and offset EXIF fields', () => {
      const inputs = editorialInputs().slice(0, 3);
      inputs[0] = candidate({
        ...inputs[0],
        value: {
          localIso: '2022-01-01T00:00:00.000066',
          zoneBasis: 'floating-local',
          precision: 'microsecond',
          fractionalDigits: '000066',
        },
      });
      inputs[1] = candidate({
        ...inputs[1],
        value: {
          localIso: '2022-01-01T00:00:00.000066',
          instantUtc: '2022-01-01T04:00:00.000066Z',
          offsetMinutes: -240,
          zoneBasis: 'explicit-offset',
          precision: 'microsecond',
          fractionalDigits: '000066',
        },
      });
      inputs.push(xmpPlaceholder());
      const result = resolveDateCandidates(request(inputs));
      expect(result.reasonCodes).toContain('EXACT_2022_BATCH_PLACEHOLDER_RECOVERY');
      expect(result).toMatchObject({ status: 'resolved', selectedCandidateId: 'photoshop' });
    });

    it('requires optional XMP CreateDate to repeat the exact 2022 placeholder', () => {
      const inputs = editorialInputs().slice(0, 3);
      inputs.push(
        candidate({
          id: 'xmp-create-disagrees',
          mediaKind: 'image',
          semantic: 'content-created',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-xmp:CreateDate',
          value: {
            localIso: '2022-01-01T00:00:01',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        })
      );
      const result = resolveDateCandidates(request(inputs));
      expect(result.reasonCodes).not.toContain('EXACT_2022_BATCH_PLACEHOLDER_RECOVERY');
    });

    it('fails closed when a present XMP CreateDate is invalid', () => {
      const inputs = editorialInputs().slice(0, 3);
      inputs.push(
        candidate({
          id: 'invalid-xmp-create',
          mediaKind: 'image',
          semantic: 'content-created',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-xmp:CreateDate',
          value: {
            localIso: '2030-01-01T00:00:00',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        })
      );
      const result = resolveDateCandidates(request(inputs));
      expect(result.reasonCodes).not.toContain('EXACT_2022_BATCH_PLACEHOLDER_RECOVERY');
    });

    it('does not recover when a second nonplaceholder creation contender exists', () => {
      const inputs = editorialInputs().slice(0, 3);
      inputs.push(
        candidate({
          id: 'second-creation-contender',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-iptc',
          sourceFamily: 'iptc',
          tag: 'IPTC:DateCreated',
          value: {
            localIso: '2023-01-27T10:11:12',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        })
      );
      const result = resolveDateCandidates(request(inputs));
      expect(result.reasonCodes).not.toContain('EXACT_2022_BATCH_PLACEHOLDER_RECOVERY');
    });

    it('rejects a Photoshop tag with swapped source provenance', () => {
      const inputs = editorialInputs().slice(0, 3);
      inputs[2] = candidate({ ...inputs[2], sourceKind: 'embedded-iptc', sourceFamily: 'iptc' });
      inputs.push(xmpPlaceholder());
      const result = resolveDateCandidates(request(inputs));
      expect(result.reasonCodes).not.toContain('EXACT_2022_BATCH_PLACEHOLDER_RECOVERY');
    });

    it('rejects an ineligible named alternative instead of ignoring it', () => {
      const inputs = editorialInputs();
      inputs.splice(2, 1);
      inputs.push(xmpPlaceholder());
      inputs.push(
        candidate({
          id: 'future-photoshop',
          mediaKind: 'image',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
          sourceFamily: 'xmp',
          tag: 'XMP-photoshop:DateCreated',
          value: {
            localIso: '2030-01-01T10:11:12',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        })
      );
      const result = resolveDateCandidates(request(inputs));
      expect(result.reasonCodes).not.toContain('EXACT_2022_BATCH_PLACEHOLDER_RECOVERY');
    });

    it('does not generalize the single-editorial-field rule to the 2003 placeholder', () => {
      const inputs = editorialInputs()
        .slice(0, 3)
        .map((input, index) =>
          index < 2
            ? candidate({
                ...input,
                value: {
                  localIso: '2003-07-01T00:00:00',
                  zoneBasis: 'floating-local',
                  precision: 'second',
                },
              })
            : input
        );
      const result = resolveDateCandidates(request(inputs));
      expect(result.reasonCodes).not.toContain('EXACT_2022_BATCH_PLACEHOLDER_RECOVERY');
    });
  });
});
