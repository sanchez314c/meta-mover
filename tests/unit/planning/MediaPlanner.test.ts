import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { DateResolutionRecord, MediaKind } from '../../../src/main/core/date';
import { MediaPlanner } from '../../../src/main/core/planning/MediaPlanner';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
} from '../../../src/shared/types/processing';

function resolution(overrides: Partial<DateResolutionRecord> = {}): DateResolutionRecord {
  const selectedValue =
    overrides.selectedValue ??
    ({
      localIso: '2024-03-04T05:06:07.123456',
      zoneBasis: 'floating-local',
      precision: 'microsecond',
      fractionalDigits: '123456',
    } as const);
  return {
    policyVersion: 'date-resolution/1',
    fileId: 'sha256:file',
    mediaKind: 'image',
    target: 'capture-time',
    evaluationTimeUtc: '2026-08-29T12:00:00.000Z',
    status: 'resolved',
    confidence: 'high',
    selectedCandidateId: 'capture',
    selectedGroupId: 'group:capture',
    selectedGroupScore: 95,
    selectedValue,
    contenderIds: ['capture'],
    rejected: [],
    reasonCodes: ['RESOLVED_HIGH_CONFIDENCE'],
    candidates: [
      {
        id: 'capture',
        fileId: 'sha256:file',
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        sourceFamily: 'exif-primary',
        tag: 'EXIF:DateTimeOriginal',
        rawValue: '2024:03:04 05:06:07.123456',
        value: selectedValue,
        eligibility: 'eligible',
        score: {
          base: 95,
          modifiers: [],
          semanticCap: 100,
          final: 95,
        },
        resolutionIssues: [],
      },
    ],
    ...overrides,
  };
}

function request(
  sourcePath: string,
  destinationRoot: string,
  dateResolution: DateResolutionRecord,
  mediaKind: MediaKind = 'image'
) {
  return {
    sourcePath,
    destinationRoot,
    mediaKind,
    resolution: dateResolution,
    operation: OperationMode.COPY,
    conflictPolicy: ConflictPolicy.RENAME,
    folderStructure: FolderStructure.YEAR_MONTH,
    appendScreenshotSuffix: false,
    screenshotDetected: false,
  } as const;
}

