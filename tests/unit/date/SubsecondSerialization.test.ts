/** @jest-environment node */
import {
  resolveDateCandidates,
  DateCandidateInput,
  ParsedDateValue,
} from '../../../src/main/core/date';
import { MediaPlanner } from '../../../src/main/core/planning/MediaPlanner';
import {
  CoordinatorJsonValue,
  ProcessingCoordinator,
} from '../../../src/main/services/ProcessingCoordinator';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
} from '../../../src/shared/types/processing';

function candidate(value: ParsedDateValue): DateCandidateInput {
  return {
    id: 'capture',
    fileId: 'file',
    mediaKind: 'image',
    semantic: 'capture',
    sourceKind: 'embedded-exif',
    sourceFamily: 'exif-primary',
    tag: 'EXIF:DateTimeOriginal',
    rawValue: value.localIso,
    value,
  };
}

describe('resolved subseconds at the preview serialization boundary', () => {
  it.each(['absent', 'unverified', 'unverified-floating', 'consensus'] as const)(
    'publishes %s subseconds without undefined properties or lost provenance',
    async (mode) => {
      const value: ParsedDateValue =
        mode === 'absent'
          ? { localIso: '2020-01-02T03:04:05', zoneBasis: 'floating-local', precision: 'second' }
          : {
              localIso: '2020-01-02T03:04:05.65',
              instantUtc: '2020-01-02T03:04:05.650Z',
              offsetMinutes: 0,
              zoneBasis: 'explicit-offset',
              precision: 'millisecond',
              fractionalDigits: '65',
            };
      if (mode === 'unverified-floating') {
        delete value.instantUtc;
        delete value.offsetMinutes;
        value.zoneBasis = 'floating-local';
      }
      const originalValue = { ...value };
      const original = candidate(value);
      const candidates =
        mode === 'consensus'
          ? [
              original,
              {
                ...original,
                id: 'xmp',
                sourceKind: 'embedded-xmp' as const,
                sourceFamily: 'xmp-primary',
                tag: 'XMP:DateTimeOriginal',
              },
            ]
          : [original];
      const resolution = resolveDateCandidates({
        fileId: 'file',
        mediaKind: 'image',
        evaluationTimeUtc: '2026-09-12T12:00:00Z',
        candidates,
      });
      expect(resolution.status).toBe('resolved');
      expect(resolution.candidates[0].value).toStrictEqual(originalValue);
      expect(original.value).toStrictEqual(originalValue);
      if (mode === 'consensus') {
        expect(resolution.selectedValue).toStrictEqual(value);
      } else {
        expect(Object.hasOwn(resolution.selectedValue!, 'fractionalDigits')).toBe(false);
        expect(resolution.selectedValue?.localIso).toBe('2020-01-02T03:04:05');
        if (mode === 'unverified') {
          expect(resolution.selectedValue?.instantUtc).toBe('2020-01-02T03:04:05.000Z');
          expect(resolution.reasonCodes).toContain('UNVERIFIED_SUBSECONDS_OMITTED');
        }
      }
      expect(JSON.parse(JSON.stringify(resolution))).toStrictEqual(resolution);
      const planned = new MediaPlanner().planForPreview({
        sourcePath: '/source/photo.jpg',
        destinationRoot: '/destination',
        mediaKind: 'image',
        resolution,
        operation: OperationMode.COPY,
        conflictPolicy: ConflictPolicy.RENAME,
        folderStructure: FolderStructure.YEAR,
        appendScreenshotSuffix: false,
        screenshotDetected: false,
      });
      expect(planned.targetPath).toBe(
        `/destination/Photos/2020/2020-01-02_03-04-05${mode === 'consensus' ? '.65' : ''}.jpg`
      );
      const coordinator = new ProcessingCoordinator({
        previewTtlMs: 60000,
        maxWorkerConcurrency: 1,
        planner: {
          plan: async () => ({
            summary: {
              totalFiles: 1,
              copyFiles: 1,
              moveFiles: 0,
              skippedFiles: 0,
              renamedFiles: 0,
              overwrittenFiles: 0,
              unresolvedDates: 0,
              totalBytes: 1,
            },
            operations: [
              {
                id: 'op',
                sourcePath: planned.sourcePath,
                targetPath: planned.targetPath,
                bytes: 1,
                payload: { dateResolution: resolution as unknown as CoordinatorJsonValue },
              },
            ],
          }),
        },
        revalidator: {
          revalidate: async () => ({
            sourceFingerprintMatches: true,
            configMatches: true,
            reasons: [],
          }),
        },
        executor: {
          execute: async () => {
            throw new Error('Preview must not execute media writes');
          },
        },
      });
      try {
        await expect(
          coordinator.createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' })
        ).resolves.toMatchObject({ summary: { totalFiles: 1 } });
      } finally {
        await coordinator.shutdown();
      }
    }
  );
});
