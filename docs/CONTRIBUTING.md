# Contributing

Thanks for taking an interest in META Mover. Here's how to get set up and what we expect from contributions.

## Getting Started

```bash
git clone https://github.com/sanchez314c/meta-mover.git
cd meta-mover
npm install
npm run dev
```

Node.js 18+ and npm 9+ are required. On Linux, if Electron crashes with a sandbox error, run `./run-source-linux.sh` instead of `npm run dev` — it passes `--no-sandbox` automatically.

## Before You Code

- Check the [GitHub Issues](https://github.com/sanchez314c/meta-mover/issues) for open bugs or planned features
- For new features, open an issue first and describe what you want to build — avoids wasted effort on things that won't be merged
- `docs/TODO.md` has a running list of known gaps and technical debt

## Development Commands

```bash
npm run dev              # Build dev mode and launch Electron
npm run test             # Run all tests
npm run test:watch       # Tests in watch mode
npm run lint             # ESLint with auto-fix
npm run typecheck        # TypeScript type checking
npm run format           # Prettier with auto-fix
```

Run all quality checks before submitting:

```bash
npm run lint && npm run typecheck && npm test
```

## Code Standards

- **TypeScript** for all new code — no plain JavaScript files in `src/`
- **No `any` types** without a comment explaining why
- **Tests are required** for new code in `src/main/core/` and `src/main/utils/` — aim for 80% coverage
- **No mutation** — return new objects instead of modifying existing ones
- Functions under 50 lines, files under 800 lines
- Use the path aliases: `@main/*`, `@renderer/*`, `@shared/*`, `@preload/*`

## Commit Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

Optional longer body explaining the why, not the what.
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

Examples:
```
feat(metadata): add HEIC format support
fix(corruption): resolve false positive on ProRes files
docs(api): update IPC channel reference
```

## Pull Request Process

1. Fork the repo and create a branch from `develop`: `git checkout -b feature/your-feature`
2. Write tests for your changes
3. Run `npm run lint && npm run typecheck && npm test`
4. Submit a pull request to `develop` with a clear description of what changed and why
5. Reference any related issues in the PR description

## Architecture Notes

Before making changes to core processing logic, read `docs/ARCHITECTURE.md` and `docs/LEARNINGS.md`. The processing pipeline has been carefully ported from legacy Python behavior — some things that look wrong are intentional (century correction, conflict counter format, screenshot detection patterns).

Key things to know:
- The renderer cannot call Node.js directly — everything goes through IPC
- `InputValidator` in `IPCHandler` sanitizes all renderer input before it reaches the engine
- `FileOrganizer` output paths must match the legacy pattern exactly for existing organized libraries to remain compatible

## Reporting Bugs

Open a GitHub issue with:
- OS and version
- Node.js version (`node --version`)
- Steps to reproduce
- What you expected vs what happened
- Relevant log output (logs live in the `logs/` directory inside `userData`)

## Security Issues

Don't open public issues for security vulnerabilities. Email sanchez314c@speedheathens.com instead. See `SECURITY.md` for details.
