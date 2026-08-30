const path = require('path');

const { resolveArtifactType } = require('../../../scripts/verify-native-package');

describe('native package verifier', () => {
  test('accepts only matching deb and rpm package types', () => {
    expect(resolveArtifactType('/tmp/meta.deb', 'deb')).toBe('deb');
    expect(resolveArtifactType('/tmp/meta.rpm', 'rpm')).toBe('rpm');
    expect(() => resolveArtifactType('/tmp/meta.rpm', 'deb')).toThrow(/extension/i);
    expect(() => resolveArtifactType('/tmp/meta.AppImage', 'appimage')).toThrow(/deb or rpm/i);
    expect(() => resolveArtifactType(path.resolve('/tmp/meta.deb'), undefined)).toThrow(/type/i);
  });
});
