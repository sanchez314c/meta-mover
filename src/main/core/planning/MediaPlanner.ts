import path from 'path';

import {
  DateResolutionRecord,
  MediaKind,
  ParsedDateValue,
  isResolvedCreationProvenance,
  isSelectedValueSupported,
} from '../date';
import { ConflictPolicy, FolderStructure, OperationMode } from '../../../shared/types/processing';

export interface MediaPlanRequest {
  sourcePath: string;
  destinationRoot: string;
  mediaKind: MediaKind;
  resolution: DateResolutionRecord;
  operation: OperationMode;
  conflictPolicy: ConflictPolicy;
  folderStructure: FolderStructure;
  appendScreenshotSuffix: boolean;
  screenshotDetected: boolean;
}

export interface MediaPlan {
  sourcePath: string;
  targetPath: string;
  mediaKind: MediaKind;
  operation: OperationMode;
  conflictPolicy: ConflictPolicy;
  needsReview: boolean;
  resolution: DateResolutionRecord;
}

interface DateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  fraction?: string;
}

function sanitizeBasename(sourcePath: string): string {
  let basename = path.basename(sourcePath).trim();
  basename = basename.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_');
  basename = basename.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!basename) return 'unnamed_file';

  const parsed = path.parse(basename);
  if (basename.length <= 240) return basename;
  return `${parsed.name.slice(0, Math.max(1, 240 - parsed.ext.length))}${parsed.ext}`;
}

function appendScreenshotSuffix(basename: string): string {
  const parsed = path.parse(basename);
  if (/-screen-shot$/i.test(parsed.name)) return basename;
  const suffix = '-screen-shot';
  const maximumStemLength = Math.max(1, 240 - parsed.ext.length - suffix.length);
  return `${parsed.name.slice(0, maximumStemLength)}${suffix}${parsed.ext}`;
}

function trustedResolution(resolution: DateResolutionRecord): resolution is DateResolutionRecord & {
  selectedValue: ParsedDateValue;
} {
  const selectedCandidate = resolution.candidates.find(
    (candidate) => candidate.id === resolution.selectedCandidateId
  );
  return (
    resolution.status === 'resolved' &&
    (resolution.confidence === 'high' || resolution.confidence === 'medium') &&
    resolution.selectedValue !== undefined &&
    selectedCandidate !== undefined &&
    selectedCandidate.eligibility === 'eligible' &&
    selectedCandidate.score.final > 0 &&
    isResolvedCreationProvenance(selectedCandidate) &&
    isSelectedValueSupported(resolution.selectedValue, selectedCandidate.value)
  );
}

function dateParts(value: ParsedDateValue): DateParts | null {
  const match = value.localIso.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/
  );
  if (!match) return null;
  return {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4] ?? '00',
    minute: match[5] ?? '00',
    second: match[6] ?? '00',
    fraction: value.fractionalDigits ?? match[7],
  };
}

// Top-level destination folder per media kind. Names match the original Meta Mover layout.
const MEDIA_KIND_FOLDER: Record<MediaKind, string> = {
  image: 'Photos',
  raw: 'Photos',
  video: 'Videos',
  audio: 'Audio',
  document: 'Documents',
  art: 'Art',
};

export function mediaKindFolder(mediaKind: MediaKind): string {
  return MEDIA_KIND_FOLDER[mediaKind] ?? 'Other';
}

function trustedTarget(
  request: MediaPlanRequest,
  basename: string,
  value: ParsedDateValue
): string | null {
  const parts = dateParts(value);
  if (!parts) return null;

  const extension = path.extname(basename);
  const fraction = parts.fraction ? `.${parts.fraction}` : '';
  const generated = `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}${fraction}${extension}`;
  const filename =
    request.appendScreenshotSuffix && request.screenshotDetected
      ? appendScreenshotSuffix(generated)
      : generated;

  const typeRoot = path.join(request.destinationRoot, mediaKindFolder(request.mediaKind));
  if (request.folderStructure === FolderStructure.FLAT) {
    return path.join(typeRoot, filename);
  }
  if (request.folderStructure === FolderStructure.YEAR_MONTH_FLAT) {
    return path.join(typeRoot, `${parts.year}-${parts.month}`, filename);
  }
  if (request.folderStructure === FolderStructure.YEAR) {
    return path.join(typeRoot, parts.year, filename);
  }
  return path.join(typeRoot, parts.year, parts.month, filename);
}

export class MediaPlanner {
  planForPreview(request: MediaPlanRequest): MediaPlan {
    return this.plan(request);
  }

  planForExecution(request: MediaPlanRequest): MediaPlan {
    return this.plan(request);
  }

  private plan(request: MediaPlanRequest): MediaPlan {
    const sourceBasename = sanitizeBasename(request.sourcePath);
    const basename =
      request.appendScreenshotSuffix && request.screenshotDetected
        ? appendScreenshotSuffix(sourceBasename)
        : sourceBasename;
    const trustedPath = trustedResolution(request.resolution)
      ? trustedTarget(request, basename, request.resolution.selectedValue)
      : null;
    const needsReview = trustedPath === null;

    return {
      sourcePath: request.sourcePath,
      targetPath:
        trustedPath ??
        path.join(
          request.destinationRoot,
          mediaKindFolder(request.mediaKind),
          '_Needs Review',
          basename
        ),
      mediaKind: request.mediaKind,
      operation: request.operation,
      conflictPolicy: request.conflictPolicy,
      needsReview,
      resolution: request.resolution,
    };
  }
}
