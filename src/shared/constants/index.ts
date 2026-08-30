/**
 * Shared constants for META_Mover application
 * Canonical source — all IPC channels, formats, and config live here.
 */

// Application constants
export const APP_NAME = 'META Mover';
export const APP_VERSION = '1.0.0';

// ─── IPC Channel Names (canonical) ──────────────────────────────────────────
export const IPC_CHANNELS = {
  // Window
  MINIMIZE_WINDOW: 'window:minimize',
  MAXIMIZE_WINDOW: 'window:maximize',
  CLOSE_WINDOW: 'window:close',

  // Dialog
  SELECT_FOLDER: 'dialog:openDirectory',
  SELECT_FILES: 'dialog:openFiles',

  // System
  GET_SYSTEM_INFO: 'system:info',
  SYSTEM_OPEN_PATH: 'system:openPath',
  SYSTEM_GET_PATH: 'system:getPath',

  // Processing
  PROCESSING_START: 'processing:start',
  PROCESSING_PAUSE: 'processing:pause',
  PROCESSING_RESUME: 'processing:resume',
  PROCESSING_CANCEL: 'processing:cancel',
  PROCESSING_PROGRESS: 'processing:progress',
  PROCESSING_COMPLETE: 'processing:complete',
  PROCESSING_ERROR: 'processing:error',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_RESET: 'config:reset',

  // Database
  DB_GET_JOBS: 'db:getJobs',
  DB_GET_JOB: 'db:getJob',

  // External
  OPEN_EXTERNAL: 'open-external',

  // Dev
  OPEN_DEVTOOLS: 'dev:devtools',
  RELOAD_APP: 'dev:reload',
};

// ─── File Format Support ────────────────────────────────────────────────────

export const SUPPORTED_MEDIA_FORMATS = {
  image: [
    '.avif',
    '.bmp',
    '.gif',
    '.heic',
    '.heif',
    '.ico',
    '.jfif',
    '.jpeg',
    '.jpg',
    '.jxl',
    '.png',
    '.tif',
    '.tiff',
    '.webp',
  ],
  raw: [
    '.3fr',
    '.arw',
    '.cr2',
    '.cr3',
    '.dcr',
    '.dng',
    '.erf',
    '.fff',
    '.iiq',
    '.kdc',
    '.mef',
    '.mos',
    '.mrw',
    '.nef',
    '.nrw',
    '.orf',
    '.pef',
    '.raf',
    '.raw',
    '.rw2',
    '.rwl',
    '.sr2',
    '.srf',
    '.srw',
    '.x3f',
  ],
  video: [
    '.3g2',
    '.3gp',
    '.asf',
    '.avi',
    '.divx',
    '.flv',
    '.m2ts',
    '.m4v',
    '.mkv',
    '.mov',
    '.mp4',
    '.mpeg',
    '.mpg',
    '.mts',
    '.ogv',
    '.rm',
    '.rmvb',
    '.ts',
    '.vob',
    '.webm',
    '.wmv',
  ],
  audio: [
    '.aac',
    '.aif',
    '.aiff',
    '.alac',
    '.ape',
    '.caf',
    '.flac',
    '.m4a',
    '.mka',
    '.mp3',
    '.oga',
    '.ogg',
    '.opus',
    '.wav',
    '.wma',
  ],
  document: [
    '.ai',
    '.doc',
    '.docx',
    '.eps',
    '.indd',
    '.odg',
    '.odp',
    '.ods',
    '.odt',
    '.pdf',
    '.ppt',
    '.pptx',
    '.ps',
    '.rtf',
    '.svg',
    '.xls',
    '.xlsx',
  ],
  art: ['.kra', '.ora', '.psb', '.psd', '.xcf'],
} as const;

export type SupportedMediaKind = keyof typeof SUPPORTED_MEDIA_FORMATS;

export function normalizedFileExtension(filePath: string): string {
  const basename = filePath.slice(
    Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1
  );
  const dot = basename.lastIndexOf('.');
  return dot < 0 ? '' : basename.slice(dot).toLowerCase();
}

export function classifyMediaExtension(filePath: string): SupportedMediaKind | null {
  const extension = normalizedFileExtension(filePath);
  for (const [kind, extensions] of Object.entries(SUPPORTED_MEDIA_FORMATS) as [
    SupportedMediaKind,
    readonly string[],
  ][]) {
    if (extensions.includes(extension)) return kind;
  }
  return null;
}

export const SUPPORTED_IMAGE_FORMATS = [...SUPPORTED_MEDIA_FORMATS.image];
export const RAW_IMAGE_FORMATS = [...SUPPORTED_MEDIA_FORMATS.raw];
export const SUPPORTED_VIDEO_FORMATS = [...SUPPORTED_MEDIA_FORMATS.video];
export const SUPPORTED_AUDIO_FORMATS = [...SUPPORTED_MEDIA_FORMATS.audio];
export const SUPPORTED_DOCUMENT_FORMATS = [...SUPPORTED_MEDIA_FORMATS.document];
export const SUPPORTED_ART_FORMATS = [...SUPPORTED_MEDIA_FORMATS.art];
export const ALL_SUPPORTED_FORMATS = Object.values(SUPPORTED_MEDIA_FORMATS).flat();

// ─── Processing ─────────────────────────────────────────────────────────────

