import path from 'path';

import {
  NativeFilesystemCapabilityPath,
  NativeFilesystemIdentity,
  NativeFilesystemOperationResult,
  ReconcileSourceDeleteResult,
} from '../../../src/main/native/NativeFilesystemHelperClient';
import {
  NativeTransactionFilesystem,
  NativeTransactionFilesystemClient,
} from '../../../src/main/core/transaction/NativeTransactionFilesystem';

const IDENTITY: NativeFilesystemIdentity = {
  kind: 'unix',
  device: '1',
  inode: '2',
  links: '1',
  size: '3',
  mtimeNs: '4',
};

const APPLIED: NativeFilesystemOperationResult = {
  outcome: 'applied',
  after: IDENTITY,
  durability: { file: 'synced', parents: ['synced'] },
};

function client(): jest.Mocked<NativeTransactionFilesystemClient> {
  return {
    ensureDirChain: jest.fn(async () => APPLIED),
    stageCopy: jest.fn(async () => ({ ...APPLIED, before: IDENTITY, sha256: 'a'.repeat(64) })),
    writeMarkerNew: jest.fn(async () => APPLIED),
    hardLinkNoReplace: jest.fn(async () => ({ ...APPLIED, before: IDENTITY })),
    removeManagedExact: jest.fn(async () => APPLIED),
    deleteSourceExact: jest.fn(async (request) => ({
      outcome: 'applied',
      state: 'deleted',
      sourceState: 'absent',
      quarantineState: 'entry-deleted',
      receiptState: 'created',
      deleteId: request.deleteId,
      durability: { file: 'synced', parents: ['synced', 'synced', 'synced'] },
    })),
    reconcileSourceDelete: jest.fn(
      async (request): Promise<ReconcileSourceDeleteResult> => ({
        outcome: 'not-applied',
        state: 'source-retained',
        sourceState: 'expected',
        quarantineState: 'absent',
        receiptState: 'absent',
        deleteId: request.deleteId,
        durability: { file: 'not-applicable', parents: [] },
      })
    ),
    close: jest.fn(async () => undefined),
  };
}

