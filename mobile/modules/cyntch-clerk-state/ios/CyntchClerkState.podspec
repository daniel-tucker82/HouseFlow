Pod::Spec.new do |s|
  s.name = 'CyntchClerkState'
  s.version = '1.0.0'
  s.summary = 'Read-only Clerk account cache inspection for Cyntch'
  s.description = s.summary
  s.license = { :type => 'Proprietary' }
  s.author = 'Cyntch'
  s.homepage = 'https://www.cyntch.com'
  s.source = { :git => 'https://github.com/daniel-tucker82/HouseFlow.git' }
  s.platforms = { :ios => '17.0' }
  s.swift_version = '5.10'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # This adapter inspects the storage format used by this exact native bridge.
  s.dependency 'ClerkExpo', '0.4.3'
  s.source_files = '**/*.swift'
  # ClerkExpo owns the exact ClerkKit 1.6.2 package and its build dependency.
  # RN 0.88 flattens each static spm_dependency pod into the shared products
  # directory. Declaring it here too puts two CocoaPods umbrella headers in
  # that directory, which Clang rejects. Keep this pod in its own output
  # directory and import the already-built package from the shared products.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'SWIFT_INCLUDE_PATHS' => '$(inherited) ${PODS_CONFIGURATION_BUILD_DIR}'
  }
end
