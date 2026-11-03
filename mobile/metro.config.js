const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Shared contracts are deliberately dependency-free; the web and native apps
// keep separate dependency trees and React versions.
config.watchFolders = [path.resolve(__dirname, '../shared')];
module.exports = config;
