# META Mover - Technology Stack

**Version**: 1.0.0
**Type**: Professional Media Organization Suite
**Architecture**: Electron-based Desktop Application
**Last Updated**: March 2026

---

## 🏗️ Core Architecture

### Desktop Application Framework
- **Electron 27.1.3** - Cross-platform desktop app framework
  - Chromium engine for web technologies
  - Node.js runtime for system access
  - Native OS integration

### Multi-Process Architecture
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Main Process  │───▶│  Renderer Process │◄──│ Preload Scripts │
│   (Node.js)     │    │    (React UI)     │   │  (IPC Bridge)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

---

## 🎨 Frontend Stack

### UI Framework
- **React 19.1.1** - Modern component-based UI library
- **React DOM 19.1.1** - React renderer for web browsers
- **TypeScript 5.2.2** - Type-safe JavaScript with static typing

### State Management
- **Redux Toolkit 2.8.2** - Modern Redux implementation
  - `jobsSlice.ts` - Processing job management
  - `settingsSlice.ts` - Application configuration
  - `appSlice.ts` - Global app state
  - `uiSlice.ts` - User interface state
- **React Redux 9.2.0** - React bindings for Redux

### Styling & Theming
- **Styled Components 6.1.19** - CSS-in-JS styling solution
- **Custom Theme System** - Light/dark mode support
- **CSS Loader 7.1.2** - Webpack CSS processing

### Internationalization
- **i18next 25.3.2** - Internationalization framework
- **React i18next 15.6.1** - React integration for i18n

---

## ⚙️ Backend & Core Services

### Main Process Architecture
```
src/main/
├── core/                    # Core processing engines
│   ├── CorruptionDetector.ts    # File integrity validation
│   ├── FileDiscovery.ts         # Media file discovery
│   ├── FileOrganizer.ts         # File organization logic
│   ├── MetadataExtractor.ts     # EXIF/metadata extraction
│   └── ProcessingEngine.ts     # Main processing pipeline
├── services/                # System services
│   ├── ConfigManager.ts         # Configuration management
│   ├── DatabaseManager.ts       # Data persistence
│   ├── IPCHandler.ts           # Inter-process communication
│   ├── LegacyMigration.ts      # Migration from v2.x
│   └── WindowManager.ts        # Window lifecycle management
└── utils/                   # Utilities
    ├── DateExtractor.ts         # Date parsing from filenames
    ├── FFProbeWrapper.ts        # Video metadata via FFprobe
    ├── FileSystemUtils.ts       # File system operations
    ├── JobQueue.ts             # Background job management
    ├── Logger.ts               # Logging system
    ├── MenuBuilder.ts          # Application menu system
    └── PerformanceMonitor.ts   # Performance metrics
```

### Runtime Environment
- **Node.js** (via Electron) - System access and file operations
- **ES2020** target compilation
- **CommonJS** module system

---

## 🛠️ Build System & Development Tools

### Build Pipeline
- **Webpack 5.89.0** - Module bundler and build system
  - `webpack.main.config.js` - Main process bundling
  - `webpack.renderer.config.js` - Renderer process bundling  
  - `webpack.preload.config.js` - Preload script bundling
- **TypeScript Compiler** - Source code transpilation
- **ts-loader 9.5.0** - TypeScript integration with Webpack

### Development Tools
- **Webpack CLI 5.1.4** - Command-line interface
- **HTML Webpack Plugin 5.3.2** - HTML template generation
- **Style Loader 4.0.0** - CSS injection into DOM
- **Concurrently 8.2.2** - Parallel script execution
- **Wait-on 7.2.0** - Process synchronization

### TypeScript Configuration
```json
{
  "target": "ES2020",
  "lib": ["ES2020", "DOM", "DOM.Iterable"],
  "module": "CommonJS",
  "jsx": "react-jsx",
  "strict": false,
  "sourceMap": true,
  "declaration": true
}
```

### Path Aliases
- `@main/*` → `src/main/*`
- `@renderer/*` → `src/renderer/*`
- `@shared/*` → `src/shared/*`
- `@preload/*` → `src/preload/*`

---

## 📦 Distribution & Packaging

### Cross-Platform Building
- **Electron Builder 24.6.4** - Application packaging
  - macOS: `.dmg` installer with code signing
  - Windows: NSIS installer with `.ico` icons
  - Linux: `.deb` packages and AppImage

### Distribution Targets
```bash
npm run dist:mac    # macOS DMG
npm run dist:win    # Windows NSIS installer  
npm run dist:linux  # Linux DEB + AppImage
npm run dist        # All platforms
```

### Build Configuration
- **App ID**: `com.speedheathens.metamover`
- **Output Directory**: `release/`
- **Assets**: `resources/` (icons, static files)
- **Bundle**: `dist/` (compiled code)

---

## 🧩 Utility Libraries

### Core Dependencies
- **Lodash 4.17.21** - Utility functions library
- **@types/lodash 4.17.20** - TypeScript definitions

### Development Dependencies
- **@types/react 19.1.9** - React TypeScript definitions
- **@types/react-dom 19.1.7** - React DOM TypeScript definitions
- **dmg-builder 24.13.3** - macOS DMG creation utility

---

## 📁 Project Structure

