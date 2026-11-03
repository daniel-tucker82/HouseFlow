# Cyntch native applications

React Native and Expo Router applications for Android and iOS. This directory is
under active development; it is not a completed or store-released application.
The existing web application remains at the repository root.

Use Node 22 and install this application's dependencies separately with `npm ci`.
Copy `.env.example` to `.env.local` and set the API URL and the matching Clerk
publishable key. Never place a Clerk secret key in the mobile application.
For a local Android emulator, the host API URL is `http://10.0.2.2:3010`.
Production builds require HTTPS. Use a Clerk development instance and an isolated
database for testing.

- `npm run start`: start Metro for a development build.
- `npx expo run:android`: generate, build and launch the Android application.
- `npx expo run:ios`: generate, build and launch on a Mac with Xcode.
- `npm run lint` and `npm run typecheck`: verify native source.
- `npx expo-doctor`: verify native dependency and configuration compatibility.
- `npx expo export --platform android` (or `ios`): verify JavaScript bundling.

Clerk's native sign-in components require a development build, not Expo Go.
Generated `android/` and `ios/` directories are ignored. Configure native behavior
through `app.json` and config plugins rather than editing generated projects.

On Windows with long paths disabled, a verified local emulator build uses a short
drive mapping for the **repository**, CMake 3.31.6 from the Android SDK, and Expo's
object-path limit. Choose an unused drive letter; the mobile app must remain in a
subdirectory because Expo autolinking does not discover a package at a drive root.
For example, after prebuild and with `JAVA_HOME` and `ANDROID_HOME` configured:

```powershell
subst M: C:\dev\HouseFlow-native
Set-Location M:\mobile\android
.\gradlew.bat :app:assembleDebug -PreactNativeArchitectures=x86_64 -Pandroid.cmakeVersion=3.31.6 -Pexpo.android.cmakeObjectPathMax=240 --max-workers=2
```

These are local build options, not changes to the generated native project or to
cloud release builds. Keep the mapping while building; remove it with `subst M: /D`
after the build tools are finished. If switching an existing build to a different
path, archive its generated CMake/app build caches first so they regenerate there.

The SQLite outbox is account scoped and stores each completion and its cached
result in one transaction. Device-clock correction occurs only for pending edits;
frozen operation IDs and timestamps make interrupted uploads safe to retry.
The server requires migrations `0018_completion_operations.sql` and
`0019_occurrence_status_versions.sql` before these APIs or the updated web
completion handler are deployed. Server status revisions cover web, mobile and
scheduled updates. The device keeps the latest server state separately from its
pending edits, so delayed responses cannot undo a newer status after sync.

From the repository root, run `node --experimental-sqlite --test tests/mobile-*.test.cjs`.
PostgreSQL tests additionally require `CYNTCH_TEST_DATABASE_URL` pointing to a local
database named `cyntch_mobile_test`; their safety guard rejects other destinations.
They create isolated fixtures and clean up their own data.

The previous Capacitor implementation is recoverable from the Git tag
`archive/capacitor-before-native-20261103`. Its platform projects, shell UI,
configuration and dependencies have been removed from the active root project.

## Local verification, 2026-11-03

The Android x86_64 development APK builds and runs on the Android 36 emulator.
Native Clerk sign-in and an isolated PostgreSQL/Next.js API were used to verify
offline completion, force-stop/restart recovery, automatic reconnect upload,
exactly one server receipt, and the next task unlocking. Phone portrait,
landscape and 1.6× system font size were inspected, including welcome-screen
scrolling. The keep-awake setting releases its screen wake lock in the background.

Changing Android system font size while the development app is running produced
an Expo Router multiple-linking-handlers warning; a clean launch did not. This
needs investigation and release-build verification before launch. No physical
device performance measurements, iOS native build, store release or household
pilot has been completed.
