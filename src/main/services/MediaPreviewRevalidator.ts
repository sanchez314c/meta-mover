import { constants } from 'fs';
import { lstat, open } from 'fs/promises';

import { hashFileHandle } from '../core/transaction/Hashing';

import {
  PreparedPreview,
  PreviewRevalidationResult,
  PreviewRevalidatorPort,
} from './ProcessingCoordinator';

export interface RuntimeReadinessResult {
  ready: boolean;
  reasons: string[];
}

export interface RuntimeReadinessPort {
  check(): Promise<RuntimeReadinessResult>;
}

export interface MediaPreviewRevalidatorDependencies {
  runtime: RuntimeReadinessPort;
}

interface ExpectedSourceIdentity {
  device: number;
  inode: number;
  links: number;
  size: number;
}

interface RevalidationPayload {
  sourceIdentity: ExpectedSourceIdentity;
  modifiedTimeMs: number;
  contentSha256: string;
  destinationSnapshot: {
    path: string;
    occupied: boolean;
    identity?: {
      device: number;
      inode: number;
      links: number;
      type: 'file' | 'directory' | 'symlink' | 'other';
    };
  };
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function dataProperties(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function dataArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = (descriptors as unknown as Record<string, PropertyDescriptor>).length?.value;
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    result.push(descriptor.value);
  }
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))
    )
  ) {
    return null;
  }
  return result;
}

function payload(value: unknown): RevalidationPayload | null {
  const record = dataProperties(value);
  if (record === null) return null;
  const identityValue = record.sourceIdentity;
  const identity = dataProperties(identityValue);
  if (identity === null) return null;
  const destinationValue = record.destinationSnapshot;
  const destination = dataProperties(destinationValue);
  if (destination === null) return null;
  const destinationIdentityValue = destination.identity;
  let destinationIdentity: RevalidationPayload['destinationSnapshot']['identity'];
  if (destinationIdentityValue !== undefined) {
    const candidate = dataProperties(destinationIdentityValue);
    if (candidate === null) return null;
    if (
      !finiteNonNegative(candidate.device) ||
      !finiteNonNegative(candidate.inode) ||
      !finiteNonNegative(candidate.links) ||
      !['file', 'directory', 'symlink', 'other'].includes(candidate.type as string)
    ) {
      return null;
    }
    destinationIdentity = {
      device: candidate.device,
      inode: candidate.inode,
      links: candidate.links,
      type: candidate.type as 'file' | 'directory' | 'symlink' | 'other',
    };
  }
  if (
    !finiteNonNegative(identity.device) ||
    !finiteNonNegative(identity.inode) ||
    !finiteNonNegative(identity.links) ||
    !finiteNonNegative(identity.size) ||
    !finiteNonNegative(record.modifiedTimeMs) ||
    typeof record.contentSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.contentSha256) ||
    typeof destination.path !== 'string' ||
    typeof destination.occupied !== 'boolean' ||
    destination.occupied !== (destinationIdentity !== undefined)
  ) {
    return null;
  }
  return {
    sourceIdentity: {
      device: identity.device,
      inode: identity.inode,
      links: identity.links,
      size: identity.size,
    },
    modifiedTimeMs: record.modifiedTimeMs,
    contentSha256: record.contentSha256,
    destinationSnapshot: {
      path: destination.path,
      occupied: destination.occupied,
      ...(destinationIdentity === undefined ? {} : { identity: destinationIdentity }),
    },
  };
}

