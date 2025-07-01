# META_Mover Technology Stack

## Core Framework
- **Electron 33.2.1**: Desktop application framework enabling cross-platform development
- **Node.js**: JavaScript runtime for main process and build tools
- **TypeScript**: Type-safe JavaScript with strict configuration

## Frontend Stack
- **React 18**: Modern UI library with functional components and hooks
- **React DOM**: DOM renderer for React components
- **Redux Toolkit 2.3.0**: State management with RTK Query for API calls
- **React-Redux**: React bindings for Redux state management

## Development Environment
- **Hybrid Setup**: Conda for Python/build tools + System Node.js v23.11.0
- **Vite**: Fast build tool and development server
- **Electron Builder**: Cross-platform packaging and distribution

## Build & Development Tools
- **TypeScript Compiler**: Strict type checking with path mapping
- **ESLint**: Code linting with TypeScript support
- **Prettier**: Code formatting
- **Concurrently**: Run multiple npm scripts in parallel

## Testing & Quality
- **Jest**: JavaScript testing framework (configured but tests needed)
- **Coverage reporting**: Built-in test coverage analysis
- **Type checking**: Integrated TypeScript validation

## Platform Support
- **macOS**: Primary development platform with Metal GPU acceleration
- **Windows**: Cross-platform compatibility via Electron Builder
- **Linux**: Ubuntu/Debian support via Electron Builder

## Media Processing Capabilities
- **Native metadata extraction**: Replacing Python ExifTool dependency
- **Worker threads**: Non-blocking file processing
- **SQLite**: Job history and caching system
- **Multi-format support**: Images, videos, audio files

## Architecture Patterns
- **Main/Renderer/Preload**: Standard Electron security model
- **IPC Communication**: Secure inter-process messaging
- **Component-based UI**: Modular React architecture
- **Redux state patterns**: Normalized state with RTK Query

## Legacy Dependencies (Being Phased Out)
- **Python 3.x**: Legacy scripts in `/legacy` folder
- **ExifTool**: External metadata tool (being replaced with native JS)
- **OpenCV**: Computer vision library (legacy Python implementation)

## Build Outputs
- **Development**: Hot-reload development server
- **Production**: Optimized builds for all platforms
- **Distribution**: Platform-specific installers (DMG, EXE, DEB)
- **Portable**: Standalone executable packages

## Version Control & Documentation
- **Git**: Source control with .gitignore for build artifacts
- **Markdown**: Documentation in standardized format
- **CLAUDE.md**: AI assistant project context and guidelines