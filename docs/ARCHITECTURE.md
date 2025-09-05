# META Mover Architecture

## Overview

META Mover is an Electron-based media organization application built with React 19, TypeScript, Redux Toolkit, and Webpack. The architecture follows a multi-process model with clear separation between system operations (Main process), UI (Renderer process), and secure IPC communication (Preload script).

## Process Model

### Main Process
**Entry Point:** `src/main/index.ts`

The Main process manages application lifecycle, system-level operations, and coordinates all backend functionality. It is responsible for:
- Application initialization and window management
- File system operations and media processing
- Database management and configuration
- IPC communication with the Renderer process

### Renderer Process
**Entry Point:** `src/renderer/App.tsx`

The Renderer process runs the React-based UI in a Chromium environment. It handles:
- User interface rendering and interaction
- State management via Redux Toolkit
- Communication with Main process via IPC
- Real-time updates and progress reporting

### Preload Script
**Entry Point:** `src/preload/index.ts`

The Preload script establishes a secure bridge between Main and Renderer processes using Electron's `contextBridge` API. It exposes controlled APIs to the Renderer without granting full Node.js access.

## Main Process Architecture

### Core Components (`src/main/core/`)

**ProcessingEngine**
- Orchestrates media file processing workflows
- Manages job queue and worker threads
- Coordinates between MetadataExtractor, FileOrganizer, and CorruptionDetector

**MetadataExtractor**
- Extracts metadata from media files (photos, videos, audio)
- Supports EXIF, IPTC, XMP, ID3, and other metadata formats
- Interfaces with FFProbe for video/audio analysis

**FileOrganizer**
- Implements file organization strategies based on metadata
- Applies user-defined templates for directory structure
- Handles file moves, copies, and naming conventions

**CorruptionDetector**
- Validates file integrity and detects corrupt media files
- Performs checksums and format validation
- Quarantines problematic files for review

**FileDiscovery**
- Recursive directory scanning and file enumeration
- File type detection and filtering
- Progress reporting for large directory structures

### Services (`src/main/services/`)

**ConfigManager**
- Manages application configuration and user preferences
- Persists settings to disk
- Validates configuration schemas

**DatabaseManager**
- SQLite database abstraction layer
- Manages media file records, processing history, and metadata cache
- Handles database migrations and schema updates

**IPCHandler**
- Central hub for all IPC communication
- Routes messages between Main and Renderer processes
- Implements request/response and event patterns

**LegacyMigration**
- Migrates data from previous application versions
- Handles schema transformations and data compatibility
- Ensures backward compatibility during upgrades

**WindowManager**
- Creates and manages application windows
- Handles window state persistence (size, position)
- Manages window lifecycle events

### Utilities (`src/main/utils/`)

**DateExtractor**
- Parses dates from metadata, filenames, and file attributes
- Handles multiple date formats and time zones
- Provides fallback strategies for missing date information

**FFProbeWrapper**
- Wraps FFProbe binary for media file analysis
- Extracts codec information, duration, resolution, bitrate
- Handles error cases and timeouts

**FileSystemUtils**
- Common file system operations (copy, move, delete, rename)
- Path manipulation and validation
- Cross-platform compatibility layer

**JobQueue**
- Manages asynchronous task execution
- Priority-based job scheduling
- Concurrency control and resource management

**Logger**
- Application-wide logging infrastructure
- Log levels (debug, info, warn, error)
- File and console output with rotation

**MenuBuilder**
- Constructs application menus (File, Edit, View, Help)
- Platform-specific menu adaptations
- Handles menu actions and keyboard shortcuts

**PerformanceMonitor**
- Tracks application performance metrics
- Memory usage, CPU utilization, processing throughput
- Reports bottlenecks and resource constraints

**TemplateEngine**
- Processes user-defined organization templates
- Variable substitution (date, metadata fields, file attributes)
- Validates template syntax

## Renderer Architecture

### React Application (`src/renderer/`)

**App.tsx**
- Root component
- Sets up Redux store provider
- Initializes global styles and themes

**Components Directory (`src/renderer/components/`)**
- Modular React components
- Smart containers and presentational components
- Hooks for IPC communication and state management

**Redux Store (`src/renderer/store/`)**
- Redux Toolkit slices for state management
- Async thunks for IPC operations
- Selectors for derived state

**Styles (`src/renderer/styles/`)**
- Global CSS and theme definitions
- Component-specific stylesheets
- Responsive design utilities

