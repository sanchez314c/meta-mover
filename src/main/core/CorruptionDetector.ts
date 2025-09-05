/**
 * Corruption Detector - VidBeast-inspired multi-phase corruption analysis
 *
 * Implements sophisticated corruption detection to prevent false positives
 * while accurately identifying truly corrupted media files.
 */

import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import sharp from 'sharp';

import { MediaType, CorruptionReport, CorruptionLevel, CorruptionType } from '@shared/types/media';
import { CORRUPTION_THRESHOLDS, PROCESSING_LIMITS } from '@shared/constants/index';

import { Logger } from '../utils/Logger';
import { FFProbeWrapper } from '../utils/FFProbeWrapper';
import { FileSystemUtils } from '../utils/FileSystemUtils';

interface AnalysisPhase {
  name: string;
  weight: number;
  completed: boolean;
  score: number; // 0 (clean) to 1 (corrupted)
  issues: string[];
}

interface ContainerAnalysis {
  headerValid: boolean;
  structureValid: boolean;
  metadataValid: boolean;
  issues: string[];
}

interface StreamAnalysis {
  streamsDetected: number;
  streamsValid: number;
  codecErrors: string[];
  timestampIssues: boolean;
}

interface BitstreamAnalysis {
  sampleCount: number;
  corruptedSamples: number;
  patternAnomalies: number;
  dataIntegrityScore: number;
}

interface PlayabilityAnalysis {
  canOpen: boolean;
  duration: number;
  playableDuration: number;
  frameErrors: number;
  audioErrors: number;
}

export class CorruptionDetector {
  private logger: Logger;
  private ffprobe: FFProbeWrapper;
  private fsUtils: FileSystemUtils;

  constructor() {
    this.logger = Logger.getInstance();
    this.ffprobe = new FFProbeWrapper();
    this.fsUtils = new FileSystemUtils();
  }

