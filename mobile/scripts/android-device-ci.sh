#!/usr/bin/env bash
# Invoked by android-emulator-runner on the fresh host assigned to this device.
set -euo pipefail
out="$RUNNER_TEMP/cyntch-android-$CYNTCH_DEVICE"
maestro="$RUNNER_TEMP/maestro-cli/maestro/bin/maestro"
case "$CYNTCH_DEVICE" in
  phone|tablet) exec node scripts/android-emulator-smoke.cjs "$CYNTCH_TEST_APK" "$maestro" "$out" ;;
  foldable) exec node scripts/android-foldable-smoke.cjs "$CYNTCH_TEST_APK" "$maestro" "$out" ;;
  minimum-api-24) exec node scripts/android-minimum-smoke.cjs "$CYNTCH_TEST_APK" "$out" ;;
  *) echo "Unknown CI device" >&2; exit 1 ;;
esac
