# Testing

How to run tests for META Mover and what the current state of the test suite looks like.

## Test Stack

- **Jest** — test runner and assertion library
- **ts-jest** — TypeScript support in Jest
- **@testing-library/react** — component testing
- **@testing-library/jest-dom** — DOM matchers
- **@testing-library/user-event** — user interaction simulation
- **jest-environment-jsdom** — browser environment simulation

## Running Tests

```bash
npm test                  # Run all tests
npm run test:watch        # Watch mode (re-runs on file changes)
npm run test:coverage     # Run with coverage report
npm run test:ci           # CI mode: no watch, coverage required
```

## Current State

The `tests/` directory exists but is largely empty. This is a known gap — see `docs/TODO.md` for the full list. The highest-priority missing tests are:

- `DateExtractor` — century correction, filename regex patterns, `isAlreadyProcessed()`, `formatFilenameWithDate()`
- `FileOrganizer` — `determineOutputPath()` per media type and corruption level, `sanitizeFilename()`, conflict counter
- `CorruptionDetector` — empty file → CATASTROPHIC, VidBeast false-positive clear rule, MINOR → NONE decision
- `MetadataExtractor` — date field priority order, screenshot detection patterns, century correction
- `ProcessingEngine` — full 6-phase pipeline integration test on a fixture set

## File Organization

Tests live next to the source files they test, using `.test.ts` or `.spec.ts` suffixes:

```
src/
├── main/
│   ├── core/
│   │   ├── MetadataExtractor.ts
│   │   └── MetadataExtractor.test.ts   ← put tests here
│   └── utils/
│       ├── DateExtractor.ts
│       └── DateExtractor.test.ts
└── renderer/
    └── components/
        ├── ErrorBoundary.tsx
        └── ErrorBoundary.test.tsx
```

You can also use `__tests__/` subdirectories if you prefer grouping.

## Coverage Target

80% coverage across `src/main/core/` and `src/main/utils/`. The `jest.collectCoverageFrom` in `package.json` controls what gets measured.

After running `npm run test:coverage`, the report lands in `coverage/lcov-report/index.html`.

## Writing a Test

Quick example for `DateExtractor`:

```typescript
import { DateExtractor } from '@main/utils/DateExtractor';

describe('DateExtractor', () => {
  describe('correctCentury', () => {
    it('maps year 112 to 2112', () => {
      const result = DateExtractor.correctCentury(new Date('0112-06-15'));
      expect(result.getFullYear()).toBe(2112);
    });

    it('leaves years >= 2000 unchanged', () => {
      const date = new Date('2024-01-01');
      expect(DateExtractor.correctCentury(date).getFullYear()).toBe(2024);
    });
  });
});
```

## Mocking IPC in Tests

Main process code that calls `ipcMain` needs to be mocked in unit tests. Use Jest's manual mocks or `jest.mock()`:

```typescript
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  app: { getPath: jest.fn().mockReturnValue('/tmp') },
}));
```

## CI Integration

`npm run test:ci` runs Jest with `--ci --coverage --watchAll=false`. This mode fails if any snapshot becomes outdated without being regenerated. Use it locally before pushing to catch issues early.
