import { Stats } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';

import {
  DateCandidateInput,
  DateSemantic,
  JsonValue,
  MediaKind,
  ParsedDateValue,
  SourceKind,
} from '../date';

export type RawExifValue = string | number | boolean | null | RawExifValue[];
export type RawExifTags = Record<string, RawExifValue | undefined>;

export interface VerifiedRawExifRead {
  tags: RawExifTags;
  sha256: string;
  bytes: number;
}

export interface ExifToolReadAdapter {
  readRaw(filePath: string, signal?: AbortSignal): Promise<RawExifTags>;
  readRawVerified?(filePath: string, signal?: AbortSignal): Promise<VerifiedRawExifRead>;
  close(): Promise<void>;
}

export interface CollectMetadataCandidatesRequest {
  fileId: string;
  filePath: string;
  /** A seekable, identity-bound path used for direct ExifTool access without whole-file streaming. */
  seekableExtractionPath?: string;
  /** Legacy hash-bound stdin extraction contract retained for compatibility tests and callers. */
  verifiedExtractionPath?: string;
  expectedContentSha256?: string;
  expectedContentBytes?: number;
  filesystemBirthTimeUtc?: string | null;
  mediaKind: MediaKind;
  signal?: AbortSignal;
}

export interface MetadataCollectionResult {
  candidates: DateCandidateInput[];
  warnings: string[];
  screenshotEvidence?: ScreenshotEvidence;
}

export interface ScreenshotEvidence {
  source: 'filename' | 'metadata';
  field: string;
}

type StatReader = (filePath: string) => Promise<Pick<Stats, 'birthtime'>>;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Metadata extraction cancelled'
  );
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

interface TagRule {
  tag: string;
  semantic: DateSemantic;
  sourceKind: SourceKind;
  sourceFamily: string;
  offsetTag?: string;
  subsecondTag?: string;
  specDefinedUtc?: boolean;
}

interface AudioDateTimePair {
  dateTag: string;
  timeTag: string;
}

const COMMON_IMAGE_RULES: TagRule[] = [
  {
    tag: 'ExifIFD:DateTimeOriginal',
    semantic: 'capture',
    sourceKind: 'embedded-exif',
    sourceFamily: 'exif',
    offsetTag: 'ExifIFD:OffsetTimeOriginal',
    subsecondTag: 'ExifIFD:SubSecTimeOriginal',
  },
  {
    tag: 'EXIF:DateTimeOriginal',
    semantic: 'capture',
    sourceKind: 'embedded-exif',
    sourceFamily: 'exif',
    offsetTag: 'EXIF:OffsetTimeOriginal',
    subsecondTag: 'EXIF:SubSecTimeOriginal',
  },
  {
    tag: 'ExifIFD:CreateDate',
    semantic: 'digitized',
    sourceKind: 'embedded-exif',
    sourceFamily: 'exif',
    offsetTag: 'ExifIFD:OffsetTimeDigitized',
    subsecondTag: 'ExifIFD:SubSecTimeDigitized',
  },
  {
    tag: 'EXIF:CreateDate',
    semantic: 'digitized',
    sourceKind: 'embedded-exif',
    sourceFamily: 'exif',
    offsetTag: 'EXIF:OffsetTimeDigitized',
    subsecondTag: 'EXIF:SubSecTimeDigitized',
  },
  {
    tag: 'XMP-photoshop:DateCreated',
    semantic: 'capture',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP:DateCreated',
    semantic: 'capture',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP-exif:DateTimeOriginal',
    semantic: 'capture',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp-exif',
  },
  {
    tag: 'XMP-xmp:CreateDate',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP-pdf:CreationDate',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp-pdf',
  },
  {
    tag: 'Samsung:TimeStamp',
    semantic: 'capture',
    sourceKind: 'embedded-exif',
    sourceFamily: 'samsung',
  },
  {
    tag: 'PNG:CreateDate',
    semantic: 'content-created',
    sourceKind: 'container-format',
    sourceFamily: 'png',
  },
  {
    tag: 'IPTC:DateCreated',
    semantic: 'capture',
    sourceKind: 'embedded-iptc',
    sourceFamily: 'iptc',
  },
];

