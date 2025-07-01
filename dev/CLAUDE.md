# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

META_Mover v3.0 is a Professional Media Organization Suite - a complete modern Electron-based desktop application rebuilt from legacy Python scripts. It's designed for photographers and media professionals to organize large media collections with intelligent date-based organization, comprehensive metadata extraction, and corruption detection.

**Current Status**: ✅ **Fully Operational** - Modern Electron application with React + TypeScript frontend, Node.js backend, and comprehensive development environment.

## 🚀 Quick Start

### Environment Setup (First Time)
```bash
# Setup hybrid environment (Conda for Python/build tools + System Node.js)
./scripts/setup-hybrid.sh

# Activate environment for each terminal session  
./scripts/activate-dev.sh

# Clean install if needed
rm -rf node_modules package-lock.json && npm install

# Start development
npm run dev
```

### Current Environment Status
✅ Hybrid Conda environment (metamover-dev)  
✅ System Node.js v23.11.0 + npm package management  
✅ TypeScript path mapping configured  
✅ Jest testing suite with 80%+ coverage targets  

## Development Commands

### Development Workflow
```bash
npm run dev                      # Start development server with hot reload
npm run dev:main                 # Build main process in watch mode
npm run dev:renderer             # Start renderer dev server only
npm run dev:electron             # Start Electron (waits for renderer)

npm run start                    # Run built application
npm run start:prod               # Build and run production version
```

### Build & Distribution
```bash
npm run build                    # Build all components for production
npm run clean                    # Remove dist and release directories
npm run rebuild                  # Clean and reinstall dependencies

npm run pack                     # Package app without installer
npm run dist                     # Create platform-specific installer
npm run dist:mac                 # Create macOS installer (.dmg)
npm run dist:win                 # Create Windows installer (.exe)
npm run dist:linux               # Create Linux installer (.AppImage)
```

### Testing & Quality Assurance
```bash
npm run test                     # Run test suite
npm run test:watch               # Run tests in watch mode
npm run test:coverage            # Generate coverage report
npm run test:ci                  # Run tests for CI (no watch)

npm run verify                   # Run all quality checks (typecheck + lint + test)
npm run typecheck               # TypeScript type checking
npm run lint                    # Lint and fix code issues
npm run format                  # Format code with Prettier
```

## Architecture Overview

### Modern Electron Architecture (v3.0.0)
- **Main Process** (`src/main/`): Node.js backend with worker threads for performance
- **Renderer Process** (`src/renderer/`): React + TypeScript frontend with Redux Toolkit
- **Preload Scripts** (`src/preload/`): Security bridge between main and renderer
- **Shared Code** (`src/shared/`): Common types, constants, and utilities

### Core Components
1. **ProcessingEngine** (`src/main/core/ProcessingEngine.ts`): Orchestrates media processing workflows
2. **MetadataExtractor** (`src/main/core/MetadataExtractor.ts`): Native metadata extraction (no ExifTool dependency)
3. **FileOrganizer** (`src/main/core/FileOrganizer.ts`): Date-based organization with conflict resolution
4. **CorruptionDetector** (`src/main/core/CorruptionDetector.ts`): VidBeast-inspired multi-phase corruption detection
5. **FileDiscovery** (`src/main/core/FileDiscovery.ts`): File system scanning and media discovery

### State Management (Redux Toolkit)
- **appSlice**: Application-wide state and configuration
- **jobsSlice**: Processing job management and history  
- **settingsSlice**: User preferences and application settings
- **uiSlice**: UI state management (modals, loading states)

## File Structure

```
src/
├── main/                        # Electron main process (Node.js backend)
│   ├── core/                    # Core processing logic
│   ├── services/                # System services (DB, Config, IPC)
│   ├── utils/                   # Utility functions
│   └── index.ts                 # Main process entry point
├── renderer/                    # React frontend
│   ├── components/              # React components
│   ├── store/                   # Redux Toolkit store and slices
│   ├── styles/                  # Styled components and themes
│   └── App.tsx                  # React app entry point
├── shared/                      # Shared types and constants
│   ├── types/                   # TypeScript type definitions
│   └── constants/               # Application constants
└── preload/                     # Security bridge scripts

config/                          # Build configuration
├── webpack.main.config.js       # Main process bundling
├── webpack.renderer.config.js   # React frontend bundling
├── webpack.preload.config.js    # Preload script bundling
└── jest.config.js               # Testing configuration

scripts/                         # Development scripts
├── setup-hybrid.sh              # Environment setup
└── activate-dev.sh              # Environment activation
```

## Key Technical Details

### Technology Stack
- **Frontend**: React 18 + TypeScript + Styled Components + Redux Toolkit
- **Backend**: Electron + Node.js Worker Threads
- **Database**: SQLite for job history and metadata caching
- **Testing**: Jest + React Testing Library (jsdom environment)
- **Build**: Webpack with multi-target configuration
- **Distribution**: Electron Builder for cross-platform installers

### TypeScript Configuration
- **Target**: ES2020 with DOM support
- **Module System**: CommonJS for Electron compatibility
- **Path Mapping**: `@main/*`, `@renderer/*`, `@shared/*`, `@preload/*`
- **Strict Mode**: Disabled for legacy compatibility

### Media Processing Pipeline
- **Date Detection Priority**: EXIF → XMP → filename patterns → filesystem timestamps
- **Video Organization**: Resolution-based categorization (720p/1080p/4K+)
- **Corruption Detection**: Multi-phase analysis with false-positive prevention
- **Performance**: Worker thread processing for non-blocking operations

## Development Guidelines

### Task Completion Workflow
When completing any development task, always run:
1. `npm run typecheck` - TypeScript validation
2. `npm run lint` - Code linting with auto-fix
3. `npm run test:coverage` - Test suite with coverage
4. `npm run verify` - Combined quality checks

### Code Conventions
- **Components**: PascalCase naming (e.g., `LoadingSpinner.tsx`)
- **Services/Utils**: PascalCase naming (e.g., `MetadataExtractor.ts`)
- **Types**: Descriptive interfaces in `shared/types/`
- **Testing**: 80% coverage threshold across all metrics

### Environment Management
- **Activation Required**: Run `./scripts/activate-dev.sh` in each new terminal
- **Dependencies**: Use npm for JavaScript packages, Conda for Python/native tools
- **Troubleshooting**: Clean install with `rm -rf node_modules package-lock.json && npm install`

### Legacy Code (Archived)
The `legacy/` directory contains the original Python scripts for reference:
- `media-organizer-enhanced-v2.0.0.py` - Reference implementation
- Various utility scripts for specific media operations
- **Note**: These are archived and no longer actively developed

## Platform Support
- **Primary**: macOS with optimized performance
- **Secondary**: Windows and Linux with full functionality
- **Requirements**: Node.js 16+, modern Electron-supported OS versions