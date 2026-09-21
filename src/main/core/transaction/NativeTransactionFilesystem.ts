import path from 'path';

import {
  DeleteSourceExactRequest,
  DeleteSourceExactResult,
  NativeFilesystemCapabilityPath,
  NativeFilesystemIdentity,
  NativeFilesystemOperationResult,
  NativeFilesystemRootBinding,
  ReconcileSourceDeleteRequest,
  ReconcileSourceDeleteResult,
  RemoveManagedExactRequest,
  StageCopyRequest,
} from '../../native/NativeFilesystemHelperClient';

export interface NativeTransactionFilesystemClient {
  ensureDirChain(
    requestPath: NativeFilesystemCapabilityPath,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult>;
  stageCopy(
    request: StageCopyRequest,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult>;
  writeMarkerNew(
    requestPath: NativeFilesystemCapabilityPath,
    contents: string,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult>;
  hardLinkNoReplace(
    request: {
      source: NativeFilesystemCapabilityPath;
      target: NativeFilesystemCapabilityPath;
      expected?: NativeFilesystemIdentity;
    },
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult>;
  renameNoReplace(
    request: {
      source: NativeFilesystemCapabilityPath;
      target: NativeFilesystemCapabilityPath;
      expected?: NativeFilesystemIdentity;
    },
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult>;
  removeManagedExact(
    request: RemoveManagedExactRequest,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult>;
  deleteSourceExact(
    request: DeleteSourceExactRequest,
    signal?: AbortSignal
  ): Promise<DeleteSourceExactResult>;
  reconcileSourceDelete(
    request: ReconcileSourceDeleteRequest,
    signal?: AbortSignal
  ): Promise<ReconcileSourceDeleteResult>;
  close(): Promise<void>;
}

interface SourceCapabilityRoot {
  name: string;
  absolutePath: string;
}

const CONTROL_COMPONENT = '.meta-mover';

async function unavailableRootBindingMutation(): Promise<never> {
  throw new Error('Root-binding mapper cannot perform mutations');
}

export class NativeTransactionFilesystem {
  private readonly sourceRoots: readonly SourceCapabilityRoot[];
  private closePromise?: Promise<void>;

  constructor(
    private readonly client: NativeTransactionFilesystemClient,
    private readonly destinationRoot: string,
    private readonly controlRoot: string,
    sourceRoots: readonly string[]
  ) {
    this.requireCanonicalRoot(destinationRoot, 'destination');
    this.requireCanonicalRoot(controlRoot, 'control');
    if (controlRoot !== path.join(destinationRoot, CONTROL_COMPONENT)) {
      throw new Error('Transaction control root must be the destination control directory');
    }
    const uniqueRoots = [...new Set(sourceRoots)];
    if (uniqueRoots.length === 0)
      throw new Error('At least one source capability root is required');
    uniqueRoots.forEach((root) => this.requireCanonicalRoot(root, 'source'));
    this.sourceRoots = uniqueRoots
      .map((absolutePath, index) => ({ name: `source_${index}`, absolutePath }))
      .sort((left, right) => right.absolutePath.length - left.absolutePath.length);
  }

  static rootBindings(
    destinationRoot: string,
    controlRoot: string,
    sourceRoots: readonly string[]
  ): NativeFilesystemRootBinding[] {
    const mapper = new NativeTransactionFilesystem(
      {
        ensureDirChain: unavailableRootBindingMutation,
        stageCopy: unavailableRootBindingMutation,
        writeMarkerNew: unavailableRootBindingMutation,
        hardLinkNoReplace: unavailableRootBindingMutation,
        renameNoReplace: unavailableRootBindingMutation,
        removeManagedExact: unavailableRootBindingMutation,
        deleteSourceExact: unavailableRootBindingMutation,
        reconcileSourceDelete: unavailableRootBindingMutation,
        close: async () => undefined,
      },
      destinationRoot,
      controlRoot,
      sourceRoots
    );
    return [
      { name: 'destination', kind: 'destination', absolutePath: destinationRoot },
      { name: 'control', kind: 'control', absolutePath: controlRoot },
      ...mapper.sourceRoots
        .slice()
        .sort((left, right) => Number(left.name.slice(7)) - Number(right.name.slice(7)))
        .map((root) => ({
          name: root.name,
          kind: 'source' as const,
          absolutePath: root.absolutePath,
        })),
    ];
  }

  sourcePath(absolutePath: string): NativeFilesystemCapabilityPath {
    this.requireCanonicalPath(absolutePath, 'source');
    const root = this.sourceRoots.find((candidate) =>
      this.isStrictlyWithin(candidate.absolutePath, absolutePath)
    );
    if (!root) throw new Error('Source path is outside the retained source capabilities');
    return this.capability(root.name, root.absolutePath, absolutePath);
  }

  destinationPath(absolutePath: string): NativeFilesystemCapabilityPath {
    this.requireCanonicalPath(absolutePath, 'destination');
    if (!this.isStrictlyWithin(this.destinationRoot, absolutePath)) {
      throw new Error('Destination path is outside the retained destination capability');
    }
    const relative = path.relative(this.destinationRoot, absolutePath);
    if (relative.split(path.sep)[0].toLocaleLowerCase('en-US') === CONTROL_COMPONENT) {
      throw new Error('Destination data path cannot enter transaction controls');
    }
    return this.capability('destination', this.destinationRoot, absolutePath);
  }

  controlPath(absolutePath: string): NativeFilesystemCapabilityPath {
    this.requireCanonicalPath(absolutePath, 'control');
    if (!this.isStrictlyWithin(this.controlRoot, absolutePath)) {
      throw new Error('Control path is outside the retained control capability');
    }
    return this.capability('control', this.controlRoot, absolutePath);
  }

  ensureDestinationDirectory(absolutePath: string, signal?: AbortSignal) {
    return this.client.ensureDirChain(this.destinationPath(absolutePath), signal);
  }

  ensureControlDirectory(absolutePath: string, signal?: AbortSignal) {
    return this.client.ensureDirChain(this.controlPath(absolutePath), signal);
  }

  stageCopy(
    sourcePath: string,
    targetPath: string,
    expectedSha256: string,
    signal?: AbortSignal,
    expected?: NativeFilesystemIdentity
  ) {
    return this.client.stageCopy(
      {
        source: this.anyPath(sourcePath),
        target: this.anyPath(targetPath),
        expected,
        expectedSha256,
      },
      signal
    );
  }

  writeMarkerNew(absolutePath: string, contents: string, signal?: AbortSignal) {
    return this.client.writeMarkerNew(this.controlPath(absolutePath), contents, signal);
  }

  hardLinkNoReplace(
    sourcePath: string,
    targetPath: string,
    expected?: NativeFilesystemIdentity,
    signal?: AbortSignal
  ) {
    return this.client.hardLinkNoReplace(
      { source: this.anyPath(sourcePath), target: this.anyPath(targetPath), expected },
      signal
    );
  }

  renameNoReplace(
    sourcePath: string,
    targetPath: string,
    expected?: NativeFilesystemIdentity,
    signal?: AbortSignal
  ) {
    return this.client.renameNoReplace(
      { source: this.anyPath(sourcePath), target: this.anyPath(targetPath), expected },
      signal
    );
  }

  removeManagedExact(
    absolutePath: string,
    expected: NativeFilesystemIdentity,
    signal?: AbortSignal
  ) {
    return this.client.removeManagedExact({ path: this.anyPath(absolutePath), expected }, signal);
  }

  deleteSourceExact(
    sourcePath: string,
    expected: NativeFilesystemIdentity,
    expectedSha256: string,
    deleteId: string,
    receiptPath: string,
    signal?: AbortSignal
  ) {
    const request = this.deleteRequest(sourcePath, expected, expectedSha256, deleteId, receiptPath);
    return signal
      ? this.client.deleteSourceExact(request, signal)
      : this.client.deleteSourceExact(request);
  }

  reconcileSourceDelete(
    sourcePath: string,
    expected: NativeFilesystemIdentity,
    expectedSha256: string,
    deleteId: string,
    receiptPath: string,
    signal?: AbortSignal
  ) {
    const request = this.deleteRequest(sourcePath, expected, expectedSha256, deleteId, receiptPath);
    return signal
      ? this.client.reconcileSourceDelete(request, signal)
      : this.client.reconcileSourceDelete(request);
  }

  close(): Promise<void> {
    this.closePromise ??= this.client.close();
    return this.closePromise;
  }

  private deleteRequest(
    sourcePath: string,
    expected: NativeFilesystemIdentity,
    expectedSha256: string,
    deleteId: string,
    receiptPath: string
  ): DeleteSourceExactRequest {
    return {
      source: this.sourcePath(sourcePath),
      expected,
      expectedSha256,
      deleteId,
      receipt: this.controlPath(receiptPath),
    };
  }

  private anyPath(absolutePath: string): NativeFilesystemCapabilityPath {
    if (this.isStrictlyWithin(this.controlRoot, absolutePath))
      return this.controlPath(absolutePath);
    if (this.isStrictlyWithin(this.destinationRoot, absolutePath))
      return this.destinationPath(absolutePath);
    return this.sourcePath(absolutePath);
  }

  private capability(
    root: string,
    rootPath: string,
    absolutePath: string
  ): NativeFilesystemCapabilityPath {
    const components = path.relative(rootPath, absolutePath).split(path.sep);
    if (components.some((component) => !component || component === '.' || component === '..')) {
      throw new Error('Capability path contains an unsafe component');
    }
    return { root, components };
  }

  private requireCanonicalRoot(rootPath: string, label: string): void {
    if (!path.isAbsolute(rootPath) || path.resolve(rootPath) !== rootPath) {
      throw new Error(`${label} capability root must be canonical and absolute`);
    }
  }

  private requireCanonicalPath(absolutePath: string, label: string): void {
    if (!path.isAbsolute(absolutePath) || path.resolve(absolutePath) !== absolutePath) {
      throw new Error(`${label} path must be canonical and normalized`);
    }
  }

  private isStrictlyWithin(rootPath: string, candidatePath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return (
      relative.length > 0 &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }
}
