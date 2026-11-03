const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// This repository uses separate installs, not package-manager workspaces.
// Make shared contracts and the package-free calendar utilities visible while
// keeping the web and native dependency trees and React versions separate.
config.watchFolders = [path.resolve(__dirname, '../shared'), path.resolve(__dirname, '../lib')];
// Native rebuilds generate thousands of files which Metro must not crawl or watch.
// Match absolute Windows/POSIX paths, including native builds inside dependencies.
const defaults = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(defaults) ? defaults : defaults ? [defaults] : []),
  /(?:^|[/\\])android[/\\](?:build|\.gradle|\.cxx|app[/\\](?:build|\.cxx))(?:[/\\]|$)/,
  /(?:^|[/\\])ios[/\\](?:build|Pods)(?:[/\\]|$)/,
];
module.exports = config;