## Shared Resources

### Types (`src/shared/types/`)

**media.ts**
- TypeScript interfaces and types for media files
- Metadata schemas
- Processing job definitions
- Shared between Main and Renderer for type safety

### Constants (`src/shared/constants/`)

**index.ts**
- Application-wide constants
- IPC channel names
- Configuration defaults
- File type definitions

## Data Flow

### IPC Communication Pattern

1. **Renderer to Main (Request)**
   - UI component dispatches action
   - Redux thunk invokes preload API
   - Preload sends IPC message to Main
   - Main process handles request

2. **Main to Renderer (Response)**
   - Main process completes operation
   - Sends IPC response back to Renderer
   - Preload receives and forwards to window
   - Redux state updates, UI re-renders

3. **Main to Renderer (Events)**
   - Main process emits progress/status events
   - Preload receives events via IPC
   - Events propagate to Redux store
   - UI displays real-time updates

### ContextBridge Security

The Preload script uses `contextBridge.exposeInMainWorld()` to create a controlled API surface:
- Prevents direct Node.js access from Renderer
- Validates and sanitizes all IPC messages
- Enforces type safety at runtime
- Logs all cross-process communications

## Build System

### Webpack Configuration (`config/`)

**webpack.main.config.js**
- Bundles Main process code
- TypeScript compilation
- Source maps for debugging

**webpack.preload.config.js**
- Bundles Preload script
- Isolated from Main and Renderer contexts

**webpack.renderer.config.js**
- Bundles React application
- CSS processing and optimization
- Development server configuration
- Production optimizations (minification, tree-shaking)

### Build Pipeline

1. TypeScript compilation for type checking
2. Webpack bundles Main, Preload, and Renderer separately
3. Electron Builder packages application for distribution
4. Platform-specific installers generated

## Development Workflow

- **Hot Reload:** Renderer supports HMR for rapid UI development
- **Debug Modes:** Source maps enabled in development builds
- **Logging:** Verbose logging in development, configurable in production
- **Testing:** Unit tests for utilities, integration tests for IPC flows

## Security Considerations

- **Context Isolation:** Enabled to prevent prototype pollution attacks
- **Node Integration:** Disabled in Renderer for security
- **Content Security Policy:** Restricts resource loading in Renderer
- **IPC Validation:** All messages validated before processing
- **File Access:** Restricted to user-selected directories via dialogs

## Performance Optimizations

- **Worker Threads:** Heavy processing offloaded from Main thread
- **Lazy Loading:** Components and resources loaded on demand
- **Database Indexing:** Optimized queries for large media libraries
- **Batch Processing:** Files processed in configurable batch sizes
- **Memory Management:** Stream-based processing for large files

## Extensibility

The architecture supports future enhancements:
- Plugin system via dynamic imports
- Custom metadata extractors
- User-defined organization strategies
- Third-party service integrations (cloud storage, photo services)

## Directory Structure Summary

```
src/
├── main/
│   ├── index.ts                 # Main process entry point
│   ├── core/                    # Core processing components
│   │   ├── ProcessingEngine.ts
│   │   ├── MetadataExtractor.ts
│   │   ├── FileOrganizer.ts
│   │   ├── CorruptionDetector.ts
│   │   └── FileDiscovery.ts
│   ├── services/                # Application services
│   │   ├── ConfigManager.ts
│   │   ├── DatabaseManager.ts
│   │   ├── IPCHandler.ts
│   │   ├── LegacyMigration.ts
│   │   └── WindowManager.ts
│   └── utils/                   # Utility functions
│       ├── DateExtractor.ts
│       ├── FFProbeWrapper.ts
│       ├── FileSystemUtils.ts
│       ├── JobQueue.ts
│       ├── Logger.ts
│       ├── MenuBuilder.ts
│       ├── PerformanceMonitor.ts
│       └── TemplateEngine.ts
├── renderer/
│   ├── App.tsx                  # React root component
│   ├── components/              # React components
│   ├── store/                   # Redux Toolkit store
│   └── styles/                  # CSS and themes
├── preload/
│   └── index.ts                 # Preload script (contextBridge)
└── shared/
    ├── types/
    │   └── media.ts             # Shared TypeScript types
    └── constants/
        └── index.ts             # Shared constants

config/                          # Webpack configurations
├── webpack.main.config.js
├── webpack.preload.config.js
└── webpack.renderer.config.js
```