const VIDEO_RULES: TagRule[] = [
  {
    tag: 'QuickTime:CreateDate',
    semantic: 'container-created',
    sourceKind: 'container-format',
    sourceFamily: 'quicktime-format',
    specDefinedUtc: true,
  },
  {
    tag: 'QuickTime:Keys:CreationDate',
    semantic: 'capture',
    sourceKind: 'container-format',
    sourceFamily: 'quicktime-keys',
  },
  {
    tag: 'QuickTime:CreationDate',
    semantic: 'capture',
    sourceKind: 'container-format',
    sourceFamily: 'quicktime-keys',
  },
  {
    tag: 'Keys:CreationDate',
    semantic: 'capture',
    sourceKind: 'container-format',
    sourceFamily: 'quicktime-keys',
  },
  {
    tag: 'QuickTime:ContentCreateDate',
    semantic: 'content-created',
    sourceKind: 'container-format',
    sourceFamily: 'quicktime-format',
    specDefinedUtc: true,
  },
  {
    tag: 'QuickTime:MediaCreateDate',
    semantic: 'container-created',
    sourceKind: 'container-stream',
    sourceFamily: 'quicktime-media',
    specDefinedUtc: true,
  },
  {
    tag: 'QuickTime:TrackCreateDate',
    semantic: 'container-created',
    sourceKind: 'container-stream',
    sourceFamily: 'quicktime-track',
    specDefinedUtc: true,
  },
  {
    tag: 'ExifIFD:DateTimeOriginal',
    semantic: 'capture',
    sourceKind: 'embedded-exif',
    sourceFamily: 'exif',
    offsetTag: 'ExifIFD:OffsetTimeOriginal',
    subsecondTag: 'ExifIFD:SubSecTimeOriginal',
  },
  {
    tag: 'EXIF:DateTimeOriginal',
    semantic: 'capture',
    sourceKind: 'embedded-exif',
    sourceFamily: 'exif',
    offsetTag: 'EXIF:OffsetTimeOriginal',
    subsecondTag: 'EXIF:SubSecTimeOriginal',
  },
  {
    tag: 'XMP-photoshop:DateCreated',
    semantic: 'capture',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP:DateCreated',
    semantic: 'capture',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP-exif:DateTimeOriginal',
    semantic: 'capture',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp-exif',
  },
  {
    tag: 'XMP-xmp:CreateDate',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP-pdf:CreationDate',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp-pdf',
  },
  {
    tag: 'UserData:DateTimeOriginal',
    semantic: 'capture',
    sourceKind: 'container-format',
    sourceFamily: 'quicktime-userdata',
  },
  {
    tag: 'ItemList:ContentCreateDate',
    semantic: 'content-created',
    sourceKind: 'container-format',
    sourceFamily: 'quicktime-itemlist',
  },
];

const AUDIO_RULES: TagRule[] = [
  {
    tag: 'iXML:OriginationDateTime',
    semantic: 'recording',
    sourceKind: 'audio-tag',
    sourceFamily: 'ixml',
  },
  {
    tag: 'RIFF:DateCreated',
    semantic: 'recording',
    sourceKind: 'audio-tag',
    sourceFamily: 'riff',
  },
  {
    tag: 'ID3v2_3:TDRC',
    semantic: 'recording',
    sourceKind: 'audio-tag',
    sourceFamily: 'id3',
  },
  {
    tag: 'ID3v2_4:TDRC',
    semantic: 'recording',
    sourceKind: 'audio-tag',
    sourceFamily: 'id3',
  },
  {
    tag: 'ID3:TDRC',
    semantic: 'recording',
    sourceKind: 'audio-tag',
    sourceFamily: 'id3',
  },
  {
    tag: 'XMP-photoshop:DateCreated',
    semantic: 'recording',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP:DateCreated',
    semantic: 'recording',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP-pdf:CreationDate',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp-pdf',
  },
];

