/**
 * File Organizer - Intelligent file organization matching legacy v2.3.0 logic
 *
 * Ported from legacy media-organizer-enhanced-v2.3.0-safe-optimized.py
 * Includes: screenshot routing, corrupt/error routing, EXIF write-back,
 * disk space check, 2-digit conflict counter, date-based filename format.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

import {
  MediaFile,
  ProcessingOptions,
  MediaType,
  MediaMetadata,
  CorruptionLevel,
} from '@shared/types/media';

import { Logger } from '../utils/Logger';
import { FileSystemUtils } from '../utils/FileSystemUtils';
import { DateExtractor } from '../utils/DateExtractor';

interface OrganizationResult {
  success: boolean;
  originalPath: string;
  newPath?: string;
  operation: 'copy' | 'move' | 'skip';
  error?: string;
  duplicateHandled?: boolean;
}

export class FileOrganizer {
  private logger: Logger;
  private dateExtractor: DateExtractor;

  constructor() {
    this.logger = Logger.getInstance();
    this.dateExtractor = new DateExtractor();
  }

  /**
   * Organize a media file according to the specified options.
   * Matches legacy process_batch() logic.
   */
  public async organizeFile(
    file: MediaFile,
    destinationRoot: string,
    options: ProcessingOptions
  ): Promise<OrganizationResult> {
    try {
      this.logger.debug('Organizing file', {
        filePath: file.path,
        destinationRoot,
        mediaType: file.type,
      });

      // Skip if file doesn't exist (legacy: validate file exists at start)
      if (!(await FileSystemUtils.fileExists(file.path))) {
        return {
          success: false,
          originalPath: file.path,
          operation: 'skip',
          error: 'File does not exist',
        };
      }

      // Skip files in 'output' directories (legacy logic)
      const pathParts = file.path.split(path.sep);
      if (pathParts.some((p) => p.toLowerCase() === 'output')) {
        return {
          success: false,
          originalPath: file.path,
          operation: 'skip',
          error: 'File in output directory',
        };
      }

      // Determine target folder structure using legacy logic
      const targetFolder = this.determineOutputPath(
        file,
        destinationRoot,
        false // not error
      );

      // Generate target filename using legacy format: YYYY-MM-DD_HH-MM-SS[.sss].ext
      const organizationDate = this.getOrganizationDate(file.metadata);
      const originalFilename = path.basename(file.path);

      // Handle MPO → JPEG conversion
      let filenameForFormat = originalFilename;
      if (originalFilename.toLowerCase().endsWith('.mpo')) {
        filenameForFormat = originalFilename.replace(/\.mpo$/i, '.jpg');
      }

      const targetFilename = this.dateExtractor.formatFilenameWithDate(
        filenameForFormat,
        organizationDate,
        file.metadata.subsecond || ''
      );

      // Sanitize filename (legacy sanitize_filename)
      const sanitizedFilename = this.sanitizeFilename(targetFilename);

      // Ensure target directory exists
      await FileSystemUtils.ensureDirectory(targetFolder);

      let finalPath = path.join(targetFolder, sanitizedFilename);

      // Handle filename conflicts with zero-padded 2-digit counters (_01, _02, _03)
      // Matches legacy counter format
      let counter = 1;
      const baseFinalPath = finalPath;
      while (await FileSystemUtils.fileExists(finalPath)) {
        const parsed = path.parse(baseFinalPath);
        finalPath = path.join(
          parsed.dir,
          `${parsed.name}_${counter.toString().padStart(2, '0')}${parsed.ext}`
        );
        counter++;
        if (counter > 99) {
          throw new Error(`Could not generate unique filename for: ${baseFinalPath}`);
        }
      }

      // Check disk space before move/copy (legacy check_disk_space)
      const fileSize = file.size || 0;
      if (fileSize > 0) {
        const hasSpace = await this.checkDiskSpace(targetFolder, fileSize * 2);
        if (!hasSpace) {
          return {
            success: false,
            originalPath: file.path,
            operation: 'skip',
            error: 'Insufficient disk space',
          };
        }
      }

      // Perform the file operation
      const operation = options.copyFiles ? 'copy' : 'move';

      if (operation === 'copy') {
        await FileSystemUtils.copyFile(file.path, finalPath);
      } else {
        await FileSystemUtils.moveFile(file.path, finalPath);
      }

      // Set EXIF CreateDate from final filename + sync file system timestamps
      // Matches legacy set_exif_create_date_from_filename()
      await this.setExifCreateDateFromFilename(finalPath);

      // Verify file integrity if requested.
      // For copies: compare source (still exists) with destination.
      // For moves: verify destination is intact by checking size against recorded value
      // (source is gone after move, so we validate the destination independently).
      if (options.verifyFileIntegrity) {
        if (operation === 'copy') {
          const verified = await this.verifyFileIntegrity(file.path, finalPath);
          if (!verified) {
            return {
              success: false,
              originalPath: file.path,
              operation,
              error: 'File integrity verification failed after copy',
            };
          }
        } else {
          // Move: verify destination file is non-empty and matches recorded size
          try {
            const destStats = await fs.stat(finalPath);
            if (destStats.size === 0) {
              return {
                success: false,
                originalPath: file.path,
                operation,
                error: 'Destination file is empty after move',
              };
            }
            if (file.size > 0 && destStats.size !== file.size) {
              return {
                success: false,
                originalPath: file.path,
                operation,
                error: 'File size mismatch after move',
              };
            }
          } catch {
            return {
              success: false,
              originalPath: file.path,
              operation,
              error: 'Cannot verify destination file after move',
            };
          }
        }
      }

      this.logger.info('File organized successfully', {
        originalPath: file.path,
        newPath: finalPath,
        operation,
      });

      return {
        success: true,
        originalPath: file.path,
        newPath: finalPath,
        operation,
        duplicateHandled: finalPath !== path.join(targetFolder, sanitizedFilename),
      };
    } catch (error) {
      this.logger.error('File organization failed', {
        filePath: file.path,
        error,
      });

      // Try to move to error directory (legacy error handling)
      try {
        const errorFolder = this.determineOutputPath(file, destinationRoot, true);
        await FileSystemUtils.ensureDirectory(errorFolder);

        const errorFilename = this.sanitizeFilename(path.basename(file.path));
        let errorPath = path.join(errorFolder, errorFilename);

        let counter = 1;
        const baseErrorPath = errorPath;
        while (await FileSystemUtils.fileExists(errorPath)) {
          const parsed = path.parse(baseErrorPath);
          errorPath = path.join(
            parsed.dir,
            `${parsed.name}_${counter.toString().padStart(2, '0')}${parsed.ext}`
          );
          counter++;
        }

        if (await FileSystemUtils.fileExists(file.path)) {
          await FileSystemUtils.moveFile(file.path, errorPath);
          this.logger.info('Moved error file to:', { errorPath });
        }
      } catch (moveError) {
        this.logger.error('Failed to move error file', { filePath: file.path, error: moveError });
      }

      return {
        success: false,
        originalPath: file.path,
        operation: options.copyFiles ? 'copy' : 'move',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Determine the output path for a file based on its metadata and type.
   * Ported from legacy determine_output_path().
   *
   * Structure:
   * - Normal: {destination}/{mediaFolder}/{year}
   * - Screenshots: {destination}/Screenshots/{year}
   * - Corrupt: {destination}/corrupt/{mediaFolder}/{year}
   * - Error: {destination}/Error/{mediaFolder}/{year}
   */
  private determineOutputPath(file: MediaFile, destinationRoot: string, isError: boolean): string {
    // Map media types to folder names (matches legacy folder_mapping)
    const folderMapping: Record<string, string> = {
      [MediaType.IMAGE]: 'Photos',
      [MediaType.VIDEO]: 'Videos',
      [MediaType.AUDIO]: 'Audio',
      [MediaType.DOCUMENT]: 'Documents',
      [MediaType.ART]: 'Art',
      [MediaType.UNKNOWN]: 'Other',
    };

    let mediaFolder = folderMapping[file.type] || 'Other';

    // Check if image is a screenshot → route to Screenshots folder (legacy is_screenshot)
    if (file.type === MediaType.IMAGE && file.metadata.isScreenshot) {
      mediaFolder = 'Screenshots';
      this.logger.debug('Routing screenshot to Screenshots folder', { filePath: file.path });
    }

    // Get the date for organization
    const organizationDate = this.getOrganizationDate(file.metadata);
    const year = organizationDate.getUTCFullYear().toString();

    // Handle corrupted files first (highest priority) - matches legacy
    if (
      file.corruption &&
      file.corruption.corruptionLevel !== CorruptionLevel.NONE &&
      file.corruption.corruptionLevel !== CorruptionLevel.MINOR
    ) {
      return path.join(destinationRoot, 'corrupt', mediaFolder, year);
    }

    // Handle error files
    if (isError) {
      return path.join(destinationRoot, 'Error', mediaFolder, year);
    }

    // Standard organization: {mediaFolder}/{year}
    return path.join(destinationRoot, mediaFolder, year);
  }

  /**
   * Get the date to use for file organization.
   * Priority: captureDate > createDate > modifyDate > current date
   */
  private getOrganizationDate(metadata: MediaMetadata): Date {
    return metadata.captureDate || metadata.createDate || metadata.modifyDate || new Date();
  }

  /**
   * Sanitize filename for filesystem safety.
   * Matches legacy sanitize_filename().
   */
  private sanitizeFilename(filename: string): string {
    // Remove null bytes and control characters
    let sanitized = filename.replace(/[\x00-\x1f]/g, '');

    // Replace problematic characters with underscore
    // Keep: alphanumeric, space, hyphen, underscore, dot, parentheses
    sanitized = sanitized.replace(/[<>:"|?*]/g, '_');

    // Remove leading/trailing spaces and dots
    sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '');

    // Limit length (most filesystems limit to 255)
    const name = path.parse(sanitized).name;
    const ext = path.extname(sanitized);
    if (sanitized.length > 250) {
      sanitized = name.substring(0, 250 - ext.length) + ext;
    }

    return sanitized || 'unnamed_file';
  }

  /**
   * Set EXIF CreateDate and file system timestamps from the filename.
   * Ported from legacy set_exif_create_date_from_filename().
   *
   * Parses the filename (format: YYYY-MM-DD_HH-MM-SS[.sss][_##].ext) and:
   * 1. Sets file system mtime/atime so Finder displays the correct date
   * 2. Attempts to write EXIF CreateDate via exiftool if available
   */
  private async setExifCreateDateFromFilename(filePath: string): Promise<boolean> {
    try {
      const basename = path.parse(filePath).name;

      // Strip counter suffix (_##) if present from conflict resolution
      const stripped = basename.replace(/_\d+$/, '');

      // Parse format: YYYY-MM-DD_HH-MM-SS[.sss]
      const match = stripped.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:\.(\d+))?$/);
      if (!match) {
        return false;
      }

      const [, year, month, day, hour, minute, second, subsecond] = match;

      // Set file system timestamps (most important - what Finder/file managers use)
      try {
        const fileDateTime = new Date(
          Date.UTC(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day),
            parseInt(hour),
            parseInt(minute),
            parseInt(second)
          )
        );
        const timestamp = fileDateTime.getTime() / 1000;
        fsSync.utimesSync(filePath, timestamp, timestamp);
      } catch (utimeError) {
        this.logger.debug('Could not set file system timestamps', { error: utimeError });
      }

      // Attempt EXIF write-back via exiftool (non-blocking, best-effort)
      try {
        const exifDate = `${year}:${month}:${day} ${hour}:${minute}:${second}`;
        const args = ['-CreateDate=' + exifDate, '-overwrite_original'];

        if (subsecond) {
          const padded = subsecond.padEnd(6, '0').substring(0, 6);
          args.push(`-SubSecTimeOriginal=${padded}`);
          args.push(`-SubSecDateTimeOriginal=${exifDate}.${padded}`);
        }

        args.push(filePath);

        await this.runExiftool(args);
      } catch {
        // ExifTool not available or failed - that's OK, filesystem timestamps are set
      }

      return true;
    } catch (error) {
      this.logger.debug('Error setting CreateDate from filename', { filePath, error });
      return false;
    }
  }

  /**
   * Run exiftool command (best-effort, non-blocking).
   */
  private runExiftool(args: string[]): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn('exiftool', args, { stdio: 'ignore' });
      proc.on('close', () => resolve());
      proc.on('error', () => resolve()); // Silently fail if exiftool not found
      setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve();
      }, 10000);
    });
  }

  /**
   * Check disk space before file operations.
   * Ported from legacy check_disk_space().
   */
  private async checkDiskSpace(targetPath: string, requiredBytes: number): Promise<boolean> {
    try {
      const stats = fsSync.statfsSync(targetPath);
      const availableSpace = stats.bfree * stats.bsize;
      return availableSpace >= requiredBytes;
    } catch {
      return true; // Assume OK if we can't check
    }
  }

  /**
   * Verify file integrity after copy/move operation.
   */
  private async verifyFileIntegrity(originalPath: string, newPath: string): Promise<boolean> {
    try {
      const originalStats = await fs.stat(originalPath);
      const newStats = await fs.stat(newPath);

      if (originalStats.size !== newStats.size) {
        this.logger.error('File size mismatch after operation', {
          originalPath,
          newPath,
          originalSize: originalStats.size,
          newSize: newStats.size,
        });
        return false;
      }

      // For small files, compare checksums
      if (originalStats.size < 100 * 1024 * 1024) {
        const originalHash = await this.calculateFileHash(originalPath);
        const newHash = await this.calculateFileHash(newPath);

        if (originalHash !== newHash) {
          this.logger.error('File checksum mismatch', { originalPath, newPath });
          return false;
        }
      }

      return true;
    } catch (error) {
      this.logger.error('File integrity verification failed', { originalPath, newPath, error });
      return false;
    }
  }

  /**
   * Calculate SHA-256 hash of a file.
   */
  private calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fsSync.createReadStream(filePath);
      stream.on('data', (data: string | Buffer) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Remove empty directories recursively.
   * Ported from legacy remove_empty_directories().
   */
  public async removeEmptyDirectories(dirPath: string): Promise<number> {
    let removedCount = 0;

    try {
      const stats = await fs.stat(dirPath);
      if (!stats.isDirectory()) return 0;
    } catch {
      return 0;
    }

    try {
      const entries = await fs.readdir(dirPath);

      if (entries.length === 0) {
        await fs.rmdir(dirPath);
        this.logger.debug('Removed empty directory', { dirPath });
        return 1;
      }

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry);
        try {
          const entryStats = await fs.stat(fullPath);
          if (entryStats.isDirectory()) {
            removedCount += await this.removeEmptyDirectories(fullPath);
          }
        } catch {
          continue;
        }
      }

      // Check again after processing subdirectories
      try {
        const remaining = await fs.readdir(dirPath);
        if (remaining.length === 0) {
          await fs.rmdir(dirPath);
          this.logger.debug('Removed empty directory', { dirPath });
          removedCount++;
        }
      } catch {
        // Directory may have been repopulated
      }
    } catch (error) {
      this.logger.warn('Error checking directory', { dirPath, error });
    }

    return removedCount;
  }

  /**
   * Create a backup manifest.
   */
  public async createBackup(
    files: MediaFile[],
    backupPath: string
  ): Promise<{ success: boolean; backupManifest?: string }> {
    try {
      await FileSystemUtils.ensureDirectory(backupPath);

      const manifest = {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        fileCount: files.length,
        files: files.map((file) => ({
          originalPath: file.path,
          size: file.size,
          hash: file.hash,
          metadata: file.metadata,
        })),
      };

      const manifestPath = path.join(backupPath, 'backup_manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      this.logger.info('Backup manifest created', { manifestPath });
      return { success: true, backupManifest: manifestPath };
    } catch (error) {
      this.logger.error('Failed to create backup', { backupPath, error });
      return { success: false };
    }
  }

  /**
   * Generate organization preview without moving files.
   */
  public async previewOrganization(
    files: MediaFile[],
    destinationRoot: string,
    options: ProcessingOptions
  ): Promise<Array<{ original: string; target: string; operation: string }>> {
    const preview: Array<{ original: string; target: string; operation: string }> = [];

    for (const file of files) {
      try {
        const targetFolder = this.determineOutputPath(file, destinationRoot, false);
        const organizationDate = this.getOrganizationDate(file.metadata);
        const targetFilename = this.dateExtractor.formatFilenameWithDate(
          path.basename(file.path),
          organizationDate,
          file.metadata.subsecond || ''
        );
        const targetPath = path.join(targetFolder, this.sanitizeFilename(targetFilename));

        preview.push({
          original: file.path,
          target: targetPath,
          operation: options.copyFiles ? 'copy' : 'move',
        });
      } catch (error) {
        this.logger.error('Preview generation failed', { filePath: file.path, error });
      }
    }

    return preview;
  }

  /**
   * Validate organization options.
   */
  public validateOptions(options: ProcessingOptions): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (options.batchSize <= 0 || options.batchSize > 10000) {
      errors.push('Batch size must be between 1 and 10000');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
