/**
 * Advanced Logging System - Structured logging with winston
 *
 * Provides comprehensive logging capabilities with multiple transports,
 * log rotation, and structured data support.
 */

import * as winston from 'winston';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';

import { LOG_CATEGORIES } from '@shared/constants/index';

export class Logger {
  private static instance: Logger;
  private winston: winston.Logger;
  private logDir: string;

  private constructor() {
    // Determine log directory
    this.logDir = path.join(app?.getPath('userData') || os.tmpdir(), 'logs');

    this.winston = this.createLogger();
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private createLogger(): winston.Logger {
    const logFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
      winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] })
    );

    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, category, ...meta }) => {
        const categoryStr = category ? `[${category}] ` : '';
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${level}: ${categoryStr}${message}${metaStr}`;
      })
    );

    return winston.createLogger({
      level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
      format: logFormat,
      defaultMeta: {
        service: 'meta-mover',
        version: '1.0.0',
        pid: process.pid,
      },
      transports: [
        // Console transport for development
        new winston.transports.Console({
          format: consoleFormat,
          level: process.env.NODE_ENV === 'development' ? 'debug' : 'warn',
        }),

        // File transport for all logs
        new winston.transports.File({
          filename: path.join(this.logDir, 'app.log'),
          level: 'info',
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
          tailable: true,
        }),

        // Error file transport
        new winston.transports.File({
          filename: path.join(this.logDir, 'error.log'),
          level: 'error',
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 3,
          tailable: true,
        }),
      ],

      // Handle uncaught exceptions
      exceptionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'exceptions.log'),
          maxsize: 5 * 1024 * 1024, // 5MB
          maxFiles: 2,
        }),
      ],

      // Handle unhandled promise rejections
      rejectionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'rejections.log'),
          maxsize: 5 * 1024 * 1024, // 5MB
          maxFiles: 2,
        }),
      ],
    });
  }

  // Core logging methods
  public error(message: string, meta: Record<string, unknown> = {}): void {
    this.winston.error(message, { category: LOG_CATEGORIES.GENERAL, ...meta });
  }

  public warn(message: string, meta: Record<string, unknown> = {}): void {
    this.winston.warn(message, { category: LOG_CATEGORIES.GENERAL, ...meta });
  }

  public info(message: string, meta: Record<string, unknown> = {}): void {
    this.winston.info(message, { category: LOG_CATEGORIES.GENERAL, ...meta });
  }

  public debug(message: string, meta: Record<string, unknown> = {}): void {
    this.winston.debug(message, { category: LOG_CATEGORIES.GENERAL, ...meta });
  }

  public verbose(message: string, meta: Record<string, unknown> = {}): void {
    this.winston.verbose(message, { category: LOG_CATEGORIES.GENERAL, ...meta });
  }

  // Category-specific logging methods
  public processing(level: string, message: string, meta: Record<string, unknown> = {}): void {
    this.winston.log(level, message, { category: LOG_CATEGORIES.PROCESSING, ...meta });
  }

  public metadata(level: string, message: string, meta: Record<string, unknown> = {}): void {
    this.winston.log(level, message, { category: LOG_CATEGORIES.METADATA, ...meta });
  }

  public corruption(level: string, message: string, meta: Record<string, unknown> = {}): void {
    this.winston.log(level, message, { category: LOG_CATEGORIES.CORRUPTION, ...meta });
  }

  public fileOps(level: string, message: string, meta: Record<string, unknown> = {}): void {
    this.winston.log(level, message, { category: LOG_CATEGORIES.FILE_OPS, ...meta });
  }

  public ui(level: string, message: string, meta: Record<string, unknown> = {}): void {
    this.winston.log(level, message, { category: LOG_CATEGORIES.UI, ...meta });
  }

  public ipc(level: string, message: string, meta: Record<string, unknown> = {}): void {
    this.winston.log(level, message, { category: LOG_CATEGORIES.IPC, ...meta });
  }

  public performance(level: string, message: string, meta: Record<string, unknown> = {}): void {
    this.winston.log(level, message, { category: LOG_CATEGORIES.PERFORMANCE, ...meta });
  }

  // Utility methods
  public setLevel(level: string): void {
    this.winston.level = level;
  }

  public getLogDir(): string {
    return this.logDir;
  }

  // Performance timing helper
  public time(label: string): void {
    console.time(label);
  }

  public timeEnd(label: string, meta: Record<string, unknown> = {}): void {
    console.timeEnd(label);
    this.performance('info', `Timer: ${label}`, meta);
  }

  // Structured error logging
  public logError(error: Error, context: string, meta: Record<string, unknown> = {}): void {
    this.winston.error(`${context}: ${error.message}`, {
      category: LOG_CATEGORIES.GENERAL,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      context,
      ...meta,
    });
  }

  // Job-specific logging
  public logJobEvent(jobId: string, event: string, data: Record<string, unknown> = {}): void {
    this.winston.info(`Job ${event}`, {
      category: LOG_CATEGORIES.PROCESSING,
      jobId,
      event,
      ...data,
    });
  }

  // File operation logging
  public logFileOperation(
    operation: string,
    filePath: string,
    result: Record<string, unknown> = {}
  ): void {
    this.winston.info(`File ${operation}`, {
      category: LOG_CATEGORIES.FILE_OPS,
      operation,
      filePath,
      ...result,
    });
  }

  // System metrics logging
  public logSystemMetrics(): void {
    const metrics = {
      memory: {
        used: process.memoryUsage(),
        system: {
          total: os.totalmem(),
          free: os.freemem(),
        },
      },
      cpu: {
        usage: process.cpuUsage(),
        load: os.loadavg(),
      },
      platform: {
        arch: os.arch(),
        platform: os.platform(),
        version: os.version(),
      },
    };

    this.winston.info('System metrics', {
      category: LOG_CATEGORIES.PERFORMANCE,
      metrics,
    });
  }

  // Cleanup and shutdown
  public async close(): Promise<void> {
    return new Promise((resolve) => {
      this.winston.info('Shutting down logger');

      this.winston.on('finish', () => {
        resolve();
      });

      this.winston.end();
    });
  }
}
