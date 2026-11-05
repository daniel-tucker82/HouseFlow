#!/usr/bin/env bash
# Invoked by android-emulator-runner on the fresh host assigned to this device.
set -euo pipefail
out="$RUNNER_TEMP/cyntch-android-$CYNTCH_DEVICE"
maestro="$RUNNER_TEMP/maestro-cli/maestro/bin/maestro"
if [[ "$CYNTCH_DEVICE" != "minimum-api-24" ]]; then
  # Older avdmanager can write target=android-0 even while the guest reports
  # SDK 37. Its graphics mapper then crashes SurfaceFlinger during install.
  avds="${ANDROID_AVD_HOME:-${ANDROID_USER_HOME:-$HOME/.android}/avd}"
  grep '^target=' "$avds/$CYNTCH_AVD.ini" | tee "$out/avd-target.txt"
  grep -Eq '^target=android-37(\.0)?[[:space:]]*$' "$out/avd-target.txt"
fi
case "$CYNTCH_DEVICE" in
  phone|tablet) exec node scripts/android-emulator-smoke.cjs "$CYNTCH_TEST_APK" "$maestro" "$out" ;;
  foldable) exec node scripts/android-foldable-smoke.cjs "$CYNTCH_TEST_APK" "$maestro" "$out" ;;
  minimum-api-24) exec node scripts/android-minimum-smoke.cjs "$CYNTCH_TEST_APK" "$out" ;;
  *) echo "Unknown CI device" >&2; exit 1 ;;
esac
