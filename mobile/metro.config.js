const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// This repository uses separate installs, not package-manager workspaces.
// Make shared contracts and the package-free calendar utilities visible while
// keeping the web and native dependency trees and React versions separate.
config.watchFolders = [path.resolve(__dirname, '../shared'), path.resolve(__dirname, '../lib')];
module.exports = config;
