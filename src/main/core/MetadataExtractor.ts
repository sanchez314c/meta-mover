/**
 * Metadata Extractor - Comprehensive metadata extraction for all media types
 *
 * Replaces the Python ExifTool and PIL functionality with native Node.js libraries
 * for better performance and reduced dependencies.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import exifr from 'exifr';
import sharp from 'sharp';

import { MediaType, MediaMetadata, GPSData } from '@shared/types/media';
import { RAW_IMAGE_FORMATS } from '@shared/constants/index';

import { Logger } from '../utils/Logger';
import { DateExtractor } from '../utils/DateExtractor';
import { FFProbeWrapper, FFProbeRawData, FFProbeStream } from '../utils/FFProbeWrapper';

export class MetadataExtractor {
  private logger: Logger;
  private dateExtractor: DateExtractor;
  private ffprobe: FFProbeWrapper;

  constructor() {
    this.logger = Logger.getInstance();
    this.dateExtractor = new DateExtractor();
    this.ffprobe = new FFProbeWrapper();
  }

  /**
   * Extract comprehensive metadata from any media file
   */
  public async extractMetadata(filePath: string, mediaType: MediaType): Promise<MediaMetadata> {
    this.logger.debug('Extracting metadata', { filePath, mediaType });

    try {
      let metadata: MediaMetadata = {};

      switch (mediaType) {
        case MediaType.IMAGE:
          metadata = await this.extractImageMetadata(filePath);
          break;

        case MediaType.VIDEO:
          metadata = await this.extractVideoMetadata(filePath);
          break;

        case MediaType.AUDIO:
          metadata = await this.extractAudioMetadata(filePath);
          break;

        default:
          metadata = await this.extractBasicMetadata(filePath);
      }

      // Always try to extract date from filename as fallback (legacy pattern)
      if (!metadata.captureDate && !metadata.createDate) {
        const filenameDate = this.dateExtractor.extractDateFromFilename(path.basename(filePath));
        if (filenameDate) {
          metadata.captureDate = filenameDate;
        }
      }

      // Get file system dates as final fallback with century correction (legacy get_fallback_date)
      const stats = await fs.stat(filePath);
      if (!metadata.createDate) {
        metadata.createDate = this.dateExtractor.getFallbackDate(stats.birthtime || stats.ctime);
      }
      metadata.modifyDate = stats.mtime;

      // Apply century correction to capture date if present
      if (metadata.captureDate) {
        metadata.captureDate = this.dateExtractor.correctCentury(metadata.captureDate);
      }

      this.logger.debug('Metadata extraction completed', {
        filePath,
        fieldsExtracted: Object.keys(metadata).length,
      });

      return metadata;
    } catch (error) {
      this.logger.error('Metadata extraction failed', { filePath, error });

      // Return minimal metadata with file system dates
      const stats = await fs.stat(filePath);
      return {
        createDate: stats.birthtime || stats.ctime,
        modifyDate: stats.mtime,
        fileType: path.extname(filePath).toLowerCase(),
      };
    }
  }

  /**
   * Extract metadata from image files
   */
  private async extractImageMetadata(filePath: string): Promise<MediaMetadata> {
    const metadata: MediaMetadata = {};
    const fileExt = path.extname(filePath).toLowerCase();

    try {
      // Use exifr for comprehensive EXIF/XMP/IPTC data
      const exifData = await exifr.parse(filePath, {
        exif: true,
        xmp: true,
        iptc: true,
        icc: true,
        multiSegment: true,
        mergeOutput: true,
      });

      if (exifData) {
        // Extract basic camera information
        if (exifData.Make) metadata.make = exifData.Make;
        if (exifData.Model) metadata.model = exifData.Model;
        if (exifData.LensModel) metadata.lens = exifData.LensModel;
        if (exifData.SerialNumber) metadata.serialNumber = exifData.SerialNumber;

        // Extract technical metadata
        if (exifData.ISO) metadata.iso = exifData.ISO;
        if (exifData.FNumber) metadata.aperture = exifData.FNumber;
        if (exifData.ExposureTime) metadata.shutterSpeed = exifData.ExposureTime.toString();
        if (exifData.FocalLength) metadata.focalLength = exifData.FocalLength;
        if (exifData.Flash !== undefined) metadata.flash = exifData.Flash > 0;
        if (exifData.Orientation) metadata.orientation = exifData.Orientation;
        if (exifData.ColorSpace) metadata.colorSpace = exifData.ColorSpace.toString();

        // Extract dates with priority order
        metadata.captureDate = this.extractDateFromExif(exifData);

        // Extract GPS data
        if (exifData.latitude && exifData.longitude) {
          metadata.gps = {
            latitude: exifData.latitude,
            longitude: exifData.longitude,
            altitude: exifData.GPSAltitude,
            timestamp: exifData.GPSTimeStamp,
          };
        }

        // Extract content metadata
        if (exifData.ImageDescription) metadata.description = exifData.ImageDescription;
        if (exifData.Copyright) metadata.copyright = exifData.Copyright;
        if (exifData.Rating) metadata.rating = exifData.Rating;

        // Extract keywords from XMP
        if (exifData.Keywords) {
          metadata.keywords = Array.isArray(exifData.Keywords)
            ? exifData.Keywords
            : [exifData.Keywords];
        }

        // Extract subsecond precision from EXIF (legacy SubSecTimeOriginal)
        if (exifData.SubSecTimeOriginal) {
          metadata.subsecond = String(exifData.SubSecTimeOriginal);
        } else if (exifData.SubSecTime) {
          metadata.subsecond = String(exifData.SubSecTime);
        }

        // Screenshot detection via EXIF UserComment (legacy is_screenshot)
        // iOS screenshots have "Screenshot" in UserComment
        // macOS screen captures use CGRect format {{x,y},{w,h}}
        if (exifData.UserComment) {
          const userComment = String(exifData.UserComment).trim();
          if (
            userComment === 'Screenshot' ||
            (userComment.startsWith('{{') && userComment.includes('},'))
          ) {
            metadata.isScreenshot = true;
          }
        }
      }

      // Use Sharp for additional image information
      try {
        const sharpMetadata = await sharp(filePath).metadata();

        metadata.dimensions = {
          width: sharpMetadata.width || 0,
          height: sharpMetadata.height || 0,
        };

        metadata.fileType = sharpMetadata.format;
        if (sharpMetadata.density) {
          metadata.customFields = {
            ...metadata.customFields,
            density: sharpMetadata.density,
          };
        }
      } catch (sharpError) {
        this.logger.warn('Sharp metadata extraction failed', { filePath, error: sharpError });

        // Fallback for RAW formats or unsupported images
        if (RAW_IMAGE_FORMATS.includes(fileExt)) {
          metadata.fileType = 'raw';
        }
      }
    } catch (error) {
      this.logger.error('Image metadata extraction failed', { filePath, error });
    }

    return metadata;
  }

  /**
   * Extract metadata from video files
   */
  private async extractVideoMetadata(filePath: string): Promise<MediaMetadata> {
    const metadata: MediaMetadata = {};

    try {
      const ffprobeData = await this.ffprobe.getRawVideoMetadata(filePath);

      if (ffprobeData && ffprobeData.format) {
        metadata.duration = parseFloat(ffprobeData.format.duration || '0');
        metadata.fileType = ffprobeData.format.format_name;
        if (ffprobeData.format.bit_rate) {
          metadata.bitrate = parseInt(ffprobeData.format.bit_rate);
        }

        // Extract creation date from format metadata
        if (ffprobeData.format.tags) {
          const tags = ffprobeData.format.tags;
          metadata.captureDate = this.extractDateFromVideoTags(tags);

          if (tags.title) metadata.title = tags.title;
          if (tags.comment) metadata.description = tags.comment;
          if (tags.copyright) metadata.copyright = tags.copyright;
        }
      }

      if (ffprobeData) {
        // Extract video stream information
        const videoStream = ffprobeData.streams?.find(
          (s: FFProbeStream) => s.codec_type === 'video'
        );
        if (videoStream) {
          metadata.dimensions = {
            width: videoStream.width || 0,
            height: videoStream.height || 0,
          };

          metadata.videoCodec = videoStream.codec_name;

          if (videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split('/');
            metadata.frameRate = parseInt(num) / parseInt(den);
          }

          // Calculate resolution category
          if (metadata.dimensions.width && metadata.dimensions.height) {
            metadata.resolution = this.categorizeVideoResolution(
              metadata.dimensions.width,
              metadata.dimensions.height
            );
          }
        }

        // Extract audio stream information
        const audioStream = ffprobeData.streams?.find(
          (s: FFProbeStream) => s.codec_type === 'audio'
        );
        if (audioStream) {
          metadata.audioCodec = audioStream.codec_name;
          if (audioStream.sample_rate) {
            metadata.sampleRate = parseInt(audioStream.sample_rate);
          }
        }

        // Extract GPS from video if available
        metadata.gps = this.extractGPSFromVideo(ffprobeData);
      }
    } catch (error) {
      this.logger.error('Video metadata extraction failed', { filePath, error });
    }

    return metadata;
  }

  /**
   * Extract metadata from audio files
   */
  private async extractAudioMetadata(filePath: string): Promise<MediaMetadata> {
    const metadata: MediaMetadata = {};

    try {
      const ffprobeData = await this.ffprobe.getVideoMetadata(filePath);

      if (ffprobeData && ffprobeData.format) {
        metadata.duration = parseFloat(ffprobeData.format.duration || '0');
        metadata.fileType = ffprobeData.format.format_name;

        if (ffprobeData.format.bit_rate) {
          metadata.bitrate = parseInt(ffprobeData.format.bit_rate);
        }

        // Extract audio tags
        if (ffprobeData.format.tags) {
          const tags = ffprobeData.format.tags;

          if (tags.title) metadata.title = tags.title;
          if (tags.artist)
            metadata.customFields = { ...metadata.customFields, artist: tags.artist };
          if (tags.album) metadata.customFields = { ...metadata.customFields, album: tags.album };
          if (tags.date) metadata.captureDate = new Date(tags.date);
          if (tags.genre) metadata.customFields = { ...metadata.customFields, genre: tags.genre };
        }
      }

      // Extract audio stream information
      if (ffprobeData && ffprobeData.streams) {
        const audioStream = ffprobeData.streams.find(
          (s: FFProbeStream) => s.codec_type === 'audio'
        );
        if (audioStream) {
          metadata.audioCodec = audioStream.codec_name;
          if (audioStream.sample_rate) {
            metadata.sampleRate = parseInt(audioStream.sample_rate);
          }
          if (audioStream.channels) {
            metadata.customFields = {
              ...metadata.customFields,
              channels: audioStream.channels,
            };
          }
        }
      }
    } catch (error) {
      this.logger.error('Audio metadata extraction failed', { filePath, error });
    }

    return metadata;
  }

  /**
   * Extract basic metadata for unsupported file types
   */
  private async extractBasicMetadata(filePath: string): Promise<MediaMetadata> {
    const metadata: MediaMetadata = {};

    try {
      const stats = await fs.stat(filePath);
      metadata.createDate = stats.birthtime || stats.ctime;
      metadata.modifyDate = stats.mtime;
      metadata.fileType = path.extname(filePath).toLowerCase();
    } catch (error) {
      this.logger.error('Basic metadata extraction failed', { filePath, error });
    }

    return metadata;
  }

  /**
   * Extract date from EXIF data with priority order matching legacy.
   * Ported from legacy extract_date_from_metadata() date_field_priority.
   *
   * Priority:
   * 1. MediaCreateDate (video track creation - most reliable for videos)
   * 2. TrackCreateDate (alternative track creation time)
   * 3. ContentCreateDate (content creation date)
   * 4. DateTimeOriginal (original photo/video capture time)
   * 5. CreateDate (QuickTime CreateDate - less reliable, can be overwritten)
   * 6. DateTime, DateCreated, DateTimeDigitized (fallbacks)
   */
  private extractDateFromExif(exifData: Record<string, unknown>): Date | undefined {
    const dateFields = [
      'MediaCreateDate',
      'TrackCreateDate',
      'ContentCreateDate',
      'DateTimeOriginal',
      'CreateDate',
      'DateTime',
      'DateCreated',
      'DateTimeDigitized',
    ];

    const now = new Date();
    const minPast = new Date(Date.UTC(1990, 0, 1));
    const maxFuture = new Date(Date.UTC(now.getFullYear(), 11, 31, 23, 59, 59));

    for (const field of dateFields) {
      if (exifData[field]) {
        const date = new Date(exifData[field] as string | number | Date);
        if (!isNaN(date.getTime())) {
          // Apply century correction
          const corrected = this.dateExtractor.correctCentury(date);
          // Validate date is reasonable
          if (corrected >= minPast && corrected <= maxFuture) {
            return corrected;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Extract date from video metadata tags.
   * Matches legacy priority: MediaCreateDate > TrackCreateDate > creation_time
   */
  private extractDateFromVideoTags(tags: Record<string, unknown>): Date | undefined {
    const dateFields = [
      'media_create_date',
      'track_create_date',
      'content_create_date',
      'creation_time',
      'date',
      'DATE',
      'CREATION_TIME',
      'com.apple.quicktime.creationdate',
    ];

    const now = new Date();
    const minPast = new Date(Date.UTC(1990, 0, 1));
    const maxFuture = new Date(Date.UTC(now.getFullYear(), 11, 31, 23, 59, 59));

    for (const field of dateFields) {
      if (tags[field]) {
        const date = new Date(tags[field] as string | number | Date);
        if (!isNaN(date.getTime())) {
          // Apply century correction
          const corrected = this.dateExtractor.correctCentury(date);
          if (corrected >= minPast && corrected <= maxFuture) {
            return corrected;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Extract GPS data from video metadata
   */
  private extractGPSFromVideo(ffprobeData: FFProbeRawData): GPSData | undefined {
    try {
      // Look for GPS data in various locations
      const streams = ffprobeData.streams || [];

      for (const stream of streams) {
        if (stream.tags) {
          const lat =
            stream.tags['com.apple.quicktime.location.ISO6709'] ||
            stream.tags['location'] ||
            stream.tags['GPS'];

          if (lat) {
            // Parse ISO 6709 format: +37.7749-122.4194/
            const match = lat.match(/([+-]\d+\.\d+)([+-]\d+\.\d+)/);
            if (match) {
              return {
                latitude: parseFloat(match[1]),
                longitude: parseFloat(match[2]),
              };
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('GPS extraction from video failed', { error });
    }

    return undefined;
  }

  /**
   * Categorize video resolution using shorter side.
   * Ported from legacy get_video_resolution() - uses orientation-aware
   * shorter-side measurement so portrait videos are categorized correctly.
   */
  private categorizeVideoResolution(width: number, height: number): string {
    // Use shorter side for resolution categorization (matches legacy)
    const resolutionHeight = width > height ? height : width;

    if (resolutionHeight >= 2160) return '4K';
    if (resolutionHeight >= 1440) return '1440p';
    if (resolutionHeight >= 1080) return '1080p';
    if (resolutionHeight >= 720) return '720p';
    if (resolutionHeight >= 480) return '480p';
    return 'below_720p';
  }

  /**
   * Repair corrupted or missing metadata
   */
  public async repairMetadata(filePath: string, metadata: MediaMetadata): Promise<MediaMetadata> {
    const repairedMetadata = { ...metadata };

    try {
      // Repair missing capture date
      if (!repairedMetadata.captureDate) {
        // Try filename patterns
        const filenameDate = this.dateExtractor.extractDateFromFilename(path.basename(filePath));
        if (filenameDate) {
          repairedMetadata.captureDate = filenameDate;
        } else {
          // Use file creation date as last resort
          const stats = await fs.stat(filePath);
          repairedMetadata.captureDate = stats.birthtime || stats.ctime;
        }
      }

      // Repair missing dimensions for images
      if (!repairedMetadata.dimensions && filePath.match(/\.(jpe?g|png|tiff?|bmp|gif)$/i)) {
        try {
          const { width, height } = await sharp(filePath).metadata();
          if (width && height) {
            repairedMetadata.dimensions = { width, height };
          }
        } catch (error) {
          this.logger.warn('Could not repair image dimensions', { filePath, error });
        }
      }

      // Repair missing file type
      if (!repairedMetadata.fileType) {
        repairedMetadata.fileType = path.extname(filePath).toLowerCase();
      }

      this.logger.debug('Metadata repair completed', { filePath });
    } catch (error) {
      this.logger.error('Metadata repair failed', { filePath, error });
    }

    return repairedMetadata;
  }

  /**
   * Sync dates across different metadata fields
   */
  public syncDates(metadata: MediaMetadata): MediaMetadata {
    const syncedMetadata = { ...metadata };

    // Use capture date as the authoritative source
    if (syncedMetadata.captureDate) {
      // If create date is missing or significantly different, sync it
      if (
        !syncedMetadata.createDate ||
        Math.abs(syncedMetadata.createDate.getTime() - syncedMetadata.captureDate.getTime()) >
          86400000
      ) {
        syncedMetadata.createDate = syncedMetadata.captureDate;
      }
    } else if (syncedMetadata.createDate) {
      // If only create date exists, use it as capture date
      syncedMetadata.captureDate = syncedMetadata.createDate;
    }

    return syncedMetadata;
  }

  /**
   * Validate metadata quality and completeness
   */
  public validateMetadata(metadata: MediaMetadata): { score: number; issues: string[] } {
    const issues: string[] = [];
    let score = 100;

    // Check for essential fields
    if (!metadata.captureDate && !metadata.createDate) {
      issues.push('Missing date information');
      score -= 20;
    }

    if (!metadata.dimensions) {
      issues.push('Missing dimensions');
      score -= 10;
    }

    if (!metadata.fileType) {
      issues.push('Missing file type');
      score -= 5;
    }

    // Check for camera metadata (for images)
    if (!metadata.make && !metadata.model) {
      issues.push('Missing camera information');
      score -= 15;
    }

    // Check for technical metadata
    if (!metadata.iso && !metadata.aperture && !metadata.shutterSpeed) {
      issues.push('Missing technical metadata');
      score -= 10;
    }

    return { score: Math.max(0, score), issues };
  }
}
