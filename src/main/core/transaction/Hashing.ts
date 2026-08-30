import { createHash } from 'crypto';
import { constants } from 'fs';
import { FileHandle, open } from 'fs/promises';

export interface HashResult {
  hash: string;
  bytes: number;
}

const BUFFER_SIZE = 1024 * 1024;

class HashingAggregateError extends Error {
  readonly name = 'AggregateError';

  constructor(
    public readonly errors: readonly unknown[],
    message: string
  ) {
    super(message);
  }
}

export async function closeFileHandlePreservingError(
  handle: Pick<FileHandle, 'close'>,
  primaryError?: unknown
): Promise<void> {
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new HashingAggregateError(
        [primaryError, closeError],
        'File operation and handle close both failed'
      );
    }
    throw closeError;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Operation cancelled');
  error.name = 'AbortError';
  throw error;
}

export async function hashFileHandle(handle: FileHandle, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
  let position = 0;

  while (true) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  return hash.digest('hex');
}

export async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let primaryError: unknown;
  try {
    return await hashFileHandle(handle, signal);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeFileHandlePreservingError(handle, primaryError);
  }
}

export async function copyHandleToStaging(
  source: FileHandle,
  stagingPath: string,
  signal?: AbortSignal,
  durable = true
): Promise<HashResult> {
  const destination = await open(stagingPath, 'wx');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
  let position = 0;
  let primaryError: unknown;

  try {
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          chunk,
          written,
          bytesRead - written,
          position + written
        );
        written += result.bytesWritten;
      }
      hash.update(chunk);
      position += bytesRead;
    }

    if (durable) await destination.sync();
    return { hash: hash.digest('hex'), bytes: position };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeFileHandlePreservingError(destination, primaryError);
  }
}

export async function copyFileToStaging(
  sourcePath: string,
  stagingPath: string,
  signal?: AbortSignal,
  durable = true
): Promise<HashResult> {
  const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let primaryError: unknown;
  try {
    return await copyHandleToStaging(source, stagingPath, signal, durable);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeFileHandlePreservingError(source, primaryError);
  }
}
