import path from 'path';

import type { ParsedDateValue } from '../date';

export type MetadataFormatFamily = 'jpeg' | 'heic' | 'png' | 'quicktime' | 'audio';

export interface MetadataTagAssignment {
  tag: string;
  value: string;
}

export interface MetadataNormalizationPlan {
  family: MetadataFormatFamily;
  assignments: readonly MetadataTagAssignment[];
}

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.heic',
  '.heif',
  '.png',
  '.mov',
  '.mp4',
  '.m4v',
  '.3gp',
  '.3g2',
  '.wav',
  '.bwf',
  '.mp3',
  '.m4a',
  '.aac',
]);

export function isMetadataNormalizationSupported(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function localTimestamp(value: ParsedDateValue): string {
  const match = value.localIso.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/
  );
  if (!match) throw new Error('Selected creation date is not a canonical local timestamp');
  const base = `${match[1]}:${match[2]}:${match[3]} ${match[4] ?? '00'}:${match[5] ?? '00'}:${match[6] ?? '00'}`;
  const fraction = match[7] ? `.${match[7]}` : '';
  return `${base}${fraction}`;
}

function offsetTimestamp(value: ParsedDateValue): string | undefined {
  if (value.offsetMinutes === undefined) return undefined;
  if (!Number.isInteger(value.offsetMinutes) || Math.abs(value.offsetMinutes) > 14 * 60) {
    throw new Error('Selected creation date has an invalid UTC offset');
  }
  const sign = value.offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(value.offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function utcContainerTimestamp(value: ParsedDateValue): string {
  if (value.instantUtc === undefined) {
    throw new Error('UTC container metadata requires a resolved UTC instant');
  }
  const match = value.instantUtc.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/
  );
  if (!match) throw new Error('Selected creation date has an invalid UTC instant');
  return `${match[1]}:${match[2]}:${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function assignment(tag: string, value: string): MetadataTagAssignment {
  return Object.freeze({ tag, value });
}

export function buildMetadataNormalizationPlan(
  filePath: string,
  selectedDate: ParsedDateValue
): MetadataNormalizationPlan {
  if (selectedDate.precision === 'date' || selectedDate.zoneBasis === 'date-only') {
    throw new Error('A calendar date with unknown time must not be written into timed metadata');
  }
  const extension = path.extname(filePath).toLowerCase();
  const local = localTimestamp(selectedDate);
  const offset = offsetTimestamp(selectedDate);
  const date = local.slice(0, 10);
  const time = local.slice(11);
  let family: MetadataFormatFamily;
  let assignments: MetadataTagAssignment[];

  if (extension === '.jpg' || extension === '.jpeg') {
    family = 'jpeg';
    assignments = [
      assignment('ExifIFD:DateTimeOriginal', local),
      assignment('ExifIFD:CreateDate', local),
      ...(offset === undefined
        ? []
        : [
            assignment('ExifIFD:OffsetTimeOriginal', offset),
            assignment('ExifIFD:OffsetTimeDigitized', offset),
          ]),
      assignment('XMP-exif:DateTimeOriginal', local),
      assignment('XMP-photoshop:DateCreated', local),
      assignment('XMP-xmp:CreateDate', local),
      assignment('IPTC:DateCreated', date),
    ];
  } else if (extension === '.heic' || extension === '.heif') {
    family = 'heic';
    assignments = [
      assignment('ExifIFD:DateTimeOriginal', local),
      assignment('ExifIFD:CreateDate', local),
      ...(offset === undefined
        ? []
        : [
            assignment('ExifIFD:OffsetTimeOriginal', offset),
            assignment('ExifIFD:OffsetTimeDigitized', offset),
          ]),
      assignment('XMP-exif:DateTimeOriginal', local),
      assignment('XMP-xmp:CreateDate', local),
    ];
  } else if (extension === '.png') {
    family = 'png';
    assignments = [assignment('PNG:CreateDate', local), assignment('XMP-xmp:CreateDate', local)];
  } else if (['.mov', '.mp4', '.m4v', '.3gp', '.3g2'].includes(extension)) {
    family = 'quicktime';
    const utc = utcContainerTimestamp(selectedDate);
    assignments = [
      assignment('QuickTime:CreateDate', utc),
      assignment('QuickTime:TrackCreateDate', utc),
      assignment('QuickTime:MediaCreateDate', utc),
    ];
  } else if (extension === '.wav' || extension === '.bwf') {
    family = 'audio';
    assignments = [
      assignment('RIFF:OriginationDate', date),
      assignment('RIFF:OriginationTime', time),
    ];
  } else if (extension === '.mp3') {
    family = 'audio';
    assignments = [assignment('ID3v2_4:TDRC', local)];
  } else if (extension === '.m4a' || extension === '.aac') {
    family = 'audio';
    const utc = utcContainerTimestamp(selectedDate);
    assignments = [
      assignment('QuickTime:CreateDate', utc),
      assignment('QuickTime:TrackCreateDate', utc),
      assignment('QuickTime:MediaCreateDate', utc),
    ];
  } else {
    throw new Error(
      `File format ${extension || '(none)'} is not supported for metadata normalization`
    );
  }

  return Object.freeze({ family, assignments: Object.freeze(assignments) });
}
