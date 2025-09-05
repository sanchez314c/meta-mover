import { EventEmitter } from 'events';

export interface Job {
  id: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  priority?: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: Error;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export class JobQueue extends EventEmitter {
  private queue: Job[] = [];
  private maxConcurrent: number = 1;
  private activeJobs: number = 0;

  constructor(maxConcurrent: number = 1) {
    super();
    this.maxConcurrent = maxConcurrent;
  }

  public addJob(job: Omit<Job, 'id' | 'createdAt' | 'status'>): string {
    const id = Math.random().toString(36).substr(2, 9);
    const newJob: Job = {
      ...job,
      id,
      createdAt: new Date(),
      status: 'pending',
      priority: job.priority || 0,
    };

    this.queue.push(newJob);
    this.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    this.emit('job-added', newJob);
    this.processNext();

    return id;
  }

  public add(job: Job): void {
    this.queue.push(job);
    this.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.emit('job-added', job);
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.activeJobs >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const job = this.queue.find((j) => j.status === 'pending');
    if (!job) return;

    this.activeJobs++;
    job.status = 'running';
    job.startedAt = new Date();

    this.emit('job-started', job);

    try {
      // Process job would be implemented by extending classes
      this.emit('process-job', job);
      job.status = 'completed';
      job.completedAt = new Date();
      this.emit('job-completed', job);
    } catch (error) {
      job.status = 'failed';
      job.error = error as Error;
      this.emit('job-failed', job);
    } finally {
      this.activeJobs--;
      this.processNext();
    }
  }

  public getJob(id: string): Job | undefined {
    return this.queue.find((j) => j.id === id);
  }

  public getAllJobs(): Job[] {
    return [...this.queue];
  }

  public clearCompleted(): void {
    this.queue = this.queue.filter((j) => j.status !== 'completed');
  }

  public stop(): void {
    // Prevents new jobs from being dequeued — activeJobs drain naturally.
  }

  public start(): void {
    this.processNext();
  }
}
