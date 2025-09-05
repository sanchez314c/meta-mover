// Jest setup file for META Mover
import '@testing-library/jest-dom';

// Mock Electron modules for testing
const mockElectron = {
  ipcRenderer: {
    on: jest.fn(),
    send: jest.fn(),
    invoke: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  contextBridge: {
    exposeInMainWorld: jest.fn(),
  },
};

// Mock the electron module
jest.mock('electron', () => mockElectron);

// Global test setup
beforeEach(() => {
  // Reset all mocks before each test
  jest.clearAllMocks();
});
