# META Mover Documentation

Complete documentation for META Mover v1.0 — a cross-platform Electron desktop application for organizing large media collections.

## Documentation Index

### Getting Started
| Document | Description |
| -------- | ----------- |
| [QUICK_START.md](QUICK_START.md) | Clone, install, and launch in under 5 minutes |
| [INSTALLATION.md](INSTALLATION.md) | Full installation instructions for macOS, Windows, and Linux |

### Architecture & Design
| Document | Description |
| -------- | ----------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Electron process model, core components, data flow, IPC security |
| [TECHSTACK.md](TECHSTACK.md) | All dependencies and their versions with rationale |
| [PRD.md](PRD.md) | Product requirements document — goals, core features, business rules, supported formats |

### API Reference
| Document | Description |
| -------- | ----------- |
| [API.md](API.md) | Public API for ProcessingEngine, MetadataExtractor, FileOrganizer, CorruptionDetector, Redux slices, IPC channels |

### Development
| Document | Description |
| -------- | ----------- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Dev environment setup, coding conventions, testing approach |
| [WORKFLOW.md](WORKFLOW.md) | Git branching, commit conventions, release process |
| [BUILD_COMPILE.md](BUILD_COMPILE.md) | Webpack build pipeline, electron-builder packaging, code signing |

### Operations
| Document | Description |
| -------- | ----------- |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Building and distributing release artifacts for all three platforms |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common errors and how to fix them |

### Reference
| Document | Description |
| -------- | ----------- |
| [FAQ.md](FAQ.md) | Answers to common questions about file organization, metadata, corruption detection |
| [LEARNINGS.md](LEARNINGS.md) | Architecture decisions, Python-to-TypeScript porting notes, known issues |
| [TODO.md](TODO.md) | Outstanding work: UI wiring, testing gaps, technical debt |

---

## Key Source Files

| Path | Role |
| ---- | ---- |
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
| `src/renderer/App.tsx` | Root React component; welcome screen UI |
| `src/renderer/store/slices/appSlice.ts` | SystemInfo, dark mode, sidebar state |
| `src/renderer/store/slices/jobsSlice.ts` | Active job, history, progress |
| `src/shared/types/media.ts` | All TypeScript interfaces and enums |
| `src/shared/constants/index.ts` | Format lists, IPC channel names, processing limits, corruption thresholds |

## Quick Reference: npm Scripts

```bash
npm run dev              # Build dev + launch Electron (--no-sandbox on Linux)
npm run build            # Production webpack build
npm run dist             # Build + electron-builder all platforms
npm run dist:linux       # Linux: AppImage, deb, rpm, snap
npm run dist:mac         # macOS: dmg, pkg, zip
npm run dist:win         # Windows: nsis, msi, appx, portable
npm run test             # Jest
npm run test:coverage    # Jest + coverage
npm run lint             # ESLint --fix
npm run typecheck        # tsc --noEmit
npm run format           # Prettier
```

## Repository Layout

```
meta-mover/
├── src/
│   ├── main/            # Electron main process (Node.js)
│   ├── preload/         # contextBridge security bridge
│   ├── renderer/        # React 19 frontend
│   └── shared/          # Types and constants used by both processes
├── config/              # webpack.main|preload|renderer.config.js, tsconfig.json
├── resources/           # Icons (icns, ico, png), DMG background, entitlements
├── scripts/             # Dev environment setup, bloat-check, temp-cleanup, build scripts
├── legacy/              # Archived Python scripts (v1.7.0 through v2.3.0)
├── docs/                # This documentation directory
├── tests/               # Test suite (currently empty — see TODO.md)
└── archive/             # Timestamped zip backups
```

---

*For the full format support list, default processing options, IPC channel names, and corruption thresholds, see `src/shared/constants/index.ts`.*
