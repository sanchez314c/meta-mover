# Development Guide

## Prerequisites

- Node.js 18.0.0 or higher
- npm 9.0.0 or higher
- Git

## Setup

### Clone and Install

```bash
git clone https://github.com/sanchez314c/meta-mover.git
cd meta-mover
npm install
```

## Development Commands

### Core Development

```bash
npm run dev              # Build dev mode and launch Electron with --dev flag
npm run watch            # Watch mode: auto-rebuild on file changes + launch Electron
npm start                # Start production build
npm run start:prod       # Start with NODE_ENV=production
```

### Build Commands

```bash
npm run build            # Production build: main + preload + renderer
npm run build:dev        # Development build: main + preload + renderer
npm run build:main       # Build main process only (production)
npm run build:preload    # Build preload script only (production)
npm run build:renderer   # Build renderer process only (production)
```

### Quality Checks

```bash
npm run lint             # ESLint with auto-fix
npm run lint:check       # ESLint without auto-fix
npm run typecheck        # TypeScript type checking
npm run typecheck:watch  # TypeScript type checking in watch mode
npm run format           # Prettier format with auto-fix
npm run format:check     # Prettier format check only
```

### Testing

```bash
npm test                 # Run Jest tests
npm run test:watch       # Run Jest in watch mode
npm run test:coverage    # Run Jest with coverage report
npm run test:ci          # CI mode: no watch, with coverage
```

### Utility Commands

```bash
npm run clean            # Clean dist, release, and temp files
npm run clean:dist       # Clean dist directory only
npm run clean:release    # Clean release directory only
npm run clean:temp       # Clean temporary files and logs
npm run clean:all        # Clean everything including node_modules
```

## Project Structure

```
src/
├── main/              # Electron main process
│   ├── core/         # Core application logic
│   ├── services/     # Business logic services
│   └── utils/        # Main process utilities
├── preload/          # Electron preload scripts
├── renderer/         # React renderer process
│   ├── components/   # React components
│   ├── store/        # Redux Toolkit store
│   └── styles/       # Global styles
├── shared/           # Shared code between processes
│   ├── constants/    # Shared constants
│   └── types/        # Shared TypeScript types
└── types/            # Global TypeScript type definitions

config/               # Webpack configurations
scripts/              # Build and utility scripts
resources/            # Application resources (icons, assets)
```

## Code Conventions

### File Naming

- React Components: PascalCase (e.g., `MediaProcessor.tsx`)
- Services: PascalCase (e.g., `FileService.ts`)
- Utilities: camelCase (e.g., `dateUtils.ts`)
- Types: PascalCase (e.g., `MediaTypes.ts`)
- Tests: Co-located with `.test.ts` or `.spec.ts` suffix

### TypeScript Path Aliases

```typescript
@main/*      // src/main/*
@renderer/*  // src/renderer/*
@shared/*    // src/shared/*
@preload/*   // src/preload/*
```

### Code Style

- Use TypeScript for all new code
- Follow ESLint and Prettier configurations
- Write tests for new features
- Document complex logic with comments
- Use Redux Toolkit for state management
- Follow React 19 best practices

## Contributing Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run quality checks: `npm run lint && npm run typecheck && npm test`
5. Commit with conventional commits format
6. Push to your fork
7. Submit a pull request

## Platform-Specific Development

### Linux

Use the provided run script:

```bash
./run-source-linux.sh
```

### macOS

Use the provided run script:

```bash
./run-source-mac.sh
```

### Windows

Use the provided batch script:

```bat
run-source-windows.bat
```

## Additional Resources

- [Quick Start Guide](./QUICK_START.md)
- [Workflow Guide](./WORKFLOW.md)
- [API Documentation](./API.md)
- [Tech Stack](./TECHSTACK.md)
