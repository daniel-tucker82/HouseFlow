#!/usr/bin/env bash
# A device compilation check. No development team, provisioning, export or store submission.
set -euo pipefail
out="$RUNNER_TEMP/cyntch-ios-archive-evidence"
archive="$RUNNER_TEMP/Cyntch-device.xcarchive"
mkdir -p "$out"
xcodebuild -version > "$out/toolchain.txt"
xcrun --sdk iphoneos --show-sdk-version >> "$out/toolchain.txt"
xcodebuild -workspace ios/Cyntch.xcworkspace -scheme Cyntch -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -archivePath "$archive" \
  -derivedDataPath "$RUNNER_TEMP/cyntch-device-derived" -jobs 2 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO DEVELOPMENT_TEAM= \
  COMPILER_INDEX_STORE_ENABLE=NO archive 2>&1 | tee "$out/archive.log"

app="$archive/Products/Applications/Cyntch.app"
plist="$app/Info.plist"
read_key() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist"; }
test "$(read_key CFBundleIdentifier)" = com.cyntch.app
test "$(read_key MinimumOSVersion)" = 17.0
test "$(read_key CFBundleSupportedPlatforms:0)" = iPhoneOS
plutil -extract UIDeviceFamily json -o - "$plist" | jq -e 'sort == [1,2]' >/dev/null
test -s "$app/main.jsbundle"
test ! -f "$app/embedded.mobileprovision"
cp "$plist" "$out/app-info.plist"
cp "$archive/Info.plist" "$out/archive-info.plist"
main="$app/$(read_key CFBundleExecutable)"
manifest="$out/device-binaries.tsv"
printf 'file\tarchitecture\tplatform\n' > "$manifest"
inspect_binary() {
  local binary="$1"
  xcrun lipo "$binary" -verify_arch arm64
  xcrun otool -arch arm64 -l "$binary" | awk -f ../.github/scripts/ios-device-platform.awk
  printf '%s\tarm64\tiOS\n' "${binary#"$app"/}" >> "$manifest"
}
inspect_binary "$main"
while IFS= read -r -d '' fw; do
  exe=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$fw/Info.plist")
  inspect_binary "$fw/$exe"
done < <(find "$app" -type d -name '*.framework' -print0)
while IFS= read -r -d '' dylib; do inspect_binary "$dylib"; done < <(find "$app" -type f -name '*.dylib' -print0)

dwarf="$archive/dSYMs/Cyntch.app.dSYM"
xcrun dwarfdump --uuid "$main" > "$out/app-uuid.txt"
xcrun dwarfdump --uuid "$dwarf" > "$out/symbol-uuid.txt"
uuid=$(awk '$3=="(arm64)"{print $2}' "$out/app-uuid.txt")
test -n "$uuid"
awk -v id="$uuid" '$3=="(arm64)" && $2==id{found=1} END{exit !found}' "$out/symbol-uuid.txt"
while IFS= read -r -d '' privacy; do
  plutil -lint "$privacy"
  printf '%s\n' "${privacy#"$app"/}" >> "$out/privacy-manifests.txt"
done < <(find "$app" -type f -name '*.xcprivacy' -print0)
test -s "$out/privacy-manifests.txt"
ditto -c -k --sequesterRsrc --keepParent "$app" "$out/cyntch-device-unsigned.zip"
(cd "$out" && shasum -a 256 cyntch-device-unsigned.zip > app.sha256)
printf 'Source: %s\nRelease device SDK, ARM64, iPhone and iPad. No distribution signing, installation or submission.\n' "$GITHUB_SHA" > "$out/result.txt"
