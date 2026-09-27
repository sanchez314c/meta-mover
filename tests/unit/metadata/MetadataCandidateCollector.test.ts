import { Stats } from 'fs';

import {
  ExifToolReadAdapter,
  MetadataCandidateCollector,
  RawExifTags,
} from '../../../src/main/core/metadata/MetadataCandidateCollector';
import { MediaKind, resolveDateCandidates } from '../../../src/main/core/date';

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
  describe('ICC profile timestamp copied into EXIF Original', () => {
    const photoshelter = {
      'File:FileType': 'JPEG',
      'ICC-header:ProfileClass': 'Display Device Profile',
      'ICC-header:ProfileCreator': 'Adobe Systems Inc.',
      'IFD0:Software': 'Photoshelter http://www.photoshelter.com',
      'ExifIFD:DateTimeOriginal': '1999:06:03 00:00:00',
      'ICC-header:ProfileDateTime': '1999:06:03 00:00:00',
      'ExifIFD:CreateDate': '2025:08:16 19:40:48',
      'XMP-xmp:CreateDate': '2025:08:16 19:40:48',
      'IPTC:DateCreated': '2012:10:11',
      'IPTC:DigitalCreationDate': '2012:10:11',
      'XMP-photoshop:DateCreated': '2012:10:11 06:49:49',
    } satisfies RawExifTags;

    it('recovers the corroborated calendar day without assuming the Photoshop clock', async () => {
      const result = await resolveImage('2025-08-16_19-40-48_01.jpeg', photoshelter);
      expect(result).toMatchObject({
        status: 'resolved',
        selectedValue: { localIso: '2012-10-11', precision: 'date', zoneBasis: 'date-only' },
      });
      expect(result.reasonCodes).toContain('ICC_EXIF_ORIGINAL_CONTAMINATION_RECOVERY');
    });

    it('recovers a whole second only when IPTC time agrees with independent edit clocks', async () => {
      const result = await resolveImage('2025-08-16_20-09-59_01.jpeg', {
        ...photoshelter,
        'IFD0:Software': 'Adobe Photoshop CS5 Macintosh',
        'ExifIFD:CreateDate': '2025:08:16 20:09:59',
        'XMP-xmp:CreateDate': '2025:08:16 20:09:59',
        'IPTC:DateCreated': '2012:07:01',
        'IPTC:TimeCreated': '18:31:47+00:00',
        'IPTC:DigitalCreationDate': undefined,
        'XMP-photoshop:DateCreated': '2012:07:01 18:31:47',
        'IFD0:ModifyDate': '2012:07:01 18:31:47',
        'XMP-xmp:ModifyDate': '2012:07:01 18:31:47',
      });
      expect(result).toMatchObject({
        status: 'resolved',
        selectedValue: { localIso: '2012-07-01T18:31:47', precision: 'second' },
      });
      expect(result.reasonCodes).toContain('ICC_EXIF_ORIGINAL_CONTAMINATION_RECOVERY');
    });

    it.each([
      ['missing ICC match', { 'ICC-header:ProfileDateTime': '1999:06:04 00:00:00' }],
      ['discordant IPTC day', { 'IPTC:DateCreated': '2012:10:12' }],
      ['discordant Photoshop day', { 'XMP-photoshop:DateCreated': '2012:10:12 06:49:49' }],
      ['no later rewrite', { 'ExifIFD:CreateDate': '2012:10:11 06:49:49' }],
      ['another creation day', { 'IPTC:DigitalCreationDate': '2012:10:12' }],
      ['conflicting XMP DC date array', { 'XMP-dc:Date': ['2011:01:01'] }],
      ['mixed XMP DC date array', { 'XMP-dc:Date': ['2012:10:11', '2011:01:01'] }],
    ] as const)('keeps review when %s', async (_name, patch) => {
      const result = await resolveImage('2025-08-16_19-40-48_01.jpeg', {
        ...photoshelter,
        ...patch,
      });
      expect(result.reasonCodes).not.toContain('ICC_EXIF_ORIGINAL_CONTAMINATION_RECOVERY');
    });

    const topaz = {
      'File:FileType': 'PNG',
      'PNG:Software': 'Topaz Photo AI 1.2.6',
      'PNG:CreateDate': '2025:08:16 23:47:56',
      'PNG:ModifyDate': '1998:02:09 06:49:00',
      'ICC-header:ProfileClass': 'Display Device Profile',
      'ICC-header:ProfileCreator': 'Hewlett-Packard',
      'ICC-header:ProfileDateTime': '1998:02:09 06:49:00',
      'ExifIFD:DateTimeOriginal': '1998:02:09 06:49:00',
      'IFD0:ModifyDate': '1998:02:09 06:49:00',
      'ExifIFD:CreateDate': '2025:08:16 23:47:56',
      'IPTC:DateCreated': '2013:12:04',
      'IPTC:TimeCreated': '16:59:15-04:00',
      'IPTC:DigitalCreationDate': '2013:12:04',
      'IPTC:DigitalCreationTime': '16:59:15-04:00',
      'XMP-xmpMM:HistoryAction': ['derived', 'saved'],
      'XMP-xmpMM:HistoryWhen': '2013:12:04 23:00:28-05:00',
      'XMP-xmpMM:HistoryParameters':
        'converted from image/x-nikon-nef to image/jpeg, saved to new location',
    } satisfies RawExifTags;
    it('recovers the Topaz export calendar day but does not promote its IPTC time', async () => {
      const result = await resolveImage('2025-08-16_23-47-56.png', topaz);
      expect(result).toMatchObject({
        status: 'resolved',
        selectedValue: { localIso: '2013-12-04', precision: 'date', zoneBasis: 'date-only' },
      });
      expect(result.reasonCodes).toContain('ICC_EXIF_ORIGINAL_CONTAMINATION_RECOVERY');
    });
    it.each([
      ['no ICC match', { 'ICC-header:ProfileDateTime': undefined }],
      ['digital time differs', { 'IPTC:DigitalCreationTime': '16:59:16-04:00' }],
      ['history absent', { 'XMP-xmpMM:HistoryWhen': undefined }],
      ['different export date', { 'PNG:CreateDate': '2025:08:17 23:47:56' }],
    ] as const)('keeps Topaz review when %s', async (_name, patch) => {
      const result = await resolveImage('2025-08-16_23-47-56.png', { ...topaz, ...patch });
      expect(result.reasonCodes).not.toContain('ICC_EXIF_ORIGINAL_CONTAMINATION_RECOVERY');
    });
    it('does not recover a Photos export with no matching ICC profile', async () => {
      const result = await resolveImage('2026-01-21_21-59-51_02.jpeg', {
        'File:FileType': 'JPEG',
        'IFD0:Software': 'Photos 1.0.1',
        'ExifIFD:DateTimeOriginal': '1998:02:09 06:49:00',
        'ExifIFD:CreateDate': '2026:01:21 21:59:51',
        'IPTC:DateCreated': '2013:05:05',
        'IPTC:TimeCreated': '22:50:42-05:00',
      });
      expect(result.reasonCodes).not.toContain('ICC_EXIF_ORIGINAL_CONTAMINATION_RECOVERY');
    });
  });
  describe('audited D2X shoot day and Display P3 screenshot day', () => {
    const d2x = {
      'IFD0:Make': 'NIKON CORPORATION',
      'IFD0:Model': 'NIKON D2X',
      'IFD0:ModifyDate': '2006:02:08 14:40:24',
      'ExifIFD:DateTimeOriginal': '2003:07:01 00:00:00',
      'ExifIFD:CreateDate': '2003:07:01 00:00:00',
      'ICC-header:ProfileDateTime': '2003:07:01 00:00:00',
      'IPTC:DateCreated': '2006:02:08',
      'IPTC:TimeCreated': '14:40:24-05:00',
      'IPTC:ObjectName': 'raw_LeticiaJoeBoxer020806',
      'IPTC:Caption-Abstract':
        'RICK WILSON/Rick Wilson Photography--2/8/06-- Leticia Cline Joe Boxer shoot at The Carling in Jacksonville, Fl. Wednesday February 8, 2006.',
    } satisfies RawExifTags;
    it('recovers the 2006 D2X shoot time at whole-second precision', async () => {
      const result = await resolveImage('2003-07-01_00-00-00.000024_07.jpeg', d2x);
      expect(result).toMatchObject({
        status: 'resolved',
        selectedValue: {
          localIso: '2006-02-08T14:40:24',
          precision: 'second',
          zoneBasis: 'explicit-offset',
        },
      });
      expect(result.reasonCodes).toContain('NIKON_D2X_SHOOT_TIME_RECOVERY');
    });
    it.each([
      ['different camera', { 'IFD0:Model': 'NIKON D200' }],
      ['different caption day', { 'IPTC:Caption-Abstract': 'shoot 2/9/06' }],
      ['different object name', { 'IPTC:ObjectName': 'raw_LeticiaJoeBoxer020906' }],
      ['different edit time', { 'IFD0:ModifyDate': '2006:02:08 14:40:25' }],
      ['different ICC day', { 'ICC-header:ProfileDateTime': '2003:07:02 00:00:00' }],
      ['discordant XMP', { 'XMP-photoshop:DateCreated': '2005:02:08 14:40:24' }],
    ] as const)('does not recover D2X with %s', async (_name, patch) => {
      const result = await resolveImage('2003-07-01_00-00-00.000024_07.jpeg', { ...d2x, ...patch });
      expect(result.reasonCodes).not.toContain('NIKON_D2X_SHOOT_TIME_RECOVERY');
    });
    const png = {
      'PNG:CreateDate': '2024:03:23 12:36:46',
      'PNG:ModifyDate': '2023:07:22 03:44:56',
      'ICC-header:ProfileDateTime': '2022:01:01 00:00:00',
      'ICC-header:ProfileCreator': 'Apple Computer Inc.',
      'PNG:ProfileName': 'kCGColorSpaceDisplayP3',
      'XMP-exif:UserComment': 'Screenshot',
      'XMP-photoshop:DateCreated': '2023:07:22 03:44:56',
    } satisfies RawExifTags;
    it('recovers the corroborated screenshot day without borrowing a time zone', async () => {
      const result = await resolveImage('2024-03-23_12-36-46_01.png', png);
      expect(result).toMatchObject({
        status: 'resolved',
        selectedValue: { localIso: '2023-07-22', precision: 'date', zoneBasis: 'date-only' },
      });
      expect(result.reasonCodes).toContain('DISPLAY_P3_SCREENSHOT_DAY_RECOVERY');
    });
    it.each([
      ['different comment', { 'XMP-exif:UserComment': 'Photo' }],
      ['different PNG modified', { 'PNG:ModifyDate': '2023:07:23 03:44:56' }],
      ['different ICC date', { 'ICC-header:ProfileDateTime': '2023:01:01 00:00:00' }],
      ['different profile', { 'PNG:ProfileName': 'Other' }],
      ['earlier PNG created', { 'PNG:CreateDate': '2023:03:23 12:36:46' }],
    ] as const)('does not recover screenshot with %s', async (_name, patch) => {
      const result = await resolveImage('2024-03-23_12-36-46_01.png', { ...png, ...patch });
      expect(result.reasonCodes).not.toContain('DISPLAY_P3_SCREENSHOT_DAY_RECOVERY');
    });
  });
  describe('Nikon D40 Photoshop CS5 rewrite', () => {
    const base = {
      'IFD0:Make': 'NIKON CORPORATION',
      'IFD0:Model': 'NIKON D40',
      'IFD0:Software': 'Adobe Photoshop CS5 Windows',
      'IFD0:ModifyDate': '2013:05:05 20:32:36',
      'ExifIFD:DateTimeOriginal': '2026:01:21 21:59:16',
      'ExifIFD:CreateDate': '2026:01:21 21:59:16',
      'XMP-xmp:CreateDate': '2026:01:21 21:59:16',
      'IPTC:DateCreated': '2013:05:05',
      'IPTC:TimeCreated': '20:32:36+00:00',
      'XMP-photoshop:DateCreated': '2013:05:05 20:32:36.007',
      'XMP-xmp:ModifyDate': '2013:05:05 20:32:36',
      'XMP-xmp:MetadataDate': '2013:05:13 19:30:18-04:00',
      'XMP-xmpMM:HistoryWhen': ['2013:05:13 19:30:18-04:00', '2013:05:13 19:30:18-04:00'],
      'XMP-xmpMM:HistoryAction': ['saved', 'saved'],
      'XMP-xmpMM:HistorySoftwareAgent': [
        'Adobe Photoshop CS5 Windows',
        'Adobe Photoshop CS5 Windows',
      ],
      'XMP-dc:Title': '2013-05-05_20-32-36-000070-1',
    } satisfies RawExifTags;

    it('selects the corroborated 2013 whole-second capture time', async () => {
      const result = await resolveImage('2026-01-21_21-59-16.000070_01.jpeg', base);
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedValue: { localIso: '2013-05-05T20:32:36', precision: 'second' },
      });
      expect(result.reasonCodes).toContain('NIKON_D40_PHOTOSHOP_REWRITE_RECOVERY');
    });

    it('accepts only the audited 1998 EXIF original sentinel when creation evidence agrees', async () => {
      const result = await resolveImage('2026-01-21_21-59-16.000070_01.jpeg', {
        ...base,
        'ExifIFD:DateTimeOriginal': '1998:02:09 06:49:00',
      });
      expect(result.reasonCodes).toContain('NIKON_D40_PHOTOSHOP_REWRITE_RECOVERY');
    });

    it('accepts a valid minute-precision Photoshop save history', async () => {
      const result = await resolveImage('2026-01-21_21-59-16.000070_01.jpeg', {
        ...base,
        'XMP-xmp:MetadataDate': '2013:05:13 19:30-04:00',
        'XMP-xmpMM:HistoryWhen': ['2013:05:13 19:30-04:00', '2013:05:13 19:30-04:00'],
      });
      expect(result.reasonCodes).toContain('NIKON_D40_PHOTOSHOP_REWRITE_RECOVERY');
    });

    it.each([
      ['different camera', { 'IFD0:Model': 'NIKON D50' }],
      ['different software', { 'IFD0:Software': 'Adobe Photoshop CC' }],
      ['different IPTC time', { 'IPTC:TimeCreated': '20:32:37+00:00' }],
      ['different Photoshop day', { 'XMP-photoshop:DateCreated': '2012:05:05 20:32:36' }],
      ['different Photoshop instant', { 'XMP-photoshop:DateCreated': '2013:05:05 20:32:36-05:00' }],
      ['different EXIF day', { 'ExifIFD:DateTimeOriginal': '2025:01:21 21:59:16' }],
      ['different history day', { 'XMP-xmpMM:HistoryWhen': ['2012:05:13 19:30:18-04:00'] }],
      ['missing history', { 'XMP-xmpMM:HistoryWhen': undefined }],
      [
        'malformed history time',
        { 'XMP-xmpMM:HistoryWhen': ['2013:05:13 99:99:99-04:00', '2013:05:13 99:99:99-04:00'] },
      ],
      [
        'rolled-over history day',
        {
          'XMP-xmpMM:HistoryWhen': ['2013:05:13 24:00:00-04:00', '2013:05:13 24:00:00-04:00'],
          'XMP-xmp:MetadataDate': '2013:05:13 24:00:00-04:00',
        },
      ],
    ] as const)('does not recover with %s', async (_label, changes) => {
      const result = await resolveImage('2026-01-21_21-59-16.000070_01.jpeg', {
        ...base,
        ...changes,
      });
      expect(result.reasonCodes).not.toContain('NIKON_D40_PHOTOSHOP_REWRITE_RECOVERY');
    });

    it('holds the rewritten 2026 date for review without IPTC or Photoshop creation', async () => {
      const result = await resolveImage('2026-01-21_21-59-16.jpeg', {
        ...base,
        'IPTC:DateCreated': undefined,
        'IPTC:TimeCreated': undefined,
        'XMP-photoshop:DateCreated': undefined,
      });
      expect(result.status).not.toBe('resolved');
      expect(result.reasonCodes).toContain('NIKON_D40_REWRITE_CAPTURE_UNKNOWN');
    });

    it('does not use unrelated titles to veto an EXIF original', async () => {
      const result = await resolveImage('2026-01-21_21-59-16.jpeg', {
        ...base,
        'IPTC:DateCreated': undefined,
        'IPTC:TimeCreated': undefined,
        'XMP-photoshop:DateCreated': undefined,
        'XMP-dc:Title': 'unrelated',
      });
      expect(result.reasonCodes).not.toContain('NIKON_D40_REWRITE_CAPTURE_UNKNOWN');
    });
  });

  describe('Nikon RAW history capture-day recovery', () => {
    const base = {
      'IFD0:Make': 'NIKON CORPORATION',
      'IFD0:Model': 'NIKON D800E',
      'IFD0:Software': 'Adobe Photoshop CC (Macintosh)',
      'IFD0:ModifyDate': '2013:12:03 09:58:21',
      'ExifIFD:DateTimeOriginal': '2013:12:05 16:07:31',
      'ExifIFD:CreateDate': '2013:12:05 16:07:31',
      'IPTC:DateCreated': '2013:12:03',
      'IPTC:TimeCreated': '09:58:21+00:00',
      'IPTC:DigitalCreationDate': '2013:12:03',
      'XMP-photoshop:DateCreated': '2013:12:03 09:58:21.003',
      'XMP-xmp:ModifyDate': '2013:12:03 09:58:21',
      'XMP-xmp:CreateDate': '2013:12:05 16:07:31',
      'XMP-xmp:MetadataDate': '2013:12:05 16:07:31-05:00',
      'XMP-xmpMM:HistoryWhen': ['2013:12:03 21:03:43-05:00', '2013:12:05 16:07:31-05:00'],
      'XMP-xmpMM:HistorySoftwareAgent': [
        'Adobe Photoshop Lightroom 5.0 (Macintosh)',
        'Adobe Photoshop CC (Macintosh)',
      ],
      'XMP-xmpMM:HistoryAction': ['derived', 'saved', 'converted', 'saved'],
      'XMP-xmpMM:HistoryParameters': [
        'converted from image/x-nikon-nef to image/tiff, saved to new location',
        'converted from application/vnd.adobe.photoshop to image/jpeg',
      ],
    } satisfies RawExifTags;

    it('keeps the Nikon original capture calendar day without borrowing later JPEG time', async () => {
      const result = await resolveImage('2013-12-05_16-07-31.jpeg', base);
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedValue: { localIso: '2013-12-03', zoneBasis: 'date-only', precision: 'date' },
      });
      expect(result.reasonCodes).toContain('NIKON_RAW_HISTORY_CAPTURE_DAY_RECOVERY');
      expect(result.reasonCodes).toContain('RESOLVED_DATE_ONLY');
    });

    it.each([
      ['wrong camera', { 'IFD0:Model': 'NIKON D810' }],
      ['missing history', { 'XMP-xmpMM:HistoryWhen': undefined }],
      [
        'misaligned history',
        { 'XMP-xmpMM:HistorySoftwareAgent': ['Adobe Photoshop CC (Macintosh)'] },
      ],
      [
        'missing RAW derivation',
        { 'XMP-xmpMM:HistoryParameters': ['converted from image/tiff to image/jpeg'] },
      ],
      [
        'wrong first history day',
        { 'XMP-xmpMM:HistoryWhen': ['2013:12:02 21:03:43-05:00', '2013:12:05 16:07:31-05:00'] },
      ],
      [
        'wrong last save',
        { 'XMP-xmpMM:HistoryWhen': ['2013:12:03 21:03:43-05:00', '2013:12:05 16:07:30-05:00'] },
      ],
      ['different Photoshop day', { 'XMP-photoshop:DateCreated': '2013:12:02 09:58:21' }],
      [
        'impossible editorial time',
        {
          'IFD0:ModifyDate': '2013:12:03 99:99:99',
          'IPTC:TimeCreated': '99:99:99+00:00',
          'XMP-photoshop:DateCreated': '2013:12:03 99:99:99.003',
          'XMP-xmp:ModifyDate': '2013:12:03 99:99:99',
        },
      ],
      [
        'impossible saved time',
        {
          'ExifIFD:DateTimeOriginal': '2013:12:05 99:99:99',
          'ExifIFD:CreateDate': '2013:12:05 99:99:99',
          'XMP-xmp:CreateDate': '2013:12:05 99:99:99',
          'XMP-xmp:MetadataDate': '2013:12:05 99:99:99-05:00',
          'XMP-xmpMM:HistoryWhen': ['2013:12:03 21:03:43-05:00', '2013:12:05 99:99:99-05:00'],
        },
      ],
      ['extra capture date', { 'XMP-exif:DateTimeOriginal': '2012:12:03 09:58:21' }],
    ] as const)('vetoes %s', async (_label, changes) => {
      const result = await resolveImage('2013-12-05_16-07-31.jpeg', { ...base, ...changes });
      expect(result.reasonCodes).not.toContain('NIKON_RAW_HISTORY_CAPTURE_DAY_RECOVERY');
    });
  });

  it('exposes a verified raw review read through the owned adapter and rejects after close', async () => {
    const signal = new AbortController().signal;
    const receipt = {
      tags: { 'IFD0:ModifyDate': '2022:12:12 00:00:00' },
      sha256: 'a'.repeat(64),
      bytes: 12,
    };
    const readRawVerified = jest.fn(async () => receipt);
    const collector = new MetadataCandidateCollector({
      readRaw: jest.fn(),
      readRawVerified,
      close: jest.fn(),
    });
    await expect(collector.readRawVerifiedForReview('/output/photo.jpg', signal)).resolves.toBe(
      receipt
    );
    expect(readRawVerified).toHaveBeenCalledWith('/output/photo.jpg', signal);
    await collector.close();
    await expect(collector.readRawVerifiedForReview('/output/photo.jpg', signal)).rejects.toThrow(
      /closed/
    );
  });
  describe('Getty original-name recovery from a 2022 rewrite', () => {
    const base = {
      'ExifIFD:DateTimeOriginal': '2022:12:12 01:15:12',
      'ExifIFD:CreateDate': '2022:12:12 01:15:12',
      'XMP-xmp:CreateDate': '2022:12:12 01:15:12',
      'IFD0:ModifyDate': '2022:12:12 01:15:12',
      'XMP-photoshop:DateCreated': '2015:02:21 16:30:42-05:00',
      'IPTC:DateCreated': '2015:02:21',
      'IPTC:TimeCreated': '16:30:42-05:00',
      'XMP-getty:OriginalFileName': '2015-02-21_16-30-42d.jpg',
    } satisfies RawExifTags;

    it('recovers the editorial time when the original name agrees and omits unsupported fractions', async () => {
      const result = await resolveImage('2022-12-12_01-15-12_21.jpeg', {
        ...base,
        'XMP-photoshop:DateCreated': '2015:02:21 16:30:42.000123-05:00',
      });
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedValue: { localIso: '2015-02-21T16:30:42', precision: 'second' },
      });
      expect(result.reasonCodes).toContain('ORIGINAL_NAME_2022_REWRITE_RECOVERY');
    });

    it('accepts the audited original-name letter suffix used by rewritten files', async () => {
      const result = await resolveImage('2022-12-12_01-05-49_02.jpeg', {
        ...base,
        'ExifIFD:DateTimeOriginal': '2022:12:12 01:05:49',
        'ExifIFD:CreateDate': '2022:12:12 01:05:49',
        'XMP-xmp:CreateDate': '2022:12:12 01:05:49',
        'IFD0:ModifyDate': '2022:12:12 01:05:49',
        'XMP-photoshop:DateCreated': '2017:09:07 15:04:12-05:00',
        'IPTC:DateCreated': '2017:09:07',
        'IPTC:TimeCreated': '15:04:12-05:00',
        'XMP-getty:OriginalFileName': '2017-09-07_15-04-12dab.jpg',
      });
      expect(result.reasonCodes).toContain('ORIGINAL_NAME_2022_REWRITE_RECOVERY');
    });

    it.each([
      ['missing name', { 'XMP-getty:OriginalFileName': undefined }],
      ['different name time', { 'XMP-getty:OriginalFileName': '2015-02-21_16-30-43d.jpg' }],
      ['different IPTC time', { 'IPTC:TimeCreated': '16:30:43-05:00' }],
      ['nonbatch EXIF date', { 'ExifIFD:DateTimeOriginal': '2022:12:13 01:15:12' }],
      [
        'same-day noon rewrite outside the audited interval',
        {
          'ExifIFD:DateTimeOriginal': '2022:12:12 12:15:12',
          'ExifIFD:CreateDate': '2022:12:12 12:15:12',
          'XMP-xmp:CreateDate': '2022:12:12 12:15:12',
          'IFD0:ModifyDate': '2022:12:12 12:15:12',
        },
      ],
      ['other creation date', { 'XMP-exif:DateTimeOriginal': '2016:02:21 16:30:42' }],
      [
        'additional digital creation contender',
        {
          'IPTC:DigitalCreationDate': '2014:05:01',
          'IPTC:DigitalCreationTime': '12:00:00-05:00',
        },
      ],
      [
        'conflicting GPS creation contender',
        {
          'GPS:GPSDateStamp': '2018:01:01',
          'GPS:GPSTimeStamp': '12:00:00',
        },
      ],
    ] as const)('does not recover %s', async (_label, change) => {
      const result = await resolveImage('2022-12-12_01-15-12_21.jpeg', { ...base, ...change });
      expect(result.reasonCodes).not.toContain('ORIGINAL_NAME_2022_REWRITE_RECOVERY');
    });
  });

  async function resolveImage(filename: string, tags: RawExifTags) {
    const collector = new MetadataCandidateCollector(new FakeExifToolAdapter(tags), async () => ({
      birthtime: new Date(Number.NaN),
    }));
    const candidates = await collector.collect({
      fileId: 'sha256:narrow-recovery',
      filePath: `/media/${filename}`,
      filesystemBirthTimeUtc: null,
      mediaKind: 'image',
    });
    await collector.close();
    return resolveDateCandidates({
      fileId: 'sha256:narrow-recovery',
      mediaKind: 'image',
      evaluationTimeUtc: '2026-09-23T12:00:00.000Z',
      candidates,
    });
  }

  describe('audited iPhone 5 GPS capture recovery', () => {
    const base = {
      'IFD0:Make': 'Apple',
      'IFD0:Model': 'iPhone 5',
      'IFD0:Software': 'QuickTime 7.7.1',
      'IFD0:ModifyDate': '2013:04:28 10:15:50',
      'ExifIFD:DateTimeOriginal': '1998:02:09 06:49:00',
      'ExifIFD:CreateDate': '2025:08:16 19:42:28',
      'GPS:GPSTimeStamp': '14:15:49.23',
      'GPS:GPSLatitude': '28 deg 33\' 52.80"',
      'GPS:GPSLatitudeRef': 'North',
      'GPS:GPSLongitude': '81 deg 22\' 17.40"',
      'GPS:GPSLongitudeRef': 'West',
    } satisfies RawExifTags;

    it('selects the GPS-corroborated whole-second 2013 local capture date at medium confidence', async () => {
      const result = await resolveImage('2025-08-16_19-42-28.jpeg', base);
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedValue: { localIso: '2013-04-28T10:15:50', precision: 'second' },
      });
      expect(result.reasonCodes).toContain('IPHONE5_GPS_LOCAL_CAPTURE_RECOVERY');
      expect(result.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tag: 'Apple:GPSLocalCapture',
            semantic: 'capture',
            sourceFamily: 'iphone5-gps-corroborated',
          }),
        ])
      );
    });

    it('rejects forged raw GPS evidence and a conflicting sidecar in the resolver', async () => {
      const observed = await resolveImage('2025-08-16_19-42-28.jpeg', base);
      const forged = observed.candidates.map((candidate) =>
        candidate.tag === 'Apple:GPSLocalCapture'
          ? {
              ...candidate,
              rawValue: { ...(candidate.rawValue as Record<string, string>), gpsTime: '14:15:45' },
            }
          : candidate
      );
      const resolve = (candidates: typeof forged) =>
        resolveDateCandidates({
          fileId: 'sha256:narrow-recovery',
          mediaKind: 'image',
          evaluationTimeUtc: '2026-09-23T12:00:00.000Z',
          candidates,
        });
      expect(resolve(forged).reasonCodes).not.toContain('IPHONE5_GPS_LOCAL_CAPTURE_RECOVERY');
      expect(
        resolve([
          ...observed.candidates,
          {
            ...observed.candidates[0],
            id: 'sidecar-conflict',
            semantic: 'sidecar-claim',
            sourceKind: 'sidecar',
            sourceFamily: 'sidecar',
            tag: 'sidecar:DateTimeOriginal',
            value: {
              localIso: '2014-01-02T03:04:05',
              zoneBasis: 'floating-local',
              precision: 'second',
            },
          },
        ]).reasonCodes
      ).not.toContain('IPHONE5_GPS_LOCAL_CAPTURE_RECOVERY');
    });

    it.each([
      ['wrong model', { 'IFD0:Model': 'iPhone 6' }],
      ['wrong software', { 'IFD0:Software': 'Other' }],
      ['different original', { 'ExifIFD:DateTimeOriginal': '1998:02:10 06:49:00' }],
      ['different rewrite day', { 'ExifIFD:CreateDate': '2025:08:17 19:42:28' }],
      ['missing GPS time', { 'GPS:GPSTimeStamp': undefined }],
      ['GPS date present', { 'GPS:GPSDateStamp': '2013:04:28' }],
      ['GPS mismatch', { 'GPS:GPSTimeStamp': '14:15:45.00' }],
      [
        'GPS day rollover',
        { 'IFD0:ModifyDate': '2013:04:28 21:15:50', 'GPS:GPSTimeStamp': '01:15:49.23' },
      ],
      ['wrong zone', { 'GPS:GPSLongitude': '118 deg 14\' 12.40"' }],
      ['malformed local date', { 'IFD0:ModifyDate': '2013:13:28 10:15:50' }],
      [
        'midnight local date',
        { 'IFD0:ModifyDate': '2013:04:28 00:00:00', 'GPS:GPSTimeStamp': '04:00:00' },
      ],
      ['outside 2013 spring', { 'IFD0:ModifyDate': '2013:12:28 10:15:50' }],
      ['conflicting IPTC date', { 'IPTC:DateCreated': '2014:01:02' }],
      ['conflicting XMP date', { 'XMP-photoshop:DateCreated': '2014:01:02 03:04:05' }],
    ] as const)('keeps %s in review', async (_label, change) => {
      const result = await resolveImage('2025-08-16_19-42-28.jpeg', { ...base, ...change });
      expect(result.reasonCodes).not.toContain('IPHONE5_GPS_LOCAL_CAPTURE_RECOVERY');
    });
  });

  describe('audited narrow metadata recoveries', () => {
    const pngTags = {
      'PNG:CreateDate': '2024:03:23 12:36:30',
      'PNG:ModifyDate': '2023:01:05 19:53:38',
      'System:FileModifyDate': '2024:03:23 08:36:30-04:00',
      'XMP-photoshop:DateCreated': '2023:01:05 19:53:38',
    } satisfies RawExifTags;

    it('selects native PNG CreateDate when the screenshot, file instant, and older edit pair agree', async () => {
      const result = await resolveImage('2024-03-23_12-36-30-screen-shot.png', pngTags);
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedValue: { localIso: '2024-03-23T12:36:30' },
      });
      expect(result.reasonCodes).toContain('PNG_SCREENSHOT_NATIVE_DATE_RECOVERY');
      expect(result.candidates.find((item) => item.id === result.selectedCandidateId)?.tag).toBe(
        'PNG:CreateDate'
      );
    });

    it('accepts the exact Apple Display P3 screenshot signature over a 2022 PNG placeholder', async () => {
      const result = await resolveImage('2024-03-23_12-36-30-screen-shot.png', {
        ...pngTags,
        'PNG:ModifyDate': '2022:01:01 00:00:00',
        'XMP-photoshop:DateCreated': '2023:01:05 19:53:38',
        'ICC-header:ProfileCreator': 'Apple Computer Inc.',
        'PNG:ProfileName': 'kCGColorSpaceDisplayP3',
        'PNG:ImageWidth': 1170,
        'PNG:ImageHeight': 2532,
      });
      expect(result.reasonCodes).toContain('PNG_SCREENSHOT_NATIVE_DATE_RECOVERY');
    });

    it.each([
      ['altered profile creator', { 'ICC-header:ProfileCreator': 'Other Inc.' }],
      ['altered profile name', { 'PNG:ProfileName': 'Display P3' }],
      ['altered dimensions', { 'PNG:ImageWidth': 1169 }],
      ['newer embedded content date', { 'XMP-photoshop:DateCreated': '2025:01:05 19:53:38' }],
    ] as const)('rejects the 2022 PNG placeholder with %s', async (_name, changed) => {
      const result = await resolveImage('2024-03-23_12-36-30-screen-shot.png', {
        ...pngTags,
        'PNG:ModifyDate': '2022:01:01 00:00:00',
        'XMP-photoshop:DateCreated': '2023:01:05 19:53:38',
        'ICC-header:ProfileCreator': 'Apple Computer Inc.',
        'PNG:ProfileName': 'kCGColorSpaceDisplayP3',
        'PNG:ImageWidth': 1170,
        'PNG:ImageHeight': 2532,
        ...changed,
      });
      expect(result.reasonCodes).not.toContain('PNG_SCREENSHOT_NATIVE_DATE_RECOVERY');
    });

    const appleTags = {
      'IFD0:Make': 'Apple',
      'IFD0:Model': 'iPhone 7',
      'ExifIFD:DateTimeOriginal': '2017:02:07 08:18:42',
      'XMP-xmp:CreateDate': '2017:02:07 08:18:42',
      'XMP-photoshop:DateCreated': '2017:02:07 20:18:42',
      'IPTC:DateCreated': '2017:02:07',
      'IPTC:TimeCreated': '20:18:42-05:00',
      'GPS:GPSDateStamp': '2017:02:08',
      'GPS:GPSTimeStamp': '01:18:40',
      'GPS:GPSLatitude': '28 deg 34\' 39.79"',
      'GPS:GPSLatitudeRef': 'North',
      'GPS:GPSLongitude': '81 deg 24\' 44.47"',
      'GPS:GPSLongitudeRef': 'West',
    } satisfies RawExifTags;

    it('corrects an audited Apple AM/PM inversion from IPTC, XMP, GPS, and coordinates', async () => {
      const result = await resolveImage('IMG_0001.jpeg', appleTags);
      expect(result).toMatchObject({
        status: 'resolved',
        confidence: 'medium',
        selectedValue: {
          localIso: '2017-02-07T20:18:42',
          instantUtc: '2017-02-08T01:18:42.000Z',
          offsetMinutes: -300,
          zoneBasis: 'explicit-offset',
        },
      });
      expect(result.reasonCodes).toContain('APPLE_AM_PM_CORRUPTION_RECOVERY');
    });

    it('rejects an LA GPS relationship when IPTC is incorrectly anchored at -05:00', async () => {
      const result = await resolveImage('IMG_0002.jpeg', {
        ...appleTags,
        'ExifIFD:DateTimeOriginal': '2017:05:05 07:39:37',
        'XMP-xmp:CreateDate': '2017:05:05 07:39:37',
        'XMP-photoshop:DateCreated': '2017:05:05 19:39:37',
        'IPTC:DateCreated': '2017:05:05',
        'IPTC:TimeCreated': '19:39:37-05:00',
        'GPS:GPSDateStamp': '2017:05:06',
        'GPS:GPSTimeStamp': '02:39:36',
        'GPS:GPSLatitude': '34 deg 2\' 36.88"',
        'GPS:GPSLongitude': '118 deg 14\' 12.40"',
        'GPS:GPSLongitudeRef': 'West',
      });
      expect(result.reasonCodes).not.toContain('APPLE_AM_PM_CORRUPTION_RECOVERY');
      expect(result.status).toBe('ambiguous');
    });

    it.each([
      ['altered model', { 'IFD0:Model': 'iPhone 8' }],
      ['missing coordinates', { 'GPS:GPSLatitude': undefined }],
      ['incompatible offset', { 'IPTC:TimeCreated': '20:18:42-06:00' }],
      ['GPS differs by 50 seconds', { 'GPS:GPSTimeStamp': '01:17:52' }],
      ['IPTC disagrees with Photoshop', { 'IPTC:TimeCreated': '20:18:41-05:00' }],
    ] as const)('does not apply Apple AM/PM recovery with %s', async (_name, changed) => {
      const result = await resolveImage('IMG_0001.jpeg', { ...appleTags, ...changed });
      expect(result.reasonCodes).not.toContain('APPLE_AM_PM_CORRUPTION_RECOVERY');
    });
  });

  it('does not convert filesystem modified time into creation evidence', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({
        'File:System:FileModifyDate': '2026:03:27 21:38:45-04:00',
      }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const result = await collector.collectDetailed({
      fileId: '7:11',
      filePath: '/media/0089b5ac-c91a-4b47-8c5e-7dddacffdb1b.jpg',
      filesystemBirthTimeUtc: null,
      mediaKind: 'image',
    });

    expect(result.candidates).toEqual([]);
    await collector.close();
  });

  it.each([
    ['Screenshot 2026-09-01 at 16.04.22.png', {} as RawExifTags, 'filename', 'filename'],
    ['Screen Shot 2026-09-01 at 16.04.22.PNG', {} as RawExifTags, 'filename', 'filename'],
    ['IMG_0042.PNG', { 'EXIF:UserComment': 'Screenshot' }, 'metadata', 'EXIF:UserComment'],
    [
      'IMG_0043.PNG',
      { 'ExifIFD:UserComment': '{{0, 0}, {1290, 2796}}' },
      'metadata',
      'ExifIFD:UserComment',
    ],
  ] as const)(
    'detects explicit screenshot evidence in %s',
    async (filename, tags, source, field) => {
      const collector = new MetadataCandidateCollector(new FakeExifToolAdapter(tags), async () => ({
        birthtime: new Date(Number.NaN),
      }));

      const result = await collector.collectDetailed({
        fileId: `sha256:${filename}`,
        filePath: `/media/${filename}`,
        mediaKind: 'image',
      });

      expect(result.screenshotEvidence).toEqual({ source, field });
      await collector.close();
    }
  );

  it('collects the group-qualified image date tags emitted by bundled ExifTool', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({
        'XMP-exif:DateTimeOriginal': '2024:03:04 05:06:07-05:00',
        'XMP-xmp:CreateDate': '2024:03:04 05:06:07-05:00',
        'XMP-pdf:CreationDate': '2024:03:04 05:06:07-05:00',
        'Samsung:TimeStamp': '2024:03:04 05:06:07-05:00',
        'PNG:CreateDate': '2024:03:04 05:06:07-05:00',
      }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const candidates = await collector.collect({
      fileId: 'sha256:image-qualified-dates',
      filePath: '/media/undated.png',
      mediaKind: 'image',
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'XMP-exif:DateTimeOriginal',
          semantic: 'capture',
          sourceKind: 'embedded-xmp',
        }),
        expect.objectContaining({
          tag: 'XMP-xmp:CreateDate',
          semantic: 'content-created',
          sourceKind: 'embedded-xmp',
        }),
        expect.objectContaining({
          tag: 'XMP-pdf:CreationDate',
          semantic: 'content-created',
          sourceKind: 'embedded-xmp',
        }),
        expect.objectContaining({
          tag: 'Samsung:TimeStamp',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
        }),
        expect.objectContaining({
          tag: 'PNG:CreateDate',
          semantic: 'content-created',
          sourceKind: 'container-format',
        }),
      ])
    );
    await collector.close();
  });

  it('does not mistake an eight-digit UUID segment for a date-only filename claim', async () => {
    const collector = new MetadataCandidateCollector(new FakeExifToolAdapter({}), async () => ({
      birthtime: new Date(Number.NaN),
    }));

    const candidates = await collector.collect({
      fileId: 'sha256:numeric-uuid',
      filePath: '/media/9a21f000-20210615-4000-8000-123456789abc.jpg',
      mediaKind: 'image',
    });

    expect(candidates).toEqual([]);
    await collector.close();
  });

  it('collects real QuickTime stream, XMP, UserData, and ItemList date groups', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({
        'QuickTime:CreateDate': '2020:11:15 20:17:02',
        'Track1:MediaCreateDate': '2020:11:15 20:17:02',
        'Track2:TrackCreateDate': '2020:11:15 20:17:02',
        'XMP-exif:DateTimeOriginal': '2020:11:15 20:17:02-05:00',
        'XMP-xmp:CreateDate': '2020:11:15 20:17:02-05:00',
        'XMP-pdf:CreationDate': '2020:11:15 20:17:02-05:00',
        'UserData:DateTimeOriginal': '2020:11:15 20:17:02-05:00',
        'ItemList:ContentCreateDate': '2020:11:15 20:17:02-05:00',
      }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const candidates = await collector.collect({
      fileId: 'sha256:video-qualified-dates',
      filePath: '/media/undated.mp4',
      mediaKind: 'video',
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'QuickTime:CreateDate',
          semantic: 'container-created',
          sourceKind: 'container-format',
          value: expect.objectContaining({ zoneBasis: 'spec-defined-utc' }),
        }),
        expect.objectContaining({ tag: 'Track1:MediaCreateDate' }),
        expect.objectContaining({ tag: 'Track2:TrackCreateDate' }),
        expect.objectContaining({
          tag: 'XMP-exif:DateTimeOriginal',
          semantic: 'capture',
        }),
        expect.objectContaining({
          tag: 'XMP-xmp:CreateDate',
          semantic: 'content-created',
        }),
        expect.objectContaining({
          tag: 'XMP-pdf:CreationDate',
          semantic: 'content-created',
        }),
        expect.objectContaining({
          tag: 'UserData:DateTimeOriginal',
          semantic: 'capture',
        }),
        expect.objectContaining({
          tag: 'ItemList:ContentCreateDate',
          semantic: 'content-created',
        }),
      ])
    );
    await collector.close();
  });

  it('combines GPS and IPTC digital date-time pairs and parses PNG creation text', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({
        'GPS:GPSDateStamp': '2019:03:29',
        'GPS:GPSTimeStamp': '19:34:15.09',
        'IPTC:DigitalCreationDate': '2019:03:29',
        'IPTC:DigitalCreationTime': '15:34:15-04:00',
        'PNG:CreationTime': 'Fri 29 Mar 2019 03:34:15 PM EDT',
      }),
      async () => ({ birthtime: new Date(Number.NaN) })
    );

    const candidates = await collector.collect({
      fileId: 'sha256:image-paired-dates',
      filePath: '/media/undated.png',
      mediaKind: 'image',
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'GPS:GPSDateStamp+GPS:GPSTimeStamp',
          semantic: 'capture',
          value: expect.objectContaining({
            instantUtc: '2019-03-29T19:34:15.09Z',
            zoneBasis: 'spec-defined-utc',
          }),
        }),
        expect.objectContaining({
          tag: 'IPTC:DigitalCreationDate+IPTC:DigitalCreationTime',
          semantic: 'digitized',
          value: expect.objectContaining({
            instantUtc: '2019-03-29T19:34:15.000Z',
            zoneBasis: 'explicit-offset',
          }),
        }),
        expect.objectContaining({
          tag: 'PNG:CreationTime',
          semantic: 'content-created',
          value: expect.objectContaining({
            localIso: '2019-03-29T15:34:15',
            instantUtc: '2019-03-29T19:34:15.000Z',
            offsetMinutes: -240,
          }),
        }),
      ])
    );
    await collector.close();
  });

  it.each([
    ['IMG_0042.PNG', 'image', { 'EXIF:UserComment': 'Photo exported from desktop' }],
    ['desktop-wallpaper.png', 'image', {}],
    ['Screenshot 2026-09-01.mov', 'video', { 'EXIF:UserComment': 'Screenshot' }],
    ['screen capture notes.pdf', 'document', { 'EXIF:UserComment': 'Screenshot' }],
  ] as const)(
    'does not infer screenshots from weak or non-image evidence: %s',
    async (filename, mediaKind, tags) => {
      const collector = new MetadataCandidateCollector(new FakeExifToolAdapter(tags), async () => ({
        birthtime: new Date(Number.NaN),
      }));

      const result = await collector.collectDetailed({
        fileId: `sha256:not-screenshot:${filename}`,
        filePath: `/media/${filename}`,
        mediaKind,
      });

      expect(result.screenshotEvidence).toBeUndefined();
      await collector.close();
    }
  );

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
        instantUtc: '2024-03-04T10:36:07.123456Z',
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

  describe('generic subsecond selection', () => {
    it('keeps the strongest EXIF timestamp while omitting unsupported subseconds', async () => {
      const result = await resolveImage('2003-10-11_00-00-00.jpeg', {
        'ExifIFD:DateTimeOriginal': '2003:10:11 15:34:20',
        'ExifIFD:CreateDate': '2003:10:11 15:34:20',
        'ExifIFD:SubSecTimeOriginal': '000007',
        'ExifIFD:SubSecTimeDigitized': '000007',
        'IPTC:DateCreated': '2003:10:11',
      });

      expect(result).toMatchObject({
        status: 'resolved',
        selectedValue: {
          localIso: '2003-10-11T15:34:20',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      });
      expect(result.selectedValue).not.toHaveProperty('fractionalDigits');
      expect(result.reasonCodes).toEqual(
        expect.arrayContaining(['UNVERIFIED_SUBSECONDS_OMITTED', 'RESOLVED_MEDIUM_CONFIDENCE'])
      );
      expect(result.reasonCodes).not.toEqual(
        expect.arrayContaining(['CALENDAR_DATE_CONSENSUS', 'RESOLVED_DATE_ONLY', 'TIME_UNKNOWN'])
      );
      expect(result.candidates.find((item) => item.id === result.selectedCandidateId)?.tag).toBe(
        'ExifIFD:DateTimeOriginal'
      );
    });

    it('preserves a legitimate strongest whole-second timestamp', async () => {
      const result = await resolveImage('photo.jpeg', {
        'ExifIFD:DateTimeOriginal': '2003:10:11 15:34:20',
        'ExifIFD:CreateDate': '2003:10:11 15:34:20',
        'IPTC:DateCreated': '2003:10:11',
      });

      expect(result.selectedValue).toMatchObject({
        localIso: '2003-10-11T15:34:20',
        precision: 'second',
      });
      expect(result.candidates.find((item) => item.id === result.selectedCandidateId)?.tag).toBe(
        'ExifIFD:DateTimeOriginal'
      );
    });

    it('still resolves inputs that contain only an embedded calendar date', async () => {
      const result = await resolveImage('photo.jpeg', {
        'IPTC:DateCreated': '2003:10:11',
      });

      expect(result).toMatchObject({
        status: 'resolved',
        selectedValue: {
          localIso: '2003-10-11',
          zoneBasis: 'date-only',
          precision: 'date',
        },
      });
      expect(result.reasonCodes).toEqual(
        expect.arrayContaining(['CALENDAR_DATE_CONSENSUS', 'RESOLVED_DATE_ONLY', 'TIME_UNKNOWN'])
      );
    });
  });

  it.each([
    ['1 digit', '2024:03:04 05:06:07', '1', '-05:30', '2024-03-04T10:36:07.1Z'],
    ['2 digits', '2024:03:04 05:06:07', '12', '+02:00', '2024-03-04T03:06:07.12Z'],
    ['3 digits', '2024:03:04 05:06:07', '123', '+00:00', '2024-03-04T05:06:07.123Z'],
    ['4 digits', '2024:03:04 05:06:07', '1234', '+00:00', '2024-03-04T05:06:07.1234Z'],
    ['5 digits', '2024:03:04 05:06:07', '12345', '+00:00', '2024-03-04T05:06:07.12345Z'],
    ['6 digits', '2024:03:04 05:06:07', '123456', '+00:00', '2024-03-04T05:06:07.123456Z'],
    ['7 digits', '2024:03:04 05:06:07', '1234567', '+00:00', '2024-03-04T05:06:07.1234567Z'],
    ['8 digits', '2024:03:04 05:06:07', '12345678', '+00:00', '2024-03-04T05:06:07.12345678Z'],
    ['9 digits', '2024:03:04 05:06:07', '123456789', '+00:00', '2024-03-04T05:06:07.123456789Z'],
    [
      'positive offset rollover',
      '2024:01:01 00:15:00',
      '000001',
      '+01:00',
      '2023-12-31T23:15:00.000001Z',
    ],
    [
      'negative offset rollover',
      '2024:12:31 23:45:00',
      '999999999',
      '-01:00',
      '2025-01-01T00:45:00.999999999Z',
    ],
  ])(
    'preserves exact explicit-offset precision for %s',
    async (_name, local, fraction, offset, expectedInstant) => {
      const collector = new MetadataCandidateCollector(
        new FakeExifToolAdapter({
          'EXIF:DateTimeOriginal': local,
          'EXIF:OffsetTimeOriginal': offset,
          'EXIF:SubSecTimeOriginal': fraction,
        }),
        statWithBirthtime
      );

      const candidates = await collector.collect({
        fileId: `sha256:${fraction}`,
        filePath: '/media/photo.jpg',
        mediaKind: 'image',
      });

      expect(
        candidates.find((candidate) => candidate.tag === 'EXIF:DateTimeOriginal')?.value
      ).toMatchObject({
        instantUtc: expectedInstant,
        fractionalDigits: fraction,
        zoneBasis: 'explicit-offset',
      });
      await collector.close();
    }
  );

  it.each([
    ['Screenshot 2021-06-15 at 12.30.45.png', '2021-06-15T12:30:45', 'second'],
    ['IMG_20210615123045.jpg', '2021-06-15T12:30:45', 'second'],
    ['2021-06-15_123045.mov', '2021-06-15T12:30:45', 'second'],
    ['IMG_20210615.jpg', '2021-06-15', 'date'],
    ['DSC_20210615_123045.jpg', '2021-06-15T12:30:45', 'second'],
    ['IMG-20210615-WA0042.jpg', '2021-06-15', 'date'],
    ['IMG_20210615_123045_LIVE.jpg', '2021-06-15T12:30:45', 'second'],
    ['IMG_20210615_123045_BURST007.jpg', '2021-06-15T12:30:45', 'second'],
    ['Instagram_20210615_123045.jpg', '2021-06-15T12:30:45', 'second'],
    ['PXL_20210615_123045.jpg', '2021-06-15T12:30:45', 'second'],
  ] as const)(
    'extracts bounded legacy date pattern from %s',
    async (filename, localIso, precision) => {
      const collector = new MetadataCandidateCollector(new FakeExifToolAdapter({}), async () => ({
        birthtime: new Date(Number.NaN),
      }));

      const candidates = await collector.collect({
        fileId: `sha256:legacy-name:${filename}`,
        filePath: `/media/${filename}`,
        mediaKind: filename.endsWith('.mov') ? 'video' : 'image',
      });

      expect(candidates).toContainEqual(
        expect.objectContaining({
          sourceKind: 'filename',
          sourceFamily: precision === 'date' ? 'filename-date-only' : expect.any(String),
          value: expect.objectContaining({ localIso, precision }),
        })
      );
      await collector.close();
    }
  );

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

  it('collects the audited Canon EOS 5D TimeStamp only when it matches IFD0 ModifyDate and replaces repeated midnight EXIF placeholders', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({
        'IFD0:Make': 'Canon',
        'IFD0:Model': 'Canon EOS 5D',
        'IFD0:ModifyDate': '2007:02:07 05:25:42',
        'ExifIFD:DateTimeOriginal': '2003:07:01 00:00:00',
        'ExifIFD:CreateDate': '2003:07:01 00:00:00',
        'Canon:TimeStamp': '2007:02:07 05:25:42',
      }),
      statWithBirthtime
    );

    const candidates = await collector.collect({
      fileId: 'canon-valid',
      filePath: '/media/canon.jpg',
      mediaKind: 'image',
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'Canon:TimeStamp',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          sourceFamily: 'canon-makernote',
          value: expect.objectContaining({ localIso: '2007-02-07T05:25:42' }),
        }),
      ])
    );
    expect(candidates.some((candidate) => candidate.tag === 'IFD0:ModifyDate')).toBe(false);
    await collector.close();
  });

  it.each([
    ['wrong model', { 'IFD0:Model': 'Canon EOS 5D Mark II' }],
    ['mismatched modify date', { 'IFD0:ModifyDate': '2007:02:07 05:25:43' }],
    ['non-repeated EXIF placeholders', { 'ExifIFD:CreateDate': '2003:07:02 00:00:00' }],
    [
      'midnight Canon timestamp',
      { 'Canon:TimeStamp': '2007:02:07 00:00:00', 'IFD0:ModifyDate': '2007:02:07 00:00:00' },
    ],
  ])('does not collect Canon TimeStamp for %s', async (_name, overrides) => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({
        'IFD0:Make': 'Canon',
        'IFD0:Model': 'Canon EOS 5D',
        'IFD0:ModifyDate': '2007:02:07 05:25:42',
        'ExifIFD:DateTimeOriginal': '2003:07:01 00:00:00',
        'ExifIFD:CreateDate': '2003:07:01 00:00:00',
        'Canon:TimeStamp': '2007:02:07 05:25:42',
        ...overrides,
      }),
      statWithBirthtime
    );
    const candidates = await collector.collect({
      fileId: 'canon-denied',
      filePath: '/media/canon.jpg',
      mediaKind: 'image',
    });
    expect(candidates.some((candidate) => candidate.tag === 'Canon:TimeStamp')).toBe(false);
    await collector.close();
  });

  it('ignores unrelated MakerNote runtime, firmware, date-mode, timer, and exposure-setting tags', async () => {
    const collector = new MetadataCandidateCollector(
      new FakeExifToolAdapter({
        'Apple:RunTimeSincePowerUp': '2024:01:02 03:04:05',
        'Apple:RunTimeScale': 1000000000,
        'Casio:FirmwareDate': '2024:01:02 03:04:05',
        'Canon:DateStampMode': 'Date & Time',
        'Canon:SelfTimer': 10,
        'Canon:ExposureTime': '1/100',
      }),
      statWithBirthtime
    );
    const candidates = await collector.collect({
      fileId: 'ignored-makers',
      filePath: '/media/ignored.jpg',
      mediaKind: 'image',
    });
    expect(
      candidates.filter((candidate) =>
        /runtime|firmware|datestamp|timer|exposure/i.test(candidate.tag)
      )
    ).toEqual([]);
    await collector.close();
  });
});
