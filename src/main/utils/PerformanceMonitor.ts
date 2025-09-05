export interface PerformanceMetrics {
  cpuUsage: number;
  memoryUsage: number;
  processedFiles: number;
  processingRate: number;
  averageFileTime: number;
  totalTime: number;
}

export class PerformanceMonitor {
  private startTime: number = 0;
  private processedFiles: number = 0;
  private fileTimes: number[] = [];
  private maxSamples: number = 100;

  public start(): void {
    this.startTime = Date.now();
    this.processedFiles = 0;
    this.fileTimes = [];
  }

  public recordFileProcessed(processingTime: number): void {
    this.processedFiles++;
    this.fileTimes.push(processingTime);

    if (this.fileTimes.length > this.maxSamples) {
      this.fileTimes.shift();
    }
  }

  public getMetrics(): PerformanceMetrics {
    const totalTime = this.startTime ? Date.now() - this.startTime : 0;
    const averageFileTime =
      this.fileTimes.length > 0
        ? this.fileTimes.reduce((a, b) => a + b, 0) / this.fileTimes.length
        : 0;

    const memUsage = process.memoryUsage();

    return {
      cpuUsage: process.cpuUsage ? process.cpuUsage().user / 1000000 : 0,
      memoryUsage: memUsage.heapUsed / 1024 / 1024,
      processedFiles: this.processedFiles,
      processingRate: totalTime > 0 ? (this.processedFiles / totalTime) * 1000 : 0,
      averageFileTime,
      totalTime,
    };
  }

  public reset(): void {
    this.startTime = 0;
    this.processedFiles = 0;
    this.fileTimes = [];
  }
}
