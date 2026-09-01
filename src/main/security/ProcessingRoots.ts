import { resolveRootPair } from './PathPolicy';

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Root analysis cancelled'
  );
  error.name = 'AbortError';
  throw error;
}

export interface ProcessingRootIdentity {
  path: string;
  device: number;
  inode: number;
}

export interface ValidatedProcessingRoots {
  sourcePaths: string[];
  destinationPath: string;
  sourceIdentities: ProcessingRootIdentity[];
  destinationIdentity: ProcessingRootIdentity;
}

function safeIdentity(value: unknown): value is ProcessingRootIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    Number.isSafeInteger(candidate.device) &&
    (candidate.device as number) >= 0 &&
    Number.isSafeInteger(candidate.inode) &&
    (candidate.inode as number) >= 0
  );
}

export function assertValidatedProcessingRoots(
  value: unknown
): asserts value is ValidatedProcessingRoots {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Validated processing roots are invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 4 ||
    !Array.isArray(candidate.sourcePaths) ||
    candidate.sourcePaths.length === 0 ||
    candidate.sourcePaths.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    typeof candidate.destinationPath !== 'string' ||
    candidate.destinationPath.length === 0 ||
    !Array.isArray(candidate.sourceIdentities) ||
    candidate.sourceIdentities.length !== candidate.sourcePaths.length ||
    candidate.sourceIdentities.some((identity) => !safeIdentity(identity)) ||
    !safeIdentity(candidate.destinationIdentity)
  ) {
    throw new Error('Validated processing roots are invalid');
  }
  const sourcePaths = candidate.sourcePaths as string[];
  const sourceIdentities = candidate.sourceIdentities as ProcessingRootIdentity[];
  if (
    sourceIdentities.some((identity, index) => identity.path !== sourcePaths[index]) ||
    (candidate.destinationIdentity as ProcessingRootIdentity).path !== candidate.destinationPath
  ) {
    throw new Error('Validated processing root paths and identities disagree');
  }
}

export function assertProcessingRootIdentitiesUnchanged(
  expected: ValidatedProcessingRoots,
  current: ValidatedProcessingRoots
): void {
  assertValidatedProcessingRoots(expected);
  assertValidatedProcessingRoots(current);
  const unchanged =
    expected.destinationPath === current.destinationPath &&
    expected.destinationIdentity.device === current.destinationIdentity.device &&
    expected.destinationIdentity.inode === current.destinationIdentity.inode &&
    expected.sourcePaths.length === current.sourcePaths.length &&
    expected.sourceIdentities.every((identity, index) => {
      const currentIdentity = current.sourceIdentities[index];
      return (
        identity.path === currentIdentity.path &&
        identity.device === currentIdentity.device &&
        identity.inode === currentIdentity.inode
      );
    });
  if (!unchanged) throw new Error('Processing root identity changed before inventory');
}

export class ProcessingRootValidator {
  async validate(
    sourcePaths: readonly string[],
    destinationPath: string,
    signal?: AbortSignal
  ): Promise<ValidatedProcessingRoots> {
    throwIfAborted(signal);
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
      throw new Error('At least one source root is required');
    }

    const canonicalSources = new Map<string, ProcessingRootIdentity>();
    let canonicalDestination: string | undefined;
    let destinationIdentity: ProcessingRootIdentity | undefined;
    for (const sourcePath of sourcePaths) {
      throwIfAborted(signal);
      const pair = await resolveRootPair(sourcePath, destinationPath, signal);
      throwIfAborted(signal);
      const currentDestinationIdentity = `${pair.destination.device}:${pair.destination.inode}`;
      if (
        destinationIdentity !== undefined &&
        (`${destinationIdentity.device}:${destinationIdentity.inode}` !==
          currentDestinationIdentity ||
          canonicalDestination !== pair.destination.realPath)
      ) {
        throw new Error('Destination identity changed during root validation');
      }
      canonicalDestination = pair.destination.realPath;
      destinationIdentity = {
        path: pair.destination.realPath,
        device: pair.destination.device,
        inode: pair.destination.inode,
      };
      canonicalSources.set(`${pair.source.device}:${pair.source.inode}`, {
        path: pair.source.realPath,
        device: pair.source.device,
        inode: pair.source.inode,
      });
    }

    const sourceIdentities = [...canonicalSources.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    throwIfAborted(signal);

    return {
      sourcePaths: sourceIdentities.map((identity) => identity.path),
      destinationPath: canonicalDestination!,
      sourceIdentities,
      destinationIdentity: destinationIdentity!,
    };
  }
}
