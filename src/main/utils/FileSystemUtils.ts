import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { promisify } from 'util';

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const copyFile = promisify(fs.copyFile);
const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);

export class FileSystemUtils {
  static async walkDirectory(dir: string, pattern?: RegExp): Promise<string[]> {
    const files: string[] = [];

    async function walk(currentPath: string) {
      const entries = await readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (!pattern || pattern.test(fullPath)) {
          files.push(fullPath);
        }
      }
    }

    await walk(dir);
    return files;
  }

  static async getFileHash(filePath: string, algorithm = 'sha256'): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algorithm);
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  static async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await mkdir(dirPath, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  static async moveFile(source: string, destination: string): Promise<void> {
    try {
      await rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        // Cross-device move: copy then verify before deleting source
        await copyFile(source, destination);

        // Verify destination is intact (non-empty and same size) before removing source
        const [srcStats, dstStats] = await Promise.all([stat(source), stat(destination)]);
        if (dstStats.size !== srcStats.size) {
          // Destination corrupted — remove bad copy, leave source intact
          try {
            await unlink(destination);
          } catch {
            /* best-effort */
          }
          throw new Error(
            `Cross-device copy verification failed: size mismatch (${srcStats.size} vs ${dstStats.size})`
          );
        }

        await unlink(source);
      } else {
        throw error;
      }
    }
  }

  static async copyFile(source: string, destination: string): Promise<void> {
    await copyFile(source, destination);
  }

  static async copyFileWithMetadata(source: string, destination: string): Promise<void> {
    await copyFile(source, destination);

    try {
      const stats = await stat(source);
      fs.utimesSync(destination, stats.atime, stats.mtime);
    } catch (error) {
      // Ignore metadata preservation errors
    }
  }

  static generateUniqueFilename(basePath: string, filename: string): string {
    const dir = path.dirname(basePath);
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);

    let counter = 1;
    let newPath = basePath;

    while (fs.existsSync(newPath)) {
      newPath = path.join(dir, `${base}_${counter}${ext}`);
      counter++;
    }

    return newPath;
  }

  static async getFileSize(filePath: string): Promise<number> {
    const stats = await stat(filePath);
    return stats.size;
  }

  static async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  static async setFileDate(filePath: string, date: Date): Promise<void> {
    try {
      const time = date.getTime() / 1000;
      fs.utimesSync(filePath, time, time);
    } catch (error) {
      // Ignore errors when setting file date
    }
  }

  static formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
}
