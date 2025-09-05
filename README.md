# META Mover

Desktop app for organizing large media collections. Built with Electron, React 19, TypeScript, and Redux Toolkit.

It scans a source folder, reads metadata from photos and videos, and moves them into a `{type}/{year}/YYYY-MM-DD_HH-MM-SS.ext` structure at your destination. It handles corrupted files, conflicting filenames, iOS/macOS screenshots, MPO files, and cameras with dead CMOS batteries gracefully.

**Version**: 1.0.0
**Platforms**: macOS, Windows, Linux
**Author**: sanchez314c
**License**: MIT

---

## Quick Start

```bash
git clone https://github.com/sanchez314c/meta-mover.git
cd meta-mover
npm install
npm run dev          # Linux: ./run-source-linux.sh
```

See [docs/QUICK_START.md](docs/QUICK_START.md) for more detail.

## Documentation

| Doc | What it covers |
|-----|---------------|
| [docs/QUICK_START.md](docs/QUICK_START.md) | Clone, install, and run in 5 minutes |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Full installation for all platforms |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, components, IPC, data flow |
| [docs/API.md](docs/API.md) | IPC channels, Redux slices, shared types |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | All config options and where settings live |
| [docs/TECHSTACK.md](docs/TECHSTACK.md) | Dependencies and versions |
| [docs/BUILD_COMPILE.md](docs/BUILD_COMPILE.md) | Webpack build pipeline |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Building and distributing release artifacts |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Git branching, commit format, release process |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy and how to run tests |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Worker threads, memory, tuning |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common errors and fixes |
| [docs/FAQ.md](docs/FAQ.md) | Frequently asked questions |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | How to contribute |
| [docs/SECURITY.md](docs/SECURITY.md) | Security architecture |
| [docs/PRD.md](docs/PRD.md) | Product requirements and business rules |
| [docs/LEARNINGS.md](docs/LEARNINGS.md) | Architecture decisions and porting notes |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

Full index: [docs/DOCUMENTATION_INDEX.md](docs/DOCUMENTATION_INDEX.md)

## License

MIT — see [LICENSE](LICENSE).
