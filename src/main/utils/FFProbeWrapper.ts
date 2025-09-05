import { spawn } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffprobe = require('ffprobe-static') as { path: string };

export interface FFProbeStream {
  index?: number;
  width?: number;
  height?: number;
  codec_name?: string;
  codec_long_name?: string;
  bit_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  codec_type?: string;
  sample_rate?: string;
  channels?: number;
  nb_frames?: string;
  start_time?: string;
  tags?: Record<string, string>;
}

export interface FFProbeFormat {
  duration?: string;
  format_name?: string;
  bit_rate?: string;
  size?: string;
  tags?: Record<string, string>;
}

export interface FFProbeRawData {
  streams?: FFProbeStream[];
  format?: FFProbeFormat;
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  codec: string;
  bitrate: number;
  fps: number;
  hasAudio: boolean;
  format?: {
    duration?: string;
    format_name?: string;
    bit_rate?: string;
    tags?: { [key: string]: string };
  };
  streams?: Array<{
    width?: number;
    height?: number;
    codec_name?: string;
    bit_rate?: string;
    r_frame_rate?: string;
    duration?: string;
    codec_type?: string;
    sample_rate?: string;
    channels?: number;
  }>;
}

export class FFProbeWrapper {
  private ffprobePath: string;

  constructor() {
    this.ffprobePath = ffprobe.path;
  }

  async getRawVideoMetadata(filePath: string): Promise<FFProbeRawData | null> {
    return new Promise((resolve) => {
      const args = [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,bit_rate,r_frame_rate,duration',
        '-show_entries',
        'format=format_name,duration,bit_rate',
        '-of',
        'json',
        filePath,
      ];

      const ffprobeProcess = spawn(this.ffprobePath, args);
      let output = '';

      const timeout = setTimeout(() => {
        ffprobeProcess.kill('SIGTERM');
      }, 30000);

      ffprobeProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      // Drain stderr to prevent buffer overflow; content is not used
      ffprobeProcess.stderr.resume();

      ffprobeProcess.on('close', (code) => {
        clearTimeout(timeout);
        // ffprobe writes informational messages to stderr even for valid files;
        // only treat non-zero exit code as failure.
        if (code !== 0) {
          resolve(null);
          return;
        }

        try {
          const result = JSON.parse(output);
          resolve(result);
        } catch (parseError) {
          resolve(null);
        }
      });
    });
  }

  async getVideoMetadata(filePath: string): Promise<VideoMetadata | null> {
    return new Promise((resolve) => {
      const args = [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,codec_name,bit_rate,r_frame_rate,duration',
        '-show_entries',
        'format=duration,bit_rate',
        '-of',
        'json',
        filePath,
      ];

      const ffprobeProcess = spawn(this.ffprobePath, args);
      let output = '';

      const timeout = setTimeout(() => {
        ffprobeProcess.kill('SIGTERM');
      }, 30000);

      ffprobeProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      // Drain stderr to prevent buffer overflow; content is not used
      ffprobeProcess.stderr.resume();

      ffprobeProcess.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          resolve(null);
          return;
        }

        try {
          const result = JSON.parse(output);
          const stream = result.streams?.[0];
          const format = result.format;

          if (!stream || !format) {
            resolve(null);
            return;
          }

          const metadata: VideoMetadata = {
            duration: parseFloat(format.duration || '0'),
            width: stream.width || 0,
            height: stream.height || 0,
            codec: stream.codec_name || 'unknown',
            bitrate: parseInt(stream.bit_rate || format.bit_rate || '0'),
            fps: this.parseFPS(stream.r_frame_rate),
            hasAudio:
              result.streams?.some((s: Record<string, unknown>) => s.codec_type === 'audio') ||
              false,
          };

          resolve(metadata);
        } catch (parseError) {
          resolve(null);
        }
      });
    });
  }

  async checkVideoIntegrity(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const args = ['-v', 'error', '-i', filePath, '-f', 'null', '-'];

      const ffprobeProcess = spawn(this.ffprobePath, args);
      let error = '';

      const timeout = setTimeout(() => {
        ffprobeProcess.kill('SIGTERM');
      }, 30000);

      ffprobeProcess.stderr.on('data', (data) => {
        error += data.toString();
      });

      ffprobeProcess.on('close', (code) => {
        clearTimeout(timeout);
        // If ffprobe exits with code 0 and no errors, video is valid
        resolve(code === 0 && !error.includes('Invalid'));
      });
    });
  }

  private parseFPS(fpsString: string): number {
    if (!fpsString) return 0;

    const parts = fpsString.split('/');
    if (parts.length === 2) {
      return parseInt(parts[0]) / parseInt(parts[1]);
    }

    return parseFloat(fpsString) || 0;
  }
}
