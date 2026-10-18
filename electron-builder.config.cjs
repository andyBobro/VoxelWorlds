// Unsigned/ad-hoc by default. Provide CSC_LINK (+ CSC_KEY_PASSWORD) for a real identity and
// APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID to notarize.
const hasCert = !!(process.env.CSC_LINK || process.env.CSC_NAME);
const notarize = !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

module.exports = {
  appId: 'app.voxelworlds.desktop',
  productName: 'VoxelWorlds',
  directories: { output: 'release', buildResources: 'build' },
  asar: true,
  files: ['out/**', 'package.json'],
  extraResources: [
    { from: 'python/voxelworlds', to: 'python/voxelworlds', filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'] },
    // VOXEL_BUNDLE_TARGET=win selects the Windows runtime built by scripts/bundle-python.mjs
    { from: process.env.VOXEL_BUNDLE_TARGET === 'win' ? 'build/python-runtime-win' : 'build/python-runtime', to: 'python-runtime' },
  ],
  mac: {
    category: 'public.app-category.graphics-design',
    icon: 'build/icon.icns',
    target: ['dmg', 'zip'],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    identity: hasCert ? undefined : '-',
    notarize,
  },
  dmg: { sign: false },
  // Windows x64, unsigned (set WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD to sign). SmartScreen will warn when unsigned.
  win: {
    icon: 'build/icon.png',
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
    signAndEditExecutable: false,
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, artifactName: '${productName}-Setup-${version}-${arch}.${ext}' },
  artifactName: '${productName}-${version}-${arch}.${ext}',
};