const CONTENT_RULES: TagRule[] = [
  {
    tag: 'XMP-xmp:CreateDate',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP:CreateDate',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP-photoshop:DateCreated',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP:DateCreated',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp',
  },
  {
    tag: 'XMP-pdf:CreationDate',
    semantic: 'content-created',
    sourceKind: 'embedded-xmp',
    sourceFamily: 'xmp-pdf',
  },
  {
    tag: 'PDF:CreateDate',
    semantic: 'content-created',
    sourceKind: 'container-format',
    sourceFamily: 'pdf',
  },
  {
    tag: 'IPTC:DateCreated',
    semantic: 'content-created',
    sourceKind: 'embedded-iptc',
    sourceFamily: 'iptc',
  },
];

const BWF_DATE_TIME_PAIRS: AudioDateTimePair[] = [
  { dateTag: 'RIFF:OriginationDate', timeTag: 'RIFF:OriginationTime' },
  { dateTag: 'RIFF:DateCreated', timeTag: 'RIFF:TimeCreated' },
  { dateTag: 'BWF:OriginationDate', timeTag: 'BWF:OriginationTime' },
];

function stringValue(value: RawExifValue | undefined): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return undefined;
}

const SCREENSHOT_FILENAME_PATTERN =
  /(?:^|[\s._-])screen(?:[\s._-]*shot|[\s._-]+capture)(?:$|[\s._-])/i;
