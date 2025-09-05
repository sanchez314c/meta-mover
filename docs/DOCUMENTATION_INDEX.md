# Documentation Index

Master index for all META Mover documentation.

---

## Getting Started

| Document | Description |
|----------|-------------|
| [QUICK_START.md](QUICK_START.md) | Clone, install, and launch in under 5 minutes |
| [INSTALLATION.md](INSTALLATION.md) | Full installation instructions for macOS, Windows, and Linux |
| [FAQ.md](FAQ.md) | Answers to common questions about file organization, metadata, and corruption detection |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common errors and how to fix them |

## Architecture and Design

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Electron process model, core components, IPC design, data flow |
| [TECHSTACK.md](TECHSTACK.md) | All dependencies and their versions |
| [PRD.md](PRD.md) | Product requirements — goals, processing pipeline, business rules, supported formats |
| [LEARNINGS.md](LEARNINGS.md) | Architecture decisions, Python-to-TypeScript porting notes, known issues |
| [CONFIGURATION.md](CONFIGURATION.md) | All config options, where settings live, IPC access, supported formats |

## API Reference

| Document | Description |
|----------|-------------|
| [API.md](API.md) | Public API for ProcessingEngine, MetadataExtractor, FileOrganizer, CorruptionDetector, Redux slices, IPC channels, shared types |

## Development

| Document | Description |
|----------|-------------|
| [DEVELOPMENT.md](DEVELOPMENT.md) | Dev environment setup, commands, coding conventions |
| [WORKFLOW.md](WORKFLOW.md) | Git branching, commit format, PR process, release process |
| [BUILD_COMPILE.md](BUILD_COMPILE.md) | Webpack build pipeline, electron-builder packaging, code signing |
| [TESTING.md](TESTING.md) | Test stack, how to run tests, what's missing, writing new tests |
| [PERFORMANCE.md](PERFORMANCE.md) | Worker threads, batch processing, memory recommendations, profiling |
| [TODO.md](TODO.md) | Outstanding work: UI wiring, testing gaps, technical debt |

## Operations

| Document | Description |
|----------|-------------|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Building and distributing release artifacts for all three platforms |
| [SECURITY.md](SECURITY.md) | Security architecture — context isolation, IPC validation, path traversal prevention |

## Contributing

| Document | Description |
|----------|-------------|
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute: setup, standards, commit format, PR process |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community guidelines |

---

## Root-Level Files

| File | Description |
|------|-------------|
| [../README.md](../README.md) | Project overview and links to all documentation |
| [../CHANGELOG.md](../CHANGELOG.md) | Full version history (Keep a Changelog format) |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Brief contributing summary linking to docs/CONTRIBUTING.md |
| [../SECURITY.md](../SECURITY.md) | Vulnerability reporting policy |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Contributor Covenant v2.1 |
| [../LICENSE](../LICENSE) | MIT License |

---

## Key Source Files

For developers, quick reference to the most important source files:

| Path | Role |
|------|------|
| `src/main/index.ts` | App lifecycle, window creation, single-instance lock, auto-updater |
| `src/main/core/ProcessingEngine.ts` | 6-phase processing pipeline orchestrator |
| `src/main/core/MetadataExtractor.ts` | EXIF/XMP/ffprobe extraction; date priority logic |
| `src/main/core/FileOrganizer.ts` | `determineOutputPath()`, `sanitizeFilename()`, EXIF write-back |
| `src/main/core/CorruptionDetector.ts` | VidBeast-inspired 4-phase corruption analysis |
| `src/main/core/FileDiscovery.ts` | Recursive directory scan; skips `output/` dirs |
| `src/main/services/ConfigManager.ts` | Reads/writes `userData/config.json` |
| `src/main/services/DatabaseManager.ts` | SQLite jobs + file_cache tables |
| `src/main/services/IPCHandler.ts` | `InputValidator` + `ipcMain.handle` registrations |
| `src/preload/index.ts` | `contextBridge.exposeInMainWorld('electronAPI', ...)` |
| `src/renderer/App.tsx` | Root React component |
| `src/shared/types/media.ts` | All TypeScript interfaces and enums |
| `src/shared/constants/index.ts` | Format lists, IPC channel names, processing limits, corruption thresholds |

---

## Quick Navigation

**First-time users:**
1. [QUICK_START.md](QUICK_START.md)
2. [INSTALLATION.md](INSTALLATION.md)
3. [FAQ.md](FAQ.md)

**Developers:**
1. [ARCHITECTURE.md](ARCHITECTURE.md)
2. [DEVELOPMENT.md](DEVELOPMENT.md)
3. [API.md](API.md)
4. [LEARNINGS.md](LEARNINGS.md)

**Contributors:**
1. [CONTRIBUTING.md](CONTRIBUTING.md)
2. [WORKFLOW.md](WORKFLOW.md)
3. [TESTING.md](TESTING.md)
4. [TODO.md](TODO.md)

**Build engineers:**
1. [BUILD_COMPILE.md](BUILD_COMPILE.md)
2. [DEPLOYMENT.md](DEPLOYMENT.md)
3. [CONFIGURATION.md](CONFIGURATION.md)
