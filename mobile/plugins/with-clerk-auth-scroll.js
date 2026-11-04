const fs = require('node:fs')
const path = require('node:path')
const { withSettingsGradle } = require('expo/config-plugins')
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode')

module.exports = function withClerkAuthScroll(config) {
  return withSettingsGradle(config, result => {
    const packageFile = require.resolve('@clerk/expo-native-components/package.json', {
      paths: [result.modRequest.projectRoot],
    })
    const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version
    const bridgeBuild = fs.readFileSync(path.join(path.dirname(packageFile), 'android/build.gradle'), 'utf8')
    if (version !== '0.4.3' || !bridgeBuild.includes('clerkAndroidUiVersion = "1.3.0"')) {
      throw new Error('Review the Cyntch native auth scroll patch before upgrading Clerk.')
    }
    if (result.modResults.language !== 'groovy') throw new Error('Expected Expo Groovy settings.gradle.')
    result.modResults.contents = mergeContents({
      src: result.modResults.contents,
      tag: 'cyntch-clerk-auth-scroll',
      anchor: /^include ':app'$/,
      offset: 1,
      comment: '//',
      newSrc: [
        'includeBuild("../vendor/clerk-android-ui") {',
        '  dependencySubstitution {',
        '    substitute module("com.clerk:clerk-android-ui:1.3.0") using project(":")',
        '  }',
        '}',
      ].join('\n'),
    }).contents
    return result
  })
}