  /**
   * Analyze a media file for corruption using multi-phase approach.
   * Matches legacy check_video_corruption_vidbeast() logic.
   *
   * Key differences from original implementation:
   * - Empty files (0 bytes) → CATASTROPHIC immediately
   * - If video plays fine with ≤1 minor issues → clear to NONE (prevent false positives)
   * - Bitrate sanity check: MIN_ACCEPTABLE_BITRATE = 10000 bps
   * - Final decision: NONE or MINOR → treated as NONE (only MODERATE+ counts)
   */
  public async analyzeFile(filePath: string, mediaType: MediaType): Promise<CorruptionReport> {
    this.logger.debug('Starting corruption analysis', { filePath, mediaType });

    try {
      // Phase 1: Basic file validation (legacy Phase 1)
      const stats = await fs.stat(filePath);

      // Empty file = CATASTROPHIC (matches legacy)
      if (stats.size === 0) {
        return {
          filePath,
          corruptionLevel: CorruptionLevel.CATASTROPHIC,
          corruptionTypes: [CorruptionType.CONTAINER],
          isPlayable: false,
          playableDuration: 0,
          totalDuration: 0,
          confidence: 1.0,
          details: 'File is empty (0 bytes)',
          recoverable: false,
          recoveryActions: [],
        };
      }

      // Initialize analysis phases
      const phases: AnalysisPhase[] = [
        { name: 'container', weight: 0.25, completed: false, score: 0, issues: [] },
        { name: 'stream', weight: 0.25, completed: false, score: 0, issues: [] },
        { name: 'bitstream', weight: 0.3, completed: false, score: 0, issues: [] },
        { name: 'playability', weight: 0.2, completed: false, score: 0, issues: [] },
      ];

      const corruptionTypes: CorruptionType[] = [];
      let playableDuration = 0;
      let totalDuration = 0;

      // Phase 1: Container Analysis
      const containerResult = await this.analyzeContainer(filePath, mediaType);
      phases[0].score = this.calculateContainerScore(containerResult);
      phases[0].issues = containerResult.issues;
      phases[0].completed = true;

      if (!containerResult.structureValid) {
        corruptionTypes.push(CorruptionType.CONTAINER);
      }
      if (!containerResult.metadataValid) {
        corruptionTypes.push(CorruptionType.METADATA);
      }

      // Phase 2: Stream Analysis (for video/audio files)
      if (mediaType === MediaType.VIDEO || mediaType === MediaType.AUDIO) {
        const streamResult = await this.analyzeStreams(filePath);
        phases[1].score = this.calculateStreamScore(streamResult);
        phases[1].issues = streamResult.codecErrors;
        phases[1].completed = true;

        if (streamResult.streamsValid < streamResult.streamsDetected) {
          corruptionTypes.push(CorruptionType.STREAM);
        }
        if (streamResult.timestampIssues) {
          corruptionTypes.push(CorruptionType.TIMESTAMP);
        }
      }

      // Phase 3: Bitstream Analysis
      const bitstreamResult = await this.analyzeBitstream(filePath, mediaType);
      phases[2].score = bitstreamResult.dataIntegrityScore;
      phases[2].completed = true;

      if (bitstreamResult.corruptedSamples > bitstreamResult.sampleCount * 0.1) {
        corruptionTypes.push(CorruptionType.BITSTREAM);
      }

      // Phase 4: Playability Test
      const playabilityResult = await this.analyzePlayability(filePath, mediaType);
      phases[3].score = this.calculatePlayabilityScore(playabilityResult);
      phases[3].completed = true;

      playableDuration = playabilityResult.playableDuration;
      totalDuration = playabilityResult.duration;

      if (playabilityResult.frameErrors > 0) {
        corruptionTypes.push(CorruptionType.STREAM);
      }
      if (playabilityResult.audioErrors > 0) {
        corruptionTypes.push(CorruptionType.AUDIO);
      }

      // Calculate overall corruption score
      let overallScore = phases.reduce((sum, phase) => sum + phase.score * phase.weight, 0);

      // LEGACY VidBeast logic: If video plays fine, clear minor issues
      // "Clear any minor issues if video plays fine"
      if (playabilityResult.canOpen && playableDuration > 0 && corruptionTypes.length <= 1) {
        overallScore = 0;
        corruptionTypes.length = 0;
      }

      // Phase 4 extension: Bitrate sanity check (legacy Phase 4)
      if (playabilityResult.canOpen && playableDuration > 0 && totalDuration > 0) {
        const bitrate = (stats.size * 8) / totalDuration;
        const minBitrate = PROCESSING_LIMITS.MIN_ACCEPTABLE_BITRATE || 10000;
        if (bitrate > 0 && bitrate < minBitrate) {
          corruptionTypes.push(CorruptionType.BITSTREAM);
          overallScore = Math.max(overallScore, CORRUPTION_THRESHOLDS.MODERATE_THRESHOLD + 0.01);
        }
      }

      // Determine corruption level
      let corruptionLevel = this.determineCorruptionLevel(overallScore);

      // LEGACY final decision: Only MODERATE or higher counts as corrupted
      // "if report.corruption_level in [CorruptionLevel.NONE, CorruptionLevel.MINOR]:"
      // "    report.corruption_level = CorruptionLevel.NONE"
      if (corruptionLevel === CorruptionLevel.NONE || corruptionLevel === CorruptionLevel.MINOR) {
        corruptionLevel = CorruptionLevel.NONE;
        corruptionTypes.length = 0;
      }

      // Calculate confidence
      const confidence = this.calculateConfidence(phases, overallScore);

      // Generate recovery actions if corrupted
      const recoveryActions =
        corruptionLevel !== CorruptionLevel.NONE
          ? this.generateRecoveryActions(corruptionTypes, playabilityResult)
          : [];

      const report: CorruptionReport = {
        filePath,
        corruptionLevel,
        corruptionTypes: [...new Set(corruptionTypes)],
        isPlayable:
          corruptionLevel === CorruptionLevel.NONE ||
          (playabilityResult.canOpen && playableDuration > 0),
        playableDuration,
        totalDuration,
        confidence,
        details: this.generateDetailedReport(phases, overallScore),
        recoverable: this.isRecoverable(corruptionLevel, corruptionTypes),
        recoveryActions,
      };

      this.logger.info('Corruption analysis completed', {
        filePath,
        corruptionLevel,
        confidence,
        isPlayable: report.isPlayable,
      });

      return report;
    } catch (error) {
      this.logger.error('Corruption analysis failed', { filePath, error });

      // Return a safe fallback report
      return {
        filePath,
        corruptionLevel: CorruptionLevel.NONE,
        corruptionTypes: [],
        isPlayable: true,
        playableDuration: 0,
        totalDuration: 0,
        confidence: 0,
        details: `Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        recoverable: true,
        recoveryActions: ['Manual inspection recommended'],
      };
    }
  }

  /**
   * Phase 1: Container Analysis
   */
  private async analyzeContainer(
    filePath: string,
    mediaType: MediaType
  ): Promise<ContainerAnalysis> {
    const result: ContainerAnalysis = {
      headerValid: false,
      structureValid: false,
      metadataValid: false,
      issues: [],
    };

    try {
      // Check file header/magic bytes
      const headerValid = await this.validateFileHeader(filePath, mediaType);
      result.headerValid = headerValid;

      if (!headerValid) {
        result.issues.push('Invalid or corrupted file header');
      }

      // For video/audio files, use ffprobe for container analysis
      if (mediaType === MediaType.VIDEO || mediaType === MediaType.AUDIO) {
        try {
          const metadata = await this.ffprobe.getRawVideoMetadata(filePath);

          result.structureValid = !!(
            metadata &&
            metadata.format &&
            metadata.streams &&
            metadata.streams.length > 0
          );
          result.metadataValid = !!(metadata && metadata.format && metadata.format.format_name);

          if (!result.structureValid) {
            result.issues.push('Container structure is invalid');
          }
          if (!result.metadataValid) {
            result.issues.push('Container metadata is missing or corrupted');
          }
        } catch (error) {
          result.issues.push(`Container analysis failed: ${error}`);
        }
      }

      // For images, use Sharp for basic validation
      if (mediaType === MediaType.IMAGE) {
        try {
          const metadata = await sharp(filePath).metadata();
          result.structureValid = !!(metadata.width && metadata.height);
          result.metadataValid = !!metadata.format;

          if (!result.structureValid) {
            result.issues.push('Image dimensions could not be read');
          }
        } catch (error) {
          result.structureValid = false;
          result.issues.push(`Image analysis failed: ${error}`);
        }
      }
    } catch (error) {
      result.issues.push(`Container analysis error: ${error}`);
    }

    return result;
  }

  /**
   * Phase 2: Stream Analysis
   */
  private async analyzeStreams(filePath: string): Promise<StreamAnalysis> {
    const result: StreamAnalysis = {
      streamsDetected: 0,
      streamsValid: 0,
      codecErrors: [],
      timestampIssues: false,
    };

    try {
      const metadata = await this.ffprobe.getRawVideoMetadata(filePath);

      if (metadata && metadata.streams) {
        result.streamsDetected = metadata.streams.length;

        for (const stream of metadata.streams) {
          let streamValid = true;

          // Check codec validity
          if (!stream.codec_name || stream.codec_name === 'unknown') {
            streamValid = false;
            result.codecErrors.push(`Stream ${stream.index}: Unknown or missing codec`);
          }

          // Check for duration issues
          if (stream.duration && parseFloat(stream.duration) <= 0) {
            streamValid = false;
            result.codecErrors.push(`Stream ${stream.index}: Invalid duration`);
          }

          // Check for timestamp issues
          if (stream.start_time && parseFloat(stream.start_time) < 0) {
            result.timestampIssues = true;
          }

          if (streamValid) {
            result.streamsValid++;
          }
        }
      }
    } catch (error) {
      result.codecErrors.push(`Stream analysis failed: ${error}`);
    }

    return result;
  }

  /**
   * Phase 3: Bitstream Analysis
   */
  private async analyzeBitstream(
    filePath: string,
    mediaType: MediaType
  ): Promise<BitstreamAnalysis> {
    const result: BitstreamAnalysis = {
      sampleCount: 0,
      corruptedSamples: 0,
      patternAnomalies: 0,
      dataIntegrityScore: 0,
    };

    try {
      // Read file in chunks for pattern analysis
      const fileHandle = await fs.open(filePath, 'r');
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;

      // Sample analysis parameters
      const sampleSize = 1024; // 1KB samples
      const maxSamples = Math.min(100, Math.floor(fileSize / sampleSize)); // Max 100 samples
      const sampleInterval = Math.floor(fileSize / maxSamples);

      result.sampleCount = maxSamples;
      let corruptedCount = 0;
      let anomalies = 0;

      for (let i = 0; i < maxSamples; i++) {
        const offset = i * sampleInterval;
        const buffer = Buffer.alloc(Math.min(sampleSize, fileSize - offset));

        await fileHandle.read(buffer, 0, buffer.length, offset);

        // Analyze sample for patterns
        const analysis = this.analyzeSample(buffer, mediaType);

        if (analysis.corrupted) {
          corruptedCount++;
        }
        if (analysis.anomalous) {
          anomalies++;
        }
      }

      await fileHandle.close();

      result.corruptedSamples = corruptedCount;
      result.patternAnomalies = anomalies;
      result.dataIntegrityScore = corruptedCount / maxSamples;
    } catch (error) {
      this.logger.error('Bitstream analysis failed', { filePath, error });
      result.dataIntegrityScore = 0.5; // Assume moderate risk if analysis fails
    }

    return result;
  }

  /**
   * Phase 4: Playability Analysis
   */
  private async analyzePlayability(
    filePath: string,
    mediaType: MediaType
  ): Promise<PlayabilityAnalysis> {
    const result: PlayabilityAnalysis = {
      canOpen: false,
      duration: 0,
      playableDuration: 0,
      frameErrors: 0,
      audioErrors: 0,
    };

    try {
      if (mediaType === MediaType.VIDEO || mediaType === MediaType.AUDIO) {
        // Test playability with ffprobe
        const metadata = await this.ffprobe.getRawVideoMetadata(filePath);

        result.canOpen = !!(metadata && metadata.format && metadata.streams);

        if (metadata && metadata.format?.duration) {
          result.duration = parseFloat(metadata.format.duration);
        }

        // Test actual playback with ffmpeg
        const playbackTest = await this.testPlayback(filePath, mediaType);
        result.playableDuration = playbackTest.playableDuration;
        result.frameErrors = playbackTest.frameErrors;
        result.audioErrors = playbackTest.audioErrors;
      } else if (mediaType === MediaType.IMAGE) {
        // Test image opening with Sharp
        try {
          const metadata = await sharp(filePath).metadata();
          result.canOpen = !!(metadata.width && metadata.height);
          result.duration = 0; // Images don't have duration
          result.playableDuration = result.canOpen ? 1 : 0; // Binary for images
        } catch (error) {
          result.canOpen = false;
        }
      }
    } catch (error) {
      this.logger.error('Playability analysis failed', { filePath, error });
    }

    return result;
  }

  /**
   * Test actual playback to detect runtime errors.
   * Matches legacy check_video_corruption_vidbeast Phase 3.
   * Uses PLAYABILITY_TEST_DURATION (5 seconds) from legacy.
   */
  private async testPlayback(
    filePath: string,
    _mediaType: MediaType
  ): Promise<{
    playableDuration: number;
    frameErrors: number;
    audioErrors: number;
  }> {
    return new Promise((resolve) => {
      const result = { playableDuration: 0, frameErrors: 0, audioErrors: 0 };
      const testDuration = PROCESSING_LIMITS.PLAYABILITY_TEST_DURATION || 5;

      // Use ffmpeg to test playback - matches legacy exactly:
      // ffmpeg -v error -i file -t 5 -f null -
      const args = ['-v', 'error', '-i', filePath, '-t', String(testDuration), '-f', 'null', '-'];

      const ffmpeg = spawn('ffmpeg', args);
      let errorOutput = '';

      ffmpeg.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ffmpeg.on('close', (code) => {
        // Parse error output for frame/audio errors
        const frameErrorMatches = errorOutput.match(/error.*frame/gi) || [];
        const audioErrorMatches = errorOutput.match(/error.*audio/gi) || [];

        result.frameErrors = frameErrorMatches.length;
        result.audioErrors = audioErrorMatches.length;

        if (code === 0) {
          // Video is playable! Matches legacy: report.is_playable = True
          result.playableDuration = testDuration;
        } else {
          // Try to determine if partially playable (legacy regex)
          const timeMatch = errorOutput.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
          if (timeMatch) {
            const hours = parseInt(timeMatch[1]);
            const minutes = parseInt(timeMatch[2]);
            const seconds = parseFloat(timeMatch[3]);
            result.playableDuration = hours * 3600 + minutes * 60 + seconds;
          }
        }

        resolve(result);
      });

      // Timeout matching legacy FFMPEG_PLAYABILITY_TIMEOUT (15s)
      setTimeout(
        () => {
          ffmpeg.kill('SIGTERM');
          resolve(result);
        },
        (PROCESSING_LIMITS.FFMPEG_PLAYABILITY_TIMEOUT || 15) * 1000
      );
    });
  }

  /**
   * Validate file header/magic bytes
   */
  private async validateFileHeader(filePath: string, mediaType: MediaType): Promise<boolean> {
    try {
      const buffer = Buffer.alloc(32);
      const fileHandle = await fs.open(filePath, 'r');
      await fileHandle.read(buffer, 0, 32, 0);
      await fileHandle.close();

      const hex = buffer.toString('hex');
      const headerValidators = this.getHeaderValidators(mediaType);

      return headerValidators.some((validator) => validator(hex));
    } catch (error) {
      return false;
    }
  }

  /**
   * Get header validation functions for different media types
   */
  private getHeaderValidators(mediaType: MediaType): Array<(hex: string) => boolean> {
    const validators: { [key in MediaType]: Array<(hex: string) => boolean> } = {
      [MediaType.IMAGE]: [
        (hex) => hex.startsWith('ffd8ff'), // JPEG
        (hex) => hex.startsWith('89504e47'), // PNG
        (hex) => hex.startsWith('47494638'), // GIF
        (hex) => hex.startsWith('424d'), // BMP
        (hex) => hex.startsWith('49492a00') || hex.startsWith('4d4d002a'), // TIFF
      ],
      [MediaType.VIDEO]: [
        (hex) => hex.includes('66747970'), // MP4/MOV (ftyp)
        (hex) => hex.startsWith('52494646') && hex.includes('41564920'), // AVI
        (hex) => hex.startsWith('1a45dfa3'), // MKV/WebM
        (hex) => hex.startsWith('464c5601'), // FLV
      ],
      [MediaType.AUDIO]: [
        (hex) => hex.startsWith('494433'), // MP3 with ID3
        (hex) => hex.startsWith('fffb') || hex.startsWith('fff3'), // MP3 frame
        (hex) => hex.startsWith('664c6143'), // FLAC
        (hex) => hex.startsWith('4f676753'), // OGG
      ],
      [MediaType.DOCUMENT]: [],
      [MediaType.ART]: [],
      [MediaType.UNKNOWN]: [],
    };

    return validators[mediaType] || [];
  }

  /**
   * Analyze a data sample for corruption patterns
   */
  private analyzeSample(
    buffer: Buffer,
    mediaType: MediaType
  ): { corrupted: boolean; anomalous: boolean } {
    let corrupted = false;
    let anomalous = false;

    // Check for null bytes (potential corruption)
    const nullBytes = buffer.filter((byte) => byte === 0).length;
    if (nullBytes > buffer.length * 0.8) {
      corrupted = true;
    }

    // Check for repeated patterns (potential corruption)
    const uniqueBytes = new Set(buffer).size;
    if (uniqueBytes < 10 && buffer.length > 100) {
      anomalous = true;
    }

    // Media-specific pattern analysis
    if (mediaType === MediaType.VIDEO || mediaType === MediaType.AUDIO) {
      // Look for frame sync patterns or codec-specific markers
      const syncPatterns = this.findSyncPatterns(buffer);
      if (syncPatterns < 1 && buffer.length > 512) {
        anomalous = true;
      }
    }

    return { corrupted, anomalous };
  }

  /**
   * Find sync patterns in media data
   */
  private findSyncPatterns(buffer: Buffer): number {
    let patterns = 0;

    // Look for common sync patterns
    const syncBytes = [
      [0xff, 0xfb], // MP3 frame header
      [0xff, 0xf9], // AAC frame header
      [0x00, 0x00, 0x01], // H.264 NAL unit
    ];

    for (let i = 0; i < buffer.length - 3; i++) {
      for (const pattern of syncBytes) {
        let match = true;
        for (let j = 0; j < pattern.length; j++) {
          if (buffer[i + j] !== pattern[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          patterns++;
        }
      }
    }

    return patterns;
  }

  /**
   * Calculate corruption level based on overall score
   */
  private determineCorruptionLevel(score: number): CorruptionLevel {
    if (score <= CORRUPTION_THRESHOLDS.MINOR_THRESHOLD) {
      return CorruptionLevel.NONE;
    } else if (score <= CORRUPTION_THRESHOLDS.MODERATE_THRESHOLD) {
      return CorruptionLevel.MINOR;
    } else if (score <= CORRUPTION_THRESHOLDS.SEVERE_THRESHOLD) {
      return CorruptionLevel.MODERATE;
    } else if (score <= CORRUPTION_THRESHOLDS.CATASTROPHIC_THRESHOLD) {
      return CorruptionLevel.SEVERE;
    } else {
      return CorruptionLevel.CATASTROPHIC;
    }
  }

  /**
   * Calculate confidence score based on analysis consistency
   */
  private calculateConfidence(phases: AnalysisPhase[], overallScore: number): number {
    // Base confidence on phase completion
    const completedPhases = phases.filter((p) => p.completed).length;
    let confidence = completedPhases / phases.length;

    // Adjust for score consistency across phases
    const scores = phases.filter((p) => p.completed).map((p) => p.score);
    if (scores.length > 1) {
      const variance = this.calculateVariance(scores);
      confidence *= Math.max(0.5, 1 - variance); // Lower confidence for high variance
    }

    // Adjust for extreme scores (high confidence in clear cases)
    if (overallScore < 0.1 || overallScore > 0.9) {
      confidence = Math.min(1.0, confidence + 0.2);
    }

    return Math.round(confidence * 100) / 100;
  }

  /**
   * Calculate statistical variance
   */
  private calculateVariance(numbers: number[]): number {
    const mean = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
    const squaredDifferences = numbers.map((n) => Math.pow(n - mean, 2));
    return squaredDifferences.reduce((sum, n) => sum + n, 0) / numbers.length;
  }

  /**
   * Calculate container analysis score
   */
  private calculateContainerScore(analysis: ContainerAnalysis): number {
    let score = 0;

    if (!analysis.headerValid) score += 0.4;
    if (!analysis.structureValid) score += 0.4;
    if (!analysis.metadataValid) score += 0.2;

    return Math.min(1.0, score);
  }

  /**
   * Calculate stream analysis score
   */
  private calculateStreamScore(analysis: StreamAnalysis): number {
    if (analysis.streamsDetected === 0) return 0;

    const streamRatio = 1 - analysis.streamsValid / analysis.streamsDetected;
    const errorPenalty = Math.min(0.3, analysis.codecErrors.length * 0.1);
    const timestampPenalty = analysis.timestampIssues ? 0.2 : 0;

    return Math.min(1.0, streamRatio + errorPenalty + timestampPenalty);
  }

  /**
   * Calculate playability score
   */
  private calculatePlayabilityScore(analysis: PlayabilityAnalysis): number {
    if (!analysis.canOpen) return 1.0;

    let score = 0;

    // Duration-based scoring
    if (analysis.duration > 0) {
      const playableRatio = analysis.playableDuration / analysis.duration;
      score = 1 - playableRatio;
    }

    // Error-based scoring
    const errorPenalty = Math.min(0.5, (analysis.frameErrors + analysis.audioErrors) * 0.05);
    score += errorPenalty;

    return Math.min(1.0, score);
  }

  /**
   * Generate detailed analysis report
   */
  private generateDetailedReport(phases: AnalysisPhase[], overallScore: number): string {
    const lines: string[] = [`Overall corruption score: ${(overallScore * 100).toFixed(1)}%`, ''];

    for (const phase of phases) {
      if (phase.completed) {
        lines.push(`${phase.name.toUpperCase()} PHASE:`);
        lines.push(`  Score: ${(phase.score * 100).toFixed(1)}%`);

        if (phase.issues.length > 0) {
          lines.push(`  Issues:`);
          phase.issues.forEach((issue) => lines.push(`    - ${issue}`));
        } else {
          lines.push(`  No issues detected`);
        }

        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Determine if corruption is recoverable
   */
  private isRecoverable(level: CorruptionLevel, types: CorruptionType[]): boolean {
    if (level === CorruptionLevel.CATASTROPHIC) {
      return false;
    }

    if (level === CorruptionLevel.SEVERE && types.includes(CorruptionType.CONTAINER)) {
      return false;
    }

    // Metadata and timestamp issues are usually recoverable
    if (
      types.every((type) => type === CorruptionType.METADATA || type === CorruptionType.TIMESTAMP)
    ) {
      return true;
    }

    return level !== CorruptionLevel.SEVERE;
  }

  /**
   * Generate recovery action suggestions
   */
  private generateRecoveryActions(
    types: CorruptionType[],
    playability: PlayabilityAnalysis
  ): string[] {
    const actions: string[] = [];

    if (types.includes(CorruptionType.METADATA)) {
      actions.push('Repair metadata using specialized tools');
      actions.push('Extract and rebuild metadata from file content');
    }

    if (types.includes(CorruptionType.TIMESTAMP)) {
      actions.push('Correct timestamp information');
      actions.push('Re-synchronize audio/video tracks');
    }

    if (types.includes(CorruptionType.CONTAINER)) {
      actions.push('Attempt container repair/reconstruction');
      actions.push('Extract raw streams and re-mux');
    }

    if (types.includes(CorruptionType.STREAM)) {
      actions.push('Re-encode affected streams');
      actions.push('Extract uncorrupted portions');
    }

    if (playability.playableDuration > 0 && playability.duration > playability.playableDuration) {
      actions.push(`Extract playable portion (${playability.playableDuration.toFixed(1)}s)`);
    }

    if (actions.length === 0) {
      actions.push('Manual inspection and recovery required');
      actions.push('Consider professional data recovery services');
    }

    return actions;
  }
}
