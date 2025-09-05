# API Documentation

META Mover v1.0 API reference for main process, renderer process, and IPC communication.

## Table of Contents
- [Main Process APIs](#main-process-apis)
- [Renderer APIs](#renderer-apis)
- [IPC Communication](#ipc-communication)
- [Redux Store](#redux-store)
- [Shared Types](#shared-types)

## Main Process APIs

### ProcessingEngine

Located in: `src/main/core/ProcessingEngine.ts`

```typescript
class ProcessingEngine {
  // Start processing a job
  async startJob(job: ProcessingJob): Promise<void>

  // Cancel active job
  cancelJob(): void

  // Get job progress
  getProgress(): JobProgress

  // Events
  on(event: 'job-started', callback: (job: ProcessingJob) => void)
  on(event: 'job-progress', callback: (progress: JobProgress) => void)
  on(event: 'job-complete', callback: (result: JobResult) => void)
  on(event: 'job-error', callback: (error: JobError) => void)
}
```

### MetadataExtractor

Located in: `src/main/core/MetadataExtractor.ts`

```typescript
class MetadataExtractor {
  // Extract metadata from image
  async extractImageMetadata(filePath: string): Promise<ImageMetadata>

  // Extract metadata from video
  async extractVideoMetadata(filePath: string): Promise<VideoMetadata>

  // Extract date with fallback priority
  async extractDate(filePath: string): Promise<Date | null>

  // Metadata priority: EXIF → XMP → filename → filesystem
}
```

### FileOrganizer

Located in: `src/main/core/FileOrganizer.ts`

```typescript
class FileOrganizer {
  // Organize file by date
  async organizeByDate(
    source: string,
    destination: string,
    options: OrganizeOptions
  ): Promise<OrganizeResult>

  // Organize videos by resolution
  async organizeVideoByResolution(
    source: string,
    options: OrganizeOptions
  ): Promise<OrganizeResult>

  // Handle naming conflicts
  resolveConflict(filePath: string, existing: string[]): string
}
```

### CorruptionDetector

Located in: `src/main/core/CorruptionDetector.ts`

```typescript
class CorruptionDetector {
  // Check image file integrity
  async checkImage(filePath: string): Promise<CorruptionResult>

  // Check video file integrity
  async checkVideo(filePath: string): Promise<CorruptionResult>

  // Multi-phase detection with false-positive prevention
  async performDeepCheck(filePath: string): Promise<CorruptionResult>
}
```

### Services

#### ConfigManager
Located in: `src/main/services/ConfigManager.ts`

```typescript
class ConfigManager {
  // Get configuration value
  get<T>(key: string, defaultValue?: T): T

  // Set configuration value
  set(key: string, value: any): void

  // Watch for changes
  watch(key: string, callback: (value: any) => void): void
}
```

#### DatabaseManager
Located in: `src/main/services/DatabaseManager.ts`

```typescript
class DatabaseManager {
  // Job history operations
  async saveJob(job: ProcessingJob): Promise<void>
  async getJobs(filters?: JobFilters): Promise<ProcessingJob[]>
  async deleteJob(jobId: string): Promise<void>

  // Metadata cache operations
  async cacheMetadata(filePath: string, metadata: MediaMetadata): Promise<void>
  async getCachedMetadata(filePath: string): Promise<MediaMetadata | null>
}
```

#### IPCHandler
Located in: `src/main/services/IPCHandler.ts`

```typescript
class IPCHandler {
  // Register IPC handlers
  registerHandlers(): void

  // Channels
  // - job:start
  // - job:cancel
  // - job:progress
  // - config:get
  // - config:set
  // - metadata:extract
  // - file:organize
  // - database:*
}
```

## Renderer APIs

### Components

#### ErrorBoundary
Located in: `src/renderer/components/ErrorBoundary.tsx`

```typescript
interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ComponentType<FallbackProps>
}

interface FallbackProps {
  error: Error
  resetErrorBoundary: () => void
}
```

#### LoadingSpinner
Located in: `src/renderer/components/common/LoadingSpinner.tsx`

```typescript
interface LoadingSpinnerProps {
  size?: 'small' | 'medium' | 'large'
  message?: string
}
```

## IPC Communication

### Main → Renderer (Sending)

```typescript
// In main process
mainWindow.webContents.send('channel-name', data)
```

### Renderer → Main (Invoking)

```typescript
// In renderer process
const result = await window.electron.ipcRenderer.invoke('channel-name', args)
```

### Available IPC Channels

| Channel | Direction | Description |
|---------|-----------|-------------|
| `job:start` | Renderer → Main | Start a new processing job |
| `job:cancel` | Renderer → Main | Cancel active job |
| `job:progress` | Main → Renderer | Job progress updates |
| `job:complete` | Main → Renderer | Job completion notification |
| `config:get` | Renderer → Main | Get configuration value |
| `config:set` | Renderer → Main | Set configuration value |
| `metadata:extract` | Renderer → Main | Extract file metadata |
| `file:organize` | Renderer → Main | Organize files |

## Redux Store

Located in: `src/renderer/store/`

### State Structure

```typescript
interface RootState {
  app: AppState
  jobs: JobsState
  settings: SettingsState
  ui: UiState
}
```

### App Slice

Located in: `src/renderer/store/slices/appSlice.ts`

```typescript
interface AppState {
  version: string
  isReady: boolean
  error: string | null
}

// Actions
appReady(): void
appError(error: string): void
clearError(): void
```

### Jobs Slice

Located in: `src/renderer/store/slices/jobsSlice.ts`

```typescript
interface JobsState {
  active: ProcessingJob | null
  history: ProcessingJob[]
  progress: JobProgress | null
}

// Actions
startJob(job: ProcessingJob): void
cancelJob(): void
updateProgress(progress: JobProgress): void
completeJob(result: JobResult): void
```

### Settings Slice

Located in: `src/renderer/store/slices/settingsSlice.ts`

```typescript
interface SettingsState {
  sourceDirectory: string
  destinationDirectory: string
  datePreference: 'exif' | 'xmp' | 'filename' | 'filesystem'
  conflictResolution: 'skip' | 'rename' | 'overwrite'
  videoOrganization: 'flat' | 'resolution'
  enableCorruptionDetection: boolean
}

// Actions
updateSetting<K extends keyof SettingsState>(
  key: K,
  value: SettingsState[K]
): void
resetSettings(): void
```

### UI Slice

Located in: `src/renderer/store/slices/uiSlice.ts`

```typescript
interface UiState {
  theme: 'light' | 'dark' | 'system'
  sidebarOpen: boolean
  activeModal: string | null
  loading: boolean
  loadingMessage: string
}

// Actions
setTheme(theme: UiState['theme']): void
toggleSidebar(): void
openModal(modal: string): void
closeModal(): void
setLoading(loading: boolean, message?: string): void
```

## Shared Types

Located in: `src/shared/types/`

### Media Types

```typescript
// media.ts
interface ImageMetadata {
  filePath: string
  width: number
  height: number
  format: string
  exif: ExifData
  xmp: XmpData | null
  dateTaken: Date | null
  fileSize: number
}

interface VideoMetadata {
  filePath: string
  width: number
  height: number
  duration: number
  format: string
  codec: string
  bitrate: number
  dateCreated: Date | null
  fileSize: number
  resolution: '720p' | '1080p' | '4K' | 'other'
}

interface ExifData {
  dateTaken?: Date
  camera?: string
  lens?: string
  iso?: number
  aperture?: string
  shutterSpeed?: string
  focalLength?: string
  gps?: GpsData
}

interface XmpData {
  dateCreated?: Date
  rating?: number
  labels?: string[]
  keywords?: string[]
}
```

### Job Types

```typescript
// job.ts
interface ProcessingJob {
  id: string
  type: 'image' | 'video' | 'mixed'
  source: string
  destination: string
  options: JobOptions
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: JobProgress
  result?: JobResult
  error?: JobError
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
}

interface JobOptions {
  datePreference: DatePreference
  conflictResolution: ConflictResolution
  videoOrganization: VideoOrganization
  enableCorruptionDetection: boolean
  dryRun: boolean
}

interface JobProgress {
  current: number
  total: number
  percentage: number
  currentFile: string
  estimatedTimeRemaining: number
}
```

### Electron Types

Located in: `src/types/electron.d.ts`

```typescript
interface ElectronAPI {
  ipcRenderer: {
    invoke(channel: string, ...args: any[]): Promise<any>
    on(channel: string, callback: (...args: any[]) => void): void
    once(channel: string, callback: (...args: any[]) => void): void
    removeListener(channel: string, callback: (...args: any[]) => void): void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
  }
}
```

---

*For implementation details, see source files in `src/`*
