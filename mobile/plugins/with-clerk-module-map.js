// Expo config plugins run in Node during native generation.
const { withPodfile } = require("expo/config-plugins")
const { mergeContents } = require("@expo/config-plugins/build/utils/generateCode")

// Expo 58 / RN 0.88.1: SPMManager moves ClerkExpo into the shared products
// directory but updates only aggregate xcconfigs. Our dependent pod's Swift
// flags still reference the old module-map path. Correct that pod after the RN
// post-install hook, only when ClerkExpo actually uses the flattened directory.
// Recheck this workaround when RN's SPMManager starts updating dependent pods.
const correction = [
  "    cyntch_target = installer.pods_project.targets.find { |target| target.name == 'CyntchClerkState' }",
  "    clerk_target = installer.pods_project.targets.find { |target| target.name == 'ClerkExpo' }",
  "    if cyntch_target && clerk_target",
  "      cyntch_target.build_configurations.each do |configuration|",
  "        clerk_configuration = clerk_target.build_configurations.find { |item| item.name == configuration.name }",
  "        next unless clerk_configuration&.build_settings&.fetch('CONFIGURATION_BUILD_DIR', nil) == '${PODS_CONFIGURATION_BUILD_DIR}'",
  "        path = configuration.base_configuration_reference&.real_path",
  "        raise 'Cyntch Clerk xcconfig is missing' unless path && File.file?(path)",
  "        contents = File.read(path)",
  "        corrected = contents.gsub('/ClerkExpo/ClerkExpo.modulemap', '/ClerkExpo.modulemap')",
  "        unless corrected == contents",
  "          File.write(path, corrected)",
  "          Pod::UI.puts \"[Cyntch] Corrected Clerk module-map path for #{configuration.name}\"",
  "        end",
  "      end",
  "    end",
].join("\n")

module.exports = function withClerkModuleMap(config) {
  return withPodfile(config, result => {
    result.modResults.contents = mergeContents({
      src: result.modResults.contents,
      newSrc: correction,
      tag: "cyntch-clerk-module-map",
      // The next line closes react_native_post_install in the SDK 58 template.
      // An incompatible future template must fail generation, not omit the fix.
      anchor: /^\s*:ccache_enabled => ccache_enabled\?\(podfile_properties\),?$/,
      offset: 2,
      comment: "#",
    }).contents
    return result
  })
}