```
META_Mover/
├── src/
│   ├── main/              # Electron main process (Node.js)
│   ├── renderer/          # React frontend application  
│   ├── preload/           # IPC bridge scripts
│   ├── shared/            # Shared types and constants
│   └── types/             # TypeScript declarations
├── config/                # Webpack build configurations
├── resources/             # Icons and static assets
├── dist/                  # Compiled application code
├── release/               # Distribution packages
├── docs/                  # Project documentation
└── scripts/               # Development and build scripts
```

---

## 🚀 Development Workflow

### Available Scripts
```bash
# Development
npm run dev          # Build dev + start Electron
npm run build:dev    # Development build only
npm start           # Start pre-built application

# Production
npm run build       # Production build all targets
npm run pack        # Package without distribution
npm run dist        # Full distribution build

# Utilities  
npm run clean       # Clean build artifacts
npm run lint        # Code linting (not configured)
npm run test        # Run tests (not configured)
npm run typecheck   # TypeScript validation (not configured)
```

### Hot Reload Development
1. `npm run build:dev` - Compile TypeScript to JavaScript
2. `electron .` - Launch application with dev builds
3. File changes trigger automatic recompilation

---

## 🏛️ Architecture Patterns

### Design Patterns
- **MVC Architecture** - Separation of concerns
- **Redux Pattern** - Unidirectional data flow
- **IPC Communication** - Main/Renderer process messaging
- **Service Layer** - Business logic abstraction
- **Component Architecture** - Reusable UI components

### Data Flow
```
User Action → React Component → Redux Action → 
Redux Reducer → State Update → Component Re-render
         ↓
IPC Message → Main Process → File System → 
Response → IPC Reply → Renderer Update
```

### Error Handling
- **ErrorBoundary.tsx** - React error boundaries
- **Logger.ts** - Centralized logging system
- **Try/Catch Blocks** - Async operation safety
- **IPC Error Channels** - Cross-process error propagation

---

## 📊 Performance Considerations

### Optimization Strategies
- **Code Splitting** - Webpack bundle optimization
- **Tree Shaking** - Dead code elimination
- **Source Maps** - Development debugging
- **Performance Monitoring** - Built-in metrics tracking
- **Background Processing** - Non-blocking file operations

### Memory Management
- **Job Queue System** - Controlled concurrent processing
- **Stream Processing** - Large file handling
- **Garbage Collection** - Automatic memory cleanup
- **Resource Pooling** - Efficient system resource usage

---

## 🔧 Configuration Management

### Application Settings
- **ConfigManager.ts** - Centralized configuration
- **Settings Persistence** - User preference storage
- **Environment Variables** - Build-time configuration
- **Runtime Configuration** - Dynamic setting updates

### File Formats
- **JSON Configuration** - Human-readable settings
- **TypeScript Constants** - Compile-time configuration
- **Environment Files** - Development/production variants

---

## 📈 Monitoring & Logging

### Logging System
- **Structured Logging** - JSON-formatted log entries
- **Log Levels** - Debug, Info, Warn, Error, Fatal
- **File Output** - Persistent log files
- **Console Output** - Development debugging

### Performance Metrics
- **Processing Times** - File operation duration
- **Memory Usage** - Application resource consumption
- **Error Rates** - Failure tracking and analysis
- **User Actions** - Usage pattern analytics

---

## 🧪 Testing Strategy

### Testing Framework
- **Jest 29** - Test runner (configured with ts-jest)
- **React Testing Library 16** - Component testing utilities
- **@testing-library/user-event** - User interaction simulation
- **jest-environment-jsdom** - Browser environment for React tests

### Quality Assurance
- **TypeScript** - Compile-time type checking
- **ESLint** - Code style and quality enforcement
- **Prettier** - Code formatting consistency
- **Husky** - Git hooks for quality gates

---

## 🔐 Security Considerations

### Electron Security
- **Context Isolation** - Renderer process security
- **Preload Scripts** - Safe IPC communication
- **Node Integration** - Disabled in renderer
- **Content Security Policy** - XSS protection

### File System Security
- **Path Validation** - Directory traversal protection
- **File Permissions** - Appropriate access controls
- **Input Sanitization** - User input validation
- **Error Information** - Sensitive data protection

---

## 📋 Migration & Legacy Support

### Version Migration
- **LegacyMigration.ts** - Automated migration from v2.x
- **Configuration Migration** - Settings transfer
- **Data Migration** - User data preservation
- **Backward Compatibility** - Graceful version handling

### Breaking Changes
- **Python to TypeScript** - Complete rewrite
- **CLI to GUI** - Interface paradigm shift
- **Script to App** - Packaging and distribution
- **Local to Electron** - Cross-platform support

---

## 🎯 Future Roadmap

### Planned Enhancements
- **Testing Suite** - Comprehensive test coverage
- **CI/CD Pipeline** - Automated build and deployment
- **Plugin System** - Extensible architecture
- **Cloud Integration** - Remote storage support
- **Advanced Analytics** - Enhanced performance monitoring

### Technology Upgrades
- **React 19 Features** - Latest React capabilities
- **Electron Updates** - Security and performance improvements
- **TypeScript Strict Mode** - Enhanced type safety
- **Modern CSS** - Container queries and logical properties

---

*This document represents the technology stack for META Mover v1.0 as of March 2026. For updates and changes, refer to the project's CHANGELOG.md.*