import * as sqlite3 from 'sqlite3';
import { app } from 'electron';
import * as path from 'path';

export interface FileCacheRecord {
  id?: number;
  filepath: string;
  hash?: string;
  metadata?: string;
  lastModified: string;
  createdAt?: string;
  size?: number;
}

export interface JobRecord {
  id?: number;
  type: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  filesProcessed: number;
  totalFiles: number;
  startTime: string;
  endTime?: string;
  error?: string;
  metadata?: string;
}

export class DatabaseManager {
  private static instance: DatabaseManager;
  private db!: sqlite3.Database;
  private dbPath: string;

  private constructor() {
    const userDataPath = app.getPath('userData');
    this.dbPath = path.join(userDataPath, 'metamover.db');
    this.initDatabase();
  }

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  private initDatabase(): void {
    this.db = new sqlite3.Database(this.dbPath);

    this.db.serialize(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          filesProcessed INTEGER DEFAULT 0,
          totalFiles INTEGER DEFAULT 0,
          startTime TEXT NOT NULL,
          endTime TEXT,
          error TEXT,
          metadata TEXT
        )
      `);

      this.db.run(`
        CREATE TABLE IF NOT EXISTS file_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filepath TEXT UNIQUE NOT NULL,
          hash TEXT,
          metadata TEXT,
          lastModified TEXT,
          createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Add size column if it doesn't exist (migration for existing databases)
      this.db.run(`ALTER TABLE file_cache ADD COLUMN size INTEGER`, (_err) => {
        // Ignore error if column already exists
      });
    });
  }

  createJob(job: Omit<JobRecord, 'id'>): Promise<number> {
    return new Promise((resolve, reject) => {
      const { type, status, filesProcessed, totalFiles, startTime, error, metadata } = job;
      this.db.run(
        `INSERT INTO jobs (type, status, filesProcessed, totalFiles, startTime, error, metadata) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [type, status, filesProcessed, totalFiles, startTime, error, metadata],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  updateJob(id: number, updates: Partial<JobRecord>): Promise<void> {
    const ALLOWED_COLUMNS = new Set([
      'type',
      'status',
      'filesProcessed',
      'totalFiles',
      'startTime',
      'endTime',
      'error',
      'metadata',
    ]);
    const fields = Object.keys(updates).filter((key) => ALLOWED_COLUMNS.has(key));
    if (fields.length === 0) return Promise.resolve();
    const setClause = fields.map((key) => `${key} = ?`).join(', ');
    const values: unknown[] = fields.map((key) => (updates as Record<string, unknown>)[key]);
    values.push(id);

    return new Promise((resolve, reject) => {
      this.db.run(`UPDATE jobs SET ${setClause} WHERE id = ?`, values, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getJobs(limit = 100): Promise<JobRecord[]> {
    return new Promise((resolve, reject) => {
      this.db.all(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`, [limit], (err, rows) => {
        if (err) reject(err);
        else resolve(rows as JobRecord[]);
      });
    });
  }

  getJob(id: number): Promise<JobRecord | null> {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT * FROM jobs WHERE id = ?`, [id], (err, row) => {
        if (err) reject(err);
        else resolve((row as JobRecord) || null);
      });
    });
  }

  getJobByUuid(uuid: string): Promise<JobRecord | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM jobs WHERE json_extract(metadata, '$.jobId') = ?`,
        [uuid],
        (err, row) => {
          if (err) reject(err);
          else resolve((row as JobRecord) || null);
        }
      );
    });
  }

  updateJobByUuid(uuid: string, updates: Partial<JobRecord>): Promise<void> {
    const ALLOWED_COLUMNS = new Set([
      'type',
      'status',
      'filesProcessed',
      'totalFiles',
      'startTime',
      'endTime',
      'error',
      'metadata',
    ]);
    const fields = Object.keys(updates).filter((key) => ALLOWED_COLUMNS.has(key));
    if (fields.length === 0) return Promise.resolve();
    const setClause = fields.map((key) => `${key} = ?`).join(', ');
    const values: unknown[] = fields.map((key) => (updates as Record<string, unknown>)[key]);
    values.push(uuid);

    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE jobs SET ${setClause} WHERE json_extract(metadata, '$.jobId') = ?`,
        values,
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveJob(job: any): Promise<number> {
    const jobRecord: Omit<JobRecord, 'id'> = {
      type: job.name || 'processing',
      status: this.mapJobStatus(job.status),
      filesProcessed: job.progress?.filesProcessed || 0,
      totalFiles: job.progress?.totalFiles || 0,
      startTime: job.startedAt?.toISOString() || job.createdAt.toISOString(),
      endTime: job.completedAt?.toISOString(),
      error: job.error?.message,
      metadata: JSON.stringify({
        jobId: job.id,
        sourcePaths: job.sourcePaths,
        destinationPath: job.destinationPath,
        options: job.options,
        statistics: job.statistics,
      }),
    };

    return this.createJob(jobRecord);
  }

  private mapJobStatus(status: string): 'pending' | 'processing' | 'completed' | 'failed' {
    switch (status) {
      case 'created':
      case 'queued':
        return 'pending';
      case 'processing':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      default:
        return 'pending';
    }
  }

  cacheFile(
    filepath: string,
    hash: string,
    metadata: string,
    lastModified: string,
    size: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR REPLACE INTO file_cache (filepath, hash, metadata, lastModified, size) VALUES (?, ?, ?, ?, ?)`,
        [filepath, hash, metadata, lastModified, size],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getCachedFile(filepath: string): Promise<FileCacheRecord | null> {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT * FROM file_cache WHERE filepath = ?`, [filepath], (err, row) => {
        if (err) reject(err);
        else resolve((row as FileCacheRecord) || null);
      });
    });
  }

  isCacheValid(filepath: string, mtime: string, size: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM file_cache WHERE filepath = ? AND lastModified = ? AND size = ?`,
        [filepath, mtime, size.toString()],
        (err, row) => {
          if (err) reject(err);
          else resolve(!!row);
        }
      );
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
