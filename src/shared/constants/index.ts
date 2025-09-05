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

export const SUPPORTED_IMAGE_FORMATS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
  '.heic',
  '.heif',
  '.raw',
  '.dng',
  '.cr2',
  '.nef',
  '.arw',
  '.ptx',
  '.svg',
  '.pdf',
  '.mpo',
  '.orf',
  '.rw2',
  '.avif',
];

export const SUPPORTED_VIDEO_FORMATS = [
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.mpg',
  '.mpeg',
  '.3gp',
  '.3g2',
  '.mts',
  '.m2ts',
  '.ts',
  '.vob',
  '.ogv',
  '.asf',
  '.rm',
  '.rmvb',
  '.prores',
];

export const SUPPORTED_AUDIO_FORMATS = [
  '.mp3',
  '.wav',
  '.aac',
  '.flac',
  '.m4a',
  '.ogg',
  '.aiff',
  '.alac',
  '.caf',
  '.amr',
  '.wmf',
  '.wma',
  '.opus',
  '.au',
  '.ra',
];

export const SUPPORTED_DOCUMENT_FORMATS = [
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.rtf',
  '.odt',
];

export const SUPPORTED_ART_FORMATS = ['.psd', '.ai', '.indd', '.cdr', '.dwg', '.eps'];

export const ALL_SUPPORTED_FORMATS = [
  ...SUPPORTED_IMAGE_FORMATS,
  ...SUPPORTED_VIDEO_FORMATS,
  ...SUPPORTED_AUDIO_FORMATS,
  ...SUPPORTED_DOCUMENT_FORMATS,
  ...SUPPORTED_ART_FORMATS,
];

// RAW formats that require special handling
export const RAW_IMAGE_FORMATS = [
  '.cr2',
  '.nef',
  '.arw',
  '.dng',
  '.raw',
  '.orf',
  '.rw2',
  '.pef',
  '.x3f',
  '.iiq',
  '.3fr',
  '.fff',
  '.mrw',
  '.bay',
  '.crw',
  '.srf',
  '.sr2',
  '.kdc',
  '.dcr',
  '.k25',
];

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