describe('NativeTransactionFilesystem', () => {
  const destinationRoot = path.resolve('/destination');
  const controlRoot = path.join(destinationRoot, '.meta-mover');
  const sourceRoot = path.resolve('/sources');

  it('maps only canonical contained paths to stable retained capabilities', () => {
    const port = new NativeTransactionFilesystem(client(), destinationRoot, controlRoot, [
      sourceRoot,
      path.join(sourceRoot, 'nested'),
    ]);

    expect(port.sourcePath(path.join(sourceRoot, 'nested', 'photo.jpg'))).toEqual({
      root: 'source_1',
      components: ['photo.jpg'],
    });
    expect(port.destinationPath(path.join(destinationRoot, '2024', '05', 'photo.jpg'))).toEqual({
      root: 'destination',
      components: ['2024', '05', 'photo.jpg'],
    });
    expect(port.controlPath(path.join(controlRoot, 'staging', 'op.part'))).toEqual({
      root: 'control',
      components: ['staging', 'op.part'],
    });
  });

  it('emits stable helper root bindings in caller source-root order', () => {
    expect(
      NativeTransactionFilesystem.rootBindings(destinationRoot, controlRoot, [
        path.join(sourceRoot, 'nested'),
        sourceRoot,
      ])
    ).toEqual([
      { name: 'destination', kind: 'destination', absolutePath: destinationRoot },
      { name: 'control', kind: 'control', absolutePath: controlRoot },
      { name: 'source_0', kind: 'source', absolutePath: path.join(sourceRoot, 'nested') },
      { name: 'source_1', kind: 'source', absolutePath: sourceRoot },
    ]);
  });

  it.each([
    [
      'source escape',
      () =>
        new NativeTransactionFilesystem(client(), destinationRoot, controlRoot, [
          sourceRoot,
        ]).sourcePath(path.resolve('/other/file')),
    ],
    [
      'destination control path',
      () =>
        new NativeTransactionFilesystem(client(), destinationRoot, controlRoot, [
          sourceRoot,
        ]).destinationPath(path.join(controlRoot, 'staging', 'bad')),
    ],
    [
      'noncanonical path',
      () =>
        new NativeTransactionFilesystem(client(), destinationRoot, controlRoot, [
          sourceRoot,
        ]).sourcePath(`${sourceRoot}${path.sep}nested${path.sep}..${path.sep}photo.jpg`),
    ],
  ])('rejects %s before calling the helper', (_label, action) => {
    expect(action).toThrow();
  });

  it.each([
    [
      'a control root outside the destination',
      () =>
        new NativeTransactionFilesystem(
          client(),
          destinationRoot,
          path.resolve('/other/.meta-mover'),
          [sourceRoot]
        ),
    ],
    [
      'an empty source-root set',
      () => new NativeTransactionFilesystem(client(), destinationRoot, controlRoot, []),
    ],
    [
      'a relative source capability root',
      () =>
        new NativeTransactionFilesystem(client(), destinationRoot, controlRoot, [
          'relative-source',
        ]),
    ],
  ])('rejects %s while binding retained roots', (_label, action) => {
    expect(action).toThrow();
  });

  it('rejects destination and control paths outside their retained capabilities', () => {
    const port = new NativeTransactionFilesystem(client(), destinationRoot, controlRoot, [
      sourceRoot,
    ]);

    expect(() => port.destinationPath(path.resolve('/other/destination.jpg'))).toThrow(
      /outside the retained destination/i
    );
    expect(() => port.controlPath(path.resolve('/other/control.file'))).toThrow(
      /outside the retained control/i
    );
  });

  it('rejects an unsafe component even after a caller reaches the capability builder', () => {
    const port = new NativeTransactionFilesystem(client(), destinationRoot, controlRoot, [
      sourceRoot,
    ]);
    const capability = port as unknown as {
      capability(
        root: string,
        rootPath: string,
        absolutePath: string
      ): NativeFilesystemCapabilityPath;
    };

    expect(() => capability.capability('source_0', sourceRoot, sourceRoot)).toThrow(
      /unsafe component/i
    );
  });

  it('passes delete ID, immutable receipt, complete identity, and hash unchanged', async () => {
    const nativeClient = client();
    const port = new NativeTransactionFilesystem(nativeClient, destinationRoot, controlRoot, [
      sourceRoot,
    ]);
    const source = path.join(sourceRoot, 'photo.jpg');
    const receipt = path.join(controlRoot, 'delete-receipts', 'delete.json');
    const deleteId = '00000000-0000-4000-8000-000000000031';

    await port.deleteSourceExact(source, IDENTITY, 'a'.repeat(64), deleteId, receipt);

    expect(nativeClient.deleteSourceExact).toHaveBeenCalledWith({
      source: { root: 'source_0', components: ['photo.jpg'] },
      expected: IDENTITY,
      expectedSha256: 'a'.repeat(64),
      deleteId,
      receipt: { root: 'control', components: ['delete-receipts', 'delete.json'] },
    });
  });

  it('maps and forwards every namespace mutation through retained capabilities', async () => {
    const nativeClient = client();
    const port = new NativeTransactionFilesystem(nativeClient, destinationRoot, controlRoot, [
      sourceRoot,
    ]);
    const signal = new AbortController().signal;
    const source = path.join(sourceRoot, 'photo.jpg');
    const destinationDirectory = path.join(destinationRoot, '2024');
    const staging = path.join(controlRoot, 'staging', 'operation.part');
    const marker = path.join(controlRoot, 'reservations', 'operation.json');
    const final = path.join(destinationDirectory, 'photo.jpg');

    await port.ensureDestinationDirectory(destinationDirectory, signal);
    await port.ensureControlDirectory(path.join(controlRoot, 'staging'), signal);
    await port.stageCopy(source, staging, 'a'.repeat(64), signal, IDENTITY);
    await port.writeMarkerNew(marker, '{}', signal);
    await port.hardLinkNoReplace(staging, final, IDENTITY, signal);
    await port.removeManagedExact(staging, IDENTITY, signal);

    expect(nativeClient.ensureDirChain).toHaveBeenNthCalledWith(
      1,
      { root: 'destination', components: ['2024'] },
      signal
    );
    expect(nativeClient.ensureDirChain).toHaveBeenNthCalledWith(
      2,
      { root: 'control', components: ['staging'] },
      signal
    );
    expect(nativeClient.stageCopy).toHaveBeenCalledWith(
      {
        source: { root: 'source_0', components: ['photo.jpg'] },
        target: { root: 'control', components: ['staging', 'operation.part'] },
        expected: IDENTITY,
        expectedSha256: 'a'.repeat(64),
      },
      signal
    );
    expect(nativeClient.writeMarkerNew).toHaveBeenCalledWith(
      { root: 'control', components: ['reservations', 'operation.json'] },
      '{}',
      signal
    );
    expect(nativeClient.hardLinkNoReplace).toHaveBeenCalledWith(
      {
        source: { root: 'control', components: ['staging', 'operation.part'] },
        target: { root: 'destination', components: ['2024', 'photo.jpg'] },
        expected: IDENTITY,
      },
      signal
    );
    expect(nativeClient.removeManagedExact).toHaveBeenCalledWith(
      {
        path: { root: 'control', components: ['staging', 'operation.part'] },
        expected: IDENTITY,
      },
      signal
    );
  });

  it('forwards cancellation signals to delete and reconciliation requests', async () => {
    const nativeClient = client();
    const port = new NativeTransactionFilesystem(nativeClient, destinationRoot, controlRoot, [
      sourceRoot,
    ]);
    const source = path.join(sourceRoot, 'photo.jpg');
    const receipt = path.join(controlRoot, 'delete-receipts', 'delete.json');
    const deleteId = '00000000-0000-4000-8000-000000000031';
    const signal = new AbortController().signal;

    await port.deleteSourceExact(source, IDENTITY, 'a'.repeat(64), deleteId, receipt, signal);
    await port.reconcileSourceDelete(source, IDENTITY, 'a'.repeat(64), deleteId, receipt, signal);

    expect(nativeClient.deleteSourceExact).toHaveBeenCalledWith(expect.any(Object), signal);
    expect(nativeClient.reconcileSourceDelete).toHaveBeenCalledWith(expect.any(Object), signal);
  });

  it('owns and closes the helper client exactly once', async () => {
    const nativeClient = client();
    const port = new NativeTransactionFilesystem(nativeClient, destinationRoot, controlRoot, [
      sourceRoot,
    ]);

    await Promise.all([port.close(), port.close()]);

    expect(nativeClient.close).toHaveBeenCalledTimes(1);
  });
});
