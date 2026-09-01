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
    selectedValue: {
      localIso: '2024-03-04T05:06:07.123456',
      zoneBasis: 'floating-local',
      precision: 'microsecond',
      fractionalDigits: '123456',
    },
    contenderIds: ['capture'],
    rejected: [],
    reasonCodes: ['RESOLVED_HIGH_CONFIDENCE'],
    candidates: [],
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
        targetPath: path.join(destinationRoot, '2024', '03', '2024-03-04_05-06-07.123456.JPG'),
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
        path.join(destinationRoot, '_Needs Review', 'unsafe__name_.jpg')
      );
      expect(plan.needsReview).toBe(true);
      expect(plan.resolution).toBe(input.resolution);
    }
  );

  it('honors flat and year-month folder choices without mutating metadata', () => {
    const planner = new MediaPlanner();
    const sourcePath = path.join(sourceRoot, 'clip.mov');
    const base = request(sourcePath, destinationRoot, resolution(), 'video');

    expect(
      planner.planForExecution({ ...base, folderStructure: FolderStructure.FLAT }).targetPath
    ).toBe(path.join(destinationRoot, '2024-03-04_05-06-07.123456.mov'));
    expect(
      planner.planForExecution({ ...base, folderStructure: FolderStructure.YEAR_MONTH_FLAT })
        .targetPath
    ).toBe(path.join(destinationRoot, '2024-03', '2024-03-04_05-06-07.123456.mov'));
    expect(base.resolution.selectedValue?.localIso).toBe('2024-03-04T05:06:07.123456');
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
      targetPath: path.join(destinationRoot, '_Needs Review', 'clip.mov'),
      needsReview: true,
    });
    expect(planner.planForPreview(missing)).toMatchObject({
      targetPath: path.join(destinationRoot, '_Needs Review', 'photo.jpg'),
      needsReview: true,
    });
  });

  it('uses a deterministic fallback for an empty sanitized basename', () => {
    const planner = new MediaPlanner();
    const input = request(path.join(sourceRoot, '...'), destinationRoot, resolution());

    expect(planner.planForPreview(input).targetPath).toBe(
      path.join(destinationRoot, '2024', '03', '2024-03-04_05-06-07.123456')
    );

    const reviewInput = request(
      path.join(sourceRoot, '...'),
      destinationRoot,
      resolution({ status: 'unresolved', confidence: 'none', selectedValue: undefined })
    );
    expect(planner.planForPreview(reviewInput).targetPath).toBe(
      path.join(destinationRoot, '_Needs Review', 'unnamed_file')
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
      path.join(destinationRoot, '2024', '03', '2024-03-04_05-06-07.jpg')
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
    ).toBe(path.join(destinationRoot, '2024', '03', '2024-03-04_05-06-07-screen-shot.PNG'));
    expect(
      planner.planForPreview({
        ...input,
        appendScreenshotSuffix: false,
        screenshotDetected: true,
      }).targetPath
    ).toBe(path.join(destinationRoot, '2024', '03', '2024-03-04_05-06-07.PNG'));
    expect(
      planner.planForPreview({
        ...input,
        appendScreenshotSuffix: true,
        screenshotDetected: false,
      }).targetPath
    ).toBe(path.join(destinationRoot, '2024', '03', '2024-03-04_05-06-07.PNG'));
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
    ).toBe(path.join(destinationRoot, '_Needs Review', 'IMG_0042-screen-shot.png'));
    expect(
      planner.planForPreview({
        ...request(path.join(sourceRoot, 'IMG_0042-screen-shot.png'), destinationRoot, unresolved),
        appendScreenshotSuffix: true,
        screenshotDetected: true,
      }).targetPath
    ).toBe(path.join(destinationRoot, '_Needs Review', 'IMG_0042-screen-shot.png'));
  });
});
