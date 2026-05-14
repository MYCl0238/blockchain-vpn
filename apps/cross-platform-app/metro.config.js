const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const bridgeRoot = path.resolve(projectRoot, '../../mobile');

const config = getDefaultConfig(projectRoot);

// The local @blockchain-vpn/mobile-bridge package is consumed via npm's
// file: protocol, which symlinks into node_modules. Metro doesn't traverse
// symlinks by default, so we add the bridge as an explicit watch root and
// expose its real path for resolution.
config.watchFolders = [...(config.watchFolders ?? []), bridgeRoot];
config.resolver.unstable_enableSymlinks = true;
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(bridgeRoot, 'node_modules'),
];

module.exports = config;