export const PROCESSING_LIMITS = {
  MAX_WORKER_COUNT: 10,
  MIN_WORKER_COUNT: 1,
  DEFAULT_WORKER_COUNT: 4,
  MAX_BATCH_SIZE: 10,
  DEFAULT_BATCH_SIZE: 5,
  MAX_MEMORY_LIMIT_MB: 8192,
  DEFAULT_MEMORY_LIMIT_MB: 2048,
  FILE_TIMEOUT_MS: 30000,
  METADATA_TIMEOUT_MS: 10000,
  MAX_CONCURRENT_JOBS: 4,
  MAX_FILE_SIZE: 10 * 1024 * 1024 * 1024, // 10GB
  MAX_RETRY_ATTEMPTS: 3,
  WORKER_POOL_SIZE: 4,
  // Timeout constants from legacy (seconds)
  FFPROBE_TIMEOUT: 30,
  FFMPEG_PLAYABILITY_TIMEOUT: 15,
  EXIFTOOL_TIMEOUT: 30,
  SUBSECOND_TIMEOUT: 10,
  // Video testing constants from legacy
  PLAYABILITY_TEST_DURATION: 5,
  // Bitrate thresholds (bits per second) from legacy
  MIN_ACCEPTABLE_BITRATE: 10000,
  NORMAL_BITRATE_MIN: 100000,
};

// ─── Corruption Detection ───────────────────────────────────────────────────

export const CORRUPTION_THRESHOLDS = {
  HEADER_CHECK_SIZE: 1024,
  MIN_FILE_SIZE: 100,
  MAX_ZERO_BYTES_RATIO: 0.9,
  VIDEO_DURATION_THRESHOLD: 0.1,
  MINOR_THRESHOLD: 0.1,
  MODERATE_THRESHOLD: 0.3,
  SEVERE_THRESHOLD: 0.6,
  CATASTROPHIC_THRESHOLD: 0.8,
};

// ─── Templates ──────────────────────────────────────────────────────────────

export const DEFAULT_FOLDER_TEMPLATES = {
  dateOnly: '{year}/{month:02d}',
  dateAndType: '{year}/{month:02d}/{mediaType}',
  typeAndDate: '{mediaType}/{year}/{month:02d}',
  resolution: '{mediaType}/{year}/{resolution}',
  device: '{make}/{year}/{month:02d}',
  custom: '{year}/{month:02d}/{day:02d}',
};

export const DEFAULT_FILENAME_TEMPLATES = {
  datePrefix: '{year}-{month:02d}-{day:02d}_{hour:02d}-{minute:02d}-{second:02d}_{originalName}',
  dateOnly: '{year}-{month:02d}-{day:02d}_{hour:02d}-{minute:02d}-{second:02d}',
  original: '{originalName}',
  sequential: '{year}-{month:02d}-{day:02d}_{sequence:04d}',
  device: '{make}_{model}_{year}-{month:02d}-{day:02d}_{hour:02d}-{minute:02d}-{second:02d}',
};

// ─── Error Codes ────────────────────────────────────────────────────────────

export const ERROR_CODES = {
  // File system errors
  UNKNOWN: 'UNKNOWN',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  DISK_FULL: 'DISK_FULL',
  PATH_TOO_LONG: 'PATH_TOO_LONG',
  INVALID_FORMAT: 'INVALID_FORMAT',

  // Processing errors
  CORRUPTION_DETECTED: 'CORRUPTION_DETECTED',
  CORRUPTION_DETECTION_FAILED: 'CORRUPTION_DETECTION_FAILED',
  METADATA_EXTRACTION_FAILED: 'METADATA_EXTRACTION_FAILED',
  FILE_ORGANIZATION_FAILED: 'FILE_ORGANIZATION_FAILED',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',

  // System errors
  INSUFFICIENT_MEMORY: 'INSUFFICIENT_MEMORY',
  WORKER_TIMEOUT: 'WORKER_TIMEOUT',
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',

  // Configuration errors
  INVALID_CONFIG: 'INVALID_CONFIG',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',

  // Job errors
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  JOB_ALREADY_RUNNING: 'JOB_ALREADY_RUNNING',
  JOB_CANCELLED: 'JOB_CANCELLED',
};

// ─── Configuration ──────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  version: APP_VERSION,
  locale: 'en',
  theme: 'system' as const,
  maxMemoryUsage: PROCESSING_LIMITS.DEFAULT_MEMORY_LIMIT_MB,
  defaultWorkerCount: PROCESSING_LIMITS.DEFAULT_WORKER_COUNT,
  enableHardwareAcceleration: true,
  enableTelemetry: false,
  autoCheckUpdates: true,
  debugMode: false,
  defaultProcessingOptions: {
    copyFiles: false,
    preserveOriginals: false,
    createFolderStructure: true,
    handleDuplicates: 'rename' as const,
    extractMetadata: true,
    repairMetadata: true,
    preserveTimestamps: true,
    syncDates: true,
    enableCorruptionDetection: true,
    corruptionSeverityThreshold: 'moderate' as const,
    quarantineCorruptedFiles: true,
    batchSize: PROCESSING_LIMITS.DEFAULT_BATCH_SIZE,
    enableGpuAcceleration: false,
    folderTemplate: DEFAULT_FOLDER_TEMPLATES.dateAndType,
    filenameTemplate: DEFAULT_FILENAME_TEMPLATES.dateOnly,
    groupByResolution: true,
    separateOrientation: false,
    supportedFormats: ALL_SUPPORTED_FORMATS,
    convertMpoToJpeg: true,
    generateThumbnails: true,
    enableIncrementalProcessing: true,
    skipExistingFiles: true,
    verifyFileIntegrity: true,
  },
};

// ─── Logging ────────────────────────────────────────────────────────────────

export const LOG_CATEGORIES = {
  GENERAL: 'general',
  SYSTEM: 'system',
  PROCESSING: 'processing',
  DATABASE: 'database',
  METADATA: 'metadata',
  CORRUPTION: 'corruption',
  FILE_OPS: 'file-ops',
  UI: 'ui',
  IPC: 'ipc',
  NETWORK: 'network',
  PERFORMANCE: 'performance',
};
