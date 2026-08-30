const path = require('path');

module.exports = {
  rootDir: path.resolve(__dirname, '..'),
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
  moduleNameMapper: {
    '^@main/(.*)$': '<rootDir>/src/main/$1',
    '^@renderer/(.*)$': '<rootDir>/src/renderer/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@preload/(.*)$': '<rootDir>/src/preload/$1'
  },
  testMatch: [
    '<rootDir>/tests/**/*.(test|spec).(ts|tsx|js)',
    '<rootDir>/src/**/*.(test|spec).(ts|tsx|js)'
  ],
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/archive/', '<rootDir>/legacy/'],
  modulePathIgnorePatterns: ['<rootDir>/archive/', '<rootDir>/legacy/'],
  collectCoverageFrom: [
    'src/main/core/**/*.ts',
    'src/main/services/**/*.ts',
    'src/main/utils/**/*.ts',
    'src/preload/**/*.ts',
    'src/shared/**/*.ts',
    '!src/**/*.d.ts',
    '!src/setupTests.ts',
    '!src/renderer/index.tsx',
    '!src/main/index.ts',
    '!src/preload/index.ts'
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: [
    'text',
    'text-summary',
    'html',
    'lcov'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    },
    'src/main/core/**/*.ts': {
      branches: 85,
      functions: 90,
      lines: 90,
      statements: 90
    }
  },
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest'
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testTimeout: 10000,
  maxWorkers: '50%'
};
