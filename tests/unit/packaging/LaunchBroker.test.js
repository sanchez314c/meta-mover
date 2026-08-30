const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseBrokerIdentityLine,
  probeLaunchBrokerRelay,
} = require('../../../scripts/build-launch-broker');

describe('native launch broker', () => {
  const helperSha256 = 'a'.repeat(64);
  const identity = {
    brokerBuild: '0.1.0',
    brokerTarget: 'x86_64-unknown-linux-musl',
    helperSha256,
    helperProtocol: 1,
    helperBuild: '0.1.0',
    helperTarget: 'linux-x64',
    releaseSigner: null,
  };

  test('accepts only the exact newline-terminated compiled identity schema', () => {
    expect(parseBrokerIdentityLine(Buffer.from(`${JSON.stringify(identity)}\n`))).toEqual(identity);
    expect(() =>
      parseBrokerIdentityLine(Buffer.from(`${JSON.stringify({ ...identity, unknown: true })}\n`))
    ).toThrow(/unknown|identity/i);
    expect(() =>
      parseBrokerIdentityLine(
        Buffer.from(
          `{"brokerBuild":"0.1.0","brokerBuild":"0.1.0","brokerTarget":"x86_64-unknown-linux-musl","helperSha256":"${helperSha256}","helperProtocol":1,"helperBuild":"0.1.0","helperTarget":"linux-x64","releaseSigner":null}\n`
        )
      )
    ).toThrow(/duplicate/i);
    expect(() => parseBrokerIdentityLine(Buffer.from(JSON.stringify(identity)))).toThrow(
      /newline/i
    );
  });

  test('relays the helper hello frame without adding broker stdout', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-mover-broker-relay-'));
    const broker = path.join(root, 'meta-mover-launch-broker');
    const helperTarget =
      process.platform === 'darwin'
        ? `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-apple-darwin`
        : `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-unknown-linux-musl`;
    const response = {
      v: 1,
      id: '00000000-0000-4000-8000-000000000001',
      ok: true,
      result: {
        outcome: 'applied',
        protocol: 1,
        build: '0.1.0',
        target: helperTarget,
        features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
      },
    };
    fs.writeFileSync(
      broker,
      `#!/bin/sh\nread request\nprintf '%s\\n' '${JSON.stringify(response)}'\n`,
      { mode: 0o755 }
    );
    await expect(
      probeLaunchBrokerRelay(broker, { platform: process.platform, arch: process.arch })
    ).resolves.toMatchObject({ protocol: 1, build: '0.1.0', target: helperTarget });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
