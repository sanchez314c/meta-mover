# Development Workflow

## Branching Strategy

### Branch Types

```
main              # Production-ready code
develop           # Integration branch for features
feature/*         # New features
bugfix/*          # Bug fixes
release/*         # Release preparation
hotfix/*          # Production hotfixes
```

### Branch Workflow

1. **Start New Feature**

```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

2. **Make Changes**

- Write code
- Add tests
- Update documentation
- Commit incrementally

3. **Quality Checks**

```bash
npm run lint
npm run typecheck
npm run test
```

4. **Push and PR**

```bash
git push origin feature/your-feature-name
# Create pull request to develop
```

## Commit Guidelines

### Conventional Commits Format

```
type(scope): subject

body

footer
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `build`: Build system changes
- `ci`: CI configuration changes
- `chore`: Maintenance tasks

### Examples

```bash
git commit -m "feat(media): add HEIC format support"
git commit -m "fix(metadata): resolve EXIF parsing for Canon files"
git commit -m "docs(api): update FileService documentation"
```

## Testing Strategy

### Test Coverage

Target: 80%+ coverage for new code

```bash
npm run test:coverage
```

### Test Types

1. **Unit Tests**: Individual functions and components
2. **Integration Tests**: Service interactions
3. **E2E Tests**: Full application workflows

### Running Tests

```bash
npm test                 # Run all tests
npm run test:watch       # Watch mode during development
npm run test:ci          # CI mode with coverage
```

### Writing Tests

Co-locate tests with source files:

```
src/
├── services/
│   ├── FileService.ts
│   └── FileService.test.ts
```

## Quality Assurance

### Pre-Commit Checklist

- [ ] Code passes linting: `npm run lint`
- [ ] Types check: `npm run typecheck`
- [ ] Tests pass: `npm test`
- [ ] Code formatted: `npm run format`
- [ ] No console.log statements in production code
- [ ] Documentation updated if needed

### Automated Checks

Run all quality checks:

```bash
npm run lint && npm run typecheck && npm test
```

## Build Pipeline

### Development Build

```bash
npm run clean:dist
npm run build:dev
npm run dev
```

### Production Build

```bash
npm run clean:dist
npm run build
npm run start:prod
```

### Distribution Build

```bash
npm run dist              # All platforms
npm run dist:linux        # Linux only
npm run dist:mac          # macOS only
npm run dist:win          # Windows only
```

## Release Process

### 1. Prepare Release

```bash
git checkout develop
git pull origin develop
git checkout -b release/v1.x.x
```

### 2. Update Version

```bash
npm version [major|minor|patch]
```

### 3. Update Changelog

Edit `CHANGELOG.md` with release notes:

```markdown
## [1.x.x] - YYYY-MM-DD

### Added
- New feature descriptions

### Changed
- Modified behavior descriptions

### Fixed
- Bug fix descriptions
```

### 4. Build and Test

```bash
npm run clean
npm install
npm run build
npm test
npm run dist
```

### 5. Merge to Main

```bash
git checkout main
git merge release/v1.x.x --no-ff
git tag -a v1.x.x -m "Release version 1.x.x"
git push origin main --tags
```

### 6. Merge Back to Develop

```bash
git checkout develop
git merge main
git push origin develop
```

## Development Cycle

### Daily Workflow

1. Pull latest from develop
2. Create/switch to feature branch
3. Make incremental changes
4. Run quality checks frequently
5. Commit with descriptive messages
6. Push to remote regularly
7. Create PR when feature complete

### Code Review Process

1. Self-review changes before creating PR
2. Request review from team members
3. Address feedback and comments
4. Ensure CI checks pass
5. Squash commits if needed
6. Merge when approved

## Performance Optimization

### Bundle Analysis

```bash
npm run bundle:analyze    # Interactive analyzer
npm run bundle:stats      # Generate stats JSON
```

### Build Optimization

```bash
npm run build-compile-dist         # Optimized compilation
npm run bloat-check                # Check bundle size
npm run bloat-check:fix            # Auto-fix bloat issues
```

## Cleanup and Maintenance

### Temporary File Cleanup

```bash
npm run temp-cleanup               # Standard cleanup
npm run temp-cleanup:aggressive    # Deep cleanup
npm run temp-cleanup:dry-run       # Preview cleanup
```

### Dependency Management

```bash
npm run deps:check                 # Check for updates
npm run deps:update                # Update dependencies
npm run security:audit             # Security audit
npm run security:audit:fix         # Fix security issues
```

## Continuous Integration

### CI Pipeline Stages

1. **Lint**: Code style validation
2. **TypeCheck**: Type safety validation
3. **Test**: Unit and integration tests
4. **Build**: Production build verification
5. **Package**: Distribution package creation

### CI Commands

```bash
npm run lint:check
npm run typecheck
npm run test:ci
npm run build
npm run dist
```

## Best Practices

- Write self-documenting code
- Keep functions small and focused
- Follow SOLID principles
- Use TypeScript strict mode
- Write tests for bug fixes
- Update documentation with code changes
- Review your own PRs before requesting review
- Keep commits atomic and focused
- Use feature flags for incomplete features
- Monitor bundle size regularly
