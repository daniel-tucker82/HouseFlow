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
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }

  # Match the native Clerk component's exact Swift Package dependency.
  if defined?(spm_dependency)
    spm_dependency(s,
      url: 'https://github.com/clerk/clerk-ios.git',
      requirement: { :kind => 'exactVersion', :version => '1.6.2' },
      products: ['ClerkKit'])
  else
    raise 'CyntchClerkState requires the Swift Package integration installed by the Clerk Expo config plugin.'
  end
end