function fileType(
  stats: Awaited<ReturnType<typeof lstat>>
): 'file' | 'directory' | 'symlink' | 'other' {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

export class MediaPreviewRevalidator implements PreviewRevalidatorPort {
  constructor(private readonly dependencies: MediaPreviewRevalidatorDependencies) {}

  async revalidate(preview: Readonly<PreparedPreview>): Promise<PreviewRevalidationResult> {
    const reasons: string[] = [];
    let sourceFingerprintMatches = true;
    let operations: unknown[] | null = null;
    try {
      operations = dataArray(dataProperties(preview)?.operations);
    } catch {
      operations = null;
    }
    if (operations === null) {
      sourceFingerprintMatches = false;
      reasons.push('Preview operations are invalid');
      operations = [];
    }

    for (const rawOperation of operations) {
      let operation: Record<string, unknown> | null = null;
      let expected: RevalidationPayload | null = null;
      try {
        operation = dataProperties(rawOperation);
        expected = payload(operation?.payload);
      } catch {
        operation = null;
      }
      const sourcePath = operation?.sourcePath;
      const targetPath = operation?.targetPath;
      if (typeof sourcePath !== 'string' || typeof targetPath !== 'string') {
        sourceFingerprintMatches = false;
        reasons.push('Preview operation is invalid');
        continue;
      }
      if (expected === null) {
        sourceFingerprintMatches = false;
        reasons.push(`Preview fingerprint is invalid: ${sourcePath}`);
        continue;
      }

      try {
        const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let before;
        let after;
        let digest: string;
        try {
          before = await handle.stat();
          if ((before.mode & 0o444) === 0) {
            sourceFingerprintMatches = false;
            reasons.push(`Source is not readable: ${sourcePath}`);
          }
          digest = await hashFileHandle(handle);
          after = await handle.stat();
        } finally {
          await handle.close();
        }
        const pathStats = await lstat(sourcePath);
        const matches =
          before.isFile() &&
          after.isFile() &&
          !pathStats.isSymbolicLink() &&
          before.dev === expected.sourceIdentity.device &&
          before.ino === expected.sourceIdentity.inode &&
          before.nlink === expected.sourceIdentity.links &&
          before.size === expected.sourceIdentity.size &&
          before.mtimeMs === expected.modifiedTimeMs &&
          after.dev === before.dev &&
          after.ino === before.ino &&
          after.nlink === before.nlink &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          pathStats.dev === before.dev &&
          pathStats.ino === before.ino;
        if (!matches) {
          sourceFingerprintMatches = false;
          reasons.push(`Source changed after preview: ${sourcePath}`);
        }
        if (digest !== expected.contentSha256) {
          sourceFingerprintMatches = false;
          reasons.push(`Source content changed after preview: ${sourcePath}`);
        }
      } catch (error) {
        sourceFingerprintMatches = false;
        const message = error instanceof Error ? error.message : String(error);
        reasons.push(`Source cannot be revalidated: ${sourcePath} (${message})`);
      }

      if (expected.destinationSnapshot.path !== targetPath) {
        sourceFingerprintMatches = false;
        reasons.push(`Destination snapshot path is invalid: ${targetPath}`);
      } else {
        try {
          const stats = await lstat(targetPath);
          const identity = expected.destinationSnapshot.identity;
          const matches =
            expected.destinationSnapshot.occupied &&
            identity !== undefined &&
            stats.dev === identity.device &&
            stats.ino === identity.inode &&
            stats.nlink === identity.links &&
            fileType(stats) === identity.type;
          if (!matches) {
            sourceFingerprintMatches = false;
            reasons.push(`Destination changed after preview: ${targetPath}`);
          }
        } catch (error) {
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as NodeJS.ErrnoException).code
              : undefined;
          if (code !== 'ENOENT' || expected.destinationSnapshot.occupied) {
            sourceFingerprintMatches = false;
            reasons.push(`Destination changed after preview: ${targetPath}`);
          }
        }
      }
    }

    let configMatches = false;
    try {
      const runtime = dataProperties(await this.dependencies.runtime.check());
      const runtimeReasons = dataArray(runtime?.reasons);
      if (
        runtime === null ||
        typeof runtime.ready !== 'boolean' ||
        runtimeReasons === null ||
        runtimeReasons.some((reason) => typeof reason !== 'string')
      ) {
        throw new Error('runtime readiness result is invalid');
      }
      configMatches = runtime.ready;
      reasons.push(...(runtimeReasons as string[]));
    } catch (error) {
      configMatches = false;
      const message = error instanceof Error ? error.message : String(error);
      reasons.push(`Bundled runtime health check failed: ${message}`);
    }

    return {
      sourceFingerprintMatches,
      configMatches,
      reasons: [...new Set(reasons)],
    };
  }
}
