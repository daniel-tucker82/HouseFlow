/* eslint-disable @typescript-eslint/no-require-imports -- Expo config plugins run in Node during native generation. */
const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins")

// React Native 0.88 updates font metrics and layout on configuration changes.
// Preserve the current activity and React surface when accessibility text size
// changes, avoiding a replacement navigation root and loss of open screen state.
module.exports = function withAndroidFontScale(config) {
  return withAndroidManifest(config, result => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(result.modResults)
    const changes = new Set((activity.$["android:configChanges"] ?? "").split("|").filter(Boolean))
    changes.add("fontScale")
    activity.$["android:configChanges"] = [...changes].join("|")
    return result
  })
}
