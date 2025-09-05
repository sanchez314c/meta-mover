import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';

export interface AppConfig {
  version: string;
  firstRun: boolean;
  theme: 'light' | 'dark' | 'system';
  language: string;
  windowBounds?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
  processingOptions: {
    maxConcurrentJobs: number;
    enableGPU: boolean;
    preserveOriginals: boolean;
    defaultOutputPath: string;
  };
  organizationOptions: {
    dateFormat: string;
    folderStructure: 'year/month' | 'year-month' | 'flat';
    conflictResolution: 'skip' | 'rename' | 'overwrite';
  };
}

export class ConfigManager {
  private static instance: ConfigManager;
  private configPath: string;
  private config: AppConfig;
  private logger: Logger;

  private constructor() {
    this.logger = Logger.getInstance();
    const userDataPath = app.getPath('userData');
    this.configPath = path.join(userDataPath, 'config.json');
    this.config = this.loadConfig();
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  updateConfig(updates: Partial<AppConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  private loadConfig(): AppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(data);
        // Merge loaded config over defaults so unknown/missing keys fall back safely
        return { ...this.getDefaultConfig(), ...parsed };
      }
    } catch (error) {
      this.logger.warn('Error loading config, using defaults', { error });
    }

    return this.getDefaultConfig();
  }

  private getDefaultConfig(): AppConfig {
    return {
      version: '1.0.0',
      firstRun: true,
      theme: 'system',
      language: 'en',
      processingOptions: {
        maxConcurrentJobs: 4,
        enableGPU: false,
        preserveOriginals: true,
        defaultOutputPath: app.getPath('pictures'),
      },
      organizationOptions: {
        dateFormat: 'YYYY-MM-DD',
        folderStructure: 'year/month',
        conflictResolution: 'rename',
      },
    };
  }

  saveConfig(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      this.logger.error('Error saving config', { error });
    }
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.config[key] = value;
    this.saveConfig();
  }

  getAll(): AppConfig {
    return { ...this.config };
  }

  reset(): void {
    this.config = this.getDefaultConfig();
    this.saveConfig();
  }
}
