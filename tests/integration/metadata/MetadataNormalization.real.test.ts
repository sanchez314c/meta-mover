import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { BundledExifToolAdapter } from '../../../src/main/tools/BundledExifToolAdapter';

const run = promisify(execFile);

describe('real ExifTool metadata normalization', () => {
  let root: string;
  let adapter: BundledExifToolAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-real-metadata-'));
    adapter = new BundledExifToolAdapter({
      platform: 'linux',
      perlPath: '/usr/bin/perl',
      exiftoolPath: '/usr/bin/exiftool',
      perlLibraryPaths: ['/usr/share/perl5'],
    });
  });

  afterEach(async () => {
    await adapter.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes EXIF local creation time plus dedicated offset tags to a real JPEG', async () => {
    const filePath = path.join(root, 'photo.jpg');
    await fs.writeFile(
      filePath,
      Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=', 'base64')
    );
    const receipt = await adapter.normalizeDateMetadata({
      filePath,
      selectedDate: {
        localIso: '2024-03-04T05:06:07',
        instantUtc: '2024-03-04T10:06:07.000Z',
        offsetMinutes: -300,
        zoneBasis: 'explicit-offset',
        precision: 'second',
      },
    });
    expect(receipt.verified).toBe(true);
    expect(receipt.after['ExifIFD:DateTimeOriginal']).toBe('2024:03:04 05:06:07');
    expect(receipt.after['ExifIFD:OffsetTimeOriginal']).toBe('-05:00');
  });

  it('writes a resolved UTC instant to real QuickTime container creation tags', async () => {
    const filePath = path.join(root, 'clip.mov');
    await run('/home/heathen-admin/miniconda3/bin/ffmpeg', [
      '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=16x16:d=0.1', '-an', '-y', filePath,
    ]);
    const receipt = await adapter.normalizeDateMetadata({
      filePath,
      selectedDate: {
        localIso: '2024-03-04T05:06:07',
        instantUtc: '2024-03-04T10:06:07.000Z',
        offsetMinutes: -300,
        zoneBasis: 'explicit-offset',
        precision: 'second',
      },
    });
    expect(receipt.verified).toBe(true);
    expect(receipt.after['QuickTime:CreateDate']).toBe('2024:03:04 10:06:07');
    expect(
      Object.entries(receipt.after).some(
        ([tag, value]) => tag.endsWith(':TrackCreateDate') && value === '2024:03:04 10:06:07'
      )
    ).toBe(true);
  });
});