const CGRECT_NUMBER = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)`;
const SCREENSHOT_CGRECT_PATTERN = new RegExp(
  String.raw`^\{\{\s*${CGRECT_NUMBER}\s*,\s*${CGRECT_NUMBER}\s*\},\s*\{\s*${CGRECT_NUMBER}\s*,\s*${CGRECT_NUMBER}\s*\}\}$`
);

function screenshotFilename(filename: string): boolean {
  return SCREENSHOT_FILENAME_PATTERN.test(path.parse(filename).name);
}

function screenshotUserComment(value: RawExifValue | undefined): boolean {
  if (Array.isArray(value)) return value.some(screenshotUserComment);
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized.toLowerCase() === 'screenshot' || SCREENSHOT_CGRECT_PATTERN.test(normalized);
}

function screenshotEvidence(
  filePath: string,
  mediaKind: MediaKind,
  tags: RawExifTags
): ScreenshotEvidence | undefined {
  if (mediaKind !== 'image') return undefined;
  if (screenshotFilename(path.basename(filePath))) {
    return { source: 'filename', field: 'filename' };
  }
  for (const [field, value] of Object.entries(tags)) {
    if (/(?:^|:)UserComment$/i.test(field) && screenshotUserComment(value)) {
      return { source: 'metadata', field };
    }
  }
  return undefined;
}

function offsetMinutes(offset: string): number | undefined {
  if (offset === 'Z') return 0;
  const match = offset.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return undefined;
  const hours = Number(match[2]);
  const minutePart = Number(match[3]);
  if (hours > 14 || minutePart > 59 || (hours === 14 && minutePart !== 0)) return undefined;
  const minutes = hours * 60 + minutePart;
  return match[1] === '-' ? -minutes : minutes;
}

function precisionFor(fraction: string | undefined, hasSeconds: boolean, hasMinutes: boolean) {
  if (fraction) {
    if (fraction.length <= 3) return 'millisecond' as const;
    if (fraction.length <= 6) return 'microsecond' as const;
    return 'nanosecond' as const;
  }
  if (hasSeconds) return 'second' as const;
  if (hasMinutes) return 'minute' as const;
  return 'date' as const;
}

function validCalendarAndClock(
  yearText: string,
  monthText: string,
  dayText: string,
  hourText: string | undefined,
  minuteText: string | undefined,
  secondText: string | undefined
): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthLengths[month - 1]) return false;
  if (hourText === undefined) return true;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? '0');
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function utcMilliseconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  milliseconds: number
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  return date.getTime();
}

function parseDateValue(
  raw: RawExifValue | undefined,
  explicitOffset?: RawExifValue,
  explicitSubsecond?: RawExifValue,
  specDefinedUtc = false
): ParsedDateValue | null {
  const text = stringValue(raw);
  if (!text) return null;

  const match = text.match(
    /^(\d{4})(?:(?::|-)(\d{2})(?::|-)(\d{2}))?(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (!match) return null;

  const year = match[1];
  const month = match[2] ?? '01';
  const day = match[3] ?? '01';
  const hour = match[4];
  const minute = match[5];
  const second = match[6];
  if (!validCalendarAndClock(year, month, day, hour, minute, second)) return null;
  const inlineFraction = match[7];
  const companionFraction = stringValue(explicitSubsecond);
  if (companionFraction && !/^\d{1,9}$/.test(companionFraction)) return null;
  if (inlineFraction && companionFraction && inlineFraction !== companionFraction) return null;
  const fraction = inlineFraction || companionFraction || undefined;
  const inlineOffset = match[8];
  const companionOffset = stringValue(explicitOffset);
  const inlineOffsetMinutes = inlineOffset ? offsetMinutes(inlineOffset) : undefined;
  const companionOffsetMinutes = companionOffset ? offsetMinutes(companionOffset) : undefined;
  if (inlineOffset && inlineOffsetMinutes === undefined) return null;
  if (companionOffset && companionOffsetMinutes === undefined) return null;
  if (
    inlineOffsetMinutes !== undefined &&
    companionOffsetMinutes !== undefined &&
    inlineOffsetMinutes !== companionOffsetMinutes
  ) {
    return null;
  }
  const offset = inlineOffset || companionOffset;

  let localIso = `${year}-${month}-${day}`;
  if (hour !== undefined && minute !== undefined) {
    localIso += `T${hour}:${minute}`;
    if (second !== undefined) localIso += `:${second}`;
    if (fraction) localIso += `.${fraction}`;
  }

  const precision = precisionFor(fraction, second !== undefined, minute !== undefined);
  if (offset) {
    const minutes = inlineOffsetMinutes ?? companionOffsetMinutes;
    if (minutes !== undefined && hour !== undefined && minute !== undefined) {
      const milliseconds = Number(`0.${fraction ?? '0'}`) * 1000;
      const instant =
        utcMilliseconds(
          Number(year),
          Number(month),
          Number(day),
          Number(hour),
          Number(minute),
          Number(second ?? '0'),
          milliseconds
        ) -
        minutes * 60 * 1000;
      return {
        localIso,
        instantUtc: new Date(instant).toISOString(),
        offsetMinutes: minutes,
        zoneBasis: 'explicit-offset',
        precision,
        ...(fraction ? { fractionalDigits: fraction } : {}),
      };
    }
  }

  if (specDefinedUtc && hour !== undefined && minute !== undefined) {
    const milliseconds = Number(`0.${fraction ?? '0'}`) * 1000;
    return {
      localIso,
      instantUtc: new Date(
        utcMilliseconds(
          Number(year),
          Number(month),
          Number(day),
          Number(hour),
          Number(minute),
          Number(second ?? '0'),
          milliseconds
        )
      ).toISOString(),
      zoneBasis: 'spec-defined-utc',
      precision,
      ...(fraction ? { fractionalDigits: fraction } : {}),
    };
  }

  return {
    localIso,
    zoneBasis: hour === undefined ? 'date-only' : 'floating-local',
    precision,
    ...(fraction ? { fractionalDigits: fraction } : {}),
  };
}

const PNG_MONTHS: Readonly<Record<string, string>> = Object.freeze({
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
});

const PNG_ZONE_OFFSETS: Readonly<Record<string, string>> = Object.freeze({
  UTC: '+00:00',
  GMT: '+00:00',
  EST: '-05:00',
  EDT: '-04:00',
  CST: '-06:00',
  CDT: '-05:00',
  MST: '-07:00',
  MDT: '-06:00',
  PST: '-08:00',
  PDT: '-07:00',
});

function parsePngCreationTime(raw: RawExifValue | undefined): ParsedDateValue | null {
  const text = stringValue(raw);
  if (!text) return null;
  const match = text.match(
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (AM|PM) (UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)$/
  );
  if (!match) return null;

  const hour12 = Number(match[5]);
  if (hour12 < 1 || hour12 > 12) return null;
  const hour24 = (hour12 % 12) + (match[8] === 'PM' ? 12 : 0);
  const month = PNG_MONTHS[match[3]];
  const offset = PNG_ZONE_OFFSETS[match[9]];
  const day = match[2].padStart(2, '0');
  const hour = String(hour24).padStart(2, '0');
  const parsed = parseDateValue(
    `${match[4]}-${month}-${day}T${hour}:${match[6]}:${match[7]}${offset}`
  );
  if (!parsed) return null;

  const expectedWeekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(`${match[4]}-${month}-${day}T00:00:00.000Z`).getUTCDay()
  ];
  return expectedWeekday === match[1] ? parsed : null;
}

function filenameDate(filename: string): { raw: string; value: ParsedDateValue } | null {
  const screenshot = filename.match(
    /(\d{4})[-_](\d{2})[-_](\d{2})\s+at\s+(\d{1,2})[._-](\d{2})[._-](\d{2})(?:[._](\d{1,9}))?/i
  );
  if (screenshot) {
    const raw = `${screenshot[1]}-${screenshot[2]}-${screenshot[3]}T${screenshot[4].padStart(2, '0')}:${screenshot[5]}:${screenshot[6]}${screenshot[7] ? `.${screenshot[7]}` : ''}`;
    const value = parseDateValue(raw);
    return value ? { raw, value } : null;
  }

  const compact = filename.match(
    /(\d{4})(\d{2})(\d{2})[-_]?(\d{2})(\d{2})(\d{2})(?:[._](\d{1,9}))?(?!\d)/
  );
  if (compact) {
    const raw = `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}${compact[7] ? `.${compact[7]}` : ''}`;
    const value = parseDateValue(raw);
    return value ? { raw, value } : null;
  }

  const separated = filename.match(
    /(\d{4})[-_](\d{2})[-_](\d{2})[ _-](\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:\.(\d{1,9}))?/
  );
  if (separated) {
    const raw = `${separated[1]}-${separated[2]}-${separated[3]}T${separated[4]}:${separated[5]}:${separated[6]}${separated[7] ? `.${separated[7]}` : ''}`;
    const value = parseDateValue(raw);
    return value ? { raw, value } : null;
  }

  const separatedDate = filename.match(/(?:^|[^\d])(\d{4})[-_](\d{2})[-_](\d{2})(?!\d)/);
  const compactDateAtStart = filename.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/);
  const labeledCompactDate = filename.match(
    /(?:IMG|VID|PIC|PHOTO|Screenshot)[-_ ](\d{4})(\d{2})(\d{2})(?!\d)/i
  );
  const date = separatedDate ?? compactDateAtStart ?? labeledCompactDate;
  if (date) {
    const raw = `${date[1]}-${date[2]}-${date[3]}`;
    const value = parseDateValue(raw);
    return value ? { raw, value } : null;
  }

  return null;
}

function rulesFor(mediaKind: MediaKind): TagRule[] {
  if (mediaKind === 'image' || mediaKind === 'raw') return COMMON_IMAGE_RULES;
  if (mediaKind === 'video') return VIDEO_RULES;
  if (mediaKind === 'audio') return AUDIO_RULES;
  return CONTENT_RULES;
}

export class MetadataCandidateCollector {
  private readonly adapter: ExifToolReadAdapter;
  private readonly statReader: StatReader;
  private closed = false;

  constructor(adapter: ExifToolReadAdapter, statReader: StatReader = stat) {
    this.adapter = adapter;
    this.statReader = statReader;
  }

  async collect(request: CollectMetadataCandidatesRequest): Promise<DateCandidateInput[]> {
    return (await this.collectDetailed(request)).candidates;
  }

  async collectDetailed(
    request: CollectMetadataCandidatesRequest
  ): Promise<MetadataCollectionResult> {
    if (this.closed) throw new Error('MetadataCandidateCollector is closed');
    throwIfAborted(request.signal);

    if (
      request.seekableExtractionPath !== undefined &&
      request.verifiedExtractionPath !== undefined
    ) {
      throw new Error('Metadata extraction cannot use two input boundaries');
    }
    const extractionPath =
      request.seekableExtractionPath ?? request.verifiedExtractionPath ?? request.filePath;
    if (!path.isAbsolute(extractionPath) || /\p{Cc}/u.test(extractionPath)) {
      throw new Error(
        'Metadata extraction path must be absolute and contain no control characters'
      );
    }

    const warnings: string[] = [];
    let tags: RawExifTags;
    if (request.verifiedExtractionPath !== undefined) {
      if (
        typeof this.adapter.readRawVerified !== 'function' ||
        !/^[a-f0-9]{64}$/.test(request.expectedContentSha256 ?? '') ||
        !Number.isSafeInteger(request.expectedContentBytes) ||
        request.expectedContentBytes! < 0
      ) {
        throw new Error('Verified metadata extraction requires an exact digest and byte contract');
      }
      let receipt: VerifiedRawExifRead | undefined;
      try {
        receipt = await this.adapter.readRawVerified(extractionPath, request.signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Metadata read failed: ${message}`);
      }
      throwIfAborted(request.signal);
      if (receipt === undefined) {
        tags = {};
      } else {
        if (
          receipt.sha256 !== request.expectedContentSha256 ||
          receipt.bytes !== request.expectedContentBytes
        ) {
          throw new Error('Verified metadata receipt does not match the preview content');
        }
        tags = receipt.tags;
      }
    } else {
      try {
        tags = await this.adapter.readRaw(extractionPath, request.signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Metadata read failed: ${message}`);
        tags = {};
      }
      throwIfAborted(request.signal);
    }
    const candidates: DateCandidateInput[] = [];

    const addCandidate = (
      tag: string,
      semantic: DateSemantic,
      sourceKind: SourceKind,
      sourceFamily: string,
      rawValue: JsonValue,
      value: ParsedDateValue
    ) => {
      candidates.push({
        id: `${request.fileId}:${candidates.length.toString().padStart(3, '0')}:${tag}`,
        fileId: request.fileId,
        mediaKind: request.mediaKind,
        semantic,
        sourceKind,
        sourceFamily,
        tag,
        rawValue,
        value,
      });
    };

    for (const rule of rulesFor(request.mediaKind)) {
      const raw = tags[rule.tag];
      const offset = rule.offsetTag ? tags[rule.offsetTag] : undefined;
      const subsecond = rule.subsecondTag ? tags[rule.subsecondTag] : undefined;
      const value = parseDateValue(raw, offset, subsecond, rule.specDefinedUtc);
      if (!value || raw === undefined) continue;

      const hasCompanions = offset !== undefined || subsecond !== undefined;
      const rawValue: JsonValue = hasCompanions
        ? {
            value: raw as JsonValue,
            ...(offset !== undefined ? { offset: offset as JsonValue } : {}),
            ...(subsecond !== undefined ? { subsecond: subsecond as JsonValue } : {}),
          }
        : (raw as JsonValue);
      addCandidate(rule.tag, rule.semantic, rule.sourceKind, rule.sourceFamily, rawValue, value);
    }

    if (request.mediaKind === 'video') {
      for (const [tag, raw] of Object.entries(tags)) {
        const match = tag.match(/^Track\d+:(MediaCreateDate|TrackCreateDate)$/i);
        if (!match) continue;
        const value = parseDateValue(raw, undefined, undefined, true);
        if (!value || raw === undefined) continue;
        addCandidate(
          tag,
          'container-created',
          'container-stream',
          match[1].toLowerCase() === 'mediacreatedate' ? 'quicktime-media' : 'quicktime-track',
          raw as JsonValue,
          value
        );
      }
    }

    if (request.mediaKind === 'image' || request.mediaKind === 'raw') {
      const createdDate = stringValue(tags['IPTC:DateCreated']);
      const createdTime = stringValue(tags['IPTC:TimeCreated']);
      if (createdDate && createdTime) {
        const value = parseDateValue(`${createdDate}T${createdTime}`);
        if (value) {
          addCandidate(
            'IPTC:DateCreated',
            'capture',
            'embedded-iptc',
            'iptc',
            {
              date: createdDate,
              dateTag: 'IPTC:DateCreated',
              time: createdTime,
              timeTag: 'IPTC:TimeCreated',
            },
            value
          );
        }
      }

      const gpsDate = stringValue(tags['GPS:GPSDateStamp']);
      const gpsTime = stringValue(tags['GPS:GPSTimeStamp']);
      if (gpsDate && gpsTime) {
        const value = parseDateValue(`${gpsDate}T${gpsTime}`, undefined, undefined, true);
        if (value) {
          addCandidate(
            'GPS:GPSDateStamp+GPS:GPSTimeStamp',
            'capture',
            'embedded-exif',
            'gps',
            {
              date: gpsDate,
              dateTag: 'GPS:GPSDateStamp',
              time: gpsTime,
              timeTag: 'GPS:GPSTimeStamp',
            },
            value
          );
        }
      }

      const digitalDate = stringValue(tags['IPTC:DigitalCreationDate']);
      const digitalTime = stringValue(tags['IPTC:DigitalCreationTime']);
      if (digitalDate && digitalTime) {
        const value = parseDateValue(`${digitalDate}T${digitalTime}`);
        if (value) {
          addCandidate(
            'IPTC:DigitalCreationDate+IPTC:DigitalCreationTime',
            'digitized',
            'embedded-iptc',
            'iptc-digital',
            {
              date: digitalDate,
              dateTag: 'IPTC:DigitalCreationDate',
              time: digitalTime,
              timeTag: 'IPTC:DigitalCreationTime',
            },
            value
          );
        }
      }

      const pngCreationTime = tags['PNG:CreationTime'];
      const parsedPngCreationTime = parsePngCreationTime(pngCreationTime);
      if (parsedPngCreationTime && pngCreationTime !== undefined) {
        addCandidate(
          'PNG:CreationTime',
          'content-created',
          'container-format',
          'png',
          pngCreationTime as JsonValue,
          parsedPngCreationTime
        );
      }
    }

    if (request.mediaKind === 'audio') {
      for (const pair of BWF_DATE_TIME_PAIRS) {
        const originDate = stringValue(tags[pair.dateTag]);
        const originTime = stringValue(tags[pair.timeTag]);
        if (!originDate || !originTime) continue;

        const value = parseDateValue(`${originDate}T${originTime}`);
        if (value) {
          addCandidate(
            'BWF:OriginationDateTime',
            'recording',
            'audio-tag',
            'bwf',
            {
              date: originDate,
              dateTag: pair.dateTag,
              time: originTime,
              timeTag: pair.timeTag,
            },
            value
          );
        }
      }
    }

    const basename = path.basename(request.filePath);
    const claimedDate = filenameDate(basename);
    if (claimedDate) {
      addCandidate(
        `filename:${basename}`,
        'filename-claim',
        'filename',
        claimedDate.value.precision === 'date'
          ? 'filename-date-only'
          : screenshotFilename(basename)
            ? 'screenshot-filename'
            : 'filename',
        claimedDate.raw,
        claimedDate.value
      );
    }

    const requireCanonicalUtc = (value: string, label: string): string => {
      const parsed = new Date(value);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`Inventoried filesystem ${label} must be a canonical UTC timestamp`);
      }
      return value;
    };

    let birthtime: string | null;
    if ('filesystemBirthTimeUtc' in request) {
      birthtime = request.filesystemBirthTimeUtc ?? null;
      if (birthtime !== null) requireCanonicalUtc(birthtime, 'birth time');
    } else {
      const fileStats = await this.statReader(request.filePath);
      birthtime = Number.isFinite(fileStats.birthtime.getTime())
        ? fileStats.birthtime.toISOString()
        : null;
    }
    if (birthtime !== null) {
      addCandidate(
        'FileSystem:BirthTime',
        'filesystem-birth',
        'filesystem',
        'filesystem-birth',
        birthtime,
        {
          localIso: birthtime.slice(0, -1),
          instantUtc: birthtime,
          zoneBasis: 'spec-defined-utc',
          precision: 'millisecond',
          fractionalDigits: birthtime.slice(20, 23),
        }
      );
    }

    const detectedScreenshot = screenshotEvidence(request.filePath, request.mediaKind, tags);
    return {
      candidates,
      warnings,
      ...(detectedScreenshot === undefined ? {} : { screenshotEvidence: detectedScreenshot }),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.adapter.close();
  }
}
