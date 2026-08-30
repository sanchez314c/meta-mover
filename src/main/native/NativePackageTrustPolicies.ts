import { execFile } from 'child_process';
import { lstat, realpath } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import type {
  BrokerLaunchTrustPolicy,
  VerifiedHelperLaunchDescriptor,
  VerifiedHelperLaunchLease,
} from './NativeFilesystemHelperClient';

const executeFile = promisify(execFile);

export interface MacOSPackagePathState {
  uid: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface MacOSPackageTrustSystem {
  canonicalPath(candidate: string): Promise<string>;
  pathState(candidate: string): Promise<MacOSPackagePathState>;
  verifyPackage(appBundle: string): Promise<string>;
  currentUid(): number | undefined;
}

export interface WindowsPackageTrustSystem {
  canonicalPath(candidate: string): Promise<string>;
  programFilesRoots(): readonly string[];
  verifyPackage(brokerPath: string, expectedSigner: string): Promise<void>;
}

function isWithin(
  pathApi: typeof path.posix | typeof path.win32,
  root: string,
  value: string
): boolean {
  const relative = pathApi.relative(root, value);
  return (
    relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)
  );
}

function macOSBundleRoot(brokerPath: string, target: string): string {
  const components = brokerPath.split('/').filter(Boolean);
  const expectedTail = [
    'Contents',
    'Resources',
    'tools',
    'launch-broker',
    target,
    'meta-mover-launch-broker',
  ];
  if (
    components.length !== expectedTail.length + 2 ||
    components[0] !== 'Applications' ||
    !components[1].endsWith('.app') ||
    expectedTail.some((component, index) => components[index + 2] !== component)
  ) {
    throw new Error('Launch broker is outside the canonical /Applications app bundle layout');
  }
  return `/${components.slice(0, 2).join('/')}`;
}

type PackageCommandRunner = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ encoding: 'utf8'; maxBuffer: number }>
) => Promise<{ stdout: string; stderr: string }>;

export async function verifyMacOSPackage(
  appBundle: string,
  run: PackageCommandRunner = executeFile as PackageCommandRunner
): Promise<string> {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appBundle], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appBundle], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const signature = await run('/usr/bin/codesign', ['--display', '--verbose=4', appBundle], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const teamIdentifier = `${signature.stdout}\n${signature.stderr}`.match(
    /(?:^|\n)TeamIdentifier=([A-Z0-9]{10})(?:\n|$)/
  )?.[1];
  if (!teamIdentifier) throw new Error('macOS signature has no canonical TeamIdentifier');
  return `mac-team:${teamIdentifier}`;
}

const DEFAULT_MACOS_SYSTEM: MacOSPackageTrustSystem = {
  canonicalPath: (candidate) => realpath(candidate),
  pathState: (candidate) => lstat(candidate),
  verifyPackage: verifyMacOSPackage,
  currentUid: () => process.geteuid?.(),
};

export class MacOSAuthenticatedBrokerLaunchTrustPolicy implements BrokerLaunchTrustPolicy {
  readonly mode = 'production' as const;
  readonly attestedPlatform = 'darwin' as const;

  constructor(private readonly system: MacOSPackageTrustSystem = DEFAULT_MACOS_SYSTEM) {}

  async acquire(
    descriptor: Readonly<VerifiedHelperLaunchDescriptor>
  ): Promise<VerifiedHelperLaunchLease> {
    if (descriptor.platform !== 'darwin') {
      throw new Error('macOS package trust policy cannot attest a non-macOS broker');
    }
    const uid = this.system.currentUid();
    if (!Number.isSafeInteger(uid) || Number(uid) <= 0) {
      throw new Error('Packaged broker cannot run with a root package-mutation token');
    }
    const canonicalManifest = await this.system.canonicalPath(descriptor.manifestPath);
    if (canonicalManifest !== descriptor.canonicalPath) {
      throw new Error('Launch broker package identity changed before trust attestation');
    }
    const appBundle = macOSBundleRoot(descriptor.canonicalPath, descriptor.electronTarget);
    const relative = path.posix.relative('/Applications', descriptor.canonicalPath);
    const components = relative.split('/');
    let current = '/Applications';
    for (let index = 0; index <= components.length; index += 1) {
      if (index > 0) current = path.posix.join(current, components[index - 1]);
      const state = await this.system.pathState(current);
      const final = index === components.length;
      if (
        state.isSymbolicLink() ||
        (final ? !state.isFile() : !state.isDirectory()) ||
        state.uid !== 0 ||
        (state.mode & 0o022) !== 0
      ) {
        throw new Error(
          'macOS package chain contains a symlink or is not root-owned and protected'
        );
      }
    }
    if (!/^mac-team:[A-Z0-9]{10}$/.test(descriptor.releaseSigner || '')) {
      throw new Error('macOS release broker has no pinned TeamIdentifier');
    }
    const actualSigner = await this.system.verifyPackage(appBundle);
    if (actualSigner !== descriptor.releaseSigner) {
      throw new Error('macOS package signer does not match the compiled broker identity');
    }
    return {
      mechanism: 'authenticated-package',
      executablePath: '/dev/fd/3',
      inheritedFileDescriptor: descriptor.verifiedFileDescriptor,
      authority: 'macos-codesign-gatekeeper',
      release: async () => undefined,
    };
  }
}

