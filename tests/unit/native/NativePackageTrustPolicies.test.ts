import path from 'path';

import {
  MacOSAuthenticatedBrokerLaunchTrustPolicy,
  WINDOWS_PACKAGE_ATTESTATION,
  WindowsAuthenticatedBrokerLaunchTrustPolicy,
  verifyMacOSPackage,
} from '../../../src/main/native/NativePackageTrustPolicies';
import type { VerifiedHelperLaunchDescriptor } from '../../../src/main/native/NativeFilesystemHelperClient';

function descriptor(
  platform: NodeJS.Platform,
  canonicalPath: string,
  releaseSigner = platform === 'darwin'
    ? 'mac-team:ABCDE12345'
    : platform === 'win32'
      ? `win-cert-sha256:${'c'.repeat(64)}`
      : null
): VerifiedHelperLaunchDescriptor {
  return {
    canonicalPath,
    manifestPath: canonicalPath,
    platform,
    architecture: 'x64',
    electronTarget: `${platform}-x64`,
    sha256: 'a'.repeat(64),
    protocolVersion: 1,
    buildVersion: '0.1.0',
    helperSha256: 'b'.repeat(64),
    helperBuildVersion: '0.1.0',
    releaseSigner,
    verifiedFileDescriptor: 41,
  };
}

describe('native package launch trust policies', () => {
  test('macOS reads TeamIdentifier from signature display after independent verification', async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'valid on disk\nsatisfies its Designated Requirement\n',
      })
      .mockResolvedValueOnce({ stdout: '', stderr: 'accepted\n' })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'Identifier=com.speedheathens.metamover\nTeamIdentifier=ABCDE12345\n',
      });
    await expect(verifyMacOSPackage('/Applications/META Mover.app', run)).resolves.toBe(
      'mac-team:ABCDE12345'
    );
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['--verify', '--deep', '--strict', '--verbose=4', '/Applications/META Mover.app'],
      ['--assess', '--type', 'execute', '--verbose=4', '/Applications/META Mover.app'],
      ['--display', '--verbose=4', '/Applications/META Mover.app'],
    ]);
  });

  test('macOS accepts only a signed, assessed, root-protected /Applications bundle', async () => {
    const broker =
      '/Applications/META Mover.app/Contents/Resources/tools/launch-broker/darwin-x64/meta-mover-launch-broker';
    const verifyPackage = jest.fn().mockResolvedValue('mac-team:ABCDE12345');
    const policy = new MacOSAuthenticatedBrokerLaunchTrustPolicy({
      canonicalPath: jest.fn(async (candidate) => candidate),
      pathState: jest.fn(async (candidate) => ({
        uid: 0,
        mode: candidate === broker ? 0o100555 : 0o40555,
        isFile: () => candidate === broker,
        isDirectory: () => candidate !== broker,
        isSymbolicLink: () => false,
      })),
      verifyPackage,
      currentUid: () => 501,
    });

    await expect(policy.acquire(descriptor('darwin', broker))).resolves.toMatchObject({
      mechanism: 'authenticated-package',
      executablePath: '/dev/fd/3',
      inheritedFileDescriptor: 41,
      authority: 'macos-codesign-gatekeeper',
    });
    expect(verifyPackage).toHaveBeenCalledWith('/Applications/META Mover.app');
  });

  test.each([
    ['mutable chain', 502, 0o40775, false],
    ['root execution', 0, 0o40555, false],
    ['symlink', 502, 0o40555, true],
  ])('macOS rejects %s', async (_label, uid, mode, symbolic) => {
    const broker =
      '/Applications/META Mover.app/Contents/Resources/tools/launch-broker/darwin-x64/meta-mover-launch-broker';
    const policy = new MacOSAuthenticatedBrokerLaunchTrustPolicy({
      canonicalPath: jest.fn(async (candidate) => candidate),
      pathState: jest.fn(async (candidate) => ({
        uid: 0,
        mode,
        isFile: () => candidate === broker,
        isDirectory: () => candidate !== broker,
        isSymbolicLink: () => symbolic,
      })),
      verifyPackage: jest.fn().mockResolvedValue('mac-team:ABCDE12345'),
      currentUid: () => uid,
    });
    await expect(policy.acquire(descriptor('darwin', broker))).rejects.toThrow(
      /root|protected|symlink/i
    );
  });

  test('Windows accepts only an Authenticode-valid non-elevated Program Files package', async () => {
    const broker = String.raw`C:\Program Files\META Mover\resources\tools\launch-broker\win32-x64\meta-mover-launch-broker.exe`;
    const verifyPackage = jest.fn().mockResolvedValue(undefined);
    const policy = new WindowsAuthenticatedBrokerLaunchTrustPolicy({
      canonicalPath: jest.fn(async (candidate) => path.win32.normalize(candidate)),
      programFilesRoots: () => [String.raw`C:\Program Files`],
      verifyPackage,
    });
    await expect(policy.acquire(descriptor('win32', broker))).resolves.toMatchObject({
      mechanism: 'authenticated-package',
      executablePath: broker,
      authority: 'windows-authenticode-program-files',
    });
    expect(verifyPackage).toHaveBeenCalledWith(broker, `win-cert-sha256:${'c'.repeat(64)}`);
  });

  test('Windows rejects a broker outside Program Files or a failed package attestation', async () => {
    const outside = String.raw`C:\Users\Jason\META Mover\resources\tools\launch-broker\win32-x64\meta-mover-launch-broker.exe`;
    const system = {
      canonicalPath: jest.fn(async (candidate: string) => path.win32.normalize(candidate)),
      programFilesRoots: () => [String.raw`C:\Program Files`],
      verifyPackage: jest.fn().mockResolvedValue(undefined),
    };
    await expect(
      new WindowsAuthenticatedBrokerLaunchTrustPolicy(system).acquire(descriptor('win32', outside))
    ).rejects.toThrow(/Program Files/i);

    const inside = String.raw`C:\Program Files\META Mover\resources\tools\launch-broker\win32-x64\meta-mover-launch-broker.exe`;
    system.verifyPackage.mockRejectedValueOnce(new Error('signature invalid'));
    await expect(
      new WindowsAuthenticatedBrokerLaunchTrustPolicy(system).acquire(descriptor('win32', inside))
    ).rejects.toThrow(/signature invalid/i);
  });

  test('Windows attestation fails closed on sharing violations and accepts only access denied', () => {
    expect(WINDOWS_PACKAGE_ATTESTATION).toContain('catch [UnauthorizedAccessException]');
    expect(WINDOWS_PACKAGE_ATTESTATION).not.toContain('catch [IO.IOException]');
  });
});
