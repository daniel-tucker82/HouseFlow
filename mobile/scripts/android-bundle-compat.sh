#!/usr/bin/env bash
# Verify what bundletool delivers to an ARM64 device. The generated development
# key is for this isolated build, never an upload or production signing key.
set -euo pipefail
export LC_ALL=C
out="$RUNNER_TEMP/cyntch-bundle-evidence"
work=$(mktemp -d "$RUNNER_TEMP/cyntch-splits-XXXXXX")
mkdir -p "$out"
bundle=android/app/build/outputs/bundle/release/app-release.aab
jar="$work/bundletool.jar"
test -s "$bundle"
cp "$bundle" "$out/cyntch-development-signed.aab"
sha256sum "$bundle" > "$out/bundle.sha256"
curl --fail --location --retry 3 https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar -o "$jar"
printf '%s  %s\n' 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29' "$jar" | sha256sum -c -
java -jar "$jar" validate --bundle="$bundle" > "$out/bundle-validation.txt"
java -jar "$jar" dump config --bundle="$bundle" > "$out/bundle-config.txt"
grep -Fq PAGE_ALIGNMENT_16K "$out/bundle-config.txt"
printf '%s\n' '{"supportedAbis":["arm64-v8a"],"supportedLocales":["en"],"screenDensity":420,"sdkVersion":37}' > "$out/device.json"
java -jar "$jar" build-apks --bundle="$bundle" --output="$work/device.apks" --device-spec="$out/device.json" \
  --ks=android/app/debug.keystore --ks-key-alias=androiddebugkey --ks-pass=pass:android --key-pass=pass:android
java -jar "$jar" extract-apks --apks="$work/device.apks" --output-dir="$work/install" --device-spec="$out/device.json"
zipalign=$(find "$ANDROID_HOME/build-tools" -mindepth 2 -maxdepth 2 -type f -name zipalign | sort -V | tail -1)
test -x "$zipalign"
mkdir -p "$work/libs"
shopt -s nullglob
apks=("$work/install"/*.apk)
test "${#apks[@]}" -gt 0
for apk in "${apks[@]}"; do
  "$zipalign" -c -P 16 4 "$apk"
  sha256sum "$apk" >> "$out/device-apks.sha256"
  unzip -Z -1 "$apk" > "$work/entries.txt"
  if grep -Eq '^lib/[^/]+/[^/]+\.so$' "$work/entries.txt"; then
    if grep -E '^lib/[^/]+/[^/]+\.so$' "$work/entries.txt" | grep -Ev '^lib/arm64-v8a/' > "$work/unexpected-abis.txt"; then
      echo 'Unexpected native ABI in ARM64 device split' >&2; exit 1
    fi
    unzip -oq "$apk" 'lib/arm64-v8a/*.so' -d "$work/libs"
  fi
done
libs=("$work/libs/lib/arm64-v8a/"*.so)
bash scripts/android-check-loads.sh "$work/libs/lib/arm64-v8a" arm64-v8a "$out/native-libraries.tsv" "$work"
printf 'Source: %s\nVerified %s ARM64 libraries across %s device-specific APKs.\nDevelopment signing only. Not a store release or device execution result.\n' \
  "$GITHUB_SHA" "${#libs[@]}" "${#apks[@]}" | tee "$out/result.txt"