describe('MediaPlanner', () => {
  let root: string;
  let sourceRoot: string;
  let destinationRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-planner-'));
    sourceRoot = path.join(root, 'source');
    destinationRoot = path.join(root, 'destination');
    await mkdir(sourceRoot);
    await mkdir(destinationRoot);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(['high', 'medium'] as const)(
    'uses a resolved %s-confidence date for both folder and filename',
    async (confidence) => {
      const sourcePath = path.join(sourceRoot, 'renamed.JPG');
      await writeFile(sourcePath, 'original');
      const planner = new MediaPlanner();
      const input = request(sourcePath, destinationRoot, resolution({ confidence }));

      const preview = planner.planForPreview(input);
      const execution = planner.planForExecution(input);

      expect(preview).toEqual(execution);
      expect(preview).toMatchObject({
        sourcePath,
        targetPath: path.join(
          destinationRoot,
          'Photos',
          '2024',
          '03',
          '2024-03-04_05-06-07.123456.JPG'
        ),
        needsReview: false,
        operation: 'copy',
        resolution: input.resolution,
      });
      expect(await readdir(destinationRoot)).toEqual([]);
      expect(await readdir(sourceRoot)).toEqual(['renamed.JPG']);
    }
  );

  it.each([
    ['review-required', 'low'],
    ['ambiguous', 'none'],
    ['unresolved', 'none'],
    ['resolved', 'low'],
  ] as const)(
    'routes %s/%s evidence to review with the sanitized original basename',
    (status, confidence) => {
      const planner = new MediaPlanner();
      const input = request(
        path.join(sourceRoot, ' unsafe<>name?.jpg '),
        destinationRoot,
        resolution({
          status,
          confidence,
          selectedValue:
            status === 'unresolved'
              ? undefined
              : {
                  localIso: '2024-03-04T05:06:07',
                  zoneBasis: 'floating-local',
                  precision: 'second',
                },
        })
      );

      const plan = planner.planForPreview(input);

      expect(plan.targetPath).toBe(
        path.join(destinationRoot, 'Photos', '_Needs Review', 'unsafe__name_.jpg')
      );
      expect(plan.needsReview).toBe(true);
      expect(plan.resolution).toBe(input.resolution);
    }
  );

  it.each(['high', 'medium'] as const)(
    'rejects forged %s-confidence filesystem modification time at the planning boundary',
    (confidence) => {
      const planner = new MediaPlanner();
      const input = request(
        path.join(sourceRoot, 'uuid-name.jpg'),
        destinationRoot,
        resolution({
          confidence,
          selectedCandidateId: 'filesystem-modified',
          selectedGroupId: 'group:filesystem-modified',
          selectedGroupScore: 99,
          selectedValue: {
            localIso: '2025-01-02T03:04:05.000',
            instantUtc: '2025-01-02T03:04:05.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'millisecond',
            fractionalDigits: '000',
          },
          contenderIds: ['filesystem-modified'],
          candidates: [
            {
              id: 'filesystem-modified',
              fileId: 'sha256:file',
              mediaKind: 'image',
              semantic: 'filesystem-modified',
              sourceKind: 'filesystem',
              sourceFamily: 'filesystem-modified',
              tag: 'FileSystem:ModifiedTime',
              rawValue: '2025-01-02T03:04:05.000Z',
              value: {
                localIso: '2025-01-02T03:04:05.000',
                instantUtc: '2025-01-02T03:04:05.000Z',
                zoneBasis: 'spec-defined-utc',
                precision: 'millisecond',
                fractionalDigits: '000',
              },
              eligibility: 'eligible',
              score: {
                base: 99,
                modifiers: [],
                semanticCap: 100,
                final: 99,
              },
              resolutionIssues: [],
            },
          ],
        })
      );

      expect(planner.planForPreview(input)).toMatchObject({
        targetPath: path.join(destinationRoot, 'Photos', '_Needs Review', 'uuid-name.jpg'),
        needsReview: true,
      });
    }
  );

  it('rejects a forbidden selected candidate even when its record claims resolved/high', () => {
    const planner = new MediaPlanner();
    const input = request(
      path.join(sourceRoot, 'photo.jpg'),
      destinationRoot,
      resolution({
        candidates: [
          {
            ...resolution().candidates[0],
            eligibility: 'forbidden',
            resolutionIssues: ['FORBIDDEN_EVIDENCE'],
          },
        ],
      })
    );

    expect(planner.planForExecution(input)).toMatchObject({
      targetPath: path.join(destinationRoot, 'Photos', '_Needs Review', 'photo.jpg'),
      needsReview: true,
    });
  });

  it.each([
    ['high', 'FileSystem:ModifiedTime', 'exif-primary'],
    ['medium', 'XMP:MetadataDate', 'xmp-primary'],
    ['high', 'ICC_Profile:ProfileDateTime', 'exif-primary'],
    ['medium', 'EXIF:DateTimeOriginal', 'filesystem-modified'],
  ] as const)(
    'rejects relabeled %s-confidence non-creation provenance %s / %s',
    (confidence, tag, sourceFamily) => {
      const planner = new MediaPlanner();
      const spoofedCandidate = {
        ...resolution().candidates[0],
        tag,
        sourceFamily,
      };
      const input = request(
        path.join(sourceRoot, 'spoofed.jpg'),
        destinationRoot,
        resolution({ confidence, candidates: [spoofedCandidate] })
      );

      expect(planner.planForPreview(input)).toMatchObject({
        targetPath: path.join(destinationRoot, 'Photos', '_Needs Review', 'spoofed.jpg'),
        needsReview: true,
      });
    }
  );

  it('accepts a valid filename creation claim at the planning boundary', () => {
    const planner = new MediaPlanner();
    const filenameCandidate = {
      ...resolution().candidates[0],
      semantic: 'filename-claim' as const,
      sourceKind: 'filename' as const,
      sourceFamily: 'screenshot-filename',
      tag: 'filename:Screenshot_20240304_050607',
      score: {
        base: 82,
        modifiers: [],
        semanticCap: 85,
        final: 82,
      },
    };
    const input = request(
      path.join(sourceRoot, 'Screenshot_20240304_050607.jpg'),
      destinationRoot,
      resolution({ confidence: 'medium', candidates: [filenameCandidate] })
    );

    expect(planner.planForPreview(input)).toMatchObject({
      targetPath: path.join(
        destinationRoot,
        'Photos',
        '2024',
        '03',
        '2024-03-04_05-06-07.123456.jpg'
      ),
      needsReview: false,
    });
  });

  it.each(['high', 'medium'] as const)(
    'rejects a %s-confidence selected value that differs from its selected candidate',
    (confidence) => {
      const planner = new MediaPlanner();
      const input = request(
        path.join(sourceRoot, 'mismatched.jpg'),
        destinationRoot,
        resolution({
          confidence,
          candidates: [resolution().candidates[0]],
          selectedValue: {
            localIso: '2026-03-27T21:38:45',
            instantUtc: '2026-03-27T21:38:45.000Z',
            zoneBasis: 'spec-defined-utc',
            precision: 'second',
          },
        })
      );

      expect(planner.planForPreview(input)).toMatchObject({
        targetPath: path.join(destinationRoot, 'Photos', '_Needs Review', 'mismatched.jpg'),
        needsReview: true,
      });
    }
  );

  it.each(['high', 'medium'] as const)(
    'rejects %s-confidence filesystem metadata relabeled as filename evidence',
    (confidence) => {
      const planner = new MediaPlanner();
      const input = request(
        path.join(sourceRoot, 'spoofed-filename.jpg'),
        destinationRoot,
        resolution({
          confidence,
          candidates: [
            {
              ...resolution().candidates[0],
              semantic: 'filename-claim',
              sourceKind: 'filename',
              sourceFamily: 'filename-timestamp',
              tag: 'FileSystem:ModifiedTime',
            },
          ],
        })
      );

      expect(planner.planForPreview(input)).toMatchObject({
        targetPath: path.join(destinationRoot, 'Photos', '_Needs Review', 'spoofed-filename.jpg'),
        needsReview: true,
      });
    }
  );

  it('honors flat and year-month folder choices without mutating metadata', () => {
    const planner = new MediaPlanner();
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const base = request(sourcePath, destinationRoot, resolution(), 'video');

    expect(
      planner.planForExecution({ ...base, folderStructure: FolderStructure.FLAT }).targetPath
    ).toBe(path.join(destinationRoot, 'Videos', '2024-03-04_05-06-07.123456.mov'));
    expect(
      planner.planForExecution({ ...base, folderStructure: FolderStructure.YEAR_MONTH_FLAT })
        .targetPath
    ).toBe(path.join(destinationRoot, 'Videos', '2024-03', '2024-03-04_05-06-07.123456.mov'));
    expect(base.resolution.selectedValue?.localIso).toBe('2024-03-04T05:06:07.123456');
  });

  it('places resolved media directly in its year folder when month subfolders are disabled', () => {
    const planner = new MediaPlanner();
    const input = request(path.join(sourceRoot, 'photo.jpg'), destinationRoot, resolution());

    expect(
      planner.planForExecution({
        ...input,
        folderStructure: 'year' as FolderStructure,
      }).targetPath
    ).toBe(path.join(destinationRoot, 'Photos', '2024', '2024-03-04_05-06-07.123456.jpg'));
  });

  it('routes malformed selected dates and missing selected values to review', () => {
    const planner = new MediaPlanner();
    const malformed = request(
      path.join(sourceRoot, 'clip.mov'),
      destinationRoot,
      resolution({
        selectedValue: {
          localIso: 'not-a-date',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      }),
      'video'
    );
    const missing = request(
      path.join(sourceRoot, 'photo.jpg'),
      destinationRoot,
      resolution({ selectedValue: undefined })
    );

    expect(planner.planForExecution(malformed)).toMatchObject({
      targetPath: path.join(destinationRoot, 'Videos', '_Needs Review', 'clip.mov'),
      needsReview: true,
    });
    expect(planner.planForPreview(missing)).toMatchObject({
      targetPath: path.join(destinationRoot, 'Photos', '_Needs Review', 'photo.jpg'),
      needsReview: true,
    });
  });

  it('uses a deterministic fallback for an empty sanitized basename', () => {
    const planner = new MediaPlanner();
    const input = request(path.join(sourceRoot, '...'), destinationRoot, resolution());

    expect(planner.planForPreview(input).targetPath).toBe(
      path.join(destinationRoot, 'Photos', '2024', '03', '2024-03-04_05-06-07.123456')
    );

    const reviewInput = request(
      path.join(sourceRoot, '...'),
      destinationRoot,
      resolution({ status: 'unresolved', confidence: 'none', selectedValue: undefined })
    );
    expect(planner.planForPreview(reviewInput).targetPath).toBe(
      path.join(destinationRoot, 'Photos', '_Needs Review', 'unnamed_file')
    );
  });

  it('bounds an oversized review filename while retaining its extension', () => {
    const planner = new MediaPlanner();
    const longName = `${'a'.repeat(300)}.jpg`;
    const input = request(
      path.join(sourceRoot, longName),
      destinationRoot,
      resolution({ status: 'unresolved', confidence: 'none', selectedValue: undefined })
    );

    const targetName = path.basename(planner.planForExecution(input).targetPath);
    expect(targetName).toHaveLength(240);
    expect(targetName.endsWith('.jpg')).toBe(true);
  });

  it('omits a fractional suffix when the selected value has whole-second precision', () => {
    const planner = new MediaPlanner();
    const input = request(
      path.join(sourceRoot, 'photo.jpg'),
      destinationRoot,
      resolution({
        selectedValue: {
          localIso: '2024-03-04T05:06:07',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      })
    );

    expect(planner.planForPreview(input).targetPath).toBe(
      path.join(destinationRoot, 'Photos', '2024', '03', '2024-03-04_05-06-07.jpg')
    );
  });

  it('appends the screenshot suffix before the extension only when enabled and detected', () => {
    const planner = new MediaPlanner();
    const input = request(
      path.join(sourceRoot, 'IMG_0042.PNG'),
      destinationRoot,
      resolution({
        selectedValue: {
          localIso: '2024-03-04T05:06:07',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      })
    );

    expect(
      planner.planForPreview({
        ...input,
        appendScreenshotSuffix: true,
        screenshotDetected: true,
      }).targetPath
    ).toBe(
      path.join(destinationRoot, 'Photos', '2024', '03', '2024-03-04_05-06-07-screen-shot.PNG')
    );
    expect(
      planner.planForPreview({
        ...input,
        appendScreenshotSuffix: false,
        screenshotDetected: true,
      }).targetPath
    ).toBe(path.join(destinationRoot, 'Photos', '2024', '03', '2024-03-04_05-06-07.PNG'));
    expect(
      planner.planForPreview({
        ...input,
        appendScreenshotSuffix: true,
        screenshotDetected: false,
      }).targetPath
    ).toBe(path.join(destinationRoot, 'Photos', '2024', '03', '2024-03-04_05-06-07.PNG'));
  });

  it('labels review filenames once and preserves the extension', () => {
    const planner = new MediaPlanner();
    const unresolved = resolution({
      status: 'unresolved',
      confidence: 'none',
      selectedValue: undefined,
    });

    expect(
      planner.planForPreview({
        ...request(path.join(sourceRoot, 'IMG_0042.png'), destinationRoot, unresolved),
        appendScreenshotSuffix: true,
        screenshotDetected: true,
      }).targetPath
    ).toBe(path.join(destinationRoot, 'Photos', '_Needs Review', 'IMG_0042-screen-shot.png'));
    expect(
      planner.planForPreview({
        ...request(path.join(sourceRoot, 'IMG_0042-screen-shot.png'), destinationRoot, unresolved),
        appendScreenshotSuffix: true,
        screenshotDetected: true,
      }).targetPath
    ).toBe(path.join(destinationRoot, 'Photos', '_Needs Review', 'IMG_0042-screen-shot.png'));
  });

  it.each([
    ['image', 'Photos'],
    ['raw', 'Photos'],
    ['video', 'Videos'],
    ['audio', 'Audio'],
    ['document', 'Documents'],
    ['art', 'Art'],
  ] as const)('places %s media under the top-level %s folder', (mediaKind, folder) => {
    const sourcePath = path.join(sourceRoot, 'file.bin');
    const base = request(sourcePath, destinationRoot, resolution(), mediaKind as MediaKind);

    expect(new MediaPlanner().planForPreview(base).targetPath).toBe(
      path.join(destinationRoot, folder, '2024', '03', '2024-03-04_05-06-07.123456.bin')
    );
    expect(
      new MediaPlanner().planForPreview({ ...base, folderStructure: FolderStructure.FLAT })
        .targetPath
    ).toBe(path.join(destinationRoot, folder, '2024-03-04_05-06-07.123456.bin'));
    expect(
      new MediaPlanner().planForPreview({
        ...base,
        folderStructure: FolderStructure.YEAR_MONTH_FLAT,
      }).targetPath
    ).toBe(path.join(destinationRoot, folder, '2024-03', '2024-03-04_05-06-07.123456.bin'));
    expect(
      new MediaPlanner().planForPreview({
        ...base,
        folderStructure: FolderStructure.YEAR,
      }).targetPath
    ).toBe(path.join(destinationRoot, folder, '2024', '2024-03-04_05-06-07.123456.bin'));
    expect(
      new MediaPlanner().planForPreview({
        ...base,
        resolution: resolution({ status: 'unresolved', confidence: 'none' }),
      }).targetPath
    ).toBe(path.join(destinationRoot, folder, '_Needs Review', 'file.bin'));
  });
});
