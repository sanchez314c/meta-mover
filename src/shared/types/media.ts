/**
 * Core media type definitions for META_Mover
 */

export interface MediaFile {
  id: string; // UUID
  path: string; // Original file path
  size: number; // File size in bytes
  type: MediaType; // Detected media type
  format: string; // File extension
  hash: string; // SHA-256 hash
  metadata: MediaMetadata; // Extracted metadata
  processingStatus: ProcessingStatus;
  error?: ProcessingError;
  createdAt: Date;
  updatedAt: Date;
  corruption?: CorruptionReport;
}

export enum MediaType {
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  ART = 'art',
  UNKNOWN = 'unknown',
}

export enum ProcessingStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  QUARANTINED = 'quarantined',
}

export interface ProcessingError {
  code: string;
  message: string;
  details?: unknown;
  timestamp: Date;
  recoverable: boolean;
}

export interface MediaMetadata {
  // Common metadata
  captureDate?: Date;
  createDate?: Date;
  modifyDate?: Date;
  dimensions?: Dimensions;
  duration?: number; // For video/audio in seconds

  // Camera/Device info
  make?: string;
  model?: string;
  lens?: string;
  serialNumber?: string;

  // Location data
  gps?: GPSData;

  // Technical metadata
  fileType?: string;
  mimeType?: string;
  encoding?: string;
  bitrate?: number;
  frameRate?: number;
  sampleRate?: number;
  colorSpace?: string;

  // Image specific
  iso?: number;
  aperture?: number;
  shutterSpeed?: string;
  focalLength?: number;
  flash?: boolean;
  orientation?: number;

  // Video specific
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;

  // Content metadata
  title?: string;
  description?: string;
  keywords?: string[];
  rating?: number;
  copyright?: string;

  // Subsecond precision from EXIF (SubSecTimeOriginal)
  subsecond?: string;

  // Screenshot detection
  isScreenshot?: boolean;

  // Custom fields
  customFields?: Record<string, unknown>;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface GPSData {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy?: number;
  direction?: number;
  speed?: number;
  timestamp?: Date;
}

export interface ProcessingJob {
  id: string;
  name: string;
  sourcePaths: string[];
  destinationPath: string;
  options: ProcessingOptions;
  status: JobStatus;
  progress: ProcessingProgress;
  files: MediaFile[];
  statistics: ProcessingStatistics;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  estimatedDuration?: number;
}

export enum JobStatus {
  CREATED = 'created',
  QUEUED = 'queued',
  PROCESSING = 'processing',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface ProcessingOptions {
  // Core options
  copyFiles: boolean; // Copy vs move files
  preserveOriginals: boolean; // Keep backup of originals
  createFolderStructure: boolean; // Create year/month folders
  handleDuplicates: DuplicateHandling;

  // Metadata options
  extractMetadata: boolean;
  repairMetadata: boolean;
  preserveTimestamps: boolean;
  syncDates: boolean;

  // Corruption detection
  enableCorruptionDetection: boolean;
  corruptionSeverityThreshold: CorruptionLevel;
  quarantineCorruptedFiles: boolean;

  // Performance options
  workerCount?: number;
  batchSize: number;
  memoryLimit?: number;
  enableGpuAcceleration: boolean;

  // Organization options
  folderTemplate: string;
  filenameTemplate: string;
  groupByResolution: boolean; // For videos
  separateOrientation: boolean; // Portrait/landscape

  // Format options
  supportedFormats: string[];
  convertMpoToJpeg: boolean;
  generateThumbnails: boolean;

  // Advanced options
  enableIncrementalProcessing: boolean;
  skipExistingFiles: boolean;
  verifyFileIntegrity: boolean;
}

export enum DuplicateHandling {
  SKIP = 'skip',
  OVERWRITE = 'overwrite',
  RENAME = 'rename',
  PROMPT = 'prompt',
}

export interface ProcessingProgress {
  phase: ProcessingPhase;
  currentFile?: string;
  filesProcessed: number;
  totalFiles: number;
  bytesProcessed: number;
  totalBytes: number;
  percentage: number;
  estimatedTimeRemaining?: number;
  currentSpeed?: number; // Files per second
}

export enum ProcessingPhase {
  DISCOVERY = 'discovery',
  METADATA_EXTRACTION = 'metadata-extraction',
  CORRUPTION_DETECTION = 'corruption-detection',
  ORGANIZATION = 'organization',
  VERIFICATION = 'verification',
  CLEANUP = 'cleanup',
  COMPLETED = 'completed',
}

export interface ProcessingStatistics {
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  quarantinedFiles: number;
  duplicateFiles: number;
  corruptedFiles: number;
  totalSize: number;
  processedSize: number;
  duration: number; // Processing time in seconds
  averageSpeed: number; // Files per second
  errorRate: number; // Percentage of failed files

  // Media type breakdown
  imageFiles: number;
  videoFiles: number;
  audioFiles: number;
  documentFiles: number;
  artFiles: number;
  unknownFiles: number;

  // Date range
  oldestFile?: Date;
  newestFile?: Date;
}

// Corruption Detection Types (from VidBeast-inspired system)
export enum CorruptionLevel {
  NONE = 'none',
  MINOR = 'minor',
  MODERATE = 'moderate',
  SEVERE = 'severe',
  CATASTROPHIC = 'catastrophic',
}

export enum CorruptionType {
  CONTAINER = 'container',
  STREAM = 'stream',
  BITSTREAM = 'bitstream',
  AUDIO = 'audio',
  METADATA = 'metadata',
  TIMESTAMP = 'timestamp',
}

export interface CorruptionReport {
  filePath: string;
  corruptionLevel: CorruptionLevel;
  corruptionTypes: CorruptionType[];
  isPlayable: boolean;
  playableDuration: number;
  totalDuration: number;
  confidence: number; // Confidence score 0-1
  details: string;
  recoverable: boolean;
  recoveryActions?: string[];
}

// Configuration and Settings Types
export interface AppConfig {
  version: string;
  locale: string;
  theme: 'light' | 'dark' | 'system';

  // Default processing options
  defaultProcessingOptions: ProcessingOptions;

  // UI preferences
  windowBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  // Performance settings
  maxMemoryUsage: number; // In MB
  defaultWorkerCount: number;
  enableHardwareAcceleration: boolean;

  // Paths
  defaultDestinationPath?: string;
  tempDirectory?: string;

  // Advanced settings
  enableTelemetry: boolean;
  autoCheckUpdates: boolean;
  debugMode: boolean;
}

export interface ProcessingProfile {
  id: string;
  name: string;
  description?: string;
  options: ProcessingOptions;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// IPC Types for Electron communication
export interface IPCMessage<T = unknown> {
  type: string;
  payload: T;
  id?: string;
}

export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  id?: string;
}
