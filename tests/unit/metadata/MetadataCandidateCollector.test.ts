import { Stats } from 'fs';

import {
  ExifToolReadAdapter,
  MetadataCandidateCollector,
  RawExifTags,
} from '../../../src/main/core/metadata/MetadataCandidateCollector';
import { MediaKind } from '../../../src/main/core/date';

class FakeExifToolAdapter implements ExifToolReadAdapter {
  public readonly reads: string[] = [];
  public closeCalls = 0;

  constructor(private readonly tags: RawExifTags) {}

  async readRaw(filePath: string): Promise<RawExifTags> {
    this.reads.push(filePath);
    return this.tags;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FailingExifToolAdapter implements ExifToolReadAdapter {
  async readRaw(): Promise<RawExifTags> {
    throw new Error('unsupported or corrupt metadata');
  }

  async close(): Promise<void> {}
}

const statWithBirthtime = async (): Promise<Pick<Stats, 'birthtime'>> => ({
  birthtime: new Date('2018-01-02T03:04:05.000Z'),
});

describe('MetadataCandidateCollector', () => {
  it('separates verified byte extraction from logical filename and inventoried birth evidence', async () => {
    const readRawVerified = jest.fn(async () => ({
      tags: { 'EXIF:DateTimeOriginal': '2024:03:04 05:06:07+00:00' },
      sha256: 'a'.repeat(64),
      bytes: 123,
    }));
    const adapter: ExifToolReadAdapter = {
      readRaw: jest.fn(),
      readRawVerified,
      close: jest.fn(),
    };
    const statReader = jest.fn(statWithBirthtime);
    const collector = new MetadataCandidateCollector(adapter, statReader);

    const result = await collector.collectDetailed({
      fileId: '7:11',
      filePath: '/media/IMG_20240304_050607.jpg',
      verifiedExtractionPath: '/private/snapshot.jpg',
      expectedContentSha256: 'a'.repeat(64),
      expectedContentBytes: 123,
      filesystemBirthTimeUtc: '2017-06-05T04:03:02.001Z',
      mediaKind: 'image',
    });

    expect(readRawVerified).toHaveBeenCalledWith('/private/snapshot.jpg', undefined);
    expect(statReader).not.toHaveBeenCalled();
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: 'EXIF:DateTimeOriginal', sourceKind: 'embedded-exif' }),
        expect.objectContaining({
          tag: 'filename:IMG_20240304_050607.jpg',
          sourceKind: 'filename',
        }),
        expect.objectContaining({
          tag: 'FileSystem:BirthTime',
          rawValue: '2017-06-05T04:03:02.001Z',
        }),
      ])
    );
    await collector.close();
  });

  it('rejects a verified metadata receipt that does not match the preview bytes', async () => {
    const adapter: ExifToolReadAdapter = {
      readRaw: jest.fn(),
      readRawVerified: jest.fn(async () => ({
        tags: { 'EXIF:DateTimeOriginal': '2035:01:02 03:04:05+00:00' },
        sha256: 'b'.repeat(64),
        bytes: 123,
      })),
      close: jest.fn(),
    };
    const collector = new MetadataCandidateCollector(adapter, statWithBirthtime);

    await expect(
      collector.collectDetailed({
        fileId: '7:11',
        filePath: '/media/photo.jpg',
        verifiedExtractionPath: '/private/snapshot.jpg',
        expectedContentSha256: 'a'.repeat(64),
        expectedContentBytes: 123,
        filesystemBirthTimeUtc: null,
        mediaKind: 'image',
      })
    ).rejects.toThrow(/verified metadata receipt/i);
  });

  it('propagates cancellation from verified extraction instead of downgrading it to a warning', async () => {
    const controller = new AbortController();
    const abortError = new Error('metadata cancelled');
    abortError.name = 'AbortError';
    const readRawVerified = jest.fn(async () => {
      throw abortError;
    });
    const adapter: ExifToolReadAdapter = {
      readRaw: jest.fn(),
      readRawVerified,
      close: jest.fn(),
    };
    const collector = new MetadataCandidateCollector(adapter, statWithBirthtime);
    controller.abort('operator cancelled');

    await expect(
      collector.collectDetailed({
        fileId: '7:11',
        filePath: '/media/photo.jpg',
        verifiedExtractionPath: '/private/snapshot.jpg',
        expectedContentSha256: 'a'.repeat(64),
        expectedContentBytes: 123,
        filesystemBirthTimeUtc: null,
        mediaKind: 'image',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports metadata read failure while retaining independent filename and birth evidence', async () => {
    const collector = new MetadataCandidateCollector(
      new FailingExifToolAdapter(),
      statWithBirthtime
    );

    const result = await collector.collectDetailed({
      fileId: 'sha256:metadata-failure',
      filePath: '/media/IMG_20240304_050607.jpg',
      mediaKind: 'image',
    });

    expect(result.warnings).toEqual(['Metadata read failed: unsupported or corrupt metadata']);
    expect(result.candidates.map((candidate) => candidate.sourceKind)).toEqual([
      'filename',
      'filesystem',
    ]);
    await collector.close();
  });

  it('preserves group identity, explicit offset, and source subseconds', async () => {
    const adapter = new FakeExifToolAdapter({
      'EXIF:DateTimeOriginal': '2024:03:04 05:06:07',
      'EXIF:OffsetTimeOriginal': '-05:30',
      'EXIF:SubSecTimeOriginal': '123456',
      'File:System:FileModifyDate': '2026:08:29 20:00:00-04:00',
    });
    const collector = new MetadataCandidateCollector(adapter, statWithBirthtime);

    const candidates = await collector.collect({
      fileId: 'sha256:image',
      filePath: '/media/IMG_20240304_050607.jpg',
      mediaKind: 'image',
    });

    const embedded = candidates.find((candidate) => candidate.tag === 'EXIF:DateTimeOriginal');
    expect(embedded).toMatchObject({
      semantic: 'capture',
      sourceKind: 'embedded-exif',
      sourceFamily: 'exif',
      rawValue: {
        value: '2024:03:04 05:06:07',
        offset: '-05:30',
        subsecond: '123456',
      },
      value: {
        localIso: '2024-03-04T05:06:07.123456',
        instantUtc: '2024-03-04T10:36:07.123Z',
        offsetMinutes: -330,
        zoneBasis: 'explicit-offset',
        precision: 'microsecond',
        fractionalDigits: '123456',
      },
    });
    expect(candidates.some((candidate) => candidate.sourceKind === 'filename')).toBe(true);
    expect(candidates.some((candidate) => candidate.semantic === 'filesystem-birth')).toBe(true);
    expect(candidates.some((candidate) => candidate.semantic === 'filesystem-modified')).toBe(
      false
    );
    expect(
      candidates.some((candidate) => candidate.tag.toLowerCase().includes('filemodifydate'))
    ).toBe(false);

    await collector.close();
    await collector.close();
    expect(adapter.reads).toEqual(['/media/IMG_20240304_050607.jpg']);
    expect(adapter.closeCalls).toBe(1);
  });

  it.each<{
    mediaKind: MediaKind;
    tags: RawExifTags;
    tag: string;
    semantic: string;
    sourceKind: string;
  }>([
    {
      mediaKind: 'raw',
      tags: { 'EXIF:DateTimeOriginal': '2021:02:03 04:05:06' },
      tag: 'EXIF:DateTimeOriginal',
      semantic: 'capture',
      sourceKind: 'embedded-exif',
    },
    {
      mediaKind: 'video',
      tags: { 'QuickTime:Keys:CreationDate': '2022-03-04T05:06:07+02:00' },
      tag: 'QuickTime:Keys:CreationDate',
      semantic: 'capture',
      sourceKind: 'container-format',
    },
    {
      mediaKind: 'audio',
      tags: {
        'BWF:OriginationDate': '2020-01-02',
        'BWF:OriginationTime': '03:04:05',
      },
      tag: 'BWF:OriginationDateTime',
      semantic: 'recording',
      sourceKind: 'audio-tag',
    },
    {
      mediaKind: 'document',
      tags: { 'XMP:CreateDate': '2019-01-02T03:04:05Z' },
      tag: 'XMP:CreateDate',
      semantic: 'content-created',
      sourceKind: 'embedded-xmp',
    },
    {
      mediaKind: 'art',
      tags: { 'XMP:CreateDate': '2017-01-02T03:04:05Z' },
      tag: 'XMP:CreateDate',
      semantic: 'content-created',
      sourceKind: 'embedded-xmp',
    },
  ])('maps $mediaKind group-qualified tags into resolver candidates', async (testCase) => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter(testCase.tags),
      statWithBirthtime
    );

    const candidates = await collector.collect({
      fileId: `sha256:${testCase.mediaKind}`,
      filePath: `/media/undated.${testCase.mediaKind}`,
      mediaKind: testCase.mediaKind,
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        tag: testCase.tag,
        semantic: testCase.semantic,
        sourceKind: testCase.sourceKind,
      })
    );
    await collector.close();
  });

  it.each([
    [
      'image',
      {
        'ExifIFD:DateTimeOriginal': '2024:03:04 05:06:07',
        'ExifIFD:OffsetTimeOriginal': '+01:30',
        'ExifIFD:SubSecTimeOriginal': '987654321',
      },
      'ExifIFD:DateTimeOriginal',
      'explicit-offset',
    ],
    [
      'image',
      { 'XMP-photoshop:DateCreated': '2024-03-04T05:06:07Z' },
      'XMP-photoshop:DateCreated',
      'explicit-offset',
    ],
    [
      'document',
      { 'XMP-xmp:CreateDate': '2024-03-04T05:06:07Z' },
      'XMP-xmp:CreateDate',
      'explicit-offset',
    ],
    [
      'audio',
      {
        'RIFF:OriginationDate': '2024-03-04',
        'RIFF:OriginationTime': '05:06:07',
      },
      'BWF:OriginationDateTime',
      'floating-local',
    ],
    ['audio', { 'ID3v2_4:TDRC': '2024' }, 'ID3v2_4:TDRC', 'date-only'],
  ] as const)(
    'consumes ExifTool family-1 group tags for %s media',
    async (mediaKind, tags, expectedTag, zoneBasis) => {
      const collector = new MetadataCandidateCollector(
        new FakeExifToolAdapter(tags),
        statWithBirthtime
      );

      const candidates = await collector.collect({
        fileId: `sha256:group-one:${mediaKind}`,
        filePath: '/media/undated.media',
        mediaKind,
      });

      expect(candidates).toContainEqual(
        expect.objectContaining({
          tag: expectedTag,
          value: expect.objectContaining({ zoneBasis }),
        })
      );
      await collector.close();
    }
  );

  it('does not invent a date when metadata, filename, and birthtime provide none', async () => {
    const adapter = new FakeExifToolAdapter({});
    const collector = new MetadataCandidateCollector(adapter, async () => ({
      birthtime: new Date(Number.NaN),
    }));

    const candidates = await collector.collect({
      fileId: 'sha256:none',
      filePath: '/media/undated.bin',
      mediaKind: 'document',
    });

    expect(candidates).toEqual([]);
    await collector.close();
  });

  it('covers UTC container dates, minute precision, separated filenames, and rejected raw values', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({
        'QuickTime:ContentCreateDate': '2021:02:03 04:05',
        'QuickTime:MediaCreateDate': true,
        'QuickTime:TrackCreateDate': ['not', 'a date'],
      }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const candidates = await collector.collect({
      fileId: 'sha256:video-branches',
      filePath: '/media/export_2021-02-03_04-05-06.mov',
      mediaKind: 'video',
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        tag: 'QuickTime:ContentCreateDate',
        value: expect.objectContaining({
          instantUtc: '2021-02-03T04:05:00.000Z',
          precision: 'minute',
          zoneBasis: 'spec-defined-utc',
        }),
      })
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({
        sourceKind: 'filename',
        value: expect.objectContaining({ precision: 'second' }),
      })
    );
    expect(candidates.some((candidate) => candidate.tag === 'QuickTime:MediaCreateDate')).toBe(
      false
    );
    await collector.close();
    await expect(
      collector.collect({
        fileId: 'sha256:closed',
        filePath: '/media/closed.mov',
        mediaKind: 'video',
      })
    ).rejects.toThrow('MetadataCandidateCollector is closed');
  });

  it('ignores incomplete BWF pairs rather than manufacturing a time', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({ 'RIFF:OriginationDate': '2024-03-04' }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const candidates = await collector.collect({
      fileId: 'sha256:incomplete-bwf',
      filePath: '/media/audio.wav',
      mediaKind: 'audio',
    });

    expect(candidates).toEqual([]);
    await collector.close();
  });

  it('joins IPTC date and time while preserving its explicit offset', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({
        'IPTC:DateCreated': '2024:03:04',
        'IPTC:TimeCreated': '05:06:07-05:00',
      }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const candidates = await collector.collect({
      fileId: 'sha256:iptc-pair',
      filePath: '/media/untitled.jpg',
      mediaKind: 'image',
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        tag: 'IPTC:DateCreated',
        rawValue: {
          date: '2024:03:04',
          dateTag: 'IPTC:DateCreated',
          time: '05:06:07-05:00',
          timeTag: 'IPTC:TimeCreated',
        },
        value: expect.objectContaining({
          instantUtc: '2024-03-04T10:06:07.000Z',
          offsetMinutes: -300,
          zoneBasis: 'explicit-offset',
        }),
      })
    );
    await collector.close();
  });

  it.each([
    {
      'EXIF:DateTimeOriginal': '2024:03:04 05:06:07',
      'EXIF:OffsetTimeOriginal': '+15:00',
    },
    {
      'EXIF:DateTimeOriginal': '2024:03:04 05:06:07+01:00',
      'EXIF:OffsetTimeOriginal': '-05:00',
    },
    {
      'EXIF:DateTimeOriginal': '2024:03:04 05:06:07.123',
      'EXIF:SubSecTimeOriginal': '456',
    },
  ])(
    'rejects contradictory or impossible explicit metadata rather than weakening it',
    async (tags) => {
      const collector = new MetadataCandidateCollector(new FakeExifToolAdapter(tags), async () => ({
        birthtime: new Date(Number.NaN),
      }));

      const candidates = await collector.collect({
        fileId: 'sha256:contradictory',
        filePath: '/media/untitled.jpg',
        mediaKind: 'image',
      });

      expect(candidates).toEqual([]);
      await collector.close();
    }
  );

  it.each([
    '2024:02:31 05:06:07+00:00',
    '2023:02:29 05:06:07+00:00',
    '2024:12:01 24:00:00+00:00',
    '2024:12:01 23:60:00+00:00',
    '2024:12:01 23:59:60+00:00',
  ])('rejects calendar and clock values that JavaScript Date would normalize: %s', async (raw) => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({ 'EXIF:DateTimeOriginal': raw }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const result = await collector.collectDetailed({
      fileId: 'sha256:invalid-calendar',
      filePath: '/media/untitled.jpg',
      mediaKind: 'image',
    });

    expect(result).toEqual({ candidates: [], warnings: [] });
    await collector.close();
  });

  it('accepts a real leap day without changing its calendar components', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({ 'EXIF:DateTimeOriginal': '2024:02:29 23:59:59+00:00' }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const result = await collector.collectDetailed({
      fileId: 'sha256:leap-day',
      filePath: '/media/untitled.jpg',
      mediaKind: 'image',
    });

    expect(result.candidates[0]?.value).toMatchObject({
      localIso: '2024-02-29T23:59:59',
      instantUtc: '2024-02-29T23:59:59.000Z',
    });
    await collector.close();
  });

  it('preserves four-digit years below 100 instead of applying Date.UTC century coercion', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({ 'EXIF:DateTimeOriginal': '0099:01:02 03:04:05+00:00' }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const result = await collector.collectDetailed({
      fileId: 'sha256:early-year',
      filePath: '/media/untitled.jpg',
      mediaKind: 'image',
    });

    expect(result.candidates[0]?.value.instantUtc).toBe('0099-01-02T03:04:05.000Z');
    await collector.close();
  });
});