export const WINDOWS_PACKAGE_ATTESTATION = String.raw`
$ErrorActionPreference = 'Stop'
$candidate = $env:META_MOVER_BROKER_PATH
$expectedSigner = $env:META_MOVER_EXPECTED_SIGNER
if ([string]::IsNullOrWhiteSpace($candidate)) { throw 'Broker path is unavailable' }
if ($expectedSigner -notmatch '^win-cert-sha256:[a-f0-9]{64}$') { throw 'Expected signer is invalid' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Elevated package mutation token is forbidden'
}
$signature = Get-AuthenticodeSignature -LiteralPath $candidate
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) {
  throw ('Authenticode verification failed: ' + $signature.Status)
}
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $actualHash = ([BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha.Dispose()
}
if (('win-cert-sha256:' + $actualHash) -ne $expectedSigner) { throw 'Authenticode signer does not match compiled identity' }
try {
  $handle = [IO.File]::Open($candidate, [IO.FileMode]::Open, [IO.FileAccess]::Write, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  $handle.Dispose()
  throw 'Broker is writable by the current token'
} catch [UnauthorizedAccessException] {
}
`;

async function defaultWindowsPackageVerification(
  brokerPath: string,
  expectedSigner: string
): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('Windows SystemRoot is unavailable for Authenticode verification');
  }
  const powershell = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  await executeFile(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'AllSigned',
      '-Command',
      WINDOWS_PACKAGE_ATTESTATION,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        SystemRoot: systemRoot,
        META_MOVER_BROKER_PATH: brokerPath,
        META_MOVER_EXPECTED_SIGNER: expectedSigner,
      },
    }
  );
}

const DEFAULT_WINDOWS_SYSTEM: WindowsPackageTrustSystem = {
  canonicalPath: (candidate) => realpath(candidate),
  programFilesRoots: () =>
    [...new Set([process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean))] as string[],
  verifyPackage: defaultWindowsPackageVerification,
};

export class WindowsAuthenticatedBrokerLaunchTrustPolicy implements BrokerLaunchTrustPolicy {
  readonly mode = 'production' as const;
  readonly attestedPlatform = 'win32' as const;

  constructor(private readonly system: WindowsPackageTrustSystem = DEFAULT_WINDOWS_SYSTEM) {}

  async acquire(
    descriptor: Readonly<VerifiedHelperLaunchDescriptor>
  ): Promise<VerifiedHelperLaunchLease> {
    if (descriptor.platform !== 'win32') {
      throw new Error('Windows package trust policy cannot attest a non-Windows broker');
    }
    const canonicalManifest = path.win32.normalize(
      await this.system.canonicalPath(descriptor.manifestPath)
    );
    const canonicalBroker = path.win32.normalize(descriptor.canonicalPath);
    if (canonicalManifest.toLowerCase() !== canonicalBroker.toLowerCase()) {
      throw new Error('Launch broker package identity changed before trust attestation');
    }
    const expectedSuffix = path.win32.join(
      'resources',
      'tools',
      'launch-broker',
      descriptor.electronTarget,
      'meta-mover-launch-broker.exe'
    );
    const roots = this.system.programFilesRoots().filter(path.win32.isAbsolute);
    const protectedRoot = roots.find(
      (root) =>
        isWithin(path.win32, path.win32.normalize(root), canonicalBroker) &&
        canonicalBroker.toLowerCase().endsWith(`\\${expectedSuffix.toLowerCase()}`)
    );
    if (!protectedRoot) {
      throw new Error('Launch broker is outside the canonical Program Files package layout');
    }
    if (!/^win-cert-sha256:[a-f0-9]{64}$/.test(descriptor.releaseSigner || '')) {
      throw new Error('Windows release broker has no pinned certificate identity');
    }
    await this.system.verifyPackage(canonicalBroker, descriptor.releaseSigner!);
    return {
      mechanism: 'authenticated-package',
      executablePath: canonicalBroker,
      authority: 'windows-authenticode-program-files',
      release: async () => undefined,
    };
  }
}

export function nativePackageBrokerLaunchTrustPolicy(
  platform: NodeJS.Platform
): BrokerLaunchTrustPolicy {
  if (platform === 'darwin') return new MacOSAuthenticatedBrokerLaunchTrustPolicy();
  if (platform === 'win32') return new WindowsAuthenticatedBrokerLaunchTrustPolicy();
  throw new Error(`No native authenticated package trust policy exists for ${platform}`);
}
