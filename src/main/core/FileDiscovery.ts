import * as path from 'path';
import * as fs from 'fs/promises';
import { EventEmitter } from 'events';

export interface DiscoveryOptions {
  recursive?: boolean;
  extensions?: string[];
  maxDepth?: number;
  excludePatterns?: RegExp[];
  excludeOutputDirs?: boolean; // Legacy: skip directories named 'output'
}

export class FileDiscovery extends EventEmitter {
  private aborted: boolean = false;

  public async discover(sourcePath: string, options: DiscoveryOptions = {}): Promise<string[]> {
    // Validate and resolve source path
    const resolvedSourcePath = path.resolve(sourcePath);

    // Ensure the path exists and is a directory
    try {
      const stats = await fs.stat(resolvedSourcePath);
      if (!stats.isDirectory()) {
        throw new Error('Source path must be a directory');
      }
    } catch (error) {
      throw new Error(
        `Invalid source path: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    const {
      recursive = true,
      extensions = [],
      maxDepth = 10,
      excludePatterns = [],
      excludeOutputDirs = true, // Default to true (matches legacy behavior)
    } = options;

    const files: string[] = [];
    await this.scanDirectory(
      resolvedSourcePath,
      files,
      extensions,
      excludePatterns,
      recursive,
      0,
      maxDepth,
      excludeOutputDirs
    );

    return files;
  }

  private async scanDirectory(
    dirPath: string,
    files: string[],
    extensions: string[],
    excludePatterns: RegExp[],
    recursive: boolean,
    currentDepth: number,
    maxDepth: number,
    excludeOutputDirs: boolean = true
  ): Promise<void> {
    if (this.aborted || currentDepth > maxDepth) return;

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (this.aborted) break;

        const fullPath = path.resolve(path.join(dirPath, entry.name));

        // Prevent path traversal attacks
        if (!fullPath.startsWith(path.resolve(dirPath))) {
          this.emit('error', new Error(`Path traversal detected: ${entry.name}`));
          continue;
        }

        if (excludePatterns.some((pattern) => pattern.test(fullPath))) {
          continue;
        }

        if (entry.isDirectory() && recursive) {
          // Skip directories named 'output' (legacy behavior)
          // Matches legacy: dirs[:] = [d for d in dirs if d.lower() != 'output']
          if (excludeOutputDirs && entry.name.toLowerCase() === 'output') {
            this.emit('output-dir-skipped', fullPath);
            continue;
          }

          await this.scanDirectory(
            fullPath,
            files,
            extensions,
            excludePatterns,
            recursive,
            currentDepth + 1,
            maxDepth,
            excludeOutputDirs
          );
        } else if (entry.isFile()) {
          if (
            extensions.length === 0 ||
            extensions.includes(path.extname(entry.name).toLowerCase())
          ) {
            files.push(fullPath);
            this.emit('file-discovered', fullPath);
          }
        }
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  public abort(): void {
    this.aborted = true;
  }
}
