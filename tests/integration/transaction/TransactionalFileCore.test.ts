import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';

import {
  FailurePoint,
  TransactionalFileCore,
} from '../../../src/main/core/transaction/TransactionalFileCore';
import { hashFile } from '../../../src/main/core/transaction/Hashing';
import { TransactionJournal } from '../../../src/main/core/transaction/TransactionJournal';
import {
  NativeTransactionFilesystem,
  NativeTransactionFilesystemClient,
} from '../../../src/main/core/transaction/NativeTransactionFilesystem';
import {
  NativeFilesystemHelperClientError,
  NativeFilesystemIdentity,
} from '../../../src/main/native/NativeFilesystemHelperClient';

jest.setTimeout(120_000);

describe('TransactionalFileCore', () => {
  let root: string;
  let sourceRoot: string;
  let destinationRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-transaction-integration-'));
    sourceRoot = path.join(root, 'sources');
    destinationRoot = path.join(root, 'destination');
    await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function source(name: string, content: string): Promise<string> {
    const sourcePath = path.join(sourceRoot, name);
    await writeFile(sourcePath, content);
    return sourcePath;
  }

  async function sourceIdentity(sourcePath: string) {
    const stats = await lstat(sourcePath, { bigint: true });
    return {
      device: Number(stats.dev),
      inode: Number(stats.ino),
      links: Number(stats.nlink),
      size: Number(stats.size),
      modifiedTimeMs: Number(stats.mtimeNs) / 1_000_000,
    };
  }

  async function nativeIdentity(filePath: string): Promise<NativeFilesystemIdentity> {
    const stats = await lstat(filePath, { bigint: true });
    return {
      kind: 'unix',
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      links: stats.nlink.toString(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
    };
  }

  function capabilityPath(capability: { root: string; components: string[] }): string {
    const capabilityRoot =
      capability.root === 'destination'
        ? destinationRoot
        : capability.root === 'control'
          ? path.join(destinationRoot, '.meta-mover')
          : sourceRoot;
    return path.join(capabilityRoot, ...capability.components);
  }

  function nativeFilesystem(
    deleteOverride?: NativeTransactionFilesystemClient['deleteSourceExact'],
    reconcileOverride?: NativeTransactionFilesystemClient['reconcileSourceDelete'],
    overrides: Partial<NativeTransactionFilesystemClient> = {}
  ): NativeTransactionFilesystem {
    const sameIdentity = async (filePath: string, expected: NativeFilesystemIdentity) => {
      const stats = await lstat(filePath, { bigint: true });
      return (
        expected.kind === 'unix' &&
        stats.dev.toString() === expected.device &&
        stats.ino.toString() === expected.inode &&
        stats.nlink.toString() === expected.links &&
        stats.size.toString() === expected.size &&
        stats.mtimeNs.toString() === expected.mtimeNs
      );
    };
    const nativeClient: NativeTransactionFilesystemClient = {
      ensureDirChain: async (requestPath) => {
        const directoryPath = capabilityPath(requestPath);
        const capabilityRoot =
          requestPath.root === 'destination'
            ? destinationRoot
            : requestPath.root === 'control'
              ? path.join(destinationRoot, '.meta-mover')
              : sourceRoot;
        let current = capabilityRoot;
        for (const component of requestPath.components) {
          current = path.join(current, component);
          const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          if (existing?.isSymbolicLink()) {
            throw new Error('Nested target ancestor is a symbolic link');
          }
          if (existing && !existing.isDirectory()) {
            throw new Error('Nested target ancestor is not a directory');
          }
          if (!existing) await mkdir(current);
        }
        const stats = await lstat(directoryPath, { bigint: true });
        return {
          outcome: 'applied',
          after: {
            kind: 'unix',
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
            links: stats.nlink.toString(),
            size: stats.size.toString(),
            mtimeNs: stats.mtimeNs.toString(),
          },
          durability: { file: 'not-applicable', parents: ['synced'] },
        };
      },
      stageCopy: async (request) => {
        const sourcePath = capabilityPath(request.source);
        const targetPath = capabilityPath(request.target);
        const targetRoot =
          request.target.root === 'destination'
            ? destinationRoot
            : request.target.root === 'control'
              ? path.join(destinationRoot, '.meta-mover')
              : sourceRoot;
        let current = targetRoot;
        for (const component of request.target.components.slice(0, -1)) {
          current = path.join(current, component);
          const ancestor = await lstat(current);
          if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) {
            throw new Error('unsafe directory component');
          }
        }
        const before = await nativeIdentity(sourcePath);
        await copyFile(sourcePath, targetPath, 1);
        const sha256 = await hashFile(targetPath);
        if (request.expectedSha256 && sha256 !== request.expectedSha256) {
          await unlink(targetPath);
          throw new Error('hash mismatch');
        }
        return {
          outcome: 'applied',
          before,
          after: await nativeIdentity(targetPath),
          sha256,
          durability: { file: 'synced', parents: ['synced'] },
        };
      },
      writeMarkerNew: async (requestPath, contents) => {
        const markerPath = capabilityPath(requestPath);
        await writeFile(markerPath, contents, { flag: 'wx' });
        return {
          outcome: 'applied',
          after: await nativeIdentity(markerPath),
          durability: { file: 'synced', parents: ['synced'] },
        };
      },
      hardLinkNoReplace: async (request) => {
        const sourcePath = capabilityPath(request.source);
        const targetPath = capabilityPath(request.target);
        await link(sourcePath, targetPath);
        return {
          outcome: 'applied',
          before: await nativeIdentity(sourcePath),
          after: await nativeIdentity(targetPath),
          durability: { file: 'not-applicable', parents: ['synced'] },
        };
      },
      renameNoReplace: async () => {
        // Default mock returns cross-device so existing tests fall through
        // to the staged-copy path. Fast-path tests override this.
        throw new NativeFilesystemHelperClientError(
          'cross-device',
          'precondition',
          'not-applied',
          false,
          'mock cross-device rename'
        );
      },
      removeManagedExact: async (request) => {
        const managedPath = capabilityPath(request.path);
        if (!(await sameIdentity(managedPath, request.expected))) {
          throw new Error('managed identity mismatch');
        }
        const before = await nativeIdentity(managedPath);
        await unlink(managedPath);
        return {
          outcome: 'applied',
          before,
          after: null,
          durability: { file: 'not-applicable', parents: ['synced'] },
        };
      },
      deleteSourceExact:
        deleteOverride ??
        (async (request) => {
          const sourcePath = capabilityPath(request.source);
          if (!(await sameIdentity(sourcePath, request.expected))) {
            throw new NativeFilesystemHelperClientError(
              'identity-mismatch',
              'precondition',
              'not-applied',
              false,
              'entry identity does not match the expected identity'
            );
          }
          await writeFile(capabilityPath(request.receipt), `${request.deleteId}\n`, { flag: 'wx' });
          await unlink(sourcePath);
          return {
            outcome: 'applied',
            state: 'deleted',
            sourceState: 'absent',
            quarantineState: 'entry-deleted',
            receiptState: 'created',
            deleteId: request.deleteId,
            durability: { file: 'synced', parents: ['synced', 'synced', 'synced'] },
          };
        }),
      reconcileSourceDelete:
        reconcileOverride ??
        (async (request) => {
          const receiptExists = await lstat(capabilityPath(request.receipt))
            .then(() => true)
            .catch(() => false);
          if (receiptExists) {
            return {
              outcome: 'applied',
              state: 'deleted',
              sourceState: 'absent',
              quarantineState: 'absent',
              receiptState: 'exact',
              deleteId: request.deleteId,
              durability: { file: 'not-applicable', parents: ['synced'] },
            };
          }
          return {
            outcome: 'not-applied',
            state: 'source-retained',
            sourceState: 'expected',
            quarantineState: 'absent',
            receiptState: 'absent',
            deleteId: request.deleteId,
            durability: { file: 'not-applicable', parents: [] },
          };
        }),
      close: async () => undefined,
      ...overrides,
    };
    return new NativeTransactionFilesystem(
      nativeClient,
      destinationRoot,
      path.join(destinationRoot, '.meta-mover'),
      [sourceRoot]
    );
  }

  async function createCore(
    requestedDestinationRoot: string,
    options: Parameters<typeof TransactionalFileCore.create>[1] = {}
  ): Promise<TransactionalFileCore> {
    return TransactionalFileCore.create(requestedDestinationRoot, {
      nativeFilesystem: nativeFilesystem(),
      ...options,
    });
  }

  it('copies by default through staging and retains the source', async () => {
    const sourcePath = await source('photo-original.jpg', 'copy-content');
    const core = await createCore(destinationRoot);

    const preview = await core.preview({ sourcePath, targetFilename: '2024-01-02_03-04-05.jpg' });
    const result = await core.execute({ sourcePath, targetFilename: preview.targetFilename });

    expect(preview.mode).toBe('copy');
    expect(result.status).toBe('copied');
    expect(result.sourceRetained).toBe(true);
    expect(await readFile(sourcePath, 'utf8')).toBe('copy-content');
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('copy-content');
    expect(result.hash).toBe(await hashFile(result.destinationPath!));
    await core.close();
  });

  it('binds execution to the caller operation ID, source identity, hash, and exact target', async () => {
    const sourcePath = await source('bound-source.jpg', 'bound-content');
    const identity = await sourceIdentity(sourcePath);
    const expectedSha256 = await hashFile(sourcePath);
    const destinationPath = path.join(destinationRoot, '2024', '05', 'bound.jpg');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      operationId: 'planner-operation-001',
      sourcePath,
      targetFilename: path.join('2024', '05', 'bound.jpg'),
      expectedDestinationPath: destinationPath,
      collisionMode: 'exact-no-clobber',
      expectedSourceIdentity: identity,
      expectedSha256,
    });

    expect(result).toMatchObject({
      operationId: 'planner-operation-001',
      status: 'copied',
      committed: true,
      hash: expectedSha256,
      destinationPath,
    });
    await core.close();
  });

  it('rejects caller source identity or hash drift before staging', async () => {
    const identitySource = await source('identity-bound.jpg', 'identity-original');
    const originalIdentity = await sourceIdentity(identitySource);
    await writeFile(identitySource, 'identity-replaced');
    const hashSource = await source('hash-bound.jpg', 'hash-current');
    const core = await createCore(destinationRoot);

    const identityResult = await core.execute({
      sourcePath: identitySource,
      targetFilename: 'identity-target.jpg',
      expectedSourceIdentity: originalIdentity,
      expectedSha256: await hashFile(identitySource),
    });
    const hashResult = await core.execute({
      sourcePath: hashSource,
      targetFilename: 'hash-target.jpg',
      expectedSourceIdentity: await sourceIdentity(hashSource),
      expectedSha256: '0'.repeat(64),
    });

    expect(identityResult).toMatchObject({ status: 'failed', committed: false });
    expect(identityResult.error).toMatch(/expected source identity/i);
    expect(hashResult).toMatchObject({ status: 'failed', committed: false });
    expect(hashResult.error).toMatch(/expected source hash/i);
    expect(await core.listStagingResidue()).toEqual([]);
    await core.close();
  });

  it('rechecks source identity after hashing and before staging', async () => {
    const sourcePath = await source('hash-race.jpg', 'hash-race-original');
    const identity = await sourceIdentity(sourcePath);
    const expectedSha256 = await hashFile(sourcePath);
    const core = await createCore(destinationRoot, {
      failureInjector: async (point) => {
        if (point === 'after-source-hash') await writeFile(sourcePath, 'hash-race-replaced');
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'hash-race-target.jpg',
      expectedSourceIdentity: identity,
      expectedSha256,
    });

    expect(result).toMatchObject({ status: 'failed', committed: false, sourceRetained: false });
    expect(result.error).toMatch(/identity changed/i);
    expect(await core.listStagingResidue()).toEqual([]);
    await core.close();
  });

  it('requires an exact destination for exact-no-clobber mode', async () => {
    const sourcePath = await source('exact-mode.jpg', 'exact-mode-content');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: 'exact-mode-target.jpg',
      collisionMode: 'exact-no-clobber',
    });

    expect(result).toMatchObject({ status: 'failed', committed: false, sourceRetained: true });
    expect(result.error).toMatch(/exact destination/i);
    await core.close();
  });

  it.each([
    {
      label: 'unsafe operation ID',
      request: { operationId: ' bad-operation-id' },
      error: /operation id/i,
    },
    {
      label: 'malformed expected hash',
      request: { expectedSha256: 'not-a-sha256' },
      error: /lowercase sha-256/i,
    },
    {
      label: 'mismatched exact destination',
      request: { expectedDestinationPath: '/not/the/planned/target.jpg' },
      error: /does not match/i,
    },
  ])('rejects $label before staging', async ({ request, error }) => {
    const sourcePath = await source(`invalid-${request.operationId ?? 'evidence'}.jpg`, 'retain');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: 'valid-target.jpg',
      ...request,
    });

    expect(result).toMatchObject({ status: 'failed', committed: false, sourceRetained: true });
    expect(result.error).toMatch(error);
    expect(await core.listStagingResidue()).toEqual([]);
    await core.close();
  });

  it('cancels before source inspection without staging', async () => {
    const sourcePath = await source('cancel-before-inspection.jpg', 'retain');
    const controller = new AbortController();
    controller.abort();
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: 'cancel-before-inspection-target.jpg',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: 'cancelled', committed: false, sourceRetained: true });
    expect(await core.listStagingResidue()).toEqual([]);
    await core.close();
  });

  it('rejects a regular file used as a nested target ancestor', async () => {
    await writeFile(path.join(destinationRoot, '2024'), 'not-a-directory');
    const sourcePath = await source('ancestor-file.jpg', 'retain');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: '2024/05/photo.jpg',
    });

    expect(result).toMatchObject({ status: 'failed', committed: false, sourceRetained: true });
    expect(result.error).toMatch(/not a directory/i);
    await core.close();
  });

  it('retains the source when a conservation object path has different content', async () => {
    const sourcePath = await source('occupied-object.jpg', 'ground-truth-object');
    const sourceHash = await hashFile(sourcePath);
    const core = await createCore(destinationRoot);
    await writeFile(
      path.join(destinationRoot, '.meta-mover', 'objects', sourceHash),
      'different-content'
    );

    const result = await core.execute({
      sourcePath,
      targetFilename: 'occupied-object-target.jpg',
      mode: 'move',
    });

    expect(result).toMatchObject({ status: 'failed', committed: true, sourceRetained: true });
    expect(result.error).toMatch(/occupied by different content/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('ground-truth-object');
    await core.close();
  });

  it('keeps an independent immutable-by-alias conservation object after destination edits', async () => {
    const sourcePath = await source('independent-object.jpg', 'original-ground-truth');
    const core = await createCore(destinationRoot);
    const result = await core.execute({
      sourcePath,
      targetFilename: 'independent-object-target.jpg',
      mode: 'move',
    });
    const objectPath = path.join(destinationRoot, '.meta-mover', 'objects', result.hash!);
    const [destinationStats, objectStats] = await Promise.all([
      lstat(result.destinationPath!, { bigint: true }),
      lstat(objectPath, { bigint: true }),
    ]);

    expect(objectStats.ino).not.toBe(destinationStats.ino);
    expect(objectStats.nlink).toBe(1n);
    await writeFile(result.destinationPath!, 'MUTATED!');
    expect(await readFile(objectPath, 'utf8')).toBe('original-ground-truth');
    await core.close();
  });

  it('rejects same-size staging corruption detected by an independent hash pass', async () => {
    const sourcePath = await source('photo.jpg', 'original');
    const core = await createCore(destinationRoot, {
      failureInjector: async (point, context) => {
        if (point === 'after-stage-written') {
          await writeFile(context.stagingPath!, 'tampered');
        }
      },
    });

    const result = await core.execute({ sourcePath, targetFilename: 'target.jpg' });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/independent hash verification failed/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('original');
    await expect(lstat(path.join(destinationRoot, 'target.jpg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await core.close();
  });

  it.each(['stage', 'stream-size', 'reservation', 'publication', 'destination-hash'] as const)(
    'fails closed when the native %s receipt violates its mutation contract',
    async (failureKind) => {
      const sourcePath = await source(`native-${failureKind}.jpg`, `native-${failureKind}-content`);
      const native = nativeFilesystem();
      const core = await TransactionalFileCore.create(destinationRoot, {
        nativeFilesystem: native,
      });

      if (failureKind === 'stage' || failureKind === 'stream-size') {
        const original = native.stageCopy.bind(native);
        jest.spyOn(native, 'stageCopy').mockImplementationOnce(async (...args) => {
          const receipt = await original(...args);
          if (failureKind === 'stage') {
            const { before: _before, ...incomplete } = receipt;
            return incomplete;
          }
          return {
            ...receipt,
            after: {
              ...receipt.after!,
              size: (BigInt(receipt.after!.size) + 1n).toString(),
            },
          };
        });
      } else if (failureKind === 'reservation') {
        const original = native.writeMarkerNew.bind(native);
        jest.spyOn(native, 'writeMarkerNew').mockImplementationOnce(async (...args) => {
          const receipt = await original(...args);
          const { after: _after, ...incomplete } = receipt;
          return incomplete;
        });
      } else {
        const original = native.hardLinkNoReplace.bind(native);
        jest.spyOn(native, 'hardLinkNoReplace').mockImplementationOnce(async (...args) => {
          const receipt = await original(...args);
          if (failureKind === 'publication') {
            const { after: _after, ...incomplete } = receipt;
            return incomplete;
          }
          await writeFile(args[1], 'corrupted-after-publication');
          return receipt;
        });
      }

      const result = await core.execute({
        sourcePath,
        targetFilename: `${failureKind}.jpg`,
      });

      expect(result).toMatchObject({ status: 'failed', sourceRetained: true });
      expect(await readFile(sourcePath, 'utf8')).toBe(`native-${failureKind}-content`);
      await core.close();
    }
  );

  it('fails closed when the native helper disappears after durable delete intent', async () => {
    const sourcePath = await source('missing-delete-helper.jpg', 'retain-after-delete-intent');
    const native = nativeFilesystem();
    const core = await TransactionalFileCore.create(destinationRoot, {
      nativeFilesystem: native,
      failureInjector: (point) => {
        if (point === 'after-source-delete-pending') {
          (core as unknown as { nativeFilesystem?: NativeTransactionFilesystem }).nativeFilesystem =
            undefined;
        }
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'missing-delete-helper-target.jpg',
      mode: 'move',
    });
    (core as unknown as { nativeFilesystem?: NativeTransactionFilesystem }).nativeFilesystem =
      native;

    expect(result).toMatchObject({
      status: 'failed',
      committed: true,
      sourceRetained: true,
    });
    expect(result.error).toMatch(/native filesystem helper/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('retain-after-delete-intent');
    await core.close();
  });

  it('rejects an incomplete duplicate-protection receipt without deleting the move source', async () => {
    const sourcePath = await source('duplicate-receipt.jpg', 'duplicate-receipt-content');
    await writeFile(
      path.join(destinationRoot, 'duplicate-receipt.jpg'),
      'duplicate-receipt-content'
    );
    const native = nativeFilesystem();
    const core = await TransactionalFileCore.create(destinationRoot, { nativeFilesystem: native });
    const original = native.stageCopy.bind(native);
    jest.spyOn(native, 'stageCopy').mockImplementationOnce(async (...args) => {
      const receipt = await original(...args);
      const { before: _before, ...incomplete } = receipt;
      return incomplete;
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'duplicate-receipt.jpg',
      mode: 'move',
    });

    expect(result).toMatchObject({ status: 'failed', committed: true, sourceRetained: true });
    expect(await readFile(sourcePath, 'utf8')).toBe('duplicate-receipt-content');
    await core.close();
  });

  it('publishes with no-replace semantics when another writer wins after reservation', async () => {
    const sourcePath = await source('photo.jpg', 'ours');
    let injected = false;
    const core = await createCore(destinationRoot, {
      failureInjector: async (point, context) => {
        if (point === 'before-publish' && !injected) {
          injected = true;
          await writeFile(context.destinationPath!, 'external-winner');
        }
      },
    });

    const result = await core.execute({ sourcePath, targetFilename: 'target.jpg' });

    expect(await readFile(path.join(destinationRoot, 'target.jpg'), 'utf8')).toBe(
      'external-winner'
    );
    expect(path.basename(result.destinationPath!)).toBe('target_01.jpg');
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('ours');
    await core.close();
  });

  it('retries a real helper target-exists publication on the deterministic suffix', async () => {
    const sourcePath = await source('native-publication-collision.jpg', 'source-content');
    let interposed = false;
    const core = await TransactionalFileCore.create(destinationRoot, {
      nativeFilesystem: nativeFilesystem(undefined, undefined, {
        hardLinkNoReplace: async (request) => {
          const sourceFile = capabilityPath(request.source);
          const targetFile = capabilityPath(request.target);
          if (!interposed && path.basename(targetFile) === 'native-publication-collision.jpg') {
            interposed = true;
            await writeFile(targetFile, 'different-winner');
            throw new NativeFilesystemHelperClientError(
              'target-exists',
              'precondition',
              'not-applied',
              false,
              'target already exists'
            );
          }
          await link(sourceFile, targetFile);
          return {
            outcome: 'applied',
            before: await nativeIdentity(sourceFile),
            after: await nativeIdentity(targetFile),
            durability: { file: 'not-applicable', parents: ['synced'] },
          };
        },
      }),
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'native-publication-collision.jpg',
    });

    expect(interposed).toBe(true);
    expect(result).toMatchObject({
      status: 'copied',
      destinationPath: path.join(destinationRoot, 'native-publication-collision_01.jpg'),
    });
    expect(
      await readFile(path.join(destinationRoot, 'native-publication-collision.jpg'), 'utf8')
    ).toBe('different-winner');
    await core.close();
  });

  it('retries a real helper target-exists reservation on the deterministic suffix', async () => {
    const sourcePath = await source('native-reservation-collision.jpg', 'source-content');
    let reservationCalls = 0;
    let reservationCollisionInjected = false;
    const core = await TransactionalFileCore.create(destinationRoot, {
      nativeFilesystem: nativeFilesystem(undefined, undefined, {
        writeMarkerNew: async (requestPath, contents) => {
          reservationCalls += 1;
          if (!reservationCollisionInjected && contents.includes('"operationId"')) {
            reservationCollisionInjected = true;
            throw new NativeFilesystemHelperClientError(
              'target-exists',
              'precondition',
              'not-applied',
              false,
              'target already exists'
            );
          }
          const markerPath = capabilityPath(requestPath);
          await writeFile(markerPath, contents, { flag: 'wx' });
          return {
            outcome: 'applied',
            after: await nativeIdentity(markerPath),
            durability: { file: 'synced', parents: ['synced'] },
          };
        },
      }),
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'native-reservation-collision.jpg',
    });

    expect(reservationCalls).toBeGreaterThan(1);
    expect(reservationCollisionInjected).toBe(true);
    expect(result).toMatchObject({
      status: 'copied',
      destinationPath: path.join(destinationRoot, 'native-reservation-collision_01.jpg'),
    });
    await core.close();
  });

  it('uses deterministic suffixes for different-content collisions', async () => {
    await writeFile(path.join(destinationRoot, 'same.jpg'), 'existing');
    const sourcePath = await source('other.jpg', 'different');
    const core = await createCore(destinationRoot);

    const result = await core.execute({ sourcePath, targetFilename: 'same.jpg' });

    expect(path.basename(result.destinationPath!)).toBe('same_01.jpg');
    expect(await readFile(path.join(destinationRoot, 'same.jpg'), 'utf8')).toBe('existing');
    await core.close();
  });

  it('treats an existing same-hash target as an idempotent duplicate', async () => {
    const sourcePath = await source('photo.jpg', 'identical');
    const core = await createCore(destinationRoot);
    const first = await core.execute({ sourcePath, targetFilename: 'same.jpg' });
    const second = await core.execute({ sourcePath, targetFilename: 'same.jpg' });

    expect(first.status).toBe('copied');
    expect(second.status).toBe('duplicate');
    expect(second.destinationPath).toBe(first.destinationPath);
    expect(second.sourceRetained).toBe(true);
    expect((await core.getLedger()).duplicate).toBe(1);
    await core.close();
  });

  it('finalizes an idempotent move against an already committed same-hash target', async () => {
    await writeFile(path.join(destinationRoot, 'same.jpg'), 'identical');
    const sourcePath = await source('photo.jpg', 'identical');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: 'same.jpg',
      mode: 'move',
    });

    expect(result.status).toBe('moved');
    expect(result.sourceRetained).toBe(false);
    expect(await readFile(path.join(destinationRoot, 'same.jpg'), 'utf8')).toBe('identical');
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await core.close();
  });

  it('rejects a multiply linked source before guard creation without corrupting retention accounting', async () => {
    const sourcePath = await source('hardlink-source.jpg', 'hardlink-content');
    const destinationPath = path.join(destinationRoot, 'hardlink-target.jpg');
    await link(sourcePath, destinationPath);
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: path.basename(destinationPath),
      mode: 'move',
    });

    expect(result).toMatchObject({
      status: 'failed',
      committed: false,
      sourceRetained: true,
    });
    expect(result.error).toMatch(/multiply linked source/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('hardlink-content');
    expect(await readFile(destinationPath, 'utf8')).toBe('hardlink-content');
    expect((await lstat(sourcePath)).nlink).toBe(2);
    await core.close();
  });

  it('deletes a move source only after a durable destination commit', async () => {
    const sourcePath = await source('move.jpg', 'move-content');
    let finalExistedBeforeDelete = false;
    const core = await createCore(destinationRoot, {
      failureInjector: async (point: FailurePoint, context) => {
        if (point === 'before-source-delete') {
          finalExistedBeforeDelete = Boolean(
            context.destinationPath &&
              (await readFile(context.destinationPath, 'utf8')) === 'move-content'
          );
        }
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'moved.jpg',
      mode: 'move',
    });

    expect(finalExistedBeforeDelete).toBe(true);
    expect(result.status).toBe('moved');
    expect(result.sourceRetained).toBe(false);
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await core.getLedger()).moved).toBe(1);
    await core.close();
  });

  it('retains a protected hardlink and the source when the published destination disappears', async () => {
    const sourcePath = await source('vanishing.jpg', 'protected-content');
    const core = await createCore(destinationRoot, {
      failureInjector: async (point, context) => {
        if (point === 'before-source-delete') await unlink(context.destinationPath!);
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'vanishing-target.jpg',
      mode: 'move',
    });

    expect(result.status).toBe('failed');
    expect(result.sourceRetained).toBe(true);
    expect(await readFile(sourcePath, 'utf8')).toBe('protected-content');
    expect(await core.listStagingResidue()).toHaveLength(1);
    await core.close();
  });

  it('protects a duplicate target before considering source deletion', async () => {
    const destinationPath = path.join(destinationRoot, 'duplicate.jpg');
    await writeFile(destinationPath, 'duplicate-content');
    const sourcePath = await source('duplicate-source.jpg', 'duplicate-content');
    const core = await createCore(destinationRoot, {
      failureInjector: async (point) => {
        if (point === 'before-source-delete') await unlink(destinationPath);
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'duplicate.jpg',
      mode: 'move',
    });

    expect(result.status).toBe('failed');
    expect(await readFile(sourcePath, 'utf8')).toBe('duplicate-content');
    expect(await core.listStagingResidue()).toHaveLength(1);
    await core.close();
  });

  it('fails move closed when destination durability cannot be proven while copy remains available', async () => {
    const moveSource = await source('unsupported-move.jpg', 'move-retained');
    const copySource = await source('supported-copy.jpg', 'copy-retained');
    const core = await createCore(destinationRoot, {
      durabilityVerifier: async () => {
        throw new Error('directory fsync unsupported');
      },
    });

    const moveResult = await core.execute({
      sourcePath: moveSource,
      targetFilename: 'move.jpg',
      mode: 'move',
    });
    const copyResult = await core.execute({
      sourcePath: copySource,
      targetFilename: 'copy.jpg',
    });

    expect(moveResult.status).toBe('failed');
    expect(moveResult.error).toMatch(/durability/i);
    expect(await readFile(moveSource, 'utf8')).toBe('move-retained');
    expect(copyResult.status).toBe('copied');
    await core.close();
  });

  it('fails move closed when durable journal records are disabled', async () => {
    const sourcePath = await source('nondurable-journal.jpg', 'retain-source');
    const core = await createCore(destinationRoot, {
      durableJournal: false,
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'must-not-move.jpg',
      mode: 'move',
    });

    expect(result).toMatchObject({ status: 'failed', sourceRetained: true });
    expect(result.error).toMatch(/journal durability/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('retain-source');
    await core.close();
  });

  it('fails move closed when durable file operations are disabled', async () => {
    const sourcePath = await source('nondurable-files.jpg', 'retain-source');
    const core = await createCore(destinationRoot, {
      durableFileOperations: false,
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'must-not-move.jpg',
      mode: 'move',
    });

    expect(result).toMatchObject({ status: 'failed', sourceRetained: true });
    expect(result.error).toMatch(/file operations/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('retain-source');
    await core.close();
  });

  it('cancels a duplicate move after its protected commit and retains both copies', async () => {
    const destinationPath = path.join(destinationRoot, 'duplicate-cancel.jpg');
    await writeFile(destinationPath, 'same-content');
    const sourcePath = await source('duplicate-cancel-source.jpg', 'same-content');
    const controller = new AbortController();
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-commit') controller.abort();
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: path.basename(destinationPath),
      mode: 'move',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: 'cancelled', sourceRetained: true });
    expect(await readFile(sourcePath, 'utf8')).toBe('same-content');
    expect(await readFile(destinationPath, 'utf8')).toBe('same-content');
    expect(await core.listStagingResidue()).toEqual([]);
    await core.close();
  });

  it('keeps failed duplicate-guard cleanup nonterminal for startup retry', async () => {
    const destinationPath = path.join(destinationRoot, 'duplicate-cleanup-retry.jpg');
    await writeFile(destinationPath, 'duplicate-cleanup-retry');
    const sourcePath = await source(
      'duplicate-cleanup-retry-source.jpg',
      'duplicate-cleanup-retry'
    );
    const controller = new AbortController();
    const first = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-commit') controller.abort();
      },
      cleanupFailureInjector: (filePath) => {
        if (filePath.endsWith('.duplicate-guard')) {
          throw new Error('injected duplicate-guard cleanup failure');
        }
      },
    });

    const interrupted = await first.execute({
      sourcePath,
      targetFilename: path.basename(destinationPath),
      mode: 'move',
      signal: controller.signal,
    });
    expect(interrupted).toMatchObject({
      status: 'cancelled',
      committed: true,
      sourceRetained: true,
      residue: [expect.stringMatching(/duplicate-guard cleanup failure/i)],
    });
    expect(await first.getLedger()).toMatchObject({
      nonterminal: 1,
      committedSourceRetained: 0,
    });
    expect(await first.listStagingResidue()).toHaveLength(1);
    await first.close();

    const recovered = await createCore(destinationRoot);
    expect(await recovered.getLedger()).toMatchObject({
      nonterminal: 0,
      committedSourceRetained: 1,
    });
    expect(await recovered.listStagingResidue()).toEqual([]);
    expect(await readFile(sourcePath, 'utf8')).toBe('duplicate-cleanup-retry');
    expect(await readFile(destinationPath, 'utf8')).toBe('duplicate-cleanup-retry');
    await recovered.close();
  });

  it('cleans a duplicate guard when cancellation follows durable delete intent', async () => {
    const destinationPath = path.join(destinationRoot, 'duplicate-pending-cancel.jpg');
    await writeFile(destinationPath, 'duplicate-pending-cancel');
    const sourcePath = await source(
      'duplicate-pending-cancel-source.jpg',
      'duplicate-pending-cancel'
    );
    const controller = new AbortController();
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-source-delete-pending') controller.abort();
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: path.basename(destinationPath),
      mode: 'move',
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: 'cancelled',
      committed: true,
      sourceRetained: true,
      residue: [],
    });
    expect(await readFile(sourcePath, 'utf8')).toBe('duplicate-pending-cancel');
    expect(await readFile(destinationPath, 'utf8')).toBe('duplicate-pending-cancel');
    expect(await core.listStagingResidue()).toEqual([]);
    expect(await core.getLedger()).toMatchObject({
      committedSourceRetained: 1,
      nonterminal: 0,
    });
    await core.close();
  });

  it('retries duplicate-guard cleanup when durable-intent cancellation cleanup fails', async () => {
    const destinationPath = path.join(destinationRoot, 'duplicate-pending-retry.jpg');
    await writeFile(destinationPath, 'duplicate-pending-retry');
    const sourcePath = await source(
      'duplicate-pending-retry-source.jpg',
      'duplicate-pending-retry'
    );
    const controller = new AbortController();
    const first = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-source-delete-pending') controller.abort();
      },
      cleanupFailureInjector: (filePath) => {
        if (filePath.endsWith('.duplicate-guard')) {
          throw new Error('injected pending duplicate-guard cleanup failure');
        }
      },
    });

    const interrupted = await first.execute({
      sourcePath,
      targetFilename: path.basename(destinationPath),
      mode: 'move',
      signal: controller.signal,
    });
    expect(interrupted).toMatchObject({
      status: 'cancelled',
      committed: true,
      sourceRetained: true,
      residue: [expect.stringMatching(/pending duplicate-guard cleanup failure/i)],
    });
    expect(await first.getLedger()).toMatchObject({
      committedSourceRetained: 0,
      nonterminal: 1,
    });
    expect(await first.listStagingResidue()).toHaveLength(1);
    await first.close();

    const recovered = await createCore(destinationRoot);
    expect(await recovered.getLedger()).toMatchObject({
      committedSourceRetained: 1,
      nonterminal: 0,
    });
    expect(await recovered.listStagingResidue()).toEqual([]);
    expect(await readFile(sourcePath, 'utf8')).toBe('duplicate-pending-retry');
    expect(await readFile(destinationPath, 'utf8')).toBe('duplicate-pending-retry');
    await recovered.close();
  });

  it('cancels before commit without publishing or deleting the source', async () => {
    const sourcePath = await source('cancel.jpg', 'keep-me');
    const controller = new AbortController();
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-stage-written') controller.abort();
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'cancelled.jpg',
      mode: 'move',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(result.sourceRetained).toBe(true);
    expect(await readFile(sourcePath, 'utf8')).toBe('keep-me');
    await expect(lstat(path.join(destinationRoot, 'cancelled.jpg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await core.close();
  });

  it('retains both the committed destination and move source when cancellation arrives post-commit', async () => {
    const sourcePath = await source('late-cancel.jpg', 'retain-both');
    const controller = new AbortController();
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-commit') controller.abort();
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'late-cancelled.jpg',
      mode: 'move',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: 'cancelled', committed: true });
    expect(result.sourceRetained).toBe(true);
    expect(await readFile(sourcePath, 'utf8')).toBe('retain-both');
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('retain-both');
    expect((await core.getLedger()).committedSourceRetained).toBe(1);
    await core.close();
  });

  it('reclaims the staging link when cancellation interrupts the source delete after commit', async () => {
    const sourcePath = await source('delete-step-cancel.jpg', 'keep-both-no-residue');
    const controller = new AbortController();
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'before-source-delete') controller.abort();
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'delete-step-cancelled.jpg',
      mode: 'move',
      expectedSha256: await hashFile(sourcePath),
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: 'cancelled', committed: true, sourceRetained: true });
    expect(await readFile(sourcePath, 'utf8')).toBe('keep-both-no-residue');
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('keep-both-no-residue');
    expect((await lstat(result.destinationPath!)).nlink).toBe(1);
    expect(await readdir(path.join(destinationRoot, '.meta-mover', 'staging'))).toEqual([]);
    await core.close();
  });

  it('sweeps staging and reservation residue of terminal operations when the core reopens', async () => {
    const sourcePath = await source('residue-source.jpg', 'residue-content');
    const controller = new AbortController();
    const stagingRoot = path.join(destinationRoot, '.meta-mover', 'staging');
    const first = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'before-source-delete') controller.abort();
      },
      cleanupFailureInjector: (filePath) => {
        if (path.dirname(filePath) === stagingRoot) {
          throw new Error('injected: helper channel aborted during cleanup');
        }
      },
    });
    const result = await first.execute({
      sourcePath,
      targetFilename: 'residue-target.jpg',
      mode: 'move',
      expectedSha256: await hashFile(sourcePath),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ status: 'cancelled', committed: true });
    expect(await readdir(stagingRoot)).toHaveLength(1);
    expect((await lstat(result.destinationPath!)).nlink).toBe(2);
    await first.close();

    const second = await createCore(destinationRoot);
    expect(await readdir(stagingRoot)).toEqual([]);
    expect((await lstat(result.destinationPath!)).nlink).toBe(1);
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('residue-content');
    expect(await readFile(sourcePath, 'utf8')).toBe('residue-content');
    await second.close();
  });

  it('reports post-commit failure as committed while retaining the source', async () => {
    const sourcePath = await source('post-commit-failure.jpg', 'committed-before-failure');
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-commit') throw new Error('post-commit injected failure');
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'post-commit-failure-target.jpg',
      mode: 'move',
    });

    expect(result).toMatchObject({
      status: 'failed',
      committed: true,
      sourceRetained: true,
      error: 'post-commit injected failure',
    });
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('committed-before-failure');
    expect(await readFile(sourcePath, 'utf8')).toBe('committed-before-failure');
    await core.close();
  });

  it('honors cancellation immediately after the durable delete-pending record', async () => {
    const sourcePath = await source('pending-cancel.jpg', 'retain-pending');
    const controller = new AbortController();
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-source-delete-pending') controller.abort();
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'pending-cancelled.jpg',
      mode: 'move',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(await readFile(sourcePath, 'utf8')).toBe('retain-pending');
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('retain-pending');
    expect(await readdir(path.join(destinationRoot, '.meta-mover', 'staging'))).toEqual([]);
    await core.close();
  });

  it('keeps an unknown source deletion nonterminal until receipt-backed reconciliation proves deletion', async () => {
    const sourcePath = await source('unknown-delete.jpg', 'unknown-delete-content');
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const first = await createCore(destinationRoot, {
      nativeFilesystem: nativeFilesystem(async (request) => {
        await writeFile(
          path.join(controlRoot, ...request.receipt.components),
          `${request.deleteId}\n`,
          {
            flag: 'wx',
          }
        );
        await unlink(sourcePath);
        throw new NativeFilesystemHelperClientError(
          'helper-disconnected',
          'protocol',
          'unknown',
          false,
          'transport ended after source deletion'
        );
      }),
    });

    const interrupted = await first.execute({
      sourcePath,
      targetFilename: 'unknown-delete-target.jpg',
      mode: 'move',
    });
    expect(interrupted).toMatchObject({ status: 'failed', committed: true, sourceRetained: false });
    expect(await first.getLedger()).toMatchObject({ nonterminal: 1, moved: 0, failed: 0 });
    const pending = (await readFile(path.join(controlRoot, 'transactions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .findLast((record) => record.state === 'source-delete-pending');
    expect(pending).toMatchObject({
      sourceDeleteId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      sourceDeleteReceiptPath: expect.stringMatching(/delete-receipts/),
    });
    await first.close();

    const recovered = await createCore(destinationRoot);
    expect(await recovered.getLedger()).toMatchObject({ moved: 1, nonterminal: 0 });
    await recovered.close();
  });

  it('terminalizes an unknown pre-mutation delete as committed source-retained after reconciliation', async () => {
    const sourcePath = await source('retained-unknown-delete.jpg', 'retained-unknown-content');
    const first = await createCore(destinationRoot, {
      nativeFilesystem: nativeFilesystem(async () => {
        throw new NativeFilesystemHelperClientError(
          'helper-disconnected',
          'protocol',
          'unknown',
          false,
          'transport ended before mutation'
        );
      }),
    });

    const interrupted = await first.execute({
      sourcePath,
      targetFilename: 'retained-unknown-target.jpg',
      mode: 'move',
    });
    expect(interrupted).toMatchObject({ status: 'failed', committed: true, sourceRetained: true });
    expect(await first.getLedger()).toMatchObject({ nonterminal: 1, committedSourceRetained: 0 });
    await first.close();

    const recovered = await createCore(destinationRoot);
    const recoveredRecords = (
      await readFile(path.join(destinationRoot, '.meta-mover', 'transactions.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(recoveredRecords.at(-1)).toMatchObject({
      state: 'cancelled',
      recoveryFinalized: true,
      residue: [],
    });
    expect(await recovered.getLedger()).toMatchObject({
      nonterminal: 0,
      committedSourceRetained: 1,
    });
    expect(await readFile(sourcePath, 'utf8')).toBe('retained-unknown-content');
    expect(await readdir(path.join(destinationRoot, '.meta-mover', 'staging'))).toEqual([]);
    await recovered.close();
  });

  it('keeps source-retained guard cleanup retriable until exact cleanup succeeds', async () => {
    const sourcePath = await source('retained-cleanup-retry.jpg', 'retained-cleanup-retry');
    const first = await createCore(destinationRoot, {
      nativeFilesystem: nativeFilesystem(async () => {
        throw new NativeFilesystemHelperClientError(
          'helper-disconnected',
          'protocol',
          'unknown',
          false,
          'transport ended before mutation'
        );
      }),
      cleanupFailureInjector: (filePath) => {
        if (filePath.endsWith('.part')) throw new Error('injected exact guard cleanup failure');
      },
    });

    const interrupted = await first.execute({
      sourcePath,
      targetFilename: 'retained-cleanup-retry-target.jpg',
      mode: 'move',
    });
    expect(interrupted).toMatchObject({ committed: true, sourceRetained: true });
    expect(interrupted.residue).toEqual([
      expect.stringMatching(/injected exact guard cleanup failure/i),
    ]);
    expect(await first.getLedger()).toMatchObject({ nonterminal: 1 });
    expect(await readdir(path.join(destinationRoot, '.meta-mover', 'staging'))).toHaveLength(1);
    await first.close();

    const failedRecovery = await createCore(destinationRoot, {
      nativeFilesystem: nativeFilesystem(undefined, undefined, {
        removeManagedExact: async (request) => {
          const managedPath = capabilityPath(request.path);
          const isOperationGuard =
            path.dirname(managedPath) === path.join(destinationRoot, '.meta-mover', 'staging') &&
            /^[0-9a-f-]{36}\.part$/.test(path.basename(managedPath));
          if (isOperationGuard) {
            throw new NativeFilesystemHelperClientError(
              'identity-mismatch',
              'precondition',
              'not-applied',
              false,
              'injected recovery guard cleanup failure'
            );
          }
          const before = await nativeIdentity(managedPath);
          expect(before).toEqual(request.expected);
          await unlink(managedPath);
          return {
            outcome: 'applied',
            before,
            after: null,
            durability: { file: 'not-applicable', parents: ['synced'] },
          };
        },
      }),
    });
    expect(await failedRecovery.getLedger()).toMatchObject({ nonterminal: 1 });
    expect(await readdir(path.join(destinationRoot, '.meta-mover', 'staging'))).toHaveLength(1);
    await failedRecovery.close();

    const recovered = await createCore(destinationRoot);
    expect(await recovered.getLedger()).toMatchObject({
      nonterminal: 0,
      committedSourceRetained: 1,
    });
    expect(await readdir(path.join(destinationRoot, '.meta-mover', 'staging'))).toEqual([]);
    expect(await readFile(sourcePath, 'utf8')).toBe('retained-cleanup-retry');
    await recovered.close();
  });

  it('previews collisions and same-hash duplicates without reserving a name', async () => {
    await writeFile(path.join(destinationRoot, 'same.jpg'), 'existing');
    const differentSource = await source('different.jpg', 'different');
    const identicalSource = await source('identical.jpg', 'existing');
    const core = await createCore(destinationRoot);

    const collision = await core.preview({
      sourcePath: differentSource,
      targetFilename: 'same.jpg',
    });
    const duplicate = await core.preview({
      sourcePath: identicalSource,
      targetFilename: 'same.jpg',
    });

    expect(collision).toMatchObject({
      targetFilename: 'same_01.jpg',
      collision: true,
      duplicate: false,
      provisional: true,
    });
    expect(duplicate).toMatchObject({
      targetFilename: 'same.jpg',
      collision: false,
      duplicate: true,
      provisional: true,
    });
    await core.close();
  });

  it.each(['2024/05/photo.jpg', '2024-05/photo.jpg'])(
    'previews and executes the exact nested relative target %s under one control root',
    async (targetFilename) => {
      const sourcePath = await source('nested-photo.jpg', `nested-${targetFilename}`);
      const core = await createCore(destinationRoot);

      const preview = await core.preview({ sourcePath, targetFilename });
      const result = await core.execute({
        sourcePath,
        targetFilename: preview.targetFilename,
        expectedDestinationPath: preview.expectedDestinationPath,
      });

      expect(preview.destinationPath).toBe(path.join(destinationRoot, targetFilename));
      expect(preview.targetFilename).toBe(targetFilename);
      expect(result.destinationPath).toBe(preview.destinationPath);
      expect(await readFile(result.destinationPath!, 'utf8')).toBe(`nested-${targetFilename}`);
      await expect(
        lstat(path.join(path.dirname(result.destinationPath!), '.meta-mover'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(path.join(destinationRoot, '.meta-mover'))).sort()).toEqual(
        expect.arrayContaining(['objects', 'reservations', 'staging', 'transactions.jsonl'])
      );
      await core.close();
    }
  );

  it('fails closed instead of silently changing an exact preview target that loses a race', async () => {
    const sourcePath = await source('exact-preview.jpg', 'planned-content');
    let externalPath: string | undefined;
    const core = await createCore(destinationRoot, {
      failureInjector: async (point, context) => {
        if (point === 'before-publish' && !externalPath) {
          externalPath = context.destinationPath;
          await writeFile(context.destinationPath!, 'external-winner');
        }
      },
    });
    const preview = await core.preview({
      sourcePath,
      targetFilename: '2024/05/exact.jpg',
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: preview.targetFilename,
      expectedDestinationPath: preview.expectedDestinationPath,
    });

    expect(result).toMatchObject({ status: 'failed', sourceRetained: true });
    expect(result.error).toMatch(/exact preview target is no longer available/i);
    expect(result.destinationPath).toBeUndefined();
    expect(await readFile(externalPath!, 'utf8')).toBe('external-winner');
    expect(await readdir(path.dirname(externalPath!))).toEqual(['exact.jpg']);
    await core.close();
  });

  it('applies deterministic collision suffixes to the leaf of a nested target', async () => {
    await mkdir(path.join(destinationRoot, '2024', '05'), { recursive: true });
    await writeFile(path.join(destinationRoot, '2024', '05', 'same.jpg'), 'existing');
    const sourcePath = await source('nested-collision.jpg', 'different');
    const core = await createCore(destinationRoot);

    const preview = await core.preview({
      sourcePath,
      targetFilename: '2024/05/same.jpg',
    });
    const result = await core.execute({
      sourcePath,
      targetFilename: preview.targetFilename,
    });

    expect(preview.targetFilename).toBe(path.join('2024', '05', 'same_01.jpg'));
    expect(result.destinationPath).toBe(path.join(destinationRoot, '2024', '05', 'same_01.jpg'));
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('different');
    await core.close();
  });

  it('rejects symlinked nested ancestors without writing through them', async () => {
    const outside = path.join(root, 'outside-nested');
    await mkdir(outside);
    await symlink(outside, path.join(destinationRoot, '2024'));
    const sourcePath = await source('nested-symlink.jpg', 'must-stay-inside');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: '2024/05/photo.jpg',
      mode: 'move',
    });

    expect(result).toMatchObject({ status: 'failed', sourceRetained: true });
    expect(result.error).toMatch(/symbolic link/i);
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(sourcePath, 'utf8')).toBe('must-stay-inside');
    await core.close();
  });

  it('fails closed when a nested destination directory changes identity before publication', async () => {
    const sourcePath = await source('nested-drift.jpg', 'retain-on-drift');
    const nestedDirectory = path.join(destinationRoot, '2024', '05');
    const displacedDirectory = path.join(destinationRoot, '2024', '05-displaced');
    const outside = path.join(root, 'outside-drift');
    await mkdir(outside);
    let attacked = false;
    const core = await createCore(destinationRoot, {
      failureInjector: async (point) => {
        if (point === 'before-publish' && !attacked) {
          attacked = true;
          await rename(nestedDirectory, displacedDirectory);
          await symlink(outside, nestedDirectory);
        }
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: '2024/05/photo.jpg',
      mode: 'move',
    });

    expect(attacked).toBe(true);
    expect(result).toMatchObject({ status: 'failed', sourceRetained: true });
    expect(result.error).toMatch(/directory identity changed/i);
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(sourcePath, 'utf8')).toBe('retain-on-drift');
    await core.close();
  });

  it('retains the source and publishes nothing on an injected pre-commit failure', async () => {
    const sourcePath = await source('failure.jpg', 'survivor');
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'before-publish') throw new Error('injected publication failure');
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'never-published.jpg',
      mode: 'move',
    });

    expect(result.status).toBe('failed');
    expect(result.sourceRetained).toBe(true);
    expect(await readFile(sourcePath, 'utf8')).toBe('survivor');
    await expect(lstat(path.join(destinationRoot, 'never-published.jpg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await core.getLedger()).failed).toBe(1);
    await core.close();
  });

  it('transforms and verifies private staging before publishing and deleting a moved source', async () => {
    const sourcePath = await source('normalize-before-publish.jpg', 'original-bytes');
    const destinationPath = path.join(destinationRoot, 'normalized.jpg');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      operationId: 'normalize-before-publish',
      sourcePath,
      targetFilename: 'normalized.jpg',
      mode: 'move',
      transformStaging: async ({ stagingPath }) => {
        expect(stagingPath).toContain(`${path.sep}.meta-mover${path.sep}staging${path.sep}`);
        await writeFile(stagingPath, 'normalized-bytes');
        return {
          verified: true,
          idempotent: true,
          normalizedTags: ['EXIF:DateTimeOriginal'],
        };
      },
    });

    expect(result).toMatchObject({ status: 'moved', committed: true, sourceRetained: false });
    expect(await readFile(destinationPath, 'utf8')).toBe('normalized-bytes');
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const records = await TransactionJournal.open(
      path.join(destinationRoot, '.meta-mover', 'transactions.jsonl')
    );
    const persisted = await records.readRecords();
    expect(persisted.findLast((record) => record.state === 'transformed')).toMatchObject({
      sourceHash: createHash('sha256').update('original-bytes').digest('hex'),
      outputHash: createHash('sha256').update('normalized-bytes').digest('hex'),
      transformationVerified: true,
      transformationReceipt: expect.objectContaining({ idempotent: true }),
    });
    await records.close();
    await core.close();
  });

  it('cancels during staging transformation without publishing or deleting the source', async () => {
    const sourcePath = await source('normalization-abort.jpg', 'source-survives-abort');
    const destinationPath = path.join(destinationRoot, 'aborted.jpg');
    const controller = new AbortController();
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: 'aborted.jpg',
      mode: 'move',
      signal: controller.signal,
      transformStaging: async ({ stagingPath }) => {
        await writeFile(stagingPath, 'normalized-before-abort');
        controller.abort();
        return { verified: true };
      },
    });

    expect(result).toMatchObject({ status: 'cancelled', committed: false, sourceRetained: true });
    expect(await readFile(sourcePath, 'utf8')).toBe('source-survives-abort');
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await core.listStagingResidue()).toEqual([]);
    await core.close();
  });

  it('streams startup recovery without materializing the complete journal record array', async () => {
    const readRecords = jest
      .spyOn(TransactionJournal.prototype, 'readRecords')
      .mockRejectedValue(new Error('must not materialize journal records'));

    try {
      const recovered = await createCore(destinationRoot);
      expect(readRecords).not.toHaveBeenCalled();
      await recovered.close();
    } finally {
      readRecords.mockRestore();
    }
  });

  it('recovers a transformed output crash after publication without deleting the retained source', async () => {
    const sourcePath = await source('normalization-crash.jpg', 'source-survives-crash');
    const destinationPath = path.join(destinationRoot, 'crash-output.jpg');
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-commit') throw new Error('simulated crash after transformed publish');
      },
    });

    const interrupted = await core.execute({
      operationId: 'transform-crash-recovery',
      sourcePath,
      targetFilename: 'crash-output.jpg',
      mode: 'move',
      transformStaging: async ({ stagingPath }) => {
        await writeFile(stagingPath, 'normalized-crash-output');
        return { verified: true };
      },
    });
    expect(interrupted).toMatchObject({ status: 'failed', committed: true, sourceRetained: true });
    await core.close();

    const recovered = await createCore(destinationRoot);
    expect(await readFile(sourcePath, 'utf8')).toBe('source-survives-crash');
    expect(await readFile(destinationPath, 'utf8')).toBe('normalized-crash-output');
    expect(await recovered.getLedger()).toMatchObject({
      committedSourceRetained: 1,
      nonterminal: 0,
    });
    expect(await recovered.listStagingResidue()).toEqual([]);
    await recovered.close();
  });

  it('retains the source and publishes nothing when staging normalization or readback fails', async () => {
    const sourcePath = await source('normalization-failure.jpg', 'source-survives');
    const destinationPath = path.join(destinationRoot, 'must-not-exist.jpg');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: 'must-not-exist.jpg',
      mode: 'move',
      transformStaging: async ({ stagingPath }) => {
        await writeFile(stagingPath, 'partially-rewritten');
        throw new Error('metadata readback verification failed');
      },
    });

    expect(result).toMatchObject({ status: 'failed', committed: false, sourceRetained: true });
    expect(result.error).toMatch(/readback verification failed/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('source-survives');
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await core.listStagingResidue()).toEqual([]);
    await core.close();
  });

  it('rejects an unverified staging transformation receipt before publication', async () => {
    const sourcePath = await source('unverified-normalization.jpg', 'source-survives-unverified');
    const destinationPath = path.join(destinationRoot, 'unverified-output.jpg');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: 'unverified-output.jpg',
      mode: 'move',
      transformStaging: async ({ stagingPath }) => {
        await writeFile(stagingPath, 'unverified-output');
        return { verified: false };
      },
    });

    expect(result).toMatchObject({ status: 'failed', committed: false, sourceRetained: true });
    expect(result.error).toMatch(/verified receipt/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('source-survives-unverified');
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await core.close();
  });

  it('rejects a source symlink without touching its target', async () => {
    const targetPath = await source('real.jpg', 'real-content');
    const sourceLink = path.join(sourceRoot, 'linked.jpg');
    await symlink(targetPath, sourceLink);
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath: sourceLink,
      targetFilename: 'must-not-publish.jpg',
      mode: 'move',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/non-symlink/i);
    expect(await readFile(targetPath, 'utf8')).toBe('real-content');
    expect((await lstat(sourceLink)).isSymbolicLink()).toBe(true);
    await expect(lstat(path.join(destinationRoot, 'must-not-publish.jpg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await core.close();
  });

  it('rejects a symlinked transaction-control directory without writing outside the destination', async () => {
    const outside = path.join(root, 'outside-control');
    await mkdir(outside);
    await symlink(outside, path.join(destinationRoot, '.meta-mover'));

    await expect(createCore(destinationRoot)).rejects.toThrow(/symbolic link/i);
    expect(await readdir(outside)).toEqual([]);
  });

  it('retains the replacement when the source pathname identity changes before deletion', async () => {
    const sourcePath = await source('replaceable.jpg', 'original-source');
    const core = await createCore(destinationRoot, {
      failureInjector: async (point) => {
        if (point === 'before-source-delete') {
          await unlink(sourcePath);
          await writeFile(sourcePath, 'replacement-file');
        }
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'replacement-target.jpg',
      mode: 'move',
    });

    expect(result.status).toBe('failed');
    expect(result.sourceRetained).toBe(false);
    expect(result.error).toMatch(/identity changed/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('replacement-file');
    expect(await core.getLedger()).toMatchObject({
      failed: 1,
      committedSourceRetained: 0,
    });
    await core.close();
  });

  it('never unlinks a replacement interposed after the final source identity check', async () => {
    const sourcePath = await source('final-unlink-race.jpg', 'original-source-bytes');
    let attacked = false;
    const core = await createCore(destinationRoot, {
      failureInjector: async (point) => {
        if ((point as string) === 'after-final-source-identity-before-unlink') {
          attacked = true;
          await unlink(sourcePath);
          await writeFile(sourcePath, 'replacement-must-survive');
        }
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'final-unlink-race-target.jpg',
      mode: 'move',
    });
    const sourceContent = await readFile(sourcePath, 'utf8').catch(() => undefined);
    await core.close();

    expect(attacked).toBe(true);
    expect(result).toMatchObject({ status: 'failed', committed: true });
    expect(sourceContent).toBe('replacement-must-survive');
  });

  it('preserves the primary failure when staging and reservation cleanup also fail', async () => {
    const sourcePath = await source('cleanup.jpg', 'cleanup-source');
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'before-publish') throw new Error('primary publication failure');
      },
      cleanupFailureInjector: () => {
        throw new Error('cleanup also failed');
      },
    });

    await expect(
      core.execute({ sourcePath, targetFilename: 'cleanup-target.jpg', mode: 'move' })
    ).resolves.toMatchObject({
      status: 'failed',
      error: 'primary publication failure',
      sourceRetained: true,
    });
    expect((await core.getLedger()).failed).toBe(1);
    await core.close();
  });

  it('preserves a replacement interposed before identity-bound staging cleanup', async () => {
    const sourcePath = await source('cleanup-replacement.jpg', 'original-source');
    let replacementPath: string | undefined;
    const core = await createCore(destinationRoot, {
      cleanupFailureInjector: async (filePath) => {
        if (!replacementPath && filePath.endsWith('.part')) {
          replacementPath = filePath;
          await unlink(filePath);
          await writeFile(filePath, 'replacement-must-survive');
        }
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'cleanup-replacement-target.jpg',
    });

    expect(replacementPath).toBeDefined();
    expect(result).toMatchObject({ committed: true, status: 'copied' });
    expect(result.residue).toEqual([
      expect.stringContaining(`${replacementPath}: Managed cleanup refused identity drift`),
    ]);
    expect(await readFile(replacementPath!, 'utf8')).toBe('replacement-must-survive');
    await core.close();
  });

  it('recovers a committed protected hardlink after restart without deleting the retained source', async () => {
    const sourcePath = await source('recover.jpg', 'recover-content');
    const first = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-commit') throw new Error('simulated process failure');
      },
    });
    const interrupted = await first.execute({
      sourcePath,
      targetFilename: 'recover-target.jpg',
      mode: 'move',
    });
    expect(interrupted.status).toBe('failed');
    expect(await first.listStagingResidue()).toHaveLength(1);
    await first.close();
    await unlink(interrupted.destinationPath!);

    const recovered = await createCore(destinationRoot);

    expect(await readFile(path.join(destinationRoot, 'recover-target.jpg'), 'utf8')).toBe(
      'recover-content'
    );
    expect(await readFile(sourcePath, 'utf8')).toBe('recover-content');
    expect(await recovered.listStagingResidue()).toEqual([]);
    expect((await recovered.getLedger()).committedSourceRetained).toBe(1);
    await recovered.close();
  });

  it('completes committed copy recovery instead of classifying retained source as partial move', async () => {
    const sourcePath = await source('recover-copy.jpg', 'recover-copy-content');
    const first = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-commit') throw new Error('copy restart boundary');
      },
    });
    const interrupted = await first.execute({
      sourcePath,
      targetFilename: 'recover-copy-target.jpg',
      mode: 'copy',
    });
    expect(interrupted).toMatchObject({ status: 'failed', committed: true, sourceRetained: true });
    await first.close();

    const recovered = await createCore(destinationRoot);

    expect(await recovered.getLedger()).toMatchObject({
      completed: 1,
      committedSourceRetained: 0,
    });
    expect(await readFile(sourcePath, 'utf8')).toBe('recover-copy-content');
    expect(await readFile(path.join(destinationRoot, 'recover-copy-target.jpg'), 'utf8')).toBe(
      'recover-copy-content'
    );
    await recovered.close();
  });

  it('recovers the verified destination when interruption follows source unlink', async () => {
    const sourcePath = await source('recover-after-unlink.jpg', 'recover-after-unlink');
    const first = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-source-unlink') throw new Error('simulated unlink-boundary crash');
      },
    });
    const interrupted = await first.execute({
      sourcePath,
      targetFilename: 'recover-after-unlink-target.jpg',
      mode: 'move',
    });
    expect(interrupted.status).toBe('failed');
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await first.listStagingResidue()).toHaveLength(1);
    await first.close();
    await unlink(interrupted.destinationPath!);

    const recovered = await createCore(destinationRoot);

    expect(
      await readFile(path.join(destinationRoot, 'recover-after-unlink-target.jpg'), 'utf8')
    ).toBe('recover-after-unlink');
    expect(await recovered.listStagingResidue()).toEqual([]);
    expect((await recovered.getLedger()).moved).toBe(1);
    await recovered.close();
  });

  it('recovers a committed nested destination without creating nested control roots', async () => {
    const sourcePath = await source('recover-nested.jpg', 'recover-nested-content');
    const destinationPath = path.join(destinationRoot, '2024', '05', 'recover.jpg');
    const first = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'after-source-unlink') throw new Error('nested recovery interruption');
      },
    });
    const interrupted = await first.execute({
      sourcePath,
      targetFilename: path.join('2024', '05', 'recover.jpg'),
      mode: 'move',
    });
    expect(interrupted.status).toBe('failed');
    await first.close();
    await unlink(destinationPath);

    const recovered = await createCore(destinationRoot);

    expect(await readFile(destinationPath, 'utf8')).toBe('recover-nested-content');
    await expect(lstat(path.join(destinationRoot, '2024', '.meta-mover'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await recovered.close();
  });

  it('never follows a nested destination ancestor swapped after recovery validation', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const stagingRoot = path.join(controlRoot, 'staging');
    const reservationRoot = path.join(controlRoot, 'reservations');
    const nestedParent = path.join(destinationRoot, '2024', '05');
    await Promise.all([
      mkdir(stagingRoot, { recursive: true }),
      mkdir(reservationRoot, { recursive: true }),
      mkdir(nestedParent, { recursive: true }),
    ]);
    const stagingPath = path.join(stagingRoot, 'nested-swap.part');
    const destinationPath = path.join(nestedParent, 'recovered.jpg');
    await writeFile(stagingPath, 'nested-swap-content');
    const journal = await TransactionJournal.open(path.join(controlRoot, 'transactions.jsonl'));
    await journal.append({
      operationId: 'nested-post-validation-swap',
      state: 'committed',
      mode: 'move',
      destinationPath,
      stagingPath,
      hash: await hashFile(stagingPath),
      committed: true,
    });
    await journal.close();
    const outside = path.join(root, 'outside-nested-swap');
    const outsideParent = path.join(outside, '05');
    await mkdir(outsideParent, { recursive: true });
    const displaced = path.join(destinationRoot, '2024-displaced');
    let attacked = false;

    const recovery = await createCore(destinationRoot, {
      failureInjector: async (point) => {
        if (point === 'before-recovery-mutation' && !attacked) {
          attacked = true;
          await rename(path.join(destinationRoot, '2024'), displaced);
          await symlink(outside, path.join(destinationRoot, '2024'));
        }
      },
    }).catch((error) => error as Error);
    if (recovery instanceof TransactionalFileCore) await recovery.close();

    expect(attacked).toBe(true);
    await expect(readFile(path.join(outsideParent, 'recovered.jpg'), 'utf8')).rejects.toMatchObject(
      {
        code: 'ENOENT',
      }
    );
  });

  it('never follows a nested recovery ancestor on non-Linux fallback paths', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const stagingRoot = path.join(controlRoot, 'staging');
    const nestedParent = path.join(destinationRoot, '2024', '05');
    await Promise.all([
      mkdir(stagingRoot, { recursive: true }),
      mkdir(path.join(controlRoot, 'reservations'), { recursive: true }),
      mkdir(nestedParent, { recursive: true }),
    ]);
    const stagingPath = path.join(stagingRoot, 'portable-nested-swap.part');
    const destinationPath = path.join(nestedParent, 'recovered.jpg');
    await writeFile(stagingPath, 'portable-escape-proof');
    const journal = await TransactionJournal.open(path.join(controlRoot, 'transactions.jsonl'));
    await journal.append({
      operationId: 'portable-nested-post-validation-swap',
      state: 'committed',
      mode: 'move',
      destinationPath,
      stagingPath,
      hash: await hashFile(stagingPath),
      committed: true,
    });
    await journal.close();
    const outside = path.join(root, 'portable-outside-nested-swap');
    await mkdir(path.join(outside, '05'), { recursive: true });
    const displaced = path.join(destinationRoot, '2024-portable-displaced');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let attacked = false;
    let recovery: TransactionalFileCore | Error | undefined;
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
    try {
      recovery = await createCore(destinationRoot, {
        failureInjector: async (point) => {
          if (point === 'before-recovery-mutation' && !attacked) {
            attacked = true;
            await rename(path.join(destinationRoot, '2024'), displaced);
            await symlink(outside, path.join(destinationRoot, '2024'));
          }
        },
      }).catch((error) => error as Error);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
    if (recovery instanceof TransactionalFileCore) await recovery.close();

    expect(attacked).toBe(true);
    await expect(readFile(path.join(outside, '05', 'recovered.jpg'), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' }
    );
    expect(await readFile(stagingPath, 'utf8')).toBe('portable-escape-proof');
  });

  it('uses recorded source identity instead of pathname existence during recovery', async () => {
    const sourcePath = await source('replacement-source.jpg', 'replacement-content');
    const replacementStats = await lstat(sourcePath, { bigint: true });
    const destinationPath = path.join(destinationRoot, 'identity-recovery.jpg');
    await writeFile(destinationPath, 'recovered-original');
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(path.join(controlRoot, 'staging'), { recursive: true });
    await mkdir(path.join(controlRoot, 'reservations'), { recursive: true });
    const journal = await TransactionJournal.open(path.join(controlRoot, 'transactions.jsonl'));
    await journal.append({
      operationId: 'replacement-source-recovery',
      state: 'committed',
      mode: 'move',
      sourcePath,
      sourceIdentity: {
        dev: replacementStats.dev.toString(),
        ino: (replacementStats.ino + 1n).toString(),
        nlink: Number(replacementStats.nlink),
        size: Number(replacementStats.size),
        modifiedTimeMs: Number(replacementStats.mtimeNs) / 1_000_000,
        mtimeNs: replacementStats.mtimeNs.toString(),
        ctimeNs: replacementStats.ctimeNs.toString(),
      },
      destinationPath,
      hash: await hashFile(destinationPath),
      committed: true,
    });
    await journal.close();

    const recovered = await createCore(destinationRoot);

    expect(await readFile(sourcePath, 'utf8')).toBe('replacement-content');
    expect(await recovered.getLedger()).toMatchObject({ moved: 1, committedSourceRetained: 0 });
    await recovered.close();
  });

  it('terminalizes committed recovery when destination is occupied by the wrong hash', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const stagingRoot = path.join(controlRoot, 'staging');
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(path.join(controlRoot, 'reservations'), { recursive: true });
    const stagingPath = path.join(stagingRoot, 'wrong-hash.part');
    const destinationPath = path.join(destinationRoot, 'wrong-hash.jpg');
    await writeFile(stagingPath, 'protected-correct-content');
    await writeFile(destinationPath, 'external-wrong-content');
    const journal = await TransactionJournal.open(path.join(controlRoot, 'transactions.jsonl'));
    await journal.append({
      operationId: 'wrong-hash-recovery',
      state: 'committed',
      mode: 'move',
      destinationPath,
      stagingPath,
      hash: await hashFile(stagingPath),
      committed: true,
    });
    await journal.close();

    const recovered = await createCore(destinationRoot);

    expect(await recovered.getLedger()).toMatchObject({ failed: 1, nonterminal: 0 });
    expect(await readFile(destinationPath, 'utf8')).toBe('external-wrong-content');
    expect(await readFile(stagingPath, 'utf8')).toBe('protected-correct-content');
    await recovered.close();

    const recordsAfterFirstRecovery = await TransactionJournal.open(
      path.join(controlRoot, 'transactions.jsonl')
    );
    const countAfterFirstRecovery = (await recordsAfterFirstRecovery.readRecords()).length;
    await recordsAfterFirstRecovery.close();
    const secondRecovery = await createCore(destinationRoot);
    await secondRecovery.close();
    const recordsAfterSecondRecovery = await TransactionJournal.open(
      path.join(controlRoot, 'transactions.jsonl')
    );
    expect((await recordsAfterSecondRecovery.readRecords()).length).toBe(countAfterFirstRecovery);
    await recordsAfterSecondRecovery.close();
  });

  it('restores a destination removed immediately after source unlink before releasing the guard', async () => {
    const sourcePath = await source('post-unlink-race.jpg', 'guarded-content');
    const destinationPath = path.join(destinationRoot, 'post-unlink-race-target.jpg');
    const core = await createCore(destinationRoot, {
      failureInjector: async (point) => {
        if (point === 'after-source-unlink') await unlink(destinationPath);
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: path.basename(destinationPath),
      mode: 'move',
    });

    expect(result).toMatchObject({ status: 'moved', sourceRetained: false });
    expect(await readFile(destinationPath, 'utf8')).toBe('guarded-content');
    expect(await core.listStagingResidue()).toEqual([]);
    await core.close();
  });

  it('revalidates conservation after the guard-cleanup failure boundary', async () => {
    const sourcePath = await source('guard-release.jpg', 'last-copy-must-survive');
    const destinationPath = path.join(destinationRoot, 'guard-release-target.jpg');
    let attacked = false;
    const core = await createCore(destinationRoot, {
      cleanupFailureInjector: async (filePath) => {
        if (!attacked && filePath.endsWith('.part')) {
          attacked = true;
          await unlink(destinationPath);
        }
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: path.basename(destinationPath),
      mode: 'move',
    });

    expect(result).toMatchObject({ status: 'moved', sourceRetained: false });
    expect(await readFile(destinationPath, 'utf8')).toBe('last-copy-must-survive');
    expect(await core.listStagingResidue()).toEqual([]);
    await core.close();
  });

  it.each([
    ['staged', false],
    ['duplicate', true],
  ])(
    'retains a named verified copy when %s destination vanishes after guard verification',
    async (_label, duplicate) => {
      const destinationPath = path.join(destinationRoot, 'late-guard-race.jpg');
      if (duplicate) await writeFile(destinationPath, 'late-race-content');
      const sourcePath = await source('late-guard-race-source.jpg', 'late-race-content');
      const expectedHash = await hashFile(sourcePath);
      let attacked = false;
      const core = await createCore(destinationRoot, {
        failureInjector: async (point) => {
          if (point === 'after-guard-release-verification') {
            attacked = true;
            await unlink(destinationPath);
          }
        },
      });

      const result = await core.execute({
        sourcePath,
        targetFilename: path.basename(destinationPath),
        mode: 'move',
      });

      expect(attacked).toBe(true);
      expect(result.status).toBe('failed');
      expect(result.sourceRetained).toBe(false);
      expect(await core.getLedger()).toMatchObject({
        failed: 1,
        committedSourceRetained: 0,
      });
      const conservationPath = path.join(destinationRoot, '.meta-mover', 'objects', expectedHash);
      const namedCopies = [destinationPath, conservationPath, ...(await core.listStagingResidue())];
      const survivingContent = await Promise.all(
        namedCopies.map((filePath) => readFile(filePath, 'utf8').catch(() => undefined))
      );
      expect(survivingContent).toContain('late-race-content');
      await core.close();
    }
  );

  it('keeps a named conservation object when the process dies after guard unlink', async () => {
    const sourcePath = await source('crash-after-guard.jpg', 'crash-conservation-content');
    const sourceHash = await hashFile(sourcePath);
    const destinationPath = path.join(destinationRoot, 'crash-after-guard-target.jpg');
    const modulePath = path.resolve(
      __dirname,
      '../../../src/main/core/transaction/TransactionalFileCore.ts'
    );
    const clientModulePath = path.resolve(
      __dirname,
      '../../../src/main/native/NativeFilesystemHelperClient.ts'
    );
    const nativePortModulePath = path.resolve(
      __dirname,
      '../../../src/main/core/transaction/NativeTransactionFilesystem.ts'
    );
    const resourcesRoot = path.resolve(__dirname, '../../..', '.build-tools');
    const script = `
      const { unlink } = require('fs/promises');
      const { TransactionalFileCore } = require(${JSON.stringify(modulePath)});
      const { developmentBrokerLaunchTrustPolicy, NativeFilesystemHelperClient } = require(${JSON.stringify(clientModulePath)});
      const { NativeTransactionFilesystem } = require(${JSON.stringify(nativePortModulePath)});
      (async () => {
        const core = await TransactionalFileCore.create(${JSON.stringify(destinationRoot)}, {
          nativeFilesystemFactory: async (destinationRoot, controlRoot) => {
            const sourceRoots = [${JSON.stringify(sourceRoot)}];
            const client = await NativeFilesystemHelperClient.open({
              resourcesRoot: ${JSON.stringify(resourcesRoot)},
              launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
              isPackaged: false,
              roots: NativeTransactionFilesystem.rootBindings(destinationRoot, controlRoot, sourceRoots)
            });
            return new NativeTransactionFilesystem(client, destinationRoot, controlRoot, sourceRoots);
          },
          failureInjector: async (point) => {
            if (point === 'after-guard-unlink') {
              await unlink(${JSON.stringify(destinationPath)});
              process.exit(91);
            }
          }
        });
        await core.execute({
          sourcePath: ${JSON.stringify(sourcePath)},
          targetFilename: ${JSON.stringify(path.basename(destinationPath))},
          mode: 'move',
          expectedSha256: ${JSON.stringify(sourceHash)}
        });
        process.exit(0);
      })().catch(() => process.exit(92));
    `;
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd: path.resolve(__dirname, '../../..'),
      stdio: 'ignore',
    });
    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));

    expect(exitCode).toBe(91);
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const objectRoot = path.join(destinationRoot, '.meta-mover', 'objects');
    const objects = await readdir(objectRoot);
    expect(objects).toHaveLength(1);
    expect(await readFile(path.join(objectRoot, objects[0]), 'utf8')).toBe(
      'crash-conservation-content'
    );
  }, 30_000);

  it('syncs the source parent before delete-pending and again after unlink', async () => {
    const sourcePath = await source('source-sync-order.jpg', 'ordered-durability');
    const events: string[] = [];
    const journalPath = path.join(destinationRoot, '.meta-mover', 'transactions.jsonl');
    const tracked = new Set([
      'after-source-directory-preflight',
      'after-source-delete-pending',
      'after-source-unlink',
      'after-source-directory-post-unlink-sync',
    ]);
    const core = await createCore(destinationRoot, {
      failureInjector: async (point) => {
        if (!tracked.has(point)) return;
        events.push(point);
        if (point === 'after-source-directory-preflight') {
          expect(await readFile(sourcePath, 'utf8')).toBe('ordered-durability');
          expect(await readFile(journalPath, 'utf8')).not.toMatch(/source-delete-pending/);
        }
        if (point === 'after-source-unlink') {
          await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
        }
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'source-sync-order-target.jpg',
      mode: 'move',
    });

    expect(result.status).toBe('moved');
    expect(events).toEqual([
      'after-source-directory-preflight',
      'after-source-delete-pending',
      'after-source-unlink',
      'after-source-directory-post-unlink-sync',
    ]);
    await core.close();
  });

  it('retains the source when the source-directory preflight boundary fails', async () => {
    const sourcePath = await source('source-sync-failure.jpg', 'retain-on-sync-failure');
    const core = await createCore(destinationRoot, {
      failureInjector: (point) => {
        if (point === 'before-source-directory-preflight') {
          throw new Error('injected source-directory durability failure');
        }
      },
    });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'source-sync-failure-target.jpg',
      mode: 'move',
    });

    expect(result).toMatchObject({ status: 'failed', sourceRetained: true });
    expect(result.error).toMatch(/source-directory durability failure/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('retain-on-sync-failure');
    await core.close();
  });

  it('persists source identity evidence and removes stale reservations during startup recovery', async () => {
    const sourcePath = await source('identity.jpg', 'identity-content');
    const first = await createCore(destinationRoot);
    await first.execute({ sourcePath, targetFilename: 'identity-target.jpg' });
    await first.close();
    const reservationPath = path.join(
      destinationRoot,
      '.meta-mover',
      'reservations',
      'stale.reserve'
    );
    await writeFile(reservationPath, 'stale');

    const recovered = await createCore(destinationRoot);
    const journalContent = await readFile(
      path.join(destinationRoot, '.meta-mover', 'transactions.jsonl'),
      'utf8'
    );
    const planned = journalContent
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.state === 'planned');

    expect(planned?.sourceIdentity).toMatchObject({
      dev: expect.any(String),
      ino: expect.any(String),
      mtimeNs: expect.any(String),
      ctimeNs: expect.any(String),
    });
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await recovered.close();
  });

  it('cancels and cleans an interrupted precommit transaction during startup recovery', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const stagingRoot = path.join(controlRoot, 'staging');
    const reservationRoot = path.join(controlRoot, 'reservations');
    await mkdir(controlRoot);
    await Promise.all([mkdir(stagingRoot), mkdir(reservationRoot)]);
    const stagingPath = path.join(stagingRoot, 'interrupted.part');
    const reservationPath = path.join(reservationRoot, 'interrupted.reserve');
    await Promise.all([writeFile(stagingPath, 'partial'), writeFile(reservationPath, 'reserved')]);
    const journal = await TransactionJournal.open(path.join(controlRoot, 'transactions.jsonl'));
    await journal.append({
      operationId: 'interrupted',
      state: 'staged',
      mode: 'copy',
      stagingPath,
      reservationPath,
      committed: false,
    });
    await journal.close();

    const recovered = await createCore(destinationRoot);

    await expect(lstat(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await recovered.getLedger()).cancelled).toBe(1);
    await recovered.close();
  });

  it('quarantines hostile recovery paths without touching files outside control roots', async () => {
    const outsidePath = path.join(root, 'outside-must-survive.jpg');
    await writeFile(outsidePath, 'outside-content');
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(controlRoot);
    await Promise.all([
      mkdir(path.join(controlRoot, 'staging')),
      mkdir(path.join(controlRoot, 'reservations')),
    ]);
    const journalPath = path.join(controlRoot, 'transactions.jsonl');
    const journal = await TransactionJournal.open(journalPath);
    await journal.append({
      operationId: 'hostile-path',
      state: 'staged',
      mode: 'move',
      stagingPath: outsidePath,
      reservationPath: outsidePath,
      destinationPath: path.join(controlRoot, 'must-not-be-a-destination.jpg'),
      committed: false,
    });
    await journal.close();

    const recovered = await createCore(destinationRoot);
    try {
      expect(await readFile(outsidePath, 'utf8')).toBe('outside-content');
      const records = (await readFile(journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[records.length - 1]).toMatchObject({
        operationId: 'hostile-path',
        state: 'failed',
        quarantined: true,
      });
    } finally {
      await recovered.close();
    }
  });

  it('quarantines a source-delete receipt whose filename does not match its durable delete ID', async () => {
    const sourcePath = await source('receipt-mismatch.jpg', 'receipt-mismatch-content');
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(controlRoot);
    const journalPath = path.join(controlRoot, 'transactions.jsonl');
    const deleteId = '11111111-1111-4111-8111-111111111111';
    const mismatchedReceiptId = '22222222-2222-4222-8222-222222222222';
    const journal = await TransactionJournal.open(journalPath);
    await journal.append({
      operationId: 'receipt-id-mismatch',
      state: 'source-delete-pending',
      mode: 'move',
      sourcePath,
      sourceNativeIdentity: await nativeIdentity(sourcePath),
      sourceDeleteId: deleteId,
      sourceDeleteReceiptPath: path.join(
        controlRoot,
        'delete-receipts',
        `${mismatchedReceiptId}.json`
      ),
      hash: await hashFile(sourcePath),
      committed: true,
    });
    await journal.close();

    const recovered = await createCore(destinationRoot);
    try {
      expect(await readFile(sourcePath, 'utf8')).toBe('receipt-mismatch-content');
      const records = (await readFile(journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[records.length - 1]).toMatchObject({
        operationId: 'receipt-id-mismatch',
        state: 'source-delete-pending',
        committed: true,
      });
      expect(records.some((record) => record.state === 'completed')).toBe(false);
    } finally {
      await recovered.close();
    }
  });

  it('keeps an incomplete committed source-delete intent nonterminal when the source is absent', async () => {
    const destinationPath = path.join(destinationRoot, 'incomplete-delete-intent.jpg');
    await writeFile(destinationPath, 'committed-destination-content');
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(controlRoot);
    const journalPath = path.join(controlRoot, 'transactions.jsonl');
    const journal = await TransactionJournal.open(journalPath);
    await journal.append({
      operationId: 'incomplete-delete-intent',
      state: 'source-delete-pending',
      mode: 'move',
      sourcePath: path.join(sourceRoot, 'now-absent.jpg'),
      destinationPath,
      hash: await hashFile(destinationPath),
      committed: true,
    });
    await journal.close();

    const recovered = await createCore(destinationRoot);
    try {
      const records = (await readFile(journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[records.length - 1]).toMatchObject({
        operationId: 'incomplete-delete-intent',
        state: 'source-delete-pending',
        committed: true,
      });
      expect(records.some((record) => record.state === 'completed')).toBe(false);
    } finally {
      await recovered.close();
    }
  });

  it('quarantines a nested recovery destination with a symlink ancestor', async () => {
    const outside = path.join(root, 'outside-recovery-nested');
    await mkdir(outside);
    await symlink(outside, path.join(destinationRoot, '2024'));
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const stagingRoot = path.join(controlRoot, 'staging');
    const reservationRoot = path.join(controlRoot, 'reservations');
    await mkdir(controlRoot);
    await Promise.all([mkdir(stagingRoot), mkdir(reservationRoot)]);
    const stagingPath = path.join(stagingRoot, 'nested.part');
    await writeFile(stagingPath, 'must-not-escape');
    const journalPath = path.join(controlRoot, 'transactions.jsonl');
    const journal = await TransactionJournal.open(journalPath);
    await journal.append({
      operationId: 'nested-symlink-recovery',
      state: 'committed',
      mode: 'move',
      destinationPath: path.join(destinationRoot, '2024', '05', 'photo.jpg'),
      stagingPath,
      hash: await hashFile(stagingPath),
      committed: true,
    });
    await journal.close();

    const recovered = await createCore(destinationRoot);
    try {
      expect(await readdir(outside)).toEqual([]);
      expect(await readFile(stagingPath, 'utf8')).toBe('must-not-escape');
      const records = (await readFile(journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[records.length - 1]).toMatchObject({
        operationId: 'nested-symlink-recovery',
        state: 'failed',
        quarantined: true,
      });
    } finally {
      await recovered.close();
    }
  });

  it('anchors recovery mutations when the staging parent is replaced after validation', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const stagingRoot = path.join(controlRoot, 'staging');
    const reservationRoot = path.join(controlRoot, 'reservations');
    await mkdir(controlRoot);
    await Promise.all([mkdir(stagingRoot), mkdir(reservationRoot)]);
    const stagingPath = path.join(stagingRoot, 'same-name.part');
    await writeFile(stagingPath, 'internal-residue');
    const outsideRoot = path.join(root, 'outside-staging');
    await mkdir(outsideRoot);
    const outsidePath = path.join(outsideRoot, path.basename(stagingPath));
    await writeFile(outsidePath, 'outside-must-survive');
    const journal = await TransactionJournal.open(path.join(controlRoot, 'transactions.jsonl'));
    await journal.append({
      operationId: 'parent-swap',
      state: 'staged',
      mode: 'copy',
      stagingPath,
      committed: false,
    });
    await journal.close();
    let attacked = false;
    const displacedStaging = path.join(controlRoot, 'staging-displaced');

    await expect(
      createCore(destinationRoot, {
        failureInjector: async (point) => {
          if (point === 'before-recovery-mutation' && !attacked) {
            attacked = true;
            await rename(stagingRoot, displacedStaging);
            await symlink(outsideRoot, stagingRoot);
          }
        },
      })
    ).rejects.toThrow(/directory identity|symbolic link/i);
    expect(attacked).toBe(true);
    expect(await readFile(outsidePath, 'utf8')).toBe('outside-must-survive');
  });

  it('records completion only after helper-backed staging and reservation cleanup', async () => {
    const sourcePath = await source('cleanup-sync.jpg', 'cleanup-sync-content');
    const core = await createCore(destinationRoot);
    const stagingRoot = path.join(destinationRoot, '.meta-mover', 'staging');
    const reservationRoot = path.join(destinationRoot, '.meta-mover', 'reservations');
    const result = await core.execute({ sourcePath, targetFilename: 'cleanup-sync-target.jpg' });

    expect(result).toMatchObject({ status: 'copied', residue: [] });
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(await readdir(reservationRoot)).toEqual([]);
    await core.close();
  });

  it('rejects target names that could escape the destination root', async () => {
    const sourcePath = await source('safe.jpg', 'safe-content');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: '../escape.jpg',
      mode: 'move',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/safe relative path/i);
    expect(await readFile(sourcePath, 'utf8')).toBe('safe-content');
    await expect(lstat(path.join(root, 'escape.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
    await core.close();
  });

  it.each([
    '../escape.jpg',
    '2024/../../escape.jpg',
    '/absolute.jpg',
    'C:\\absolute.jpg',
    '.meta-mover/objects/not-a-target.jpg',
    '2024//photo.jpg',
  ])('rejects unsafe relative target %s', async (targetFilename) => {
    const sourcePath = await source(`unsafe-${Math.random()}.jpg`, 'safe-content');
    const core = await createCore(destinationRoot);

    const result = await core.execute({ sourcePath, targetFilename, mode: 'move' });

    expect(result).toMatchObject({ status: 'failed', sourceRetained: true });
    expect(await readFile(sourcePath, 'utf8')).toBe('safe-content');
    await core.close();
  });

  it('rejects a second active writer and operations after close', async () => {
    const sourcePath = await source('closed.jpg', 'closed-content');
    const core = await createCore(destinationRoot);

    await expect(createCore(destinationRoot)).rejects.toThrow(/active transaction writer/i);
    await unlink(path.join(destinationRoot, '.meta-mover', 'core.lock'));
    await core.close();
    await core.close();

    await expect(
      core.execute({ sourcePath, targetFilename: 'closed-target.jpg' })
    ).resolves.toMatchObject({
      status: 'failed',
      sourceRetained: true,
      error: expect.stringMatching(/closed/i),
    });
  });

  it('attempts every core close and lock release when journal close reports a failure', async () => {
    const core = await createCore(destinationRoot);
    const internals = core as unknown as {
      journal: { close: () => Promise<void> };
      controlDirectoryHandle: { close: () => Promise<void> };
      destinationDirectoryHandle: { close: () => Promise<void> };
      stagingDirectoryHandle: { close: () => Promise<void> };
      reservationDirectoryHandle: { close: () => Promise<void> };
      objectDirectoryHandle: { close: () => Promise<void> };
    };
    const originalJournalClose = internals.journal.close.bind(internals.journal);
    jest.spyOn(internals.journal, 'close').mockImplementationOnce(async () => {
      await originalJournalClose();
      throw new Error('injected core journal close failure');
    });
    const handles = [
      internals.controlDirectoryHandle,
      internals.destinationDirectoryHandle,
      internals.stagingDirectoryHandle,
      internals.reservationDirectoryHandle,
      internals.objectDirectoryHandle,
    ];
    const closeSpies = handles.map((handle) => jest.spyOn(handle, 'close'));

    const closeOutcome = await core.close().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error })
    );
    const everyHandleAttempted = closeSpies.every((spy) => spy.mock.calls.length === 1);
    const lockPath = path.join(destinationRoot, '.meta-mover', 'core.lock');
    const lockRemained = await lstat(lockPath)
      .then(() => true)
      .catch(() => false);
    for (const handle of handles) await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);

    expect(String(closeOutcome.error)).toMatch(/core journal close failure/i);
    expect(everyHandleAttempted).toBe(true);
    expect(lockRemained).toBe(false);
  });

  it('makes concurrent close callers wait for the same resource shutdown', async () => {
    let releaseNativeClose!: () => void;
    const nativeCloseBarrier = new Promise<void>((resolve) => {
      releaseNativeClose = resolve;
    });
    let observeNativeClose!: () => void;
    const nativeCloseObserved = new Promise<void>((resolve) => {
      observeNativeClose = resolve;
    });
    const close = jest.fn(async () => {
      observeNativeClose();
      await nativeCloseBarrier;
    });
    const core = await createCore(destinationRoot, {
      nativeFilesystem: nativeFilesystem(undefined, undefined, { close }),
    });

    const firstClose = core.close();
    await nativeCloseObserved;
    let secondSettled = false;
    const secondClose = core.close().finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);

    releaseNativeClose();
    await Promise.all([firstClose, secondClose]);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(
      lstat(path.join(destinationRoot, '.meta-mover', 'core.lock'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not steal an incomplete visible core lock', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(controlRoot);
    const lockPath = path.join(controlRoot, 'core.lock');
    await writeFile(lockPath, '');

    await expect(createCore(destinationRoot)).rejects.toThrow(/lock|writer/i);
    expect(await readFile(lockPath, 'utf8')).toBe('');
  });

  it.each([
    ['non-object owner', 'null'],
    ['non-positive PID', JSON.stringify({ pid: 0, token: 'invalid-pid' })],
    ['empty token', JSON.stringify({ pid: 99_999_999, token: '' })],
  ])('fails closed on a core lock with %s', async (_label, ownerData) => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(controlRoot);
    const lockPath = path.join(controlRoot, 'core.lock');
    await writeFile(lockPath, ownerData);

    await expect(createCore(destinationRoot)).rejects.toThrow(/lock/i);
    expect(await readFile(lockPath, 'utf8')).toBe(ownerData);
  });

  it('fails closed on a multiply linked core lock without removing either name', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(controlRoot);
    const outside = path.join(root, 'outside-hardlinked-lock');
    const lockPath = path.join(controlRoot, 'core.lock');
    const ownerData = JSON.stringify({ pid: 99_999_999, token: 'hardlinked-owner' });
    await writeFile(outside, ownerData);
    await link(outside, lockPath);

    await expect(createCore(destinationRoot)).rejects.toThrow(/lock/i);
    expect(await readFile(lockPath, 'utf8')).toBe(ownerData);
    expect((await lstat(outside)).nlink).toBe(2);
  });

  it('rejects operation IDs that could escape the staging root', async () => {
    const sourcePath = await source('operation-id-escape.jpg', 'retain-operation-source');
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      operationId: '../../../escaped',
      sourcePath,
      targetFilename: 'safe-target.jpg',
    });

    expect(result).toMatchObject({ status: 'failed', committed: false, sourceRetained: true });
    expect(result.error).toMatch(/operation id/i);
    await expect(lstat(path.join(root, 'escaped.part'))).rejects.toMatchObject({ code: 'ENOENT' });
    await core.close();
  });

  it('rejects a non-directory transaction-control path', async () => {
    await writeFile(path.join(destinationRoot, '.meta-mover'), 'hostile-control-file');

    await expect(createCore(destinationRoot)).rejects.toThrow(/not a directory/i);
  });

  it('closes every acquired resource and releases the writer lock when journal admission fails', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const invalidJournal = path.join(controlRoot, 'transactions.jsonl');
    await mkdir(invalidJournal, { recursive: true });
    const nativeClose = jest.fn(async () => undefined);

    await expect(
      TransactionalFileCore.create(destinationRoot, {
        nativeFilesystem: nativeFilesystem(undefined, undefined, { close: nativeClose }),
      })
    ).rejects.toThrow(/journal.*regular|regular.*journal/i);

    expect(nativeClose).toHaveBeenCalledTimes(1);
    await expect(lstat(path.join(controlRoot, 'core.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await rm(invalidJournal, { recursive: true, force: true });
    const reopened = await createCore(destinationRoot);
    await reopened.close();
  });

  it('rejects a symlinked core lock and reclaims a dead-owner core lock', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(controlRoot);
    const outside = path.join(root, 'outside-lock-target');
    await writeFile(outside, 'outside');
    const lockPath = path.join(controlRoot, 'core.lock');
    await symlink(outside, lockPath);

    await expect(createCore(destinationRoot)).rejects.toThrow(/lock.*symbolic/i);
    expect(await readFile(outside, 'utf8')).toBe('outside');
    await unlink(lockPath);
    await writeFile(lockPath, JSON.stringify({ pid: 99_999_999, token: 'dead-owner-token' }));

    const core = await createCore(destinationRoot);

    await core.close();
  });

  it('repairs a crash-left core lock publication alias before reclaiming it', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(controlRoot);
    const token = 'crashed-publication-token';
    const candidatePath = path.join(controlRoot, `core.lock.candidate.99999999.${token}`);
    const lockPath = path.join(controlRoot, 'core.lock');
    await writeFile(candidatePath, JSON.stringify({ pid: 99_999_999, token }));
    await link(candidatePath, lockPath);

    const core = await createCore(destinationRoot);

    await expect(lstat(candidatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await core.close();
  });

  it('keeps a live core lock publisher valid when a contender repairs its candidate alias', async () => {
    let publisherReached!: () => void;
    const publicationObserved = new Promise<void>((resolve) => {
      publisherReached = resolve;
    });
    let releasePublisher!: () => void;
    const publicationRelease = new Promise<void>((resolve) => {
      releasePublisher = resolve;
    });
    const firstOpening = createCore(destinationRoot, {
      failureInjector: async (point) => {
        if ((point as string) === 'before-core-lock-candidate-cleanup') {
          publisherReached();
          await publicationRelease;
        }
      },
    });
    const observedInTime = await Promise.race([
      publicationObserved.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!observedInTime) {
      const unexpectedlyOpened = await firstOpening;
      await unexpectedlyOpened.close();
    }

    expect(observedInTime).toBe(true);
    const contenderOutcome = await createCore(destinationRoot).then(
      (core) => ({ core }),
      (error: unknown) => ({ error })
    );
    releasePublisher();
    const first = await firstOpening;

    expect(contenderOutcome).toHaveProperty('error');
    expect(String('error' in contenderOutcome ? contenderOutcome.error : '')).toMatch(
      /active transaction writer/i
    );
    await first.close();
    if ('core' in contenderOutcome) await contenderOutcome.core.close();
  });

  it('never restores a live core lock release quarantine as crash residue', async () => {
    let releaseReached!: () => void;
    const releaseObserved = new Promise<void>((resolve) => {
      releaseReached = resolve;
    });
    let resumeRelease!: () => void;
    const releaseBarrier = new Promise<void>((resolve) => {
      resumeRelease = resolve;
    });
    let releasingToken: string | undefined;
    const first = await createCore(destinationRoot, {
      failureInjector: async (point, context) => {
        if ((point as string) === 'after-core-lock-quarantined') {
          releasingToken = context.operationId;
          releaseReached();
          await releaseBarrier;
        }
      },
    });
    const closing = first.close();
    const observedInTime = await Promise.race([
      releaseObserved.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!observedInTime) await closing;
    expect(observedInTime).toBe(true);

    let contenderObserved!: () => void;
    const contenderSawQuarantine = new Promise<void>((resolve) => {
      contenderObserved = resolve;
    });
    const contender = createCore(destinationRoot, {
      failureInjector: (point) => {
        if ((point as string) === 'live-core-lock-quarantine-observed') contenderObserved();
      },
    }).then(
      (core) => ({ core }),
      (error: unknown) => ({ error })
    );
    await contenderSawQuarantine;
    resumeRelease();
    await closing;
    const lockPath = path.join(destinationRoot, '.meta-mover', 'core.lock');
    let strandedOwner = false;
    try {
      const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: string };
      strandedOwner = owner.token === releasingToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (strandedOwner) await unlink(lockPath);
    const contenderOutcome = await contender;

    expect(strandedOwner).toBe(false);
    if ('core' in contenderOutcome) await contenderOutcome.core.close();
    const afterRelease = await createCore(destinationRoot);
    await afterRelease.close();
  });

  it('does not reclaim a replacement live core lock interposed after stale-owner validation', async () => {
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    await mkdir(controlRoot);
    const lockPath = path.join(controlRoot, 'core.lock');
    await writeFile(lockPath, JSON.stringify({ pid: 99_999_999, token: 'stale-token' }));
    let attacked = false;

    await expect(
      createCore(destinationRoot, {
        failureInjector: async (point) => {
          if ((point as string) === 'before-core-lock-reclaim' && !attacked) {
            attacked = true;
            await unlink(lockPath);
            await writeFile(
              lockPath,
              JSON.stringify({ pid: process.pid, token: 'replacement-live-token' })
            );
          }
        },
      })
    ).rejects.toThrow(/active transaction writer|identity changed/i);
    expect(attacked).toBe(true);
    expect(await readFile(lockPath, 'utf8')).toContain('replacement-live-token');
  });

  it('cleans interrupted exact reservations on non-Linux recovery paths', async () => {
    const sourcePath = await source('portable-recovery.jpg', 'portable-recovery-content');
    const destinationPath = path.join(destinationRoot, 'portable-target.jpg');
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const reservationRoot = path.join(controlRoot, 'reservations');
    await mkdir(path.join(controlRoot, 'staging'), { recursive: true });
    await mkdir(reservationRoot, { recursive: true });
    const reservationName = `${createHash('sha256').update(destinationPath).digest('hex')}.reserve`;
    const reservationPath = path.join(reservationRoot, reservationName);
    await writeFile(
      reservationPath,
      JSON.stringify({ operationId: 'interrupted', destinationPath })
    );
    const journal = await TransactionJournal.open(path.join(controlRoot, 'transactions.jsonl'));
    await journal.append({
      operationId: 'portable-interrupted',
      state: 'reserved',
      mode: 'copy',
      reservationPath,
      destinationPath,
      committed: false,
    });
    await journal.close();
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
    let core: TransactionalFileCore | undefined;
    try {
      core = await createCore(destinationRoot);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }

    const result = await core.execute({
      sourcePath,
      targetFilename: path.basename(destinationPath),
      expectedDestinationPath: destinationPath,
      collisionMode: 'exact-no-clobber',
    });
    expect(result.status).toBe('copied');
    await core.close();
  });

  it.each(['staging', 'reservations'])(
    'fails closed when the %s control directory is replaced after creation',
    async (directoryName) => {
      const sourcePath = await source(`${directoryName}-swap.jpg`, 'stay-contained');
      const core = await createCore(destinationRoot);
      const controlRoot = path.join(destinationRoot, '.meta-mover');
      const managedDirectory = path.join(controlRoot, directoryName);
      const displacedDirectory = path.join(controlRoot, `${directoryName}-displaced`);
      const outsideDirectory = path.join(root, `${directoryName}-outside`);
      await mkdir(outsideDirectory);
      await rename(managedDirectory, displacedDirectory);
      await symlink(outsideDirectory, managedDirectory);

      const result = await core.execute({
        sourcePath,
        targetFilename: `${directoryName}-swap-target.jpg`,
      });

      expect(result).toMatchObject({ status: 'failed', sourceRetained: true });
      expect(await readdir(outsideDirectory)).toEqual([]);
      await core.close();
    }
  );

  it('does not remove a replacement core lock carrying a different ownership token', async () => {
    const core = await createCore(destinationRoot);
    const lockPath = path.join(destinationRoot, '.meta-mover', 'core.lock');
    await unlink(lockPath);
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'replacement-token' }));

    await core.close();

    expect(await readFile(lockPath, 'utf8')).toContain('replacement-token');
  });

  it('enforces internal durability, identity, and collision safety primitives at their boundaries', async () => {
    const sourcePath = await source('primitive-source.jpg', 'primitive-content');
    const core = await createCore(destinationRoot);
    const internals = core as unknown as {
      collisionFilename(filename: string, counter: number): string;
      identityAfterOneLinkRemoval(identity: NativeFilesystemIdentity): NativeFilesystemIdentity;
      isOneLinkRemovalOfSameIdentity(
        expected: NativeFilesystemIdentity,
        observed: NativeFilesystemIdentity
      ): boolean;
      identityFromStats(stats: { size: bigint }): unknown;
      singleLinkedRegularFileHash(filePath: string): Promise<string | undefined>;
      syncRegularFile(filePath: string): Promise<void>;
      syncOpenedDirectory(directoryPath: string): Promise<void>;
      verifyMoveDurability(): Promise<void>;
      requireNativeFilesystem(): NativeTransactionFilesystem;
      durableFileOperations: boolean;
      nativeFilesystem?: NativeTransactionFilesystem;
    };
    const unixTwoLinks: NativeFilesystemIdentity = {
      ...(await nativeIdentity(sourcePath)),
      links: '2',
    };
    const unixOneLink = { ...unixTwoLinks, links: '1' };
    const windowsTwoLinks: NativeFilesystemIdentity = {
      kind: 'windows',
      volumeSerial: 'volume',
      fileId: 'file',
      links: '2',
      size: unixTwoLinks.size,
      mtimeNs: unixTwoLinks.mtimeNs,
    };
    const windowsOneLink = { ...windowsTwoLinks, links: '1' };

    expect(internals.collisionFilename('photo.jpg', 100)).toBe('photo_100.jpg');
    expect(internals.identityAfterOneLinkRemoval(unixTwoLinks)).toMatchObject({ links: '1' });
    expect(() => internals.identityAfterOneLinkRemoval(unixOneLink)).toThrow(/final link/i);
    expect(internals.isOneLinkRemovalOfSameIdentity(unixTwoLinks, unixOneLink)).toBe(true);
    expect(internals.isOneLinkRemovalOfSameIdentity(windowsTwoLinks, windowsOneLink)).toBe(true);
    expect(internals.isOneLinkRemovalOfSameIdentity(unixTwoLinks, windowsOneLink)).toBe(false);
    expect(
      internals.isOneLinkRemovalOfSameIdentity(unixTwoLinks, { ...unixOneLink, size: '999' })
    ).toBe(false);
    expect(() =>
      internals.identityFromStats({ size: BigInt(Number.MAX_SAFE_INTEGER) + 1n })
    ).toThrow(/safe integer/i);

    expect(await internals.singleLinkedRegularFileHash(path.join(root, 'missing'))).toBeUndefined();
    expect(await internals.singleLinkedRegularFileHash(destinationRoot)).toBeUndefined();
    await expect(internals.syncRegularFile(destinationRoot)).rejects.toThrow(/regular file/i);
    await internals.syncOpenedDirectory(destinationRoot);

    internals.durableFileOperations = false;
    await internals.syncRegularFile(sourcePath);
    await internals.syncOpenedDirectory(destinationRoot);
    internals.durableFileOperations = true;

    const native = internals.nativeFilesystem;
    const publicationFailure = jest
      .spyOn(native!, 'hardLinkNoReplace')
      .mockImplementationOnce(async (stagingPath) => {
        await unlink(stagingPath);
        throw new Error('injected durability publication failure');
      });
    await expect(internals.verifyMoveDurability()).rejects.toThrow(/publication failure/i);
    publicationFailure.mockRestore();

    internals.nativeFilesystem = undefined;
    expect(() => internals.requireNativeFilesystem()).toThrow(/native filesystem helper/i);
    internals.nativeFilesystem = native;
    await core.close();
  });

  it('fails closed at protected-guard and conservation-object boundary variants', async () => {
    const core = await createCore(destinationRoot);
    const controlRoot = path.join(destinationRoot, '.meta-mover');
    const protectedPath = path.join(controlRoot, 'staging', 'manual.guard');
    const destinationPath = path.join(destinationRoot, 'manual-target.jpg');
    await writeFile(protectedPath, 'expected-content');
    const expectedHash = await hashFile(protectedPath);
    const internals = core as unknown as {
      destinationDirectoryHandle: object;
      objectRoot: string;
      nativeFilesystem: NativeTransactionFilesystem;
      managedNativeIdentities: Map<string, NativeFilesystemIdentity>;
      restoreDestinationFromGuard(
        destinationPath: string,
        protectedPath: string,
        expectedHash: string,
        targetDirectory: { directoryPath: string; handle: object }
      ): Promise<void>;
      releaseProtectedGuard(
        operationId: string,
        sourcePath: string,
        protectedPath: string,
        destinationPath: string,
        expectedHash: string,
        residue: string[],
        targetDirectory: { directoryPath: string; handle: object }
      ): Promise<void>;
      cleanupConservationAliases(objectPath: string, expectedHash: string): Promise<void>;
      singleLinkedRegularFileHash(filePath: string): Promise<string | undefined>;
    };
    const targetDirectory = {
      directoryPath: destinationRoot,
      handle: internals.destinationDirectoryHandle,
    };

    await writeFile(protectedPath, 'wrong-content');
    await expect(
      internals.restoreDestinationFromGuard(
        destinationPath,
        protectedPath,
        expectedHash,
        targetDirectory
      )
    ).rejects.toThrow(/protected hardlink/i);
    await writeFile(protectedPath, 'expected-content');
    await writeFile(destinationPath, 'occupied-by-other-content');
    await expect(
      internals.restoreDestinationFromGuard(
        destinationPath,
        protectedPath,
        expectedHash,
        targetDirectory
      )
    ).rejects.toThrow(/replaced/i);

    await unlink(destinationPath);
    await expect(
      internals.restoreDestinationFromGuard(
        destinationPath,
        protectedPath,
        expectedHash,
        targetDirectory
      )
    ).rejects.toThrow(/no native identity/i);

    internals.managedNativeIdentities.set(protectedPath, await nativeIdentity(protectedPath));
    const genericPublicationFailure = jest
      .spyOn(internals.nativeFilesystem, 'hardLinkNoReplace')
      .mockRejectedValueOnce(new Error('generic publication failure'));
    await expect(
      internals.restoreDestinationFromGuard(
        destinationPath,
        protectedPath,
        expectedHash,
        targetDirectory
      )
    ).rejects.toThrow(/generic publication failure/i);
    genericPublicationFailure.mockRestore();

    const collisionPublication = jest
      .spyOn(internals.nativeFilesystem, 'hardLinkNoReplace')
      .mockImplementationOnce(async () => {
        await writeFile(destinationPath, 'collision-content');
        throw new NativeFilesystemHelperClientError(
          'target-exists',
          'precondition',
          'not-applied',
          false,
          'target already exists'
        );
      });
    await expect(
      internals.restoreDestinationFromGuard(
        destinationPath,
        protectedPath,
        expectedHash,
        targetDirectory
      )
    ).rejects.toThrow(/could not be restored/i);
    collisionPublication.mockRestore();
    await unlink(destinationPath);

    await link(protectedPath, destinationPath);
    internals.managedNativeIdentities.delete(protectedPath);
    const residue: string[] = [];
    await expect(
      internals.releaseProtectedGuard(
        'manual-release',
        protectedPath,
        protectedPath,
        destinationPath,
        expectedHash,
        residue,
        targetDirectory
      )
    ).rejects.toThrow(/no native identity/i);
    expect(residue.join('\n')).toMatch(/no native identity/i);
    await unlink(destinationPath);

    const objectPath = path.join(internals.objectRoot, expectedHash);
    await mkdir(objectPath);
    await internals.cleanupConservationAliases(objectPath, expectedHash);
    await rm(objectPath, { recursive: true, force: true });
    await writeFile(objectPath, 'expected-content');
    await writeFile(path.join(internals.objectRoot, 'unrelated.tmp'), 'unrelated');
    const aliasPath = path.join(internals.objectRoot, `.${expectedHash}.manual.tmp`);
    await link(objectPath, aliasPath);
    await internals.cleanupConservationAliases(objectPath, expectedHash);
    await expect(lstat(aliasPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(objectPath, 'utf8')).toBe('expected-content');

    const secondAlias = path.join(internals.objectRoot, `.${expectedHash}.second.tmp`);
    await link(objectPath, secondAlias);
    expect(await internals.singleLinkedRegularFileHash(objectPath)).toBeUndefined();
    await unlink(secondAlias);
    await core.close();
  });

  it('fails closed across static core-lock owner and residue boundaries', async () => {
    const lockPath = path.join(root, 'standalone-core.lock');
    const statics = TransactionalFileCore as unknown as {
      readCoreLockSnapshot(
        lockPath: string
      ): Promise<{ pid: number; token: string; dev: bigint; ino: bigint } | undefined>;
      repairCoreLockPublicationAliases(lockPath: string): Promise<void>;
      restoreCoreLockQuarantine(lockPath: string): Promise<void>;
      releaseCoreLock(lockPath: string, token: string): Promise<void>;
      processIsAlive(pid: number): boolean;
    };

    await expect(statics.readCoreLockSnapshot(lockPath)).resolves.toBeUndefined();
    await statics.repairCoreLockPublicationAliases(lockPath);
    await statics.releaseCoreLock(lockPath, 'missing');

    await Promise.all([
      writeFile(`${lockPath}.reclaim.99999998.first`, 'first'),
      writeFile(`${lockPath}.reclaim.99999997.second`, 'second'),
    ]);
    await expect(statics.restoreCoreLockQuarantine(lockPath)).rejects.toThrow(/ambiguous/i);

    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }) as typeof process.kill);
    expect(statics.processIsAlive(12345)).toBe(true);
    killSpy.mockImplementation((() => {
      const error = new Error('unexpected owner probe failure') as NodeJS.ErrnoException;
      error.code = 'EINVAL';
      throw error;
    }) as typeof process.kill);
    expect(() => statics.processIsAlive(12345)).toThrow(/unexpected owner probe failure/i);
    killSpy.mockRestore();
  });

  it('durably conserves 1,000 same-name inputs and every hash across an injected post-commit failure', async () => {
    const core = await createCore(destinationRoot, {
      failureInjector: (point, context) => {
        if (point === 'after-commit' && context.sourcePath.includes(`${path.sep}0500${path.sep}`)) {
          throw new Error('injected conservation failure');
        }
      },
    });
    const inputs = await Promise.all(
      Array.from({ length: 1000 }, async (_, index) => {
        const directory = path.join(sourceRoot, index.toString().padStart(4, '0'));
        await mkdir(directory);
        const sourcePath = path.join(directory, 'same.jpg');
        const content = `content-${index.toString().padStart(4, '0')}`;
        await writeFile(sourcePath, content);
        return { sourcePath, content };
      })
    );

    const results = await Promise.all(
      inputs.map(({ sourcePath }) => core.execute({ sourcePath, targetFilename: 'same.jpg' }))
    );

    expect(new Set(results.map((result) => result.destinationPath)).size).toBe(1000);
    expect(results.filter((result) => result.status === 'copied')).toHaveLength(999);
    expect(results.filter((result) => result.status === 'failed' && result.committed)).toHaveLength(
      1
    );
    const outputs = await Promise.all(
      results.map((result) => readFile(result.destinationPath!, 'utf8'))
    );
    expect(new Set(outputs)).toEqual(new Set(inputs.map(({ content }) => content)));
    const expectedHashes = await Promise.all(inputs.map(({ sourcePath }) => hashFile(sourcePath)));
    expect(results.map((result) => result.hash).sort()).toEqual(expectedHashes.sort());
    expect(results.every((result) => result.sourceRetained)).toBe(true);
    expect(
      await Promise.all(inputs.map(({ sourcePath }) => readFile(sourcePath, 'utf8')))
    ).toHaveLength(1000);
    expect(await core.getLedger()).toMatchObject({ completed: 999, committedSourceRetained: 1 });
    await core.close();
  }, 360_000);

  it('durably conserves 1,000 same-name moves across one injected post-commit fault', async () => {
    const core = await createCore(destinationRoot, {
      failureInjector: (point, context) => {
        if (point === 'after-commit' && context.sourcePath.includes(`${path.sep}0500${path.sep}`)) {
          throw new Error('injected move conservation fault');
        }
      },
    });
    const inputs = await Promise.all(
      Array.from({ length: 1000 }, async (_, index) => {
        const directory = path.join(sourceRoot, index.toString().padStart(4, '0'));
        await mkdir(directory);
        const sourcePath = path.join(directory, 'same-move.jpg');
        const content = `move-content-${index.toString().padStart(4, '0')}`;
        await writeFile(sourcePath, content);
        return { sourcePath, content };
      })
    );

    const results = await Promise.all(
      inputs.map(({ sourcePath }) =>
        core.execute({ sourcePath, targetFilename: 'same-move.jpg', mode: 'move' })
      )
    );

    expect(results.filter((result) => result.status === 'moved')).toHaveLength(999);
    expect(results.filter((result) => result.status === 'failed' && result.committed)).toHaveLength(
      1
    );
    expect(new Set(results.map((result) => result.destinationPath)).size).toBe(1000);
    const outputs = await Promise.all(
      results.map((result) => readFile(result.destinationPath!, 'utf8'))
    );
    expect(new Set(outputs)).toEqual(new Set(inputs.map(({ content }) => content)));
    const retainedSources = await Promise.all(
      inputs.map(({ sourcePath }) => readFile(sourcePath, 'utf8').catch(() => undefined))
    );
    expect(retainedSources.filter((content) => content !== undefined)).toEqual([
      'move-content-0500',
    ]);
    expect(await core.getLedger()).toMatchObject({ moved: 999, committedSourceRetained: 1 });
    await core.close();
  }, 360_000);

  // --- Same-filesystem rename fast path tests ---

  function workingRenameNoReplace(): NativeTransactionFilesystemClient['renameNoReplace'] {
    return async (request) => {
      const sourcePath = capabilityPath(request.source);
      const targetPath = capabilityPath(request.target);
      const exists = await lstat(targetPath)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        throw new NativeFilesystemHelperClientError(
          'target-exists',
          'precondition',
          'not-applied',
          false,
          'target already exists'
        );
      }
      const before = await nativeIdentity(sourcePath);
      await rename(sourcePath, targetPath);
      const after = await nativeIdentity(targetPath);
      return {
        outcome: 'applied',
        before,
        after,
        durability: { file: 'not-applicable', parents: ['synced'] },
      };
    };
  }

  it('uses rename fast path for same-filesystem move without staging or hashing', async () => {
    const sourcePath = await source('rename-fast.mov', 'fast-move-content');
    const beforeStats = await lstat(sourcePath, { bigint: true });
    const beforeDev = beforeStats.dev;
    const beforeIno = beforeStats.ino;
    let stageCopyCalled = false;
    const ns = nativeFilesystem(undefined, undefined, {
      renameNoReplace: workingRenameNoReplace(),
      stageCopy: async (request) => {
        stageCopyCalled = true;
        const src = capabilityPath(request.source);
        const tgt = capabilityPath(request.target);
        await copyFile(src, tgt, 1);
        const sha256 = await hashFile(tgt);
        return {
          outcome: 'applied',
          before: await nativeIdentity(src),
          after: await nativeIdentity(tgt),
          sha256,
          durability: { file: 'synced', parents: ['synced'] },
        };
      },
    });
    const core = await TransactionalFileCore.create(destinationRoot, { nativeFilesystem: ns });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'rename-fast-target.mov',
      mode: 'move',
    });

    expect(result.status).toBe('moved');
    expect(result.committed).toBe(true);
    expect(result.sourceRetained).toBe(false);
    expect(result.hash).toBeUndefined();
    expect(stageCopyCalled).toBe(false);
    // Source should be gone
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    // Destination should exist with same inode
    const afterStats = await lstat(result.destinationPath!, { bigint: true });
    expect(afterStats.dev).toBe(beforeDev);
    expect(afterStats.ino).toBe(beforeIno);
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('fast-move-content');

    // Journal should have planned, reserved, committed, completed but no staged/verified/source-deleted
    const records = (
      await readFile(path.join(destinationRoot, '.meta-mover', 'transactions.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((r: { operationId: string }) => r.operationId === result.operationId);
    const states = records.map((r: { state: string }) => r.state);
    expect(states).toEqual(['planned', 'reserved', 'committed', 'completed']);
    expect(records.every((r: { mode: string }) => r.mode === 'move')).toBe(true);
    // No hash in any record
    expect(records.every((r: { hash?: string }) => r.hash === undefined)).toBe(true);
    // Completed record should have sourceRetained: false
    const completed = records.find((r: { state: string }) => r.state === 'completed');
    expect(completed.sourceRetained).toBe(false);

    await core.close();
  });

  it('takes the verified staged path when expectedSha256 is supplied for a same-filesystem move', async () => {
    const sourcePath = await source('hash-gated.mov', 'gated-content');
    const expectedSha256 = await hashFile(sourcePath);
    const core = await createCore(destinationRoot);

    const result = await core.execute({
      sourcePath,
      targetFilename: 'hash-gated-target.mov',
      mode: 'move',
      expectedSha256,
    });

    expect(result.status).toBe('moved');
    expect(result.committed).toBe(true);
    expect(result.sourceRetained).toBe(false);
    expect(result.hash).toBe(expectedSha256);
    // Source should be gone
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    // Journal should have staged and verified records (full path)
    const records = (
      await readFile(path.join(destinationRoot, '.meta-mover', 'transactions.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((r: { operationId: string }) => r.operationId === result.operationId);
    const states = records.map((r: { state: string }) => r.state);
    expect(states).toContain('staged');
    expect(states).toContain('verified');
    await core.close();
  });

  it('falls back to staged copy when rename returns a cross-device error', async () => {
    const sourcePath = await source('cross-device.mov', 'cross-device-content');
    let renameCallCount = 0;
    const ns = nativeFilesystem(undefined, undefined, {
      renameNoReplace: async () => {
        renameCallCount++;
        throw new NativeFilesystemHelperClientError(
          'cross-device',
          'precondition',
          'not-applied',
          false,
          'cross-device rename not supported'
        );
      },
    });
    const core = await TransactionalFileCore.create(destinationRoot, { nativeFilesystem: ns });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'cross-device-target.mov',
      mode: 'move',
    });

    expect(renameCallCount).toBeGreaterThan(0);
    expect(result.status).toBe('moved');
    expect(result.committed).toBe(true);
    expect(result.sourceRetained).toBe(false);
    // Hash should be present since it took the staged path
    expect(result.hash).toBeDefined();
    expect(result.hash).toHaveLength(64);
    // Source should be gone
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('cross-device-content');
    // Journal should contain staged records
    const records = (
      await readFile(path.join(destinationRoot, '.meta-mover', 'transactions.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((r: { operationId: string }) => r.operationId === result.operationId);
    const states = records.map((r: { state: string }) => r.state);
    expect(states).toContain('staged');
    expect(states).toContain('source-deleted');
    await core.close();
  });

  it('rejects exact-no-clobber collision on the rename fast path with source untouched', async () => {
    const sourcePath = await source('collision-fast.mov', 'collision-content');
    const destinationPath = path.join(destinationRoot, 'collision-fast-target.mov');
    // Pre-create the exact destination
    await writeFile(destinationPath, 'existing-occupant');
    const ns = nativeFilesystem(undefined, undefined, {
      renameNoReplace: workingRenameNoReplace(),
    });
    const core = await TransactionalFileCore.create(destinationRoot, { nativeFilesystem: ns });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'collision-fast-target.mov',
      expectedDestinationPath: destinationPath,
      collisionMode: 'exact-no-clobber',
      mode: 'move',
    });

    expect(result.status).toBe('failed');
    expect(result.committed).toBe(false);
    expect(result.error).toMatch(/exact preview target/i);
    // Source must be untouched
    expect(await readFile(sourcePath, 'utf8')).toBe('collision-content');
    // The pre-existing destination must be untouched
    expect(await readFile(destinationPath, 'utf8')).toBe('existing-occupant');
    await core.close();
  });

  it('copy on the same filesystem still uses staged path with hash', async () => {
    const sourcePath = await source('copy-same-fs.mov', 'copy-content');
    let renameCalled = false;
    const ns = nativeFilesystem(undefined, undefined, {
      renameNoReplace: async () => {
        renameCalled = true;
        throw new Error('rename should not be called for copy mode');
      },
    });
    const core = await TransactionalFileCore.create(destinationRoot, { nativeFilesystem: ns });

    const result = await core.execute({
      sourcePath,
      targetFilename: 'copy-same-fs-target.mov',
      mode: 'copy',
    });

    expect(result.status).toBe('copied');
    expect(result.committed).toBe(true);
    expect(result.sourceRetained).toBe(true);
    expect(result.hash).toBeDefined();
    expect(renameCalled).toBe(false);
    expect(await readFile(sourcePath, 'utf8')).toBe('copy-content');
    expect(await readFile(result.destinationPath!, 'utf8')).toBe('copy-content');
    await core.close();
  });
});
