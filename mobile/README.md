# Cyntch native applications

React Native and Expo Router applications for Android and iOS. This directory is
under active development; it is not a completed or store-released application.
The existing web application remains at the repository root.

Android run `41867082612` (`93777e1`) passed the optimized API 36 phone/tablet
matrix at 1x/1.6x text, including software-keyboard rotation, retained input,
keyboard dismissal and app Back handling. Both devices also passed real native
development email-code sign-in, isolated household/task loading in both
orientations and authenticated restart. API 24 startup/rotation/dismissal/restart
passed. The artifact digest was verified and reports/screenshots inspected:
`C:/Users/danie/.codex/tmp/cyntch-android-evidence-41867082612`;
artifact SHA-256 `13117d61e11b9dcfa247b1af17ddfac26e6d7e2e577633288cc5b156283fcbe0`;
APK SHA-256 `87818e2756ac72365d7bac35a7daba4a0aeb51045726da3a97b55f36c7bcdcb8`.
The tablet landscape board and phone board after restart show the correct test
household and task dependencies. Visual review still found the floating email
label partly clipped above the populated field on the phone's 1.6x landscape
keyboard capture. The next build removes the header's 8 dp top/bottom decorative
padding when a landscape keyboard occupies the screen, making 16 dp more room
for the outlined field and label. Close/Back retain their 48 dp controls and
safe insets. The pinned source preparation passes; verify the complete label,
typed value, keyboard and restored spacing after dismissal on the new build.

The next Android matrix uses Android 17/API 37 (`37.0` SDK packages) with 16 KB
memory pages, retaining the API 24 minimum check. A separate Pixel Fold job
downloads and verifies the same run's compiled APK. At 1x/1.6x text it enters a
reserved invalid address once, then unfolds and folds without relaunching or
refilling the form. Each posture must retain the input and expose Continue;
committed device states and actual screenshot dimensions must change and return
as expected. Reports, screenshots, hierarchy and logs survive failures. It uses
Android's documented [emulator fold/unfold commands](https://developer.android.com/blog/posts/emulator-control-for-adaptive-app-development).
Source/YAML/Bash checks, lint/types and simulated runner-control failure checks
pass; actual Android 17/foldable execution is still required. This is sign-in
state-retention coverage, not proof of every editor or physical foldable device.

iOS Intel run `41860511228` (`79abb8f`) compiled the optimized simulator app and
passed `codesign --verify --deep --strict`, then stopped at the architecture
check: `lipo -verify_arch` consumed the following executable path as another
architecture. Both current/minimum-OS checks now put the executable before
`-verify_arch`. This preserves the architecture and embedded-entitlement checks;
it does not establish device success. The corrected workflow needs another
native run. Evidence: `C:/Users/danie/.codex/tmp/cyntch-ios-41860511228-job.log`.

Cyntch's 16 modal presentations now use the system reduced-motion preference.
One root provider reads the setting at startup, listens for changes and refreshes
it when the app returns to the foreground. Until a successful read, or if a read
fails, presentations use no animation. A delayed read cannot override a newer
setting event. The same preference disables automatic animated scrolling to
validation errors in the task and schedule editors. Screen state, native sheet
presentation, orientation props and dismissal callbacks are preserved.
This follows React Native 0.88's
[AccessibilityInfo](https://reactnative.dev/docs/accessibilityinfo) and
[Modal](https://reactnative.dev/docs/modal) APIs. Page/form sheets already use
iOS orientation behavior; their `supportedOrientations` prop is ignored by iOS.

Mobile lint and types pass. Device verification remains required: launch with
reduced motion enabled, open/close sign-in, task details, editing, settings,
kiosk PIN and account-recovery sheets; change the system setting while the app
is active and while backgrounded; return with an unsaved form and verify its
contents and navigation remain intact. Trigger task/schedule validation errors
and confirm the message is revealed without animated scrolling. Repeat with the
setting disabled to verify ordinary transitions. This change alone does not
establish screen-reader coverage or motion behavior inside third-party native
authentication/purchase components.

Normal sign-in and kiosk parent recovery now share one presentation outside the
notification-session loading gate. A session change can replace application
content while the native auth view remains mounted until Clerk dismisses it.
Parent recovery uses Android's Activity overlay and the iOS sheet, opens after
successful sign-out in the same action, and retains the kiosk restriction until
the existing recovery checks succeed. Failed durable sign-out now rejects to the
caller instead of allowing the next recovery action to proceed. The 26 existing
kiosk/PIN/notification-session checks and mobile lint/types pass; these checks
cover the underlying durable boundaries, not native presentation. Native normal
sign-in and parent-recovery confirmation remain required. This follows Clerk's
[auth view lifecycle guidance](https://clerk.com/docs/reference/expo/native-components/auth-view#render-in-a-modal).

Manual Android/iOS workflow dispatches can now supply `fixture_url` and
`fixture_email` to add native email-code sign-in, household/task loading,
portrait/landscape and session persistence after restart. Both inputs are required
together. The URL must be the temporary HTTPS tunnel to an isolated development
backend; the identity must be an existing `cyntch-native-*+clerk_test@example.com`
profile in the fixed development Clerk instance. Ordinary push runs stay signed
out. No provider secret or password is sent to Actions. The additional flow runs
once per device after the two text-size cases, with separate reports and three
required screenshots; it does not replace the earlier checks or establish offline,
billing or push coverage. Android execution is verified above; iOS execution
remains pending.

The unchanged backend at `79abb8f` was built in a separate worktree and verified
through both local HTTP and a temporary HTTPS tunnel: real development email-code
sign-in, authenticated household/task loading, server time and rejection of
signed-out access. Each preflight session was revoked. Test data lives in the local
`cyntch_mobile_test` database; provider delivery remains disabled. Bind this local
production server to `localhost`: binding to `127.0.0.1` caused repeated internal
Clerk rewrites to `localhost`, making requests loop. No application auth changes
were required. Evidence: `C:/Users/danie/.codex/tmp/cyntch-native-http-preflight-https.json`.

Android run `41855537547` (`b3cfb66`) now proves API 24 landscape dismissal: the
Close control is within the app's bounds and tapping it returns to the welcome
screen. Installation, portrait/landscape and force-stop/relaunch passed. Its newer
phone/tablet keyboard checks failed; this build predates `3f77f19`'s keyboard
corrections. Evidence: `C:/Users/danie/.codex/tmp/cyntch-android-evidence-41855537547`;
artifact SHA-256 `f4c6fac9ce2d3f8a9cc5678f9b990a2313784881440abedacc5a22f73ba77a90`;
APK SHA-256 `144292eacbbf3fe360b8302720919523a2890249a23f88556d80727be90f9e2c`.

iOS run `41855537525` never obtained a Mac runner. GitHub's annotations report
hosted-runner acquisition failure and macOS arm64 capacity constraints; no code
or device check ran. The workflow now defaults to the standard
`macos-26-intel` pool and allows `macos-26` on manual dispatch. Both jobs use the
same selected pool, compile for the actual host architecture and verify that
the compiled executable contains it. Architecture-specific queue groups preserve
already queued work while allowing the other pool to run. Xcode 26.6, signed
Release builds, both text sizes and the separate iOS 17 phone/tablet checks
remain required. Intel run `41860511228` acquired a host and is compiling; device
results remain pending. See GitHub's
[standard Mac runner labels](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/)
and [installed Xcode versions](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md).
Failure evidence: `C:/Users/danie/.codex/tmp/cyntch-ios-41855537525-runner-annotations.json`.

Android CI uses the pinned Gradle setup action's basic GitHub cache after
prebuild, with task caching enabled for both native builds. Generated Gradle
files participate in its key and wrapper validation. The workflow still builds
the requested revision, hashes its APK and runs every device stage. Build Scans
and dependency uploads are disabled. First-cache population and any reduction
in compilation time still need hosted evidence. See
[Gradle's basic cache documentation](https://github.com/gradle/actions/blob/v6.4.1/docs/setup-gradle.md#basic-caching).

The iOS workflow now has a separate minimum-OS job using the same compiled app
artifact from that workflow run, with its ZIP hash and signature checked again.
The built app's `MinimumOSVersion` is 17.0. The job requests Apple's original
iOS 17.0 simulator runtime and runs the phone/tablet suite on iPhone 15 and
iPad (10th generation), including both text sizes. It requires exactly 17.0 and
the named device types; unavailable downloads or runtimes fail explicitly.
It can still collect minimum-OS evidence if the current-OS device stage fails
after a usable app was compiled. Actual runtime download and device execution
remain pending. Apple's download/import procedure is documented in
[additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

The current phone/tablet suite also includes an independent keyboard journey at
each text size. It types a reserved `.invalid` address without submitting it,
requires software-keyboard keys in portrait and landscape, checks that the entry
survives rotation in both directions, and reaches Continue after keyboard
dismissal. Three additional screenshots are required for each case; the earlier
signed-out screenshots cannot satisfy this coverage. YAML, runner syntax and
mobile lint/types pass. The first native results and required corrections follow.

The first keyboard run, Android `41851280065` (source `62c043f`), compiled and
passed all four baseline phone/tablet journeys, but failed every keyboard case.
The enlarged phone's hierarchy shows a 770px form container after the fixed
development footer, with the top bar and keyboard consuming its remaining
height. The footer patch now consumes its reserved bottom inset, so IME padding
uses overlapping space once. On the tablet, keyboard dismissal returned to the
welcome screen: the React Native dialog forwards Back to its close handler.
Android auth now renders above the app in the Activity, with the underlying
content hidden from accessibility and pointer input. Clerk stays mounted across
session changes until its completion/dismissal callback, and root Back returns
to welcome. The iOS sheet remains at that same independent presentation level.

The keyboard flow clears only its disposable app state before each case; the
earlier enlarged-tablet failure appended to an identifier retained by Clerk.
Rotation, keyboard visibility, retained input and Continue assertions remain,
with an added Android root-Back screenshot. The first phone case also encountered
an offline emulator transport during launch; no automatic test restart hides
that failure. The minimum-API stage timed out during its single APK install
after 30 seconds, before any app check. That install now has a bounded 120-second
observation budget without retrying it. Actual Gradle source preparation passed,
with exactly five of 219 upstream Kotlin files changed; mobile lint/types,
runner syntax and YAML parsing pass. Native proof of these corrections remains
pending. Artifact SHA-256:
`f25e6bd1d55341d177be5b392d7ed89f1e5d956c1fafe1cc0db8a2fe2ad9031e`;
APK SHA-256: `113b32bbcc226ad13551ee803e3b33cd7ce53b14d7726b3553490ec683625161`.
Evidence: `C:/Users/danie/.codex/tmp/cyntch-android-evidence-41851280065`.

Android run `41841090786` (source `70f2ef4`) passed the signed-out startup,
rotation, native sign-in and restart journeys on Pixel 6 and Pixel Tablet at
1x and 1.6x text. Each case retained seven correctly oriented screenshots.
Visual review confirms the tablet's enlarged Google label is no longer clipped
and the phone's landscape Continue action is reachable. Artifact SHA-256:
`18fd9b4d78bb88d680716712872d9cb5334c42e4c3ebfb53ed99b7868e94cfd2`;
APK SHA-256: `02ccf72dfbdd0cf31a17829fae34eec83a975e27668382a5e669ce72f9bc1ead`.
Evidence: `C:/Users/danie/.codex/tmp/cyntch-android-evidence-41841090786`.
This run predates the 600dp width change and minimum-Android stage.

Run `41845177451` (source `13f46ac`) subsequently passed phone/tablet at both
text sizes and the Android 7.0/API 24 installation/startup/form/rotation/restart
flow. Artifact SHA-256 is
`402e6124a58deecc3b999cee9fb815cb98674645bcf47ba4c73824578943af80`;
APK SHA-256 is `c18719ccc6a0ba6531b23bd2a9e14a30f72225d31e7fa96f7956819134d4e212`.
The verified evidence is in
`C:/Users/danie/.codex/tmp/cyntch-android-evidence-41845177451`. Visual review
confirms centered 600dp tablet forms and uncut labels at both text sizes.
However, the minimum-OS landscape image reveals Close overlapping the side
system navigation bar. The previous flow did not tap Close, so its green result
does not establish a usable dismissal control. The pinned header patch now
includes horizontal safe-drawing insets, and both Android runners actually
dismiss/reopen native auth. Source preparation, runner control checks and mobile
lint/types pass; the new fix still requires native compilation and device proof.

iOS run `41839062482` (source `c88394d`) passed compilation, signing and the
iPhone 17 Maestro journey on iOS 26.5, including native sign-in and restart.
Its orientation check failed because XCTest stores landscape images as portrait
pixel arrays with EXIF Orientation=8. Visual review confirms landscape rendering;
the corrected checker reads that metadata and passes all five existing captures,
retaining both stored and displayed dimensions. It also rejects malformed EXIF
instead of guessing. The run remains failed: the iPad did not finish its initial
simulator boot within five minutes, before application installation. The runner
now retains boot logs and rechecks a live device for one further observation
period without rebooting it, bounded by a ten-minute setup budget. The later run
below supplies the first iPad and enlarged-text evidence. Artifact SHA-256:
`82280cb88ffa4d1746f4817045dba7f38de38e01dd713e5fa94e7f6028c10425`.
Evidence: `C:/Users/danie/.codex/tmp/cyntch-ios-evidence-41839062482`.

iOS run `41845177445` (source `13f46ac`) subsequently compiled and passed signing,
then completed the native sign-in/rotation/restart flow on iPhone 17 at default
text and iPad (A16) at both default and accessibility-extra-large text on iOS
26.5. Rechecking the 15 original captures with the corrected EXIF reader passes
their actual display orientations; the original failed report is preserved.
The iPhone enlarged-text case failed before sign-in: the welcome heading and
description pushed the action below the first screenful. The welcome layout now
uses the existing smaller heading style at enlarged text sizes and places the
sign-in action before supporting copy. System font scaling remains enabled and
the page remains scrollable. Both test journeys explicitly scroll to the action
before using it, including after rotation/restart. Lint, types and YAML parsing
pass; native verification of this correction is pending. This run does not
prove authenticated workflows, keyboard handling or minimum-iOS support.
Artifact SHA-256:
`07eeea5fb6cada2e95c339ef2e8e29f13f88ad52647e23b9a33d8b363152e164`.
Evidence: `C:/Users/danie/.codex/tmp/cyntch-ios-evidence-41845177445`;
separate image recheck: `C:/Users/danie/.codex/tmp/cyntch-ios-41845177445-orientation-recheck.json`.

The Android native sign-in form now has a centered maximum width of 600dp;
the earlier tablet screenshots showed its fields stretching almost edge to edge.
Narrow screens retain their available width, and the existing scroll/keyboard
insets remain. Run `41845177451` provides the native width verification described
above; the later header safe-area correction still needs new device evidence.

The iOS runner now repeats the signed-out phone/tablet journey at default Dynamic
Type (`large`) and `accessibility-extra-large`. It checks the simulator's actual
setting before each case, retains the installed `simctl ui` help, and saves each
case's screenshots, orientation checks and test log separately. One failed case
does not suppress the remaining text size or device. Local runner-control checks
cover timeout isolation, setting mismatch, screenshot/cleanup failures and host
guards; mobile lint/types pass. Run `41845177445` verifies the iPad journey at
both text sizes; the iPhone enlarged-text correction still needs device proof.

The Android workflow also runs the optimized APK on an API 24 (Android 7)
Nexus 5 emulator, matching the current native minimum SDK. The compatibility
script uses Android's UIAutomator hierarchy and ADB input rather than assuming
the modern Maestro driver's OS support matches the application's. It requires
installation, welcome/native sign-in in both orientations, and force-stop/relaunch,
retaining screenshots, UI hierarchy, logcat and an APK hash. Run `41845177451`
passed that flow, with the subsequent Close-control fix still awaiting native
verification. It does not establish authenticated-workflow or performance
coverage on the minimum OS. The Clerk iOS dependency requires iOS 17;
the new minimum-iOS job still needs successful runtime verification.

Android run `41836733823` (source `0d257f0`) compiled the patched Clerk UI and
optimized application successfully; dependency insight confirms the bridge uses
`:cyntch-clerk-ui`. Both tablet text sizes and the phone's 1.6x text flow passed,
including actual portrait/landscape screenshot checks. The phone's default-text
flow failed because Maestro considered the Continue ID's full bounds visible
inside the screen even though its scroll parent clipped the label. The hierarchy
shows a scrollable parent ending at y=707 and the button extending to y=810;
the test performed zero scrolls before its text assertion failed. The flow now
scrolls to the rendered label and also requires the action ID. The later run
`41841090786`, described above, verifies the default-text phone correction. Earlier artifact SHA-256:
`f6368dddd4f19a889dd7c9f68bd6239afaddbfe74c6cf1065e3f14257e6d0bfa`;
APK SHA-256: `9ecef772c25fd8081721f11a7c9272d0cf05d633a06af0d5e9503abd265d1529`.
Evidence: `C:/Users/danie/.codex/tmp/cyntch-android-evidence-41836733823`.

Visual review of that run found another defect despite the tablet flow passing:
the Google button's fixed 48dp height clipped its label at 1.6x text. The pinned
UI patch now lets social and standard button heights grow above their existing
minimum. Android tests also require separate Google-button screenshots in both
orientations. Run `41841090786` verifies that correction; automated element
visibility alone does not establish that text is uncut.

The first bundled iOS Release runtime check compiled successfully but failed
before sign-in: the unsigned simulator binary reported Keychain error -34018
(missing entitlement). The iOS workflow now enables local ad-hoc simulator
signing and checks the executable's embedded simulator application-identifier before
testing. Its artifact also retains the simulator app ZIP and hash. This signing
is for the simulator only, not TestFlight or App Store distribution. A separate
iPad setup timeout prompted a five-minute cold-boot allowance and per-command
timings/stage reporting. Run `41839062482` (source `c88394d`) has now compiled and
passed the embedded-entitlement/signature checks and the iPhone startup/sign-in
journey, resolving the earlier startup failure there. The later iPad execution
in run `41845177445` is described above.
Failed-run evidence: `C:/Users/danie/.codex/tmp/cyntch-ios-evidence-41822109295`.

The locally signed Release build in run `41832990843` (source `50e4173`)
compiled successfully, but the pre-runtime check incorrectly required simulator
entitlements in the macOS ad-hoc signature. Its signature plist was empty;
Xcode generated `FAKETEAMID.com.cyntch.app` in `Cyntch.app-Simulated.xcent`
and linked the simulator XML/DER entitlement sections. The workflow now extracts
those sections from the actual executable using Apple's `segedit`, checks the
application identifier, and retains both the embedded and signature entitlements.
Signature verification remains required. This corrects the check; Keychain access
and the device flows still require runtime verification. Failed-check artifact:
`C:/Users/danie/.codex/tmp/cyntch-native-ios-41832990843.zip`, SHA-256
`0c7141a81bcaffe1bb6de43a5b16bd8ccceff7f481f3bc2d3506629033b2a240`.

Startup account-storage failures now replace the loading spinner with a readable,
scrollable retry screen. Internal storage/SDK exception text is not shown on
that screen. The saved-account readiness gate remains in place, so failure does
not reveal account controls. Mobile lint/types pass; native visual verification
of this error state is still pending.

Membership departure notifications now describe the recorded cause: a parent
removing someone produces "was removed", while self-requested account deletion
produces "left" for surviving households. The cause commits with membership
removal and its deferred notification event. Older events without a recorded
cause say the member is no longer in the household. App history and push bodies
use the same wording; private alerts still omit names. The existing web removal
notification also describes removal accurately.

Verification: 53 real PostgreSQL notification-event, outbox, history and account
deletion checks passed, including rollback, retries, delete/reinsert without a
net change, recipient restrictions and private/detailed wording. Root typecheck,
focused lint and mobile lint/types passed. Log:
`C:/Users/danie/.codex/tmp/cyntch-member-departure-tests.log`.

Settings includes live task edits in its saved-change count and sign-out warning,
alongside completions, routine edits/creations and notification changes. Pending
live edits show their title and household; rejected edits have retry and
confirmed-discard controls even when their original board cannot be opened.
Lost management access hides retry. Discarding a cached existing-task edit still
requires a current server view; removing an unavailable household's rejected
local edit remains possible offline. Rejected changes are described as needing
attention, rather than silently reported as already synced.

Verification: the actual Settings component was evaluated with isolated runtime
snapshots for live-only pending/rejected/resolved edits, sign-out warnings,
retry routing, offline discard restrictions and confirmation before cleanup
after lost household access. All 18 live-editor SQLite/controller checks and
mobile lint/types passed. Evidence is in
`C:/Users/danie/.codex/tmp/cyntch-settings-live-edits-{render,regression}.log`.
Native visual verification of these Settings additions remains pending.

The `Native Android verification` Actions workflow builds a minified x86_64
Release APK with bundled JavaScript and the generated development signing key.
It then runs the shared signed-out Maestro journey on separate Android API 36
Pixel 6 and Pixel Tablet emulators, including rotation, opening native sign-in
and restarting the app, at both default and 1.6× system text size. Each text size
has separate logs, screenshots and results, and is attempted even if the other
fails. The tablet run still executes if the phone flow fails.
The build uses Cyntch's public development Clerk identifier and a reserved
`.invalid` API address; it never submits sign-in credentials or reaches the
production API. The APK is for this emulator verification, not store submission.

The seven-day artifact retains the APK and hash, build logs, per-device model,
OS and display metadata, JUnit results, screenshots, Maestro output and logcat.
Run `41825137438` at `55d1ae4` compiled the optimized APK successfully. Both
devices opened the welcome and native authentication screens, then failed on
an incorrect test label (`Email address`; Android displayed `Enter your email`).
The retained phone screenshot also exposes a genuine defect: the Continue
button is compressed and clipped in landscape, with no scrollable form. The
same non-scrolling auth scaffold remains in the published Clerk Android UI
1.4.1 sources. A pinned source patch now adds scrolling and keyboard insets to
the native auth scaffold; `vendor/clerk-android-ui` records its reproducible
build and upstream license. It preserves the 1.3.0 authentication/API versions.
Prebuild, lint and typecheck pass; compilation and native runtime verification
of the replacement remain pending.
The first patched run (`41833452182`, source `5771a7a`) failed before compiling
the library because the verification task path did not resolve. The workflow
now compiles the library directly with Gradle's project-directory option before
the app build, and the generated included build has an explicit name. Java and
Kotlin compilation targets are both 17. Failure evidence is retained in
`C:/Users/danie/.codex/tmp/cyntch-android-evidence-41833452182`.
Run `41835086449` reached the standalone library but AGP 9 rejected its lazy
ProGuard file provider. Generated source/resource/rule paths now use concrete
files with the existing explicit preBuild dependency. That failed run's evidence
is in `C:/Users/danie/.codex/tmp/cyntch-android-evidence-41835086449`.
The next run reached source preparation and exposed a Groovy copy-spec closure
binding error. The copy action now addresses its project and copy specifications
explicitly. The actual preparation task passed twice under Gradle 9.4.1 in a
small local fixture using the official archives: all 219 Kotlin sources were
preserved, exactly the intended scaffold changed, consumer rules were retained,
and the upstream compiled classes were excluded. Forced regeneration produced
identical patched source and removed a stale fixture output. This proves source
preparation, not Android compilation or layout. Fixture:
`C:/Users/danie/.codex/tmp/cyntch-clerk-source-check-20261104`.

The shared flow now selects Clerk's published native field/action identifiers
on both platforms and requires the complete Continue control and its text to be
reachable in each orientation. It checks portrait authentication first to retain
that evidence even if landscape fails. On Android, the driver maps rotations
using the emulator's natural display orientation. The previous Pixel Tablet
screenshots were labelled backwards. Both drivers now check the actual PNG
dimensions before accepting orientation coverage and retain those findings.
The evidence checker correctly rejects the original tablet screenshots and the
missing authentication/restart screenshots. This is a regression check for an
open defect, not a claim that sign-in now passes.

Downloaded evidence: `C:/Users/danie/.codex/tmp/cyntch-android-evidence-41825137438`.
The original ZIP SHA-256 is
`45e5e0fa502e27344522911336345ca66bca89063c6d0773d9a6d335545fca07`.
Authenticated workflows, physical-device performance,
push delivery, billing and the remaining device matrix need separate evidence.
Both native workflows let an active run finish and queue the latest pending
revision, preserving device evidence when implementation work is pushed.

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

### Cloud builds and native iOS compilation

Run EAS commands from this `mobile` directory. `eas.json` defines:

| Profile | Intended artifact | EAS environment |
| --- | --- | --- |
| `development` | Android/iOS development client for devices | `development` |
| `development-simulator` | iOS development client for Simulator | `development` |
| `preview` | Internal release-like device build | `preview` |
| `preview-simulator` | Release-like iOS Simulator build | `preview` |
| `production` | Google Play/App Store build | `production` |

The profiles pin Node 22.23.3 and use EAS remote version management; production
builds increment their platform build number. Store submission is a separate
release step. Link the correct Expo account/project with `npx eas-cli@latest init`
after signing in; reuse an existing Cyntch project if one is present. No project
identifier has been invented or committed.

Set `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in each selected
EAS environment. The pre-install hook rejects missing sign-in configuration,
test keys in production, and non-HTTPS preview/production API URLs. Development
profiles also allow the local emulator/loopback addresses. These checks do not
establish that the API and Clerk instance match; verify sign-in against the
selected backend. Local `.env` files and signing credentials are not uploaded.

For example, `npx eas-cli@latest build --platform ios --profile development-simulator`
starts an unsigned Simulator build once the project and environment are linked.
Device/store builds additionally need the appropriate signing and push-provider
configuration. Preserve the existing `com.cyntch.app` identifiers.

Android Firebase client configuration is supplied through `GOOGLE_SERVICES_JSON`:
use an absolute file path in the ignored local `.env.local`, or an EAS file
environment variable in the selected build environment. `app.config.js` extends
`app.json` with `android.googleServicesFile`; it does not embed the JSON contents
in the JavaScript configuration. Android preview/production build validation
requires this file and checks the package/project identifiers. It rejects a
service-account private key. Simulator/iOS and credential-free development
compilation remain available without this Android file.

Read-only Firebase inspection on 2026-11-04 confirmed the existing project
`cyntch-2358a`, Android app `com.cyntch.app`, and enabled Cloud Messaging V1 API.
Its existing client configuration was downloaded for local build preparation.
No new project, app registration, service-account credential or access grant was
created. The downloaded client file and signing/service credentials are excluded
from Git and the EAS source archive. Supply the client file separately through
EAS environment configuration. FCM V1 sending credentials still need to be
configured in the linked Expo project, and iOS needs APNs credentials; this
inspection does not establish token registration or delivered push notifications.
References: [Expo Android push credentials](https://docs.expo.dev/push-notifications/fcm-credentials/)
and [dynamic app configuration](https://docs.expo.dev/workflow/configuration/).

Read-only distribution-account inspection on 2026-11-04 found Google Play
Console showing developer-account creation for the currently signed-in business
Google account. No developer account or listing was created. App Store Connect
redirected to its unauthenticated login page, so Apple membership, app records
and signing access remain unverified. No account registration, agreement or
purchase was submitted. These are distribution dependencies, not evidence that
either app is available through a store testing track.

The isolated Expo 58 Android prebuild at
`C:/Users/danie/.codex/tmp/cyntch-firebase-prebuild-20261104` completed with this
downloaded client file. Its generated `android/app/google-services.json` matches
the source byte-for-byte; Gradle includes Google's services plugin and classpath.
`firebase-prebuild-evidence.json` records that check. Four automated build-config
checks cover required environments, malformed/mismatched files, private-key
rejection without disclosure and preservation of existing app settings. Mobile
lint and type checking passed. Native compilation with Firebase configuration
and on-device registration/delivery remain unverified.

The root `.easignore` uploads `mobile`, `shared`, and the three package-free
calendar/type utilities in `lib`. It excludes generated app projects while
retaining the local Expo module's Android and Swift sources. Update the allowlist
if mobile code gains another external source dependency. EAS regenerates native
app projects through the existing config plugins.

`.github/workflows/native-ios.yml` provides locally signed arm64 Simulator verification
on the mobile development branch, using a standard macOS 26 runner and Xcode
26.6. EAS remains the signing/distribution path.

The last verified Debug compilation is run `41818248579`, source `9cadf3b`:
all 27 native persistence/biometric/Keychain checks and the full compile passed.
The downloaded artifact is
`C:/Users/danie/.codex/tmp/cyntch-native-ios-41818248579.zip`, SHA-256
`67afa58ceff4027b617834f7694634ced8f50f86282b16d98caf05c9e128028a`.
That run did not launch the application.

The workflow now builds the **Release** Simulator configuration and requires its
bundled `main.jsbundle` before runtime checks. It installs the pinned Maestro
2.12.1 archive after checking its SHA-256, then creates its own disposable iPhone
and iPad simulators using the newest installed runtime with both device types.
`scripts/ios-simulator-smoke.cjs` runs `.maestro/signed-out.yaml` separately on
each, retains JUnit results, screenshots and app logs, and shuts down/removes
only the simulators it created, including after a failed flow.

The flow checks signed-out welcome text, portrait/landscape controls, opening
Clerk's native email sign-in form in both orientations, and a clean return to
the welcome screen after restarting. It uses Cyntch's public development Clerk
identifier, grants no device permissions and never submits login credentials.
The application API is a reserved `.invalid` address, so these checks cannot
exercise production household data. No Metro server or signing account is used.
The first runtime attempt failed on the unsigned binary's Keychain access;
the corrected signing and flow still need a successful run. They do not cover authenticated journeys, real device
performance, purchases, delivered pushes or store readiness.

RevenueCat's React Native SDK is pinned to `10.16.0`. The first Mac check
(`41796637009`, commit `152b698`) generated the iOS project but stopped at pod
installation: version 11 requires the unpublished `PurchasesHybridCommon 20.1.0`
pod during the November 2026 CocoaPods publishing freeze. RevenueCat recommends
Expo apps remain on 10.x until that dependency is published; its experimental
full Swift Package Manager migration does not yet support Expo Router. Version
10.16.0 retains RevenueCat iOS 5.99.0 and uses Android 10.30.0. Recheck the
[official migration guidance](https://www.revenuecat.com/docs/sdk-guides/react-native-cocoapods-to-spm-migration#expo-apps)
before upgrading. Native prebuild and pod-install logs are retained even if the
compiler cannot start.

The compatibility change passed mobile lint/typecheck, all 42 billing client and
identity-recovery checks, and an Android x86_64 debug build. Its first emulator
launch stayed blank and reported a Clerk initialization timeout. A controlled
relaunch reached the signed-out welcome screen and responded to JavaScript
inspection. The task board and startup reliability were not verified; do not
count the relaunch as resolving the first failure. A bug report and thread
snapshot were retained locally, alongside the low-memory host observations.
Evidence: `C:/Users/danie/.codex/tmp/cyntch-ios-compat-evidence.json`.

The Mac workflow also compiles and runs the production account-cache parser
against synthetic Swift fixtures before generating the app. These checks cover
target/other accounts, unidentified sessions, authentication attempts, malformed
caches and the restricted bridge payload. They do not read the Keychain and do
not verify account erasure, SDK concurrency, biometric keys or device behavior.
All ten Swift checks passed on the Mac runner in run `41802152555`.

The subsequent Mac run (`41798029428`, commit `c1b9d77`) installed pods but failed
Clang dependency scanning: React Native flattened both `ClerkExpo` and
`CyntchClerkState` into the shared products directory, where their generated
umbrella headers conflict. The adapter now depends on `ClerkExpo 0.4.3` and
imports that bridge's already-built ClerkKit package from the shared products
directory, instead of declaring a second `spm_dependency`. Native compilation
of this correction exposed a second path issue in run `41802152555`: the RN hook
updates aggregate configurations but leaves this dependent pod pointing at
`ClerkExpo/ClerkExpo.modulemap`. The SDK 58 `with-clerk-module-map` config plugin
corrects only the adapter's configurations after the RN hook, and only while
ClerkExpo is built into the shared directory. Its insertion was checked against
the official SDK 58 Podfile, including repeated generation and rejection of an
incompatible template. The complete unsigned arm64 Simulator build passed in
run `41807271365` at commit `84fca1b`; the retained compiler log ends with
`BUILD SUCCEEDED`, and pod-install output confirms both configurations were
corrected. The downloaded artifact's SHA-256 is
`48e8a1e5c09fd8032831bdbe0232c3aecacff5375d7c0d20788381bc7361c070`.
This establishes native compilation, not simulator execution or device release.
The original artifacts are retained locally as
`cyntch-native-ios-41798029428.zip` and `cyntch-native-ios-41802152555.zip` in
`C:/Users/danie/.codex/tmp`.

### iOS account-scoped biometric cleanup

The adapter now implements local biometric cleanup for Cyntch's private app
Keychain configuration, pinned to ClerkKit 1.6.2's metadata and key-tag format.
Clerk's equivalent account-scoped method is package-only on iOS, while its public
revocation method requires a signed-in account and does not propagate all local
cleanup failures. This adapter validates ownership before removing private keys,
confirms key absence, and only then updates the exact metadata item through its
persistent reference. Other accounts and app identifiers retain their records.
Unknown schemas, duplicate identifiers, ambiguous stores and storage errors keep
cleanup unverified. Metadata survives a partial key-deletion failure or failed
write so a later attempt can resume. No credential contents cross the JS bridge.

Apple's [Keychain query documentation](https://developer.apple.com/documentation/security/secitemcopymatching(_:_:))
disallows requesting all password data in a single query. Both biometric cleanup
and profile-cache inspection now enumerate references and read each password item
individually. Biometric mutations run synchronously on MainActor, matching the
SDK's metadata-store serialization. These operations occur during account
cleanup, never while saving tasks; they still need device latency verification.

The Mac workflow adds 14 failure/retry/ownership checks against the production
coordinator and three Security API checks using newly created random fixture
services and software keys. All 27 native checks and the complete updated
unsigned arm64 Simulator build passed in run `41810970540`, commit `4216998`.
The downloaded compiler/test artifact has SHA-256
`c822e7b640f44e97c89ac6c1f68cb4994e69e33b199cc75b8ba1bf20b36e52d2`.
Its logs confirm all three test groups passed and `BUILD SUCCEEDED`.
The subsequent run `41813668322` at `31e2621` also passed all 27 checks and the
full Simulator compile. Its downloaded artifact was verified against SHA-256
`53a5280f1c2cc172da29ae1ca5568057ac8a8fda4b18e53d7dc43c01f447d4bd`.
The Security fixtures are removed on success and failure;
they do not enroll biometric credentials or touch an existing account.
Mobile lint and TypeScript passed after the adapter change.

This does not enable account-deletion submission. Shared Keychain access-group
configuration remains unsupported and fails explicitly; Cyntch currently does
not configure one. Late SDK enrollment callbacks, native-profile refresh after
remote deletion, real biometric keys and physical-device behavior still require
implementation/verification before the deletion release gate can open. The
current erasure pass is not proof that a later SDK callback cannot write again.
ClerkKit's native `UserProfileSecurityView` offers provider-side deletion when
`user.deleteSelfEnabled` is true, bypassing Cyntch's household and billing review.
On 2026-11-04, the **Cyntch development instance only** was configured in Clerk's
User & authentication > User model > User permissions: turn off **Allow users
to delete their account**, save, then **Apply to existing users**. The default
toggle alone does not migrate existing users. A Backend API read confirmed both
existing development users had `delete_self_enabled: false` afterward. Profile
name and email editing remain enabled. Production settings were not changed.

The opt-in `tests/integration/account-deletion-clerk.cjs` check now creates a
marked disposable development user without a deletion-permission override and
verifies that the instance default is inherited. It signs in that fixture via
Clerk's native Frontend API, then simulates an existing session that has loaded
the old enabled permission. After updating the fixture's provider policy, direct
deletion from that same session is rejected with HTTP 403 and
`user_delete_self_not_enabled`, without first refreshing its profile. Profile
name editing still succeeds. Cyntch's server deletion then completes, including
recovery after an intentionally lost provider DELETE response. The fixture and
isolated local database schema are removed; tokens and secrets are not recorded.

This real-provider check passed with evidence at
`C:/Users/danie/AppData/Local/Temp/cyntch-delete-32a24c3e-5ee6-4a52-bae8-3c6175cabe96.json`
and `C:/Users/danie/.codex/tmp/cyntch-clerk-default-deletion-policy.log`.
The dashboard evidence is
`C:/Users/danie/.codex/tmp/cyntch-clerk-development-deletion-policy.jpg`.
Run with `CYNTCH_CLERK_DELETION_TEST=true`, a development `CLERK_SECRET_KEY`, and
`CYNTCH_TEST_DATABASE_URL` pointing to the isolated local `cyntch_mobile_test`
database. The check deliberately fails if the default is unsafe.

Before production release, finish and verify Cyntch's custom deletion workflow
on every supported client, apply the same provider policy to new **and existing**
production users, and verify native profile presentation on Android and iOS.
Retain recovery for administrative/out-of-band provider deletion. The provider
test is not native UI evidence and does not open the account-deletion submission
gate or prove protection against late SDK credential writes.

A read-only dashboard inspection on the same date found **Sign-in with mobile
biometrics** disabled in both Cyntch development and production. Neither setting
was changed. Evidence is
`C:/Users/danie/.codex/tmp/cyntch-clerk-biometric-settings.txt`. This narrows the
current exposure to biometric enrollment callbacks; it does not prove general
native identity cleanup or make future enrollment safe. Recheck the effective
provider configuration during release verification, and resolve the late-write
case before enabling biometric sign-in. Existing account-scoped key cleanup and
its failure handling remain in place.

Receipt dismissal no longer stops device identity recovery. The controller reads
the durable deleted-account list after restart and repairs retired Clerk caches,
biometric credentials and billing identity without resetting the current user's
notifications or kiosk. Recovery runs on native sign-in readiness/identity changes
and foreground transitions, with one listener and no polling. Events received
during repair coalesce into a trailing pass; cleanup's own state updates cannot
create a retry loop. Timed-out native checks for the same account share their
still-running operation until it settles. A later event can inspect it again.
Signed-out and Settings screens show a retry notice if a dismissed account still
needs cleanup. Other household members can keep using the app during that repair.

Seventy SQLite/controller/cache/identity checks passed, including restart after
receipt dismissal, late simulated SDK profiles, failure/retry, coalesced events,
native adapter wiring and preservation of another account's notification session
and kiosk. Mobile lint/types, focused test lint and both platform JavaScript exports
passed. Evidence logs are `C:/Users/danie/.codex/tmp/cyntch-retired-identity-*.log`.
This is lifecycle-triggered repair, not a native SDK write fence: ClerkKit 1.6.2's
[`enroll` / `saveLocalCredential`](https://github.com/clerk/clerk-ios/blob/1.6.2/Sources/ClerkKit/Core/BiometricCredentials.swift)
can still finish storing credentials after an earlier cleanup. Immediate prevention
of that write, out-of-band deletion and physical-device verification remain open;
the account-deletion submission gate is unchanged.

### Closed-client scheduler verification

The public `/api/cron` endpoint now reports partial household, native billing or
account-deletion failure with HTTP 503 and an uncached response. A healthy batch
returns 200. Task/occurrence counters advance only after the household commits;
a failed transaction no longer reports its rolled-back task changes as completed
work. Legacy web push retains its committed-record lookup, including candidates
from an uncertain commit acknowledgement. Native notification events remain in
the same database transaction as their task/routine changes.

`tests/integration/recurrence-worker.cjs` runs the built production Next server
on a temporary loopback port with a newly created isolated database schema.
It uses a real clock and Australia/Sydney recurrence, with no browser or mobile
client. It checks early/then-due activation, expiry, recurrence generation,
newer-copy completion, distinct durable native events and retry deduplication.
Injected database failures verify rollback, committed-only counters, partial
failure health and recovery. External provider credentials are explicitly empty;
the test does not send pushes, charge a card or delete a provider identity.

Run `npm run build` first, then set
`CYNTCH_TEST_DATABASE_URL=postgresql://cyntch_test@localhost:55439/cyntch_mobile_test`
and `CYNTCH_RECURRENCE_HTTP_TEST=true` before
`node --test tests/integration/recurrence-worker.cjs`. The temporary server stops
and the isolated schema is dropped after the test. This small-fixture check does
not establish external scheduler cadence, load/p95 timing or real push delivery.
Production rollout and enabling/verifying failure/recovery alerts remain open.
The HTTP scenario, ten calendar/database recurrence checks, root lint and the
production Next build passed on 2026-11-04. The deliberate late-transaction
failure first reproduced an incorrect `tasksUnlocked: 1` despite rollback;
the corrected handler reports zero and its next tick applies the change once.
Final HTTP evidence is
`C:/Users/danie/AppData/Local/Temp/cyntch-recurrence-worker-a30eb3c5-8357-4e38-a805-ff74ddba2854.json`.
No production scheduler settings, alert recipients or application deployment were
changed. Documentation-only mobile edits no longer trigger the native iOS build.

For the controlled load scenario, also set `CYNTCH_RECURRENCE_LOAD_TEST=true`.
Optionally point `CYNTCH_RECURRENCE_TEST_BUILD_ROOT` at a worktree containing
the matching production build. On 2026-11-05 the worker processed 14 households,
including 8 measured fixtures with 580 items on 16 boards. With all clients
closed and two ticks a minute apart, 96 tasks became startable and 96 expired.
Each change had exactly one durable event; an immediate retry made no changes.
Measured from scheduled time to the first post-response database observation,
the median was 32.724 s, p95 was 56.726 s and the slowest change was 59.727 s
(target: p95 below 90 s). This measures the local worker under that workload;
production traffic, external cron reliability and push delivery are separate checks.

The handler now budgets 20 seconds for recurrence/database work and 25 seconds
for its HTTP response, leaving headroom below cron-job.org's 30-second timeout.
Both route aliases export a 60-second platform duration so already-started work
retained with `after()` has time to settle. A response deadline returns uncached
503; it never reports an unfinished provider batch as successful. Native billing
and deletion retain their existing durable jobs/leases for retry. This does not
make legacy web push durable or prove real provider latency/cancellation.

`lib/scheduler-deadline.ts` bounds pool acquisition and each owned transaction.
It uses transaction-local statement/lock/idle timeouts and discards interrupted
connections, rather than merely abandoning a JavaScript query promise. Late pool
checkouts are released, and a late callback cannot issue SQL on the released
connection. Committed households survive; an interrupted household rolls back.
Routine-column discovery is transactional, avoiding a successful cached ALTER
before its transaction commits. No PostgreSQL 17-only setting is required.

On 2026-11-04, the production HTTP test canceled a deliberate 35-second SQL
stall in 5,104ms and stopped a six-household slow batch in 20,137ms. Both returned
503 and recovered on the next request; recurrence events remained deduplicated.
Evidence: `C:/Users/danie/AppData/Local/Temp/cyntch-recurrence-worker-98c3f3dc-2059-4de3-ab39-1500384caa44.json`.
The three deadline tests also verified actual backend termination, late checkout
cleanup, late callback rejection, transaction-local settings and aggregate query
budgets. Billing/deletion worker checks passed, including a scaled-duration route
test retaining the same unfinished billing batch after its response deadline.
Root lint, production build and ten calendar/database recurrence checks passed.
Production deployment, provider behavior, load/fairness and delivered monitoring
alerts still require verification.

### Android optimized startup verification

The first x86_64 release APK compiled with R8 enabled but crashed before the app
opened: Room 2.6.1 creates `androidx.work.impl.WorkDatabase_Impl` through reflection,
and R8 removed its no-argument constructor. The optimizer's usage report confirms
the removal. `expo-build-properties` now preserves that exact constructor through
`extraProguardRules`; generated native files are not edited by hand. WorkManager
2.10.5 already supplies constructor rules for its input mergers and workers.
The corrected optimized APK passed compilation and Android API 36 emulator
checks: welcome, native test-account sign-in, household board, offline completion,
force-stop/restart with the pending change, and automatic upload on reconnect.
Read-only checks of the isolated PostgreSQL database confirmed acceptance and
the dependent reward becoming available. The task was restored through the app;
server state, the restored board and another online restart were verified. No
new crash or ANR was recorded during this corrected-build session. The bundle
runs with Metro stopped and the APK is non-debuggable.

The initial 1.5 GiB Gradle heap failed during optimization. The successful first
APK used a 3 GiB heap, 512 MiB metaspace, two active processors and one Gradle
worker, with Metro and the emulator stopped during compilation. It uses the
local test signing key and development Clerk instance, so it is not a store
artifact. Its HTTPS endpoint temporarily forwards to the isolated local API;
the original mobile environment file was restored after bundling. The first
APK and R8 reports are `cyntch-release-first.apk` and
`cyntch-release-first-r8.zip` in the local evidence directory. The captured
failure is `cyntch-release-first-crash.log`. This distinct release crash does
not explain or resolve the earlier development-client blank screen or ANRs.
The final evidence and hashes are in
`C:/Users/danie/.codex/tmp/cyntch-release-evidence.json`. The emulator and temporary
HTTPS tunnel were stopped, and device networking was restored. The installed
test APK still contains that temporary endpoint; further online release checks
need a live matching endpoint or a new build. These emulator checks do not
establish physical-device performance, remote push, live billing or store readiness.

Local validation used EAS CLI 27.4.1's profile resolver and actual Git archive
copy implementation. The 138-file archive installed from its lockfile and
exported Android/iOS Hermes bundles without the web app's dependencies. Native
configuration introspection and iOS module discovery succeeded. Windows rejects
iOS Prebuild before project generation; native compilation must run on the Mac
runner or EAS. At setup, both the Expo CLI and browser were signed out, so no
EAS cloud build was started. Evidence:
`C:/Users/danie/.codex/tmp/cyntch-eas-archive-evidence.json`.

On Windows with long paths disabled, the verified local emulator build uses
CMake 3.31.6 from the Android SDK and Expo's object-path limit. Run from the
canonical repository path: mixing a mapped drive with canonical dependency paths
can make React Native code generation fail with a different-roots error.
After prebuild and with `JAVA_HOME` and `ANDROID_HOME` configured:

```powershell
Set-Location C:\dev\HouseFlow-native\mobile\android
.\gradlew.bat :app:assembleDebug '-PreactNativeArchitectures=x86_64' '-Pandroid.cmakeVersion=3.31.6' '-Pexpo.android.cmakeObjectPathMax=240' --max-workers=2
```

These are local build options, not changes to the generated native project or to
cloud release builds. If CMake reports an existing cache from a different path,
archive that generated cache so it can regenerate at the canonical path.
Quote the property arguments in PowerShell; unquoted dotted property names can
be split into separate arguments and override Gradle's Android extension.

The SQLite outbox is account scoped and stores each completion and its cached
result in one transaction. Device-clock correction occurs only for pending edits;
frozen operation IDs and timestamps make interrupted uploads safe to retry.
The server requires migrations `0018_completion_operations.sql` and
`0019_occurrence_status_versions.sql` before these APIs or the updated web
completion handler are deployed. Server status revisions cover web, mobile and
scheduled updates. The device keeps the latest server state separately from its
pending edits, so delayed responses cannot undo a newer status after sync.

The Routines tab provides native template and task management, assignments,
prerequisites, rewards and task activation/expiry rules. Existing task edits update the screen immediately and
commit to a separate SQLite queue. Unfinished task forms stay on this device;
submitting a form atomically clears its draft and retains its saved operation.
New routines, tasks, manual routine starts and schedule edits use durable requests
with immutable operation IDs. Apply `0020_planner_creations.sql`,
`0021_routine_start_receipts.sql` and `0022_routine_schedule_receipts.sql`
before deploying this version of the planner API. Receipts commit with the created item, allow retries at full quota, and
remain after item deletion to prevent resurrection. The queue is scoped to the
account, preserves rejected requests for review, and stops uploading after a
confirmed management-role revocation.

**Try it out** opens an in-memory practice copy of the selected template and its
upstream prerequisites, including links from other routines. Tasks unlock after
their prerequisites are completed in practice; Start again resets the copy.
Practice is available offline for loaded templates and never saves completions,
changes live runs or sends notifications. It preserves the website's task-order
preview scope: time and expiry rules are exercised by live runs. A refresh cannot
rewrite an open practice session; reopening captures the latest locally saved
template. Portrait and large-text layouts use a scrolling list, while wider
layouts show progress and reset controls beside the tasks.

A start request returns after saving locally and uploads in the background. It
requires a connection initially and all earlier planner changes to be synced or
reviewed; it does not wait for a network flush before saving. Template edits and
duplicate starts are blocked while that template has an unresolved start. The
server assigns the start time on its first committed attempt. Copying tasks,
dependencies and assignments, completing older runs when enabled, and recording
the receipt all share one transaction. Today refreshes after acknowledgement.

Task timing supports fixed dates, calendar days, weekdays, month days, elapsed
durations and rules relative to actual availability. Native date/time pickers
use the household timezone; on short Android windows they appear inside the
scrolling form to keep calendar dates and the Done control accessible. Timing
uses the same durable edit queue as task details, including offline recovery.
Omitted timing is preserved, while explicitly clearing it removes legacy saved
times as well. Template rules resolve against each new run, not the edit time.
Timezone conversion chooses the first occurrence of repeated clock times and
moves missing times forward by the daylight-saving gap.

Recurrence generation now uses the household timezone in both the background
scheduler and web catch-up path. Interval dates are stable; legacy schedules with
no start date acquire one from their last generated household date, or today if
they have never generated. Monthly ordinal weekdays are counted correctly, and
monthly/yearly dates missing in a shorter month use its last day (including
February 29 in non-leap years). Previews use the same household timezone.
Generation and editor writes share the household lock, and schedule edits cannot
replace server-owned generation watermarks. Production scheduler throughput and
the delivery window still need verification.

The native schedule editor supports daily, weekly, monthly and yearly rules,
calendar dates and ordinal weekdays, household-timezone previews, and completing
older runs when a fresh copy starts. Unfinished forms persist locally; submitting
one atomically replaces its draft with an immutable SQLite request and updates
the cached schedule. Uploads run separately from the save interaction. The server
compares the editable rules with the form's starting version, ignoring generation
watermarks. Conflicts retain the intended changes for review against the current
household settings; replacing a rejected request is atomic. A late replay returns
its receipt without overwriting newer rules. After a downgrade, households can
remove recurrences or disable automatic completion without re-enabling automation.

The Runs tab lists active and past runs with stable, paginated history. Opening a
run saves its details in account/household-scoped SQLite storage. Task completion
and reopening use the same durable outbox as Today, including when the entire run
has already left Today. Pending changes move runs between the cached lists;
versioned responses cannot undo newer acknowledged task states. Membership loss
clears cached history, and discarding a rejected change refreshes the affected run.
Reads do not require Premium or mutate historical completion states. Apply
`0023_run_history_index.sql` before deploying the run-history API.

The remaining run management actions, physical-device kiosk verification,
remote push verification and store billing are still under development. Rename/delete
actions currently require a connection; extending interruption recovery to those
remaining management actions is still required. Automatic cross-device refresh
and its five-second target also remain to be implemented and measured.

The native notification settings API (`/api/mobile/notifications`) is separate
from the old web/account-wide preferences. Migration `0024_native_notification_settings.sql`
adds registrations and preferences scoped to account, installation and household.
The client must retain a random 32-byte hexadecimal installation secret in secure
storage and send it as `X-Cyntch-Installation`, alongside the existing account and
device headers. Registration and preference writes include a frozen operation ID
and the last server revision. A replay acknowledges the original write; it must
not replace a newer cached revision. A 409 version conflict requires fetching the
current state before preparing another operation. Registration with a null token
disables delivery without deleting preferences. Token rotation and account switches
invalidate previous registrations; a device UUID alone cannot take over another
installation. Receipts and settings commit together. Current household membership
and role restrict both reads and writes. Expo tokens stay on the server and are
not included in API responses or error diagnostics.

The Settings screen now includes the native permission prompt and per-device,
per-household notification editor for all 15 event types. Member selections include
profiles without email; current role and membership limit the choices. Quiet hours
use an explicit timezone, and notification details are private by default. Choices
update immediately and persist in SQLite before uploading. An immutable request
survives interruption, newer choices wait behind it, and a rejected version conflict
requires explicit review. Foreground/reconnect retries use persisted backoff.

Permission inspection does not prompt. Android creates one channel per event type
before asking permission; iOS provisional permission is distinguished from normal
alerts. Token refresh failures preserve existing registrations and queued tokens.
The installation secret is retained in SecureStore. Token rotation is observed.
Background settings sync and kiosk integration remain to be implemented. An EAS project ID and
FCM/APNs credentials must be configured before push can register and deliver.
This build reports their absence while allowing preference editing. A registration
or a passing JavaScript export is not evidence of delivered push.

Migration `0027_native_notification_sessions.sql` binds registrations and queued
deliveries to the authenticated Clerk session. The API checks that the session
header matches the current token. Sign-out commits a local revocation before
ending authentication; a separate controller can upload it while signed out,
including after restart. Its installation capability can only disable the named
session. Server tombstones and the installation transaction lock reject late
registration/replay even when revocation arrives first. Old-session delivery
jobs are suppressed, and old provider errors cannot disable a newer session
even if its Expo token is unchanged.

Local sign-out removes only the device registration cache. Household preferences,
unfinished task edits and planner changes remain account-isolated. Notification
cache writes also check the local session inside their SQLite transaction.
Native tray/scheduled-notification/token cleanup is durable and serialized with
token creation. A stalled provider operation times out for the notification UI
while retaining its ordering; task saving and sign-in do not wait for it. Native
cleanup retries on resume/reconnect and before token registration. Notifications
already handed to APNs/FCM cannot be recalled by server revocation alone; native
background delivery and real-device checks are still required before enabling
the delivery gate. Retried cleanup removes obsolete-session notifications by ID;
it preserves the current session's tray items, scheduled alerts and launch response.

Native notification payload version 3 contains validated event/entity IDs, session
identity, expiry and display-policy metadata. Foreground presentation uses an
in-memory policy with no storage or network waits: current permission, household
access/role, local event/member choices, quiet hours and privacy all apply. A hash
of the category's member selection rejects queued alerts after selections change
without including family member IDs in every payload. Provider TTL controls expiry;
an inaccurate device clock is not used to discard otherwise valid alerts.

Explicit taps commit to a session-scoped SQLite inbox before the OS response is
cleared. The latest tap wins; duplicate deliveries do not reopen handled destinations.
Navigation waits for startup, revalidates online household access and opens only
known in-app destinations. Task notifications bring the referenced task to the
top of its run; routine notifications open that run and membership events open
the household. Cached runs remain available offline. Taps cannot perform task
changes, route to arbitrary URLs or bypass current household roles. Kiosk routing
restrictions still need integration before kiosk mode is released.

Migration `0025_native_notification_events.sql` captures all 15 native event types
in the transaction that changes a task, run or household membership. It records
the first state and compares it with the final state at commit, so recalculation,
assignment replacement, failed writes and replayed receipts do not create
intermediate or duplicate events. Manual boards emit task events without claiming
to be routine runs. Recurrence generation and replacement of an older run have
distinct events; replacement suppresses per-task completion alerts and preserves
cancelled runs. Availability includes reopened tasks and newly assigned startable
tasks, with the latter targeting only newly added assignees.

The outbox writes no network requests and performs no per-device delivery during
task saving. Its pending records survive a stopped server process. Apply this
migration before deploying the updated task/timer writers. Local schema tests
cover commit/rollback, concurrent completion, household deletion and 100-task
completion. Real route tests cover routine starts, both recurrence generators,
timer availability/expiry and task creation/editing without premature alerts.

Migration `0026_native_notification_deliveries.sql` adds unique per-device delivery
records and recoverable leases. The server worker rechecks membership, role, device
permission, preferences, quiet hours and current task/run state before sending.
Status versions prevent old readiness events resurfacing after a complete/reopen
cycle. Newly registered devices do not receive earlier queued events. Private
payloads omit names, and Android channel IDs match the native settings channels.

`NATIVE_PUSH_ENABLED=true` enables post-response attempts after household writes
and the scheduled recurrence handler. The authenticated
`GET /api/internal/notifications` endpoint can also drain a bounded batch using
the same `CRON_SECRET`. `EXPO_PUSH_ACCESS_TOKEN` supplies Expo enhanced-security
authentication when configured. Keep this gate off until credentials, sign-out,
kiosk behavior and actual device reception have been verified. No deployment or
external scheduler settings have been changed during local development.

The worker stores Expo tickets, waits 15 minutes before checking receipts, backs
off failures, expires stale alerts and conditionally unregisters invalid tokens.
An old receipt cannot revoke a rotated token. A successful receipt is recorded as
`provider_accepted`, not proof that a device displayed a banner. Unknown receipts
become an explicit failure after 24 hours without resending an accepted ticket.
If sending succeeds but its acknowledgement is lost, a retry may occur; stable
delivery IDs, collapse IDs and Android tags reduce duplicate presentation.
Provider requests are bounded to 100 messages and use an eight-second timeout.
Production queue-lag/throughput testing, monitoring and outbox retention cleanup
remain required before launch. All current provider tests use controlled HTTP
responses; no real push has been sent.

From the repository root, run `node --experimental-sqlite --test tests/mobile-*.test.cjs`.
PostgreSQL tests additionally require `CYNTCH_TEST_DATABASE_URL` pointing to a local
database named `cyntch_mobile_test`; their safety guard rejects other destinations.
They create isolated fixtures and clean up their own data.
Also run `node --test tests/planner-creation-db.test.cjs` with that database URL
to exercise creation receipts through the actual flow route and PostgreSQL.

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

The native planner was exercised against the same local API: create a routine,
create an assigned task, add a reward with a prerequisite, edit a task offline,
force-stop/restart, reconnect and verify its new title in PostgreSQL. The offline
edit remained queued after restart and uploaded without another user action.
One routine and two tasks produced exactly three creation receipts. Portrait
and landscape planner layouts were inspected; a horizontal selector sizing bug
found during this walkthrough was corrected. Starting the template then copied
its current tasks into Today. Free-plan active-run admission was also exercised.

Task timing was verified on the Android emulator with a temporary local Premium
fixture: select a date and time with native pickers, set expiry after availability,
save offline, force-stop/restart, reconnect, and confirm both rules in PostgreSQL.
The server remained unchanged offline. Calendar selection and Done were also
exercised in landscape; this caught and fixed the stock dialog's clipped calendar.
The fixture was returned to Free and its timing cleared through the app.
`tests/task-timing.test.cjs` covers validation, Free/Premium enforcement, calendar
boundaries and full/half-hour DST transitions. SQLite and PostgreSQL planner tests
cover timing durability, coalescing, rollback and stale retries.

Durable routine starts were verified on the Android emulator: a Free-plan
capacity rejection survived force-stop/restart, completing the active run freed
capacity, and retrying the saved start produced one new run with its two tasks
and one receipt. Today refreshed automatically. Automated SQLite/PostgreSQL
tests additionally cover lost replies, duplicate local submissions, mutation
barriers, replay at capacity, removed-run tombstones and transaction rollback
including automatic completion of older runs.

`tests/recurrence-calendar.test.cjs` covers all recurrence frequencies, interval
phases, UTC date boundaries, full/half-hour DST, calendar limits and independence
from the host timezone. `tests/recurrence-scheduler-db.test.cjs` invokes both real
generation implementations against PostgreSQL, checking copied task timing,
concurrent retries, rollback, capacity gating and stable legacy anchors. These
tests use isolated schemas and mocked notification delivery; they do not verify
production scheduling or mobile push delivery.

Native schedule editing was verified on the Android emulator: a monthly ordinal
rule and the complete-older option survived a force-stop as an unfinished draft,
then survived a second restart as an offline saved request. PostgreSQL stayed
unchanged while offline. A simulated competing edit caused a visible conflict on
reconnect; reviewing and saving the intended schedule produced one receipt.
The review editor was inspected and saved in landscape. Removing the recurrence
and disabling automatic completion also succeeded after restoring the fixture to
Free. `tests/routine-schedule.test.cjs`, `tests/routine-schedule-db.test.cjs` and
the mobile planner tests cover validation, access/entitlement checks, transaction
rollback, immutable retries, concurrent changes and interruption recovery.
Android and iOS JavaScript exports pass; this does not establish native iOS behavior.

On 2026-11-04, the Runs tab was verified against the local API on Android: reopen
a completed run's task offline, force-stop/restart, reconnect, and confirm one
server receipt and the run's transition to active. Completing it again returned
it to history. The server stayed unchanged while offline. Portrait and the
two-column landscape list, landscape detail scrolling and native Back dismissal
were inspected. The temporary Premium fixture was returned to Free and the run
to its original completed state. SQLite tests cover rollback during removal,
discarding rejected edits, stale replies, role changes and household revocation;
PostgreSQL tests cover history pagination including equal/microsecond timestamps,
membership checks and read-only behavior. The completion-route integration test
now runs its historical migrations in an isolated schema, leaving emulator data
and public-schema constraints untouched.

Changing Android system font size previously recreated the activity and produced
an Expo Router multiple-linking-handlers warning. The font-scale configuration
plugin and emulator verification below address this; release-build verification
on the supported OS/device matrix remains required. No physical
device performance measurements, iOS native build, store release or household
pilot has been completed.

Notification settings were verified on the Android 36 emulator on 2026-11-04:
deny and then allow the real OS permission prompt; select completed-task alerts
for a profile without email and quiet hours while offline; force-stop/relaunch;
confirm both choices remain; reconnect and confirm the saved choices in PostgreSQL.
The server stayed unchanged while offline. All five amended routine/member events
were independently enabled and persisted. Portrait and landscape scrolling and
Done were inspected, including the settings controls at 1.6× system font size.
The Android APK rebuilt and installed successfully with the notification plugin;
Android and iOS JavaScript exports passed. Native build outputs are excluded from
Metro's watcher to avoid processing generated files during rebuilds.
A custom-sound warning was fixed by using Android's default
channel sound. SQLite/controller tests cover lost replies, disk rollback, coalesced
edits, stale registration receipts, review, account isolation, household removal,
permission failures and iOS provisional status. No real remote push was delivered.

The native event outbox and server delivery worker were verified on 2026-11-04
against isolated PostgreSQL schemas and controlled provider responses. All 127
non-billing tests passed, including rollback, concurrent expansion, resumed leases,
stale acknowledgements, lost replies, quiet hours, access revocation, token rotation
and provider receipt handling. The production Next.js build, root lint/typecheck,
and mobile lint/typecheck passed. Migrations 0025 and 0026 were applied only to the
local emulator test database. The delivery gate remains off; this verification
does not establish real FCM/APNs delivery, physical-device performance or production
scheduler throughput.

Session cleanup was verified on the Android emulator on 2026-11-04: sign out with
Wi-Fi and mobile data disabled, force-stop and relaunch to the signed-out screen,
inspect the persisted pending revocation, reconnect without signing in, and
confirm the server tombstone. Native email-code sign-in then created a different
session and registered it with the local API; saved household notification
preferences retained revision 7. The build lacks FCM/APNs credentials, so actual
provider token invalidation remains unverified. Controlled native tests cover
cleanup failure, interruption, ordering, repeated connectivity events and timeout.
All 137 non-billing tests passed with real local PostgreSQL fixtures; root/mobile
lint and typecheck, the production Next.js build and Android/iOS JavaScript exports
passed. Migration 0027 was applied only to the local emulator test database.

Foreground banners, Android notification-pane entries, routine taps and task-focused
taps were verified on the Android 36 emulator on 2026-11-04 using local test
notifications. Disabling household alerts suppressed foreground presentation.
Portrait and landscape run details were inspected. Killing the background app
process and then tapping a task notification reproduced a cleanup race; after
the fix, the app relaunched into the intended task and acknowledged its durable
inbox entry. The original household notification preferences were restored.
All 149 non-billing tests passed, including real SQLite/PostgreSQL fixtures,
server-to-client payload validation, access changes during navigation, local
settings enforcement and retried cleanup across sessions. Root/mobile lint and
typecheck, the production Next.js build and Android/iOS JavaScript exports passed.
These checks do not establish remote FCM/APNs reception or native iOS behavior.
The Android notification icon still uses a placeholder silhouette and needs
a dedicated monochrome asset before release.

Native kiosk backend protection was verified on 2026-11-04 in isolated PostgreSQL
schemas. Migration 0028 adds independent device/session locks, replay-safe
activation and unlocking, and recovery through a different authenticated session
of the same parent. Recovered sessions remain blocked. Restricted bootstrap data
contains only selected members and their tasks; completion permissions are checked
again under the household write lock. Authenticated parent APIs reject locked
sessions even without a client kiosk flag. Activating a lock waits for previously
admitted requests. Kiosks suppress queued and new native push deliveries without
changing another device's preferences or sending a backlog after unlocking.

Eight kiosk integration tests cover independent tablets, access changes, invalid
credentials/configuration, interrupted transactions and all protected API routes.
The completion-route test also covers real restricted completion and reopening.
All 157 non-billing tests and 19 billing regression tests passed; billing
database tests used their own temporary database, without Stripe network calls.
Root/mobile lint and typecheck and the production Next.js build passed. Migration
0028 was applied only to the local emulator test database. Deploy it before the
guarded API routes or notification worker. Request admission uses a separate pool
of at most two connections in addition to the existing five working connections;
production connection capacity and latency still need measurement.

The native PIN screen, restricted cache lifecycle and recovery UI are now connected
as described below. The backend checks above alone do not establish device coverage.

The offline PIN verifier stores a six-digit PIN's verifier, random device secret and server exit
capability exclusively in OS secure storage, using WHEN_UNLOCKED_THIS_DEVICE_ONLY
on iOS. Each attempt is durably reserved before verification. Five failures start
a 30-second cooldown, increasing to a 15-minute cap. A process restart restarts
the outstanding cooldown, so changing the wall clock or repeatedly reopening the
app cannot skip it. Checking the PIN does no network work and starts no polling
timer. Missing/corrupt secure data or write failures require recovery or a retry;
they never release an unlock capability. This protects the app lock, not a rooted
device or a compromised OS keychain.

Six controlled verifier tests passed for retries, concurrent attempts, secure
storage failures and interruption during verification. On the Android 36 emulator,
the real SecureStore-backed verifier accepted the correct PIN, persisted five
failures, retained its cooldown after the background app process was killed and
relaunched, and successfully removed the temporary test credential. Root/mobile
lint and typecheck and Android/iOS JavaScript exports passed. Native iOS storage
behavior remains unverified; subsequent Android UI verification is recorded below.

Native Settings now lets managers choose visible/editable household members and
enable a six-digit PIN lock. The lock is read before parent navigation mounts.
Activation commits restricted cache pruning and the lock together, refuses pending
edits or unfinished planner drafts, and fences late parent-cache writes. Only
permitted task toggles remain available. Hidden prerequisites lose their titles,
IDs and assignee IDs; visible prerequisites retain their explanations. An
authenticated parent-access revocation removes the restricted task cache and
retains pending changes as rejected. Temporary errors preserve offline tasks.

PIN verification saves an unlock intent before showing parent controls, even
offline. Network work runs separately and survives interruption. Forgotten-PIN
recovery persists the old identity before sign-out and waits for a fresh session
of the same parent. Migration `0029_native_kiosk_recovery_receipts.sql` adds durable
recovery and cancellation receipts, including when activation never reached the
server. Late activation cannot undo either outcome. Apply 0029 before deploying
the updated kiosk guard/store; it has been applied only to the local test database.
The client retains an unconfirmed lock until verified PIN access or authenticated
recovery, including when the OS credential is unavailable.

Android verification on 2026-11-04 used emulator-5554, Android 36, the native
Expo 58 / React Native 0.88 development build, current Metro source, and the isolated
`Cyntch emulator family` household. The fixture includes a parent and Alex's
email-less profile, a school-bag task and a dependent bedtime-story reward.

| Cases | Steps and observed result |
|---|---|
| K02, O01, O02 | Enable only Alex's tasks, disable Wi-Fi/data, complete the bag task, kill the background app process, relaunch. The restricted board, completion and pending operation remain. |
| K03 | Open `cyntch://settings` while locked. Parent tabs remain unavailable and the restricted board stays visible. |
| K04 | Submit an incorrect PIN, then the correct PIN offline. The first keeps the lock; the second exposes parent controls with an unsynced-unlock notice. Kill/relaunch offline: the unlock intent and task queue remain. |
| O02 | Restore connectivity. Server lock becomes unlocked, completion uploads, dependent reward unlocks, and the local operation/lock records clear. Reopen the bag task to restore the fixture; no pending operations remain. |
| U01, U02 | Inspect kiosk portrait/landscape and 1.6× text, including PIN controls. Landscape uses a member sidebar at normal text size; the single header leaves task space. The initially reproduced activity-recreation warning was then fixed and rechecked as described below. |
| K04 | Enable again, select forgotten-PIN recovery, sign out and authenticate through native Clerk email-code UI using its reserved test identity. The display remains restricted through sign-out. Fresh parent authentication creates a server recovery receipt, retires the original kiosk session and clears the local lock. Parent tabs return. |

Server notification preferences remained at revision 11 across activation, offline
unlock and recovery. Wi-Fi/data, portrait and normal text size were restored.
Screenshots and test logs are in the local Codex temporary directory, named
`cyntch-kiosk-landscape-compact.png`, `cyntch-kiosk-landscape-large-text.png` and
`cyntch-kiosk-final-*.log`.

All 179 non-billing tests and 19 isolated billing regression tests passed with real
SQLite/PostgreSQL fixtures. Kiosk tests cover lost replies, rollback, cancellation,
fresh authentication, access revocation, hidden prerequisite data, stale replies,
offline unlock and interruption. Root/mobile lint and typecheck, the production
Next.js build and Android/iOS JavaScript exports passed. Native iOS, physical
phones/tablets, device reboot/app upgrade, multi-device kiosk UI, remote pushes,
release performance and the household pilot still require their specified checks.

The Android font-scale config plugin adds `fontScale` to the generated main
activity's existing configuration-change handling. React Native 0.88 updates font
metrics/layout when the activity receives configuration changes and resumes.
This preserves open forms without modifying generated native files or hiding
navigation warnings. An Android development APK rebuilt successfully and replaced
the installed build with an active kiosk lock; the restricted board and secure PIN
remained available afterward.

On that build, open Parent access and enter four PIN digits, background the app,
change system text scale from 1.0 to 1.6, and resume. The same Android activity and
single React root remained; the modal and entered digits survived. React Native
reported fontScale 1.6, the visible text resized, and no duplicate-linking warning
was emitted. Returning to 1.0 also preserved state, and a correct PIN unlocked and
synced successfully. Evidence: `cyntch-font-scale-pin-retained.png` and
`cyntch-font-scale-build.log` in the local Codex temporary directory. Root/mobile
lint and mobile typecheck passed. This verifies a development APK replacement,
not store delivery, database-version migration or the complete OS/device matrix.

## Native subscription verification foundation

Migration `0030_native_billing.sql` adds household billing identities and verified
Apple/Google subscription records separately from Stripe. An identity is an opaque
UUID, reused on reinstall and bound to one household/environment. Deleting a
household retires its identity while retaining purchase ownership; restore cannot
silently attach an old purchase to another household. RevenueCat must use identified
customer IDs from these records, with **Keep with original App User ID** configured
for both production and sandbox. Anonymous purchases and store family-sharing must
not be enabled: Cyntch already shares Premium with the household's members.

Server verification uses RevenueCat API V2 to check original/current customer,
store, ownership, environment, approved product and access state. Pagination must
finish before any access changes commit. API V1 is used only when a grace period
requires its explicit expiry, checked against the same subscription transaction.
Provider failures retain the last verified deadline; they never extend it.
Database revisions are reserved before network requests so a delayed response
cannot overwrite a more recent completed verification. No database transaction is
held during provider requests, and credentials cannot follow redirects/pagination
to a different origin/customer.

The same paid-access predicate now covers household quotas, automation and free
household admission. A Stripe hold does not revoke an independent valid store
purchase, and revoking a store purchase does not erase paid Stripe or permanent
owner access. Downgrades retain household data.

This foundation is **disabled by default and is not a complete purchase flow**.
No store/RevenueCat account was provisioned, no purchase SDK was installed, and no
real store purchase or remote verification was performed in this stage. Before
enabling it, finish authenticated billing endpoints, duplicate-purchase prevention,
purchase/restore/management UI, provider configuration and the B01–B04 device/sandbox
tests. Durable lifecycle handling is implemented below; its remote delivery still
needs verification. The migration has only
been applied inside disposable local test schemas, not production.

Server configuration, once the full flow is ready:

- `NATIVE_BILLING_ENABLED=true` and `NATIVE_BILLING_ENVIRONMENT=production`.
  Sandbox is permitted only with an explicit development/test or Vercel preview
  runtime; a production Vercel environment cannot accept sandbox grants.
- `REVENUECAT_PROJECT_ID`, `REVENUECAT_V2_SECRET_KEY` (read subscriptions), and
  `REVENUECAT_V1_SECRET_KEY` belong in protected server configuration, never the app.
- `REVENUECAT_NATIVE_PRODUCTS` is a JSON array of four objects containing
  `revenuecatProductId`, `storeProductId`, `store` (`app_store`/`play_store`) and
  `interval` (`monthly`/`yearly`). These are real provider/catalog identifiers, not
  client-supplied product choices. Both intervals are required for each store.

`tests/mobile-native-billing-db.test.cjs` uses real isolated PostgreSQL transactions
to verify lifecycle access, household isolation, retirement, rollback, out-of-order
responses, sandbox exclusion, scheduler access and admission limits.
`tests/mobile-native-billing-provider.test.cjs` uses synthetic provider responses
to exercise pagination, ownership, current access decisions, explicit grace expiry,
malformed responses and safe transport failures. These tests do not establish
live RevenueCat/store compatibility; that remains a release prerequisite.

Verification on 2026-11-04: all 197 non-billing regression tests (including the 18
native billing checks), 19 isolated web-billing tests, root/mobile lint and
typecheck, and the production Next.js build passed. No live charge, production
database change or production deployment was made.

Provider references checked on 2026-11-04: [Expo IAP](https://docs.expo.dev/guides/in-app-purchases/),
[RevenueCat V2 subscription model](https://www.revenuecat.com/docs/api-v2/subscription-data-model),
[customer subscriptions](https://www.revenuecat.com/docs/api-v2/customer/resources),
[V1 grace expiry](https://www.revenuecat.com/docs/api-v1/customer-info-model), and
[restore behaviour](https://www.revenuecat.com/docs/projects/restore-behavior).

## Durable native billing updates

Migration `0031_native_billing_jobs.sql` adds event receipts and persistent
reconciliation jobs. `POST /api/billing/native/webhook` requires both the configured
Authorization header and RevenueCat's HMAC-SHA256 signature over the exact raw
body. Signature timestamps allow five minutes of delivery skew; old events remain
acceptable when the provider signs a fresh retry. Bodies are limited to 256 KiB.
Configure HMAC signing in the provider dashboard before connecting this endpoint.

Receipt acceptance and every affected household job commit together before the
response. Duplicate events reuse their receipt; a reused ID with conflicting
event identity is rejected. Webhook payment/expiry claims never grant access.
Known customer IDs, including both sides of transfer events, trigger fresh
server-to-server verification. Other environments/apps, unknown customers and
dashboard TEST events cannot create grants. Receipts retain only the event envelope,
a fingerprint and known opaque account IDs; customer attributes are not stored.

An `after()` callback prompts processing but is not the durable retry mechanism.
Jobs have 60-second leases, increasing request generations and verification
revisions. An interrupted worker can be replaced, late results cannot overwrite
newer verified state, and events received during a fetch remain pending. Retriable
failures use persistent backoff and honor bounded provider `Retry-After` values;
new webhook deliveries do not bypass that backoff. A busy household write makes
verification retry without waiting for the household lock.

The existing authenticated `/api/cron` starts billing alongside recurrence work
when `NATIVE_BILLING_ENABLED=true`, and includes its health in the response's `ok`.
The separate authenticated `GET /api/internal/billing` is available for an
independent schedule and returns HTTP 503 for application-level failure. It uses
the existing `CRON_SECRET`. Processing is bounded to five jobs/20 seconds by
default, with pending work retained for later invocations. Paid accounts receive
hourly missed-event checks (sooner near expiry), billing trouble receives
five-minute checks, and empty/expired accounts receive daily checks. Deleted
households stop scheduled checks. Health reports due jobs, persistent errors,
oldest due age and attempt counts without revealing customer/provider payloads.

Additional protected server configuration:

- `REVENUECAT_APP_IDS`: the two native dashboard app IDs, comma-separated.
- `REVENUECAT_WEBHOOK_AUTHORIZATION`: the exact header configured in RevenueCat,
  preferably `Bearer ` followed by a cryptographically random secret.
- `REVENUECAT_WEBHOOK_SIGNING_SECRET`: the integration's HMAC signing secret.
  Both secrets must be at least 32 characters; neither belongs in the mobile app.

Apply 0030/0031 before enabling the feature. The production gate is still off.
No provider integration, production migration or external scheduler setting has
been changed in this stage. Delivery from RevenueCat, Apple and Google remains
unverified until those accounts/catalogs are configured and sandbox events are
sent through a deployed endpoint.

`tests/mobile-native-billing-jobs.test.cjs` exercises real PostgreSQL rollback,
duplicate/concurrent delivery, lease takeover, delayed responses, events during
verification, provider backoff, periodic recovery, household contention, transfer
isolation and retired accounts. It also exercises the actual webhook/cron handlers
with signed synthetic requests and verifies the household scheduler integration.
Provider reference: [RevenueCat webhook authentication, retries and event handling](https://www.revenuecat.com/docs/integrations/webhooks).

## Native billing admission and recovery

`GET/POST /api/mobile/billing` now supports household plan status, identified
store setup, purchase admission, cancellation and durable purchase/restore
verification. Requests must match the authenticated account and session and carry
the installation's device ID. Members can read plan limits; only the household
owner can access provider details or billing actions. The existing kiosk guard
protects both native billing and web checkout. Mobile API replies are checked
against account, session, household, device and operation before use.

Migration `0032_billing_purchase_attempts.sql` adds a shared household purchase
reservation and preserves verified `pending_payment` state. Apply 0030–0032 before
enabling native billing. Reservations are isolated by production/sandbox
environment; sandbox verification cannot retire a production hold. A mobile
attempt reserves ten minutes for preflight;
permission to open the store sheet extends it once to 24 hours. Replaying an ID
does not extend that hold or revive an expired/released attempt. Cancellation is
scoped to the original account/session/device. Provider verification is queued
before the external purchase so termination cannot lose the recovery work.
Unresolved native attempts receive a server check every minute, subject to
provider failure backoff. A confirmed subscription retires its temporary hold
and resumes the usual hourly or billing-trouble verification cadence. Pending payments and paused/retrying/unknown store
subscriptions block a second subscription even when they grant no Premium access.

Before native purchase permission is returned, current RevenueCat and Stripe
state is fetched outside the household write transaction; ownership, Premium
access and the reservation are then checked again under the household lock.
Client purchase claims never grant access. Restore/refresh requests commit a
verification job before returning; provider outages preserve the retry.

With native billing enabled, web checkout uses the same reservation and verifies
prior native billing activity. A new web attempt holds one hour; a reused open
Checkout retains its actual provider expiry. Stripe create retries reuse the
persisted integration label, expiry and idempotency key, including after a lost
provider response. Another device/provider/interval cannot start while that
attempt remains open. With the gate off, existing web checkout requires no new
reservation table. Stripe prices and tax configuration are unchanged.

Add the store-specific **public** SDK keys as `REVENUECAT_IOS_PUBLIC_KEY` and
`REVENUECAT_ANDROID_PUBLIC_KEY` on the server. Only the matching public key,
approved product IDs and opaque household customer ID are returned to the app.
Secret provider keys remain server-only. React Native Purchases 11 is installed
and included in the rebuilt Android development app. Other development builds
must also be rebuilt before using its native SDK. The native settings card and
SDK interaction flow are connected as described below.

Reservations protect Cyntch-initiated flows. A delayed external store approval
can outlive a reservation, so duplicate detection and provider management remain
necessary; this is not a promise that unrelated store actions can be locked.
Store credentials/catalogs, real purchase sheets, live sandbox lifecycle events
and store submission remain unverified. The production gate remains off.

## Native subscription settings and interruption recovery

Settings shows the selected household's server-confirmed plan, limits, billing
sources and verification state. Owners can request monthly/annual store prices,
purchase, restore and open management for the current device's store. Localized
prices come from the store; the app rechecks product, amount and currency before
purchase. Google purchases use the approved auto-renewing base plan rather than
an automatically selected trial offer. Existing subscriptions block another
purchase, including pending payment and subscriptions needing attention.

The SDK loads on demand. A process-wide queue keeps the opaque household identity
unchanged throughout each store operation. Normal purchase setup starts with an
explicit household identity; accepted-account cleanup now uses the SDK's logout,
which creates a detached anonymous identity (see the cleanup section below).
Account, session, selected household, connectivity and kiosk access are checked
at asynchronous boundaries. Explicit sign-out fences new requests immediately,
before persistence or React unmount. A sheet already presented by the OS retains
its original household identity until its callback completes.

SQLite schema 10 stores only scoped operation IDs and recovery stages, never
receipts or SDK customer objects. Purchase intent is durable before admission or
store presentation. Restart cancels an untouched preflight or verifies an
uncertain store result; it never reopens a purchase automatically. A remounted
runtime waits for an operation still executing in this process, preventing early
verification from discarding a live restore. Late responses cannot overwrite
another household's state or a replacement operation. Recovery metadata can still
be saved after sign-out or kiosk entry; new presentation cannot.

Store/network calls hold no local database transaction. Task completion remains
independently writable while the store sheet waits. Pending recovery uses durable
backoff and lifecycle/connectivity events. Idle plans do not continuously poll.
Only server-verified entitlements can enable Premium.

`tests/mobile-billing-client.test.cjs` exercises the actual SQLite store and
controller with synthetic provider responses, including disk failure, lost
acknowledgements, process restart, active-sheet remounts, household/account/kiosk
changes, price changes, pending payment and concurrent task saving. SDK adapter
tests cover identity serialization, approved base-plan selection and cancellation.

Android emulator checks cover the actual server-backed Free plan and synthetic
price displays in portrait, landscape and enlarged text. The two price cards sit
side by side on a wide screen and stack when text is enlarged. Display fixtures
are temporary runtime-only values and are removed after inspection; they do not
enable billing or make purchases. Physical-device and iOS checks remain required.

This is not yet the complete subscription release: store accounts/catalogs and
real store sandbox lifecycle verification remain outstanding, as do policy/support
links and real account verification of management on both platforms. Web reservations also still
need a polished change/cancel recovery flow. Keep the production billing gate off
until the complete purchase and management flows have been verified.

## Existing subscription management

Owners can open the recorded billing provider's subscription centre even when
purchase offerings or SDK keys are unavailable. Management
rechecks household ownership and the recorded provider before opening the fixed
Apple or Google management URL. It does not configure a purchasing identity or
start a purchase. Account, household and kiosk changes fence delayed actions.
Native source history still requires the native integration gate to be enabled;
that gate controls entitlement reads as well as purchase integration. Website
cancellation also works while the native integration gate is off.
On iOS, Apple subscriptions open the native account subscription URL; on Android,
they open Apple's documented web subscription page. Google subscriptions use
Google Play's subscription centre on either platform. These actions are shown
only for existing recorded providers, with one button per provider and a reminder
to use the original purchasing account. They do not promote another purchase
method. Platform review must still assess the resulting provider pages and
territory rules before release.

An existing website subscription has a **Cancel website subscription** action.
The backend creates a short-lived Stripe cancellation session after checking the
stored customer/subscription binding, current provider state and approved price.
Stripe asks the parent to confirm cancellation at the end of the paid period.
Creating/opening the link never changes entitlements. Stripe webhook processing
remains required to reconcile the resulting lifecycle event. The return page at
`/mobile/billing/return` contains only a neutral status explanation and an app
link; it neither accepts account/redirect parameters nor grants access.

Set protected server configuration `STRIPE_NATIVE_CANCEL_PORTAL_CONFIG_ID` to a
dedicated portal configuration in the same Stripe environment as the subscription:

- Active, non-default configuration, with public login disabled.
- Only subscription cancellation enabled, at period end, without proration.
- All other portal features disabled; no retention/upgrade flow is requested.
- Optional legal URLs restricted to this deployment's `/legal/privacy` and
  `/legal/terms`; publish and review those pages before configuring their URLs.
- Never reuse the general website portal configuration. Stripe makes the first
  configuration in an empty sandbox the default; create a separate non-default
  configuration for mobile cancellation.

The service checks this configuration on every request and fails visibly if it
changes. Provider calls run outside the household write lock; owner and billing
binding are rechecked before and after session creation. Session links stay in
memory only, with no cache, analytics or logs. Validation accepts the current
`/p/session/flow?secret=...` form and legacy opaque path tokens on
`https://billing.stripe.com`, rejecting extra query parameters and other hosts.
Use a server-only restricted Stripe key with the required subscription reads,
portal configuration reads and portal session writes. No secret key belongs in
the mobile bundle. Existing prices and Stripe Tax settings are unchanged.

Verification on 2026-11-04: 249 general regression checks passed, followed by 37
focused billing checks after the real Stripe URL-format correction; all 19
isolated web-billing checks passed. Root/mobile lint and typecheck, the Next.js
production build and Android/iOS JavaScript exports passed.

An isolated Stripe sandbox and disposable PostgreSQL schema exercised the actual
mobile API handler and entitlement reconciliation with real Stripe responses
through the authenticated CLI. Browser confirmation scheduled cancellation;
fresh provider state reported an active subscription with `cancel_at`, and
Cyntch retained Premium with renewal `will_not_renew` through the paid period.
The return page was inspected after navigation. This verifies provider responses
and reconciliation, not webhook delivery, a physical mobile browser handoff or
store review approval. Test subscription/customer/schema were removed and prices,
product and dedicated portal configuration deactivated after evidence capture.
Stripe requires its default configuration to remain active; all features and its
public login were disabled. Live Stripe settings and subscriptions were untouched.

References: [Stripe portal deep links](https://docs.stripe.com/customer-management/portal-deep-links),
[Google subscription cancellation requirements](https://support.google.com/googleplay/android-developer/answer/12154973),
[Google payment-policy guidance](https://support.google.com/googleplay/android-developer/answer/10281818),
[Apple cancellation guidance](https://support.apple.com/en-us/118428), and
[Google subscription management](https://support.google.com/googleplay/answer/7018481).

Cross-platform management verification: 19 native billing client tests include
all four device/provider combinations, absent providers, changed ownership and
household switches during delayed status reads. Android emulator inspection with
temporary, in-memory billing-source fixtures confirmed both management buttons
in portrait and landscape. The fixture was removed and the actual server-backed
Free plan restored. These are layout and boundary checks, not proof of an Apple
or Google authenticated cancellation or iOS device handoff.

Purchase admission waits for both parallel provider checks to settle before
returning an error. Native verification can write a snapshot even when the
Stripe check fails; returning early left that write running and could make an
immediate retry collide with the household transaction. A deterministic test
holds the native response while Stripe fails, confirms other household writes
remain available, and retries the same durable reservation after both settle.
After this fix, all 252 general regression checks passed, including 40 focused
billing checks. The 19 isolated web-billing checks also passed. Root/mobile lint
and typecheck and Android/iOS JavaScript exports passed. No purchase catalogue,
live billing configuration or pricing/tax setting changed.

Verification on 2026-11-04: 241 general checks (including 15 native billing client
checks) and 19 isolated web billing checks passed. Root/mobile lint and typecheck,
the Next.js production build and Android/iOS JavaScript exports passed. The
existing Android development APK includes the SDK; this stage changes JavaScript
and the local SQLite schema only. Emulator inspection confirmed the existing
session, task states and notification revisions were retained. These checks do
not establish real store purchases, iOS native compilation or physical performance.

`tests/mobile-native-billing-actions.test.cjs` covers real PostgreSQL reservations,
cross-device/web competition, network work without the household lock, late
entitlement changes, lost Stripe responses, pending payments, durable recovery,
API identity fences, kiosk denial and feature-off compatibility. Provider
transports are synthetic; no real purchases are made.

Verification on 2026-11-04: 226 general regression checks and 19 isolated web
billing checks passed, along with root/mobile lint and typecheck, the Next.js
production build, Android/iOS JavaScript exports and the Android native build.
Installing the new APK over the emulator app preserved the authenticated session,
cached household/task states and device/household notification revisions. The app
returned to its native task board. This does not verify iOS native compilation or
store purchase UI; those remain outstanding.

Verification on 2026-11-04: regression suites passed, including 15 signed-webhook,
durable-job and scheduler checks plus the existing 19 isolated web-billing tests.
Root/mobile lint and typecheck and the production Next.js build passed; both new
HTTP endpoints are included in the build. All lifecycle/provider responses in
these tests are synthetic; PostgreSQL transactions, leases and routes are real.

## Native notification history

The Today bell and Settings → Notification history open a native, paginated
history screen. Portrait uses full-width cards; landscape uses a list and detail
pane, with a single column at large text sizes. Expo SDK 58 redirects routes
marked `href: null`, so this route hides its tab button without marking the
route hidden. The five existing tabs remain visible.

`/api/mobile/notification-history` requires the authenticated account/session,
installation secret and current household membership, and is denied in kiosk
mode. Apply `database/0033_notification_history.sql` before deploying the API.
It adds per-device read/dismiss state and bulk-action cutoffs; canonical events
and push deliveries are preserved. Responses are uncached and include their
account, session, device, household and selection key for client validation.

App history includes all 15 native event kinds, including recurrence creation,
both routine-completion reasons and both member-addition routes. Visibility
follows the device's current category/member selections and current role.
Quiet hours, the master push switch, denied OS permission and expired push
delivery do not erase history or cause old pushes to be replayed. Website
history is a separate source because it uses the existing account preferences;
its read/dismiss state remains shared with the website. Legacy external URLs
are never used for navigation.

SQLite schema 11 caches loaded pages and commits each read/dismiss operation
with its visible update in one transaction. Network requests do not hold local
saves. Retries survive process death and lost acknowledgements, with bounded
backoff only while work is pending. Large backwards clock changes do not strand
that backoff. Bulk actions retain the server cutoff of the initial page, so an
offline retry does not clear newer history. App bulk actions cover all earlier
categories for this household/device, including currently disabled categories;
the clear confirmation explains this. Website actions retain current-role
filtering. Opening a target refreshes household access and uses the existing
run detail screen, including its removed-task handling.

Cache writes and presentation are fenced across household/filter changes,
sign-out, kiosk locking and in-flight local mutations. Kiosk activation purges
history content. Known server denial removes the cache, and the controller
continues to hide it even if disk cleanup fails. Household removal and role
changes reconcile the cache and outbox. While the app is active, saved actions
for every household in the signed-in account drain independently of the visible
screen. The local session, kiosk state, membership and continued existence of
each queued action are checked before sending. A delayed or denied household
does not block another household. Account, installation or kiosk rejection stops
all uploads and hides all cached account history; household-only rejection is
identified by an explicit API error code. Pending counts and retry errors cover
the account and are visible in history and Settings. Reopening or reconnecting
resumes delivery; no history lists are fetched merely to drain another queue.

Saved individual reads and dismissals are authorized against current household
membership and role independently of the device's category/member filters. A
preference change before upload must not silently discard an offline action or
make a dismissed item reappear when that category is enabled again. History
reads still apply the current filters; removed membership and reduced roles
still restrict which events may be changed.

Verification on 2026-11-04: real PostgreSQL tests cover all event categories,
role/device isolation, equal-time pagination, bulk retry cutoffs, legacy state,
invalid dates, API identity and kiosk rejection. Real SQLite tests cover atomic
save failure, restart/retry, stale responses, changed selections, permission
revocation and clock changes. On the Android emulator, a real API-backed event
was marked read offline, retained through force-stop/relaunch, then acknowledged
in PostgreSQL after reconnecting. Native taps opened its task, and landscape
detail and 1.6× text layouts were inspected. This does not establish iOS native
behavior, physical-device performance, push-provider delivery or store release.

The final general regression run passed 276 checks. Root/mobile lint and
typecheck, the Next.js production build and Android/iOS JavaScript exports also
passed. Migration 0033 was applied to the isolated local test database only;
production still requires its normal migration/deployment rollout.

Cross-household follow-up verification: 284 general checks passed, including
real SQLite tests for restart, lost acknowledgements, household switches during
requests, role reconciliation, account isolation and sign-out/kiosk/background
boundaries. Root/mobile lint and typecheck, the Next.js production build and
Android/iOS JavaScript exports passed. On Android, read actions were saved offline
in two local test households, then both were acknowledged in PostgreSQL while
Today remained open in the first household. Observed transport contained exactly
the two writes and no history reads; the pending count returned to zero. The
disposable second household and both fixture events were removed afterward.

Preference-change regression: real PostgreSQL/API tests reproduced silent loss
of queued reads/dismissals after category or member filters changed, then passed
with access and display filters separated. Duplicate replay, member/supervisor
role limits, removed members and foreign-household IDs are covered. The complete
general suite passed 288 checks; root lint, typecheck and the production build
passed. This follow-up changes only server authorization selection, with no
database migration or native module change.

## Account deletion preparation

The account deletion workflow is **not complete**. The API at
`/api/mobile/account-deletion` supports a read-only review and a separately gated
POST for durable request acceptance. The native review, submission and receipt
recovery screens are implemented below, but `ACCOUNT_DELETION_SUBMISSION_ENABLED`
remains off pending full verification. Clerk profile management alone does not
remove Cyntch data. The development provider policy and integration evidence near
the start of this README cover direct provider deletion; production rollout and
native end-to-end verification remain outstanding.

The review lists current memberships, owned households, counts of content and
profiles without sign-in, possible ownership successors with an existing
manager/supervisor role and a Clerk-linked account, permanent owner access, and
stored Stripe/Apple/Google subscription state. Billing data is included even
when new purchases are disabled, is labelled by environment, and reflects the
last stored verification rather than a new provider check. Provider IDs, email
addresses and unrelated household details are omitted. Authored content in a
former household contributes only to account-level counts.

The review uses one repeatable-read transaction. Its fingerprint binds the
account/session/device to household ownership, member roles, content identity,
subscription state, provider customer bindings and pending purchases. Internal
acceptance recomputes the review under the relevant write locks and validates
explicit choices for every owned household. Its future HTTP caller must check
recent identity verification. The fingerprint is
not authorization or consent. Transfer candidates exclude members without
management access and profiles without independent sign-in.

The API checks the authenticated account/session, existing installation secret,
revocation records and kiosk restrictions. A first-install review does not
require push registration or notification permission. The native transport
rejects a response belonging to another account, session or device. Reads do
not create an installation, delete content, transfer ownership, or change a
subscription.

Verification on 2026-11-04: seven focused tests exercise real PostgreSQL and API
boundaries, including stale reviews, replacement with unchanged content counts,
pending payments, explicit confirmation, unrelated/child successor rejection,
empty accounts, first-install access and kiosk/session protection. The Android
development app fetched an actual local API review through its authenticated
MobileApi instance: one owned test household, one profile without sign-in, one
routine, three runs and nine tasks. Temporary inspection hooks were removed.
Existing migrations 0030–0032 were applied only to the local test database so
its billing tables match the integration-test schemas; no production or billing
provider state was changed.

The final general regression run passed 295 checks. Root/mobile lint and type
checks, the Next.js production build and Android/iOS JavaScript exports passed.

Next work is the remaining provider cleanup adapters, current-session/reverification checks at the
HTTP confirmation boundary, safe handling of subscriptions, personal data
removal at Cyntch and its providers, local data cleanup, native confirmation UI,
and the web deletion path. Account deletion
must be available in-app under [Apple's guidance](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion);
[Google also requires a web request path](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en-EN).
Provider deletion and interrupted recovery still need end-to-end verification.

### Durable acceptance and processing

Apply `database/0034_account_deletion_requests.sql` before deploying this
backend revision. Existing web/mobile admission checks now depend on that table
and its account guard function. The migration is additive and has been applied
only to the local test database; production has not been changed.

`acceptAccountDeletion()` is an internal transaction boundary, not an HTTP
endpoint. It checks the account/session/device, installation secret, session
revocations and kiosk lock. The caller must supply Clerk's actual strict
reverification result and verify that each selected successor still has an
active identity. Client-supplied verification flags are never sufficient.

Acceptance locks the account, kiosk session, installation and affected households
in that order, rechecks the review, saves a durable request, applies explicitly
chosen household transfers/removals, removes the departing memberships and
invites, and stops all three push-registration types. These changes either
commit together or roll back together. Retrying the same operation and intent
returns its original receipt; another operation cannot repeat its effects.
Provider cleanup identifiers stay on the server.

The request blocks subsequent account access. Database guards prevent a delayed
identity upsert, new membership or new ownership from recreating the account.
HTTP requests, kiosk changes, web preferences, household admission and household
writes participate in account admission. Invitation acceptance now commits
membership, invite usage and notification events in one transaction, so a
failure cannot leave a partial join. An admitted write finishes before deletion
can be accepted; contention returns a retryable response.

`processAccountDeletions()` claims durable leases and runs data, Stripe, native
billing and identity cleanup in order. Every phase requires a real, idempotent
adapter with bounded provider timeouts. Acknowledged phases survive restarts;
expired workers cannot acknowledge or complete a newer lease. Failures persist
a retry time and an allowlisted error code. Processing yields between phases
when its budget is spent. Only after all phases succeed does it clear raw
account/provider identifiers, retaining the opaque account hash and outcome to
prevent resurrection.

**Public deletion acceptance and scheduler wiring are not enabled.** Internal
PostgreSQL, Stripe, native billing and Clerk adapters are described below.
Provider integration tests use newly created Stripe test-mode customers and
Clerk development accounts only. No existing user account or live billing
customer has been erased. Do not expose acceptance until real Apple revocation,
restore protection, status recovery, disclosures and confirmation flows are
implemented and verified. Shared authored content, notification
snapshots, orphan profiles, store subscription handling, out-of-band identity
deletion and local queues must all be covered by the completed workflow.

Verification on 2026-11-04: 331 general tests and 19 isolated web billing tests
passed with no skips. Coverage includes transaction rollback, lost receipt
acknowledgements, stale reviews, role changes during successor verification,
kiosk/revoked-session rejection, concurrent admission, late web writes,
identity resurrection, atomic joining, delayed entitlement grants, durable retries, expired leases and
processing budgets. Root/mobile lint and type checks and the Next.js production
build passed. Native code and
native modules are unchanged by this addition.

### Account data cleanup

Apply `database/0035_account_data_cleanup.sql` before using the data adapter.
It has been exercised in disposable local test schemas. It allows an
existing locked kiosk to retain an empty member selection after a removal;
new kiosk activation still requires a nonempty selection. It also removes
untraceable display-name copies from old membership notification messages,
preserving their history entries with generic text. New membership events
record their subject's user ID so cleanup can identify the relevant copies.

`deleteAccountData()` uses the accepted request's stored scope and checks its
current lease. One PostgreSQL transaction removes the departing account's
authored tasks, routines and runs, personal records, notification copies,
preferences and device records. It deletes orphan profiles without sign-in
only after rechecking that no household still uses them. Shared installations
remain available to their other accounts.

Other authors' tasks are preserved: their template tasks move to a neutral
one-off template, their tasks in a departing author's run move to a neutral
manual run, and their independently started runs detach from the removed
template. Task IDs, assignments, statuses, dependencies between surviving
tasks and completion ordering survive. Replacement containers retain no
departing author's names, recurrence or schedule. The confirmation flow must
explain this consequence before accepting a deletion.

Saved operation receipts retain their immutable IDs and request hashes to
prevent duplicate execution, but erased response snapshots become a marker
that returns HTTP 410 and requires refresh. Pending purchase reservations
retain their protection against duplicate subscriptions while their actor,
session and device fields are scrubbed. Provider identifiers remain only for
the later provider cleanup phases. Exact acceptance retries and late sign-out
retries cannot recreate erased installation or revocation records.

Seven real PostgreSQL tests cover mixed authorship, private-data copies,
lease/scope checks, rollback and durable retry, an orphan profile adopted by
another household, late preference writes, reservation preservation, migration
reapplication and an empty kiosk remaining locked. Cached copies on other
devices, provider erasure, the HTTP mutation/status boundary, web/native
confirmation and local queue/cache removal remain part of the unfinished
end-to-end deletion workflow.

Verification on 2026-11-04: all 338 general checks passed with file concurrency
limited to four, and 19 isolated web billing checks passed. A previous run
overlapped the build and native exports and timed out one existing planner
test; that test passed independently and in the final complete run without
changing its timeout or assertions. Root/mobile lint and type checks, the
Next.js production build and Android/iOS JavaScript exports passed. No live
account, provider or production database was changed.

### Stripe cleanup and transferred households

Apply `database/0036_retired_stripe_customers.sql` before this backend revision.
Migrations 0035 and 0036 have also been applied to the local emulator database;
its two accounts, one household and zero deletion requests were unchanged.
Production has not been migrated.
Acceptance immediately retires the former owner's customer-portal access when
transferring a household. Both website and native cancellation endpoints reject
access to that payment account. A new purchase waits for provider cleanup.

`deleteAccountStripeData()` reads the accepted request's stored scope and checks
the current lease before provider calls. It verifies the customer's Cyntch
household binding and Stripe environment before deleting it. A subscription-only
binding is resolved through its verified subscription. An unrelated local
binding, mismatched provider response or arbitrary 404 fails without claiming
erasure. Calls use bounded timeouts without in-process network retries.

Stripe customer deletion stops renewals and removes saved payment details;
[Stripe retains customer financial history](https://docs.stripe.com/api/customers/delete).
The adapter records per-customer progress durably. If a deletion response is
lost, a retry retrieves the deleted customer and acknowledges the existing
result. Expired workers cannot save progress. No cleanup effect depends on the
mobile app remaining open.
Confirmed deletion releases the former owner's Stripe purchase reservation;
Apple/Google reservations remain protected until store reconciliation resolves.

A transferred household retains its verified paid period, with renewal stopped.
The household's old customer/subscription IDs remain as financial linkage for
paid-period, refund and dispute reconciliation, without exposing the former
owner's customer portal. Reconciliation reads the recorded subscription even
after customer deletion. Existing refund holds still prevent access. When the
paid period ends and the new owner subscribes on the website, checkout creates
a new customer using a new, retry-stable generation of its idempotency key.
It cannot reuse the deleted customer or inherit their saved payment method.
An outstanding billing hold still requires resolution before website checkout.
Checkout commits its customer binding before requesting a checkout session,
then rechecks ownership, entitlement, reservation and binding under the
household lock. A lost checkout response cannot roll back the customer link
needed by a later deletion request.
The adapter also inventories orphan customers from historical checkouts that
lost their database binding. Acceptance captures the exact owned-household
scope and freezes replacement purchases even when a household has no billing
row. Inventory uses Stripe's paginated customer list, persisting each cursor
and matching Cyntch customer ID before continuing. Test mode also enumerates
test clocks and their separate customer lists. Unrelated customers' personal
details are neither saved nor deleted. Membership without ownership does not
authorize cleanup of that household's customer.

No customer deletion begins until the inventory is complete. A provider failure
or expired worker resumes from saved progress. Replacement purchases remain
frozen until every discovered customer has been deleted. Finalization and
releasing the former owner's Stripe reservations commit atomically, so a lost
acknowledgement cannot later unlock a successor's new payment account.

The final confirmation and privacy disclosures must explain immediate Stripe
cancellation, retained financial records, and the separate Apple/Google store
subscription-management requirements. Billing presentation still needs to show
the retired/closing state clearly as part of the complete account-deletion UI.

Verification on 2026-11-04: nine PostgreSQL/provider-double tests cover deletion scope,
lost responses, per-customer progress, stale leases, portal isolation, preserved
paid access, refund holds and retry-stable new-owner checkout. The explicit
`tests/integration/account-deletion-stripe.cjs` test also passed against the
existing Stripe test account using CLI 1.55.7 and API 2026-10-28.endive: two newly
created customers had active paid test subscriptions, deletion cancelled both,
a deliberately lost deletion response recovered, and the transferred paid
period remained unchanged in PostgreSQL. Test customers were deleted, the new
product/price were archived, and the disposable database schema was removed.
The test uses a CLI bridge for actual provider requests; request-option and
timeout behavior is separately covered by adapter tests. Live mode was not used.

Run that provider check only with `CYNTCH_STRIPE_SANDBOX_TEST=true`, an absolute
`CYNTCH_STRIPE_CLI` pointing to a current CLI authenticated in test mode, and
`CYNTCH_TEST_DATABASE_URL` targeting the verified local `cyntch_mobile_test`
database. Invoke `node --test tests/integration/account-deletion-stripe.cjs`.
The test writes a unique cleanup/evidence manifest to the OS temporary folder.

Final regression: all 347 general checks and 19 isolated web billing checks
passed with no skips or cancellations. Root lint and the production build,
including TypeScript checks, passed. The Stripe step changes no native modules;
the earlier Android/iOS exports cover the shared kiosk parser change. The full
account-deletion workflow remains unavailable until the remaining provider,
recovery, UI and disclosure requirements above are implemented and verified.

Inventory follow-up verification on 2026-11-04: all 354 general tests and 19
isolated web billing tests passed, alongside root lint and the production build.
The Stripe-focused suite now has 16 tests, including pagination recovery,
unbound customers, ownership isolation, test-clock lists, expired inventory
workers, incomplete erasure keeping purchases frozen, safe finalization retries
and an account with no owned billing scope. The real Stripe test was extended
to three active test subscriptions: the third customer's only connection to
the household was its Cyntch metadata, and it lived under a test clock. Inventory
found it and deletion cancelled all three subscriptions. Customers and clock
were deleted, product/price were archived, and the isolated schema was dropped.
No production database or live billing state was changed.

Cleanup adapters can now raise `AccountDeletionDeferred` after a durable
checkpoint or while an asynchronous provider operation is pending. The
coordinator saves a bounded next-attempt time, releases the lease, leaves the
phase unacknowledged and clears failure backoff. It never waits in memory or
marks a queued provider deletion complete. Expired workers cannot save a
deferred retry. Stripe inventory uses this path when its invocation budget is
spent, preserving its page cursor rather than escalating normal progress into
an increasingly delayed failure retry. RevenueCat's deletion confirmation still
needs to be connected to this mechanism as part of its unfinished adapter.

Deferred-job verification: all 357 general checks passed with no skips or
cancellations. Root lint, standalone TypeScript checks and the production build
passed. Tests verify a durable scheduled retry, unchanged phase acknowledgement,
reset failure backoff, stale-worker rejection and a Stripe page checkpoint
resuming after its processing budget is exhausted. No native module or public
deletion endpoint is introduced by this follow-up.

### RevenueCat customer erasure

`deleteAccountNativeData()` implements the native provider phase internally.
It reads the accepted request from PostgreSQL, checks the current worker lease
and retired household billing identity before every provider call, and records
per-customer progress. Transferred households are outside its deletion scope.
It requires `REVENUECAT_PROJECT_ID` and `REVENUECAT_V2_SECRET_KEY`, independently
of the purchase feature gate, V1 credentials and product catalogue. The V2 key
needs customer read/write, subscription read and purchase read permissions.

The adapter proves project access before interpreting a missing customer and
inspects all alias, subscription and purchase pages without an environment
filter. Unexpected aliases, foreign ownership, mixed environments and stores
other than Apple/Google stop deletion. Pagination cannot redirect credentials
to another origin or customer. Requests have an eight-second maximum timeout
within the invocation budget; errors persist only a safe internal code.

RevenueCat's DELETE response queues asynchronous work. The adapter saves that
checkpoint and uses the durable retry mechanism, confirming erasure only with
a subsequent V2 GET/404. A lost DELETE response recovers the same way. V1
Get-or-Create is never used. If the customer remains after five minutes, the
worker revalidates scope before reissuing deletion. This follows RevenueCat's
[customer deletion guidance](https://www.revenuecat.com/docs/dashboard-and-metrics/customer-profile#delete-customer).
It does **not** cancel Apple/Google subscriptions; the confirmation flow must
explain this and provide the existing store management links.

Local subscription bindings remain unchanged. Before enabling account deletion,
still verify restore protection across provider erasure/recreation, prevent
the old SDK identity from recreating data, and implement follow-up erasure for
late provider events. Real Apple revocation verification, the confirmation/status
endpoints, native/web UI and local data purge are also unfinished. No public deletion
action or scheduled worker is enabled by this adapter.

Provider-double tests use isolated real PostgreSQL schemas and cover asynchronous
confirmation, interrupted requests, misleading 404s, scope/alias isolation,
pagination, stale leases, durable waits, per-customer budget recovery and HTTP
timeouts. Local RevenueCat credentials are not configured, so this is not yet
evidence of a successful deletion against RevenueCat itself.

Verification on 2026-11-04: the general regression run passed 372 checks without
skips or cancellations. After adding an HTTP abort check, all 16 focused native
deletion checks passed. Root lint, the final changed-file lint check, standalone
TypeScript checks and the production build also passed. Test schemas were
isolated; no RevenueCat requests or production database changes were made.

### Clerk identity erasure

`acceptAccountDeletion()` now requires the issuer from Clerk's verified session
claims as a separate server argument. Never take it from a request payload.
The issuer is saved with the durable work so cleanup can verify the provider
after sign-in sessions cease to exist. Issuer capture needs no schema change;
the Apple outcome field introduced below requires migration 0037.

`deleteAccountIdentity()` runs only after the other three phases have completed.
It verifies the Clerk instance and its domains against that saved issuer, then
pins the instance ID and development/production environment. A retry may use a
rotated key or changed domain only if the instance still matches. A foreign
tenant's 404 cannot be mistaken for successful erasure.

The adapter calls the versioned REST API directly to enforce an eight-second
request limit within its invocation budget. It validates the selected user and
DELETE acknowledgement, then confirms absence with GET. A lost response or
worker interruption can resume without deleting another account. Only the
coordinator clears the account/work identifiers after all phases succeed.
No profile, plaintext OAuth token, provider error message or API credential is
persisted. Apple's encrypted temporary retry checkpoint is described below.

Linked Apple identities now run upstream token revocation before DELETE, with
encrypted interrupted recovery. Clerk deletion alone is not treated as proof
of Apple revocation. The observed local
development instance enables Google sign-in; that does not prove production
or future Apple configuration. Self-deletion through Clerk's own profile UI and
out-of-band provider deletion must also be handled in the completed flow.

Ten PostgreSQL/provider-double checks cover issuer validation, tenant isolation,
lost responses, identity mismatch, phase ordering, stale leases, durable waits,
HTTP timeouts and malformed Apple account data. `tests/integration/account-deletion-clerk.cjs`
also passed against the configured Clerk development instance. It creates a
uniquely marked test account, verifies the actual DELETE response, discards that
response deliberately, confirms GET/404 recovery and durable completion, then
verifies cleanup of its own fixture. It refuses live keys or a production
instance and uses only the isolated localhost test database.

Run that integration check explicitly with `CYNTCH_CLERK_DELETION_TEST=true`,
`CYNTCH_TEST_DATABASE_URL=postgresql://cyntch_test@localhost:55439/cyntch_mobile_test`
and `node --test tests/integration/account-deletion-clerk.cjs`. Credentials load
from protected local configuration; the temporary evidence file contains only
test identifiers and verification outcomes. The latest evidence file is
`cyntch-delete-d16bf6c3-e1cf-48c4-8fa6-0fdbd098c881.json` in the OS temporary directory.

Verification on 2026-11-04: all 383 general regression checks passed without
skips or cancellations; root lint, standalone TypeScript checks and the
production build passed. No native modules, public deletion action or cron
worker were enabled by this change.

### Sign in with Apple revocation and recovery

`revokeAccountAppleIdentity()` now runs within the identity worker. It retrieves
tokens from the authenticated Clerk Backend API, follows the complete paginated
result, and matches the external account and Apple subject. The Clerk-returned
ID token selects an explicitly configured Apple client ID; this decoding never
authenticates a client request or grants application access. Unexpected subjects,
providers, clients or ambiguous token responses leave deletion pending.

Before contacting Apple, the worker saves the access token encrypted with
AES-256-GCM. Authenticated context binds it to the Clerk instance, Cyntch account,
deletion request, external account, Apple client and encryption-key version.
The worker creates a five-minute ES256 client secret from the configured P-256
Apple key, then sends a bounded form POST to Apple's fixed revocation endpoint.
An empty HTTP 200 confirms revocation, including a previously revoked token,
as documented by [Apple's revocation API](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens).
The encrypted credential is removed immediately after that acknowledgement.

A lost response or expired worker leaves the encrypted credential available
for a later lease, even if Clerk can no longer refresh the token or its user
has been removed. The worker does not re-fetch a token after that checkpoint.
API keys, client secrets and plaintext tokens are never saved or logged. A
fresh identity read before Clerk deletion checks for newly linked Apple accounts.

Configure these **server-only secrets** before enabling Apple sign-in/deletion:

- `APPLE_SIGN_IN_CLIENTS`: a JSON array of `{clientId, teamId, keyId, privateKey}`.
  Each entry must match an Apple App ID or Services ID used by the Clerk flow,
  its ten-character Team ID and key ID, and the associated P-256 private PEM key.
  Include each supported native/web client explicitly; duplicate client IDs fail.
- `ACCOUNT_DELETION_TOKEN_KEYS`: JSON `{current, keys}`, where `current` names the
  key used for new checkpoints and `keys` maps version names to base64-encoded
  32-byte random keys. Keep older versions available until pending checkpoints
  using them have drained. These keys are separate from the Apple signing key
  and must not be included in public/mobile configuration.

When a complete Clerk result contains no matching token, the user has disappeared
without a saved token, or Clerk explicitly reports unretrievable shared-credential
tokens, cleanup follows [Apple TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple):
delete the account and direct the person to revoke manually. The worker records
`apple_revocation_required=true`; receipts expose `appleRevocationRequired`.
This non-identifying instruction survives removal of the work/account IDs.
The pending confirmation/status UI must display [Apple's instructions](https://support.apple.com/en-us/102571)
when that flag is true, and must not claim automatic revocation. Authentication,
configuration, timeout, throttling and other temporary failures retry; they do
not silently choose the manual path.

Apply `database/0037_account_deletion_apple.sql` before deploying this revision.
It was applied twice successfully only to localhost `cyntch_mobile_test`; its
two users, one household and zero deletion requests were unchanged. Production
has not been migrated. Local Apple client/encryption secrets are not configured,
and no real Apple authorization was revoked; real Apple/Clerk compatibility and
the manual instruction UI remain release requirements.

Verification on 2026-11-04: 395 general regression checks passed without skips
or cancellations. After adding pagination, cross-request ciphertext isolation,
missing-key and vanished-user tests, all 26 Apple/identity checks passed (16
Apple-specific). Root lint, final changed-file lint, standalone TypeScript and
the production build passed. No public deletion endpoint or worker was enabled.

### Deletion status after sign-in removal

`GET /api/mobile/account-deletion/status` is a read-only recovery endpoint.
Its exact path bypasses Clerk middleware and uses only a request UUID and a
random 256-bit recovery key in `X-Cyntch-Deletion-Request` and
`X-Cyntch-Deletion-Key`. Never put either in a URL, analytics or logs. Acceptance
commits the key's domain-separated SHA-256 hash with the deletion request;
replaying the operation with a different key fails. The raw key is never stored
server-side. Apply `database/0038_account_deletion_status.sql` first.

Replies contain only request ID, pending/completed state, acceptance/completion
times, receipt expiry and the manual Apple-revocation flag. No personal,
household, billing or worker details are exposed. Pending recovery does not
expire; a completed receipt is readable for 90 days after server completion.
Expiry does not remove the account tombstone. Invalid, unknown and expired
credentials receive the same 404. Authorized reads allow 30 requests per minute;
invalid keys do not create counters or consume the legitimate key's allowance.
Status replies are private/no-store. A status lookup cannot run cleanup.

`AccountDeletionVault` stores one unresolved recovery record in OS secure
storage, independently of account caches and sign-out. Use `AccountDeletionDrafts`
to prepare the frozen request and await `requestForSubmission` **before** sending
deletion. It coordinates the keychain record with the SQLite intent journal; do
not call the individual store mutation methods from a screen. A lost
acknowledgement then reuses the same key and original request after restart.
Only a never-submitted preparation can be discarded. A missing status response,
offline failure or 404 never deletes the key or proves that submission failed.
Validated receipts are persisted; late pending replies cannot overwrite a
completed receipt or remove a recorded manual Apple action. The UI may dismiss a
completed receipt only after local account cleanup and the necessary manual
instructions. No timer or device-clock expiry clears this record automatically.

The standalone `AccountDeletionStatusApi` does not request a Clerk token, send
cookies or follow redirects. It binds each saved key to its original API origin,
uses a 25-second cancellable timeout covering the response body, validates the
minimal receipt and exposes only fixed error messages. The native adapter imports
[`expo/fetch`](https://docs.expo.dev/versions/v58.0.0/sdk/expo/) explicitly so the
networking implementation cannot change through the RN-fetch environment flag.
The key uses [`getRandomBytesAsync`](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/)
and [`SecureStore`](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/)
with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The installed SDK 58 Android and iOS
network implementations were also inspected for cookie and redirect handling.

These are recovery foundations; the confirmation/status screens,
native persistence and provider verification still need work. The submission
transport, disabled HTTP boundary and scheduled orchestration are described below.
No destructive public acceptance endpoint or cron worker is enabled by this
change. Apple and native billing provider verification remain outstanding.

Verification on 2026-11-04: all 420 general checks passed with no skips or
cancellations, including seven PostgreSQL/HTTP-handler status checks and fourteen
client/middleware recovery checks. Root and mobile lint and TypeScript passed,
as did the production build and local production-server HTTP check below.
Migration 0038 was applied twice only to localhost `cyntch_mobile_test`; its two
users, one household and zero deletion requests remained unchanged. Production
has not been migrated. SecureStore and network interruption tests use controlled
adapters; these do not substitute for physical Android/iOS validation.

After a production build, the real local HTTP check is:

```powershell
$env:CYNTCH_TEST_DATABASE_URL='postgresql://cyntch_test@localhost:55439/cyntch_mobile_test'
$env:CYNTCH_DELETION_STATUS_HTTP_TEST='true'
node --test tests/integration/account-deletion-status.cjs
```

It uses an isolated database schema, a temporary local Next production process
with no Clerk secret, invalid sign-in credentials and the real data-cleanup
adapter. External provider phases use acknowledged doubles. It checks pending
and completed HTTP receipts, the Apple manual flag, cache/privacy headers and
rejection of destructive HTTP methods, and removes the temporary process/schema.
The same check also reads both receipts through the native client's transport
logic using Node's fetch against that real server; OS networking still requires
physical-device verification.

### Preserve the confirmed deletion request on the device

The local database now initializes `native_account_deletion_intent` (schema
version 12). It stores only the canonical intent, original account/session/device
scope, API origin, a fingerprint and a submission marker. Recovery keys and
authentication tokens stay out of SQLite. The phone and server share the intent
normalizer; unknown fields, display names and credentials are discarded.

`AccountDeletionDrafts.prepare` saves the recovery key, writes the immutable
intent, then binds its SHA-256 fingerprint in the OS keychain. The fingerprint
includes the original scope, origin and recovery secret. A replaced key or
changed SQLite decision cannot reuse that binding. Up to 100 household choices
stay in SQLite so the secure-store record remains small. A failed preparation
preserves the existing key and resumes the same request; it never silently
rotates the key or substitutes a new review.

After explicit confirmation, `requestForSubmission` checks the binding, records
submission in the keychain first, then commits the SQLite marker while checking
the active local session and kiosk restrictions. Only then does it return the
exact saved payload for the authenticated HTTP caller. It performs no network
requests or automatic destructive retries. The HTTP boundary must still enforce
current identity, strict reverification, installation and household permissions.

An interrupted marker write can leave the two stores at different stages; that
keeps the request recoverable and prevents unsafe local cancellation. Explicit
cancellation removes only a never-submitted preparation, journal first and key
last. An accepted status is saved securely before its household decisions are
removed from SQLite. Late or repeated callbacks cannot rebuild an accepted
request. Legacy submitted recovery records without a bound intent can still
read status, but cannot synthesize a new destructive request.

The remaining submission UI must use the authenticated withdrawal flow below
when returning from an unaccepted attempt to a new review. A 404 or lost
acknowledgement alone must never authorize discarding a submitted record or
changing its original choices.

Verification on 2026-11-04: all 433 general regression checks passed without
skips or cancellations. The 27 focused draft/recovery checks also passed on the
final implementation, including 13 new tests using real SQLite files and
controlled keychain interruptions. Root/mobile lint and TypeScript, the Next
production build, and separate Android/iOS Expo exports passed. These exports
verify JavaScript/Hermes packaging, not signed store binaries or physical-device
keychain behavior. This change adds no server migration and enables no
destructive public endpoint or background deletion worker.

### Withdraw an unaccepted deletion attempt

Apply `database/0039_account_deletion_withdrawals.sql` before deploying this
revision. `POST /api/mobile/account-deletion/withdraw` requires a current Clerk
identity, `has({reverification: 'strict'})`, matching account/session/device
headers, the installation secret and the original recovery key/request ID.
Neither a recovery key by itself nor a boolean supplied by the client grants
permission. A new verified sign-in by the same account can withdraw its original
attempt. Revoked sessions, kiosk restrictions and mismatched keys are rejected.

Acceptance and withdrawal take the same account and operation locks. If
acceptance already committed, withdrawal returns `outcome: 'accepted'` and leaves
deletion untouched. Otherwise it records a permanent opaque fence for that
request ID and returns `outcome: 'withdrawn'`. Retries return the same withdrawal
time. Account/household/provider data is not deleted or transferred by withdrawal.
The fence contains only request ID, account hash, recovery-key hash and creation
time. It must not expire: an arbitrarily delayed old submission must stay blocked.
Database triggers also prevent conflicting outcomes from older application
revisions that do not perform the new application-level check. Starting deletion
again requires a new request ID and fresh review.

The endpoint has a separate ten-attempt/minute authenticated rate limit, charged
outside the outcome transaction so failures cannot bypass it. It never uses the
normal shared account-admission wrapper, which would conflict with its exclusive
lock or hide an already accepted outcome. Responses are private/no-store; recovery
headers never belong in URLs or logs. Other account and kiosk controls remain
unchanged.

`AccountDeletionWithdrawalApi` uses authenticated POST with the current scope,
omits cookies, rejects redirects and validates the returned scope/outcome. It
preserves Clerk's strict reverification hint for the native `useReverification`
flow instead of treating that hint as a success. Obtain current credentials for
each callback/retry; never freeze a JWT with the original intent. This follows
[Clerk's reverification protocol](https://clerk.com/docs/guides/secure/reverification).
Tests check the server hint with the actual installed mobile Clerk recognizer.

Only a matching withdrawn receipt lets `AccountDeletionDrafts.rememberWithdrawal`
save proof in SecureStore, remove the SQLite intent, and finally remove the key.
If either cleanup write is interrupted, `finishWithdrawal` resumes from the
persisted proof without another server mutation. An accepted outcome preserves
recovery information and requires the independent status lookup. Conflicting or
late replies cannot overwrite an accepted/withdrawn outcome or clear another
request. No response, a 404, a timeout or reverification cancellation is withdrawal
proof.

Migration 0039 was applied twice only to localhost `cyntch_mobile_test`; two
users, one household, zero deletion requests and zero withdrawals remained.
Production has not been migrated. All 450 general regression checks passed with
no skips/cancellations, including real PostgreSQL race/trigger checks and SQLite
interruption checks. Root/mobile lint, TypeScript and the production build passed. Native confirmation
and recovery screens still need integration; the destructive acceptance endpoint
and deletion worker remain disabled.

### Submit the confirmed deletion request

`POST /api/mobile/account-deletion` now accepts the exact saved intent only when
the server rollout setting `ACCOUNT_DELETION_SUBMISSION_ENABLED` is exactly
`true`. It is off by default and has not been enabled in a running environment.
Keep it off until the native confirmation/reverification screens, account-local
cleanup, provider safeguards and durable worker are integrated and verified.
This gate controls new submission calls; the independent status and withdrawal
endpoints remain usable while submission is disabled.

The handler requires Clerk's authenticated account/session, a bearer token,
matching native identity headers, the installation secret and the original
request ID/recovery key. It checks `auth.has({ reverification: 'strict' })` on
the server and returns Clerk's recognizable reverification hint when needed.
Neither a request body nor a client flag can assert recent authentication.
The body is bounded to 64 KiB and five seconds; verified submission attempts
have a separate ten-per-minute quota which does not reject identical replay
merely because acceptance has already closed the account.

Before looking up selected successors in Clerk, the handler validates that
they are eligible parents in the reviewed households. The provider lookup must
return every selected identity, with no banned, locked or substituted account.
Its eight-second timeout has no late continuation into acceptance. The server
then repeats permissions, kiosk restrictions, review and ownership checks under
the existing account/household transaction locks. Original request IDs, keys
and confirmed choices cannot change on replay. The handler does not call any
provider deletion API or run cleanup work in the request.

Responses contain authenticated scope and the minimal status receipt: HTTP 202
for accepted/pending work or 200 for a completed replay. Acceptance is never
described as completed cleanup. A lost COMMIT acknowledgement returns a generic
retry/status message; it does not roll back an already committed decision.

`nativeAccountDeletionSubmissionApi()` uses the explicit SDK 58 `expo/fetch`
transport. Call it only with the result of
`AccountDeletionDrafts.requestForSubmission`, after both durable stores have
committed. Obtain fresh credentials on each call, including the retry after
Clerk reverification; never rewrite the saved account/session/device/intent.
The transport binds origin and scope, rejects redirected or malformed receipts,
omits cookies, keeps keys in headers, and makes no automatic destructive retry.
Persist a valid receipt with `AccountDeletionDrafts.rememberStatus` before any
account-cache cleanup. Errors, a disabled rollout or cancellation of verification
must retain the submitted attempt until its outcome or withdrawal is confirmed.

Verification uses real isolated PostgreSQL with verified-auth/provider doubles,
the native transport core against the actual route handler, lost database commit
acknowledgement, superseded reviews, invalid successors, kiosk/revocation guards,
quota exhaustion, bounded uploads and transport interruption. This does not
establish native OS execution, a real Clerk reverification flow, or release readiness.

All 463 general regression checks passed with no skips/cancellations. Final
review also made receipt expiry a shared 90-day elapsed duration, independent of
the database timezone/DST. All 35 focused submission/status/recovery checks
passed on that final change, including completed replay after real data erasure
and a Sydney DST boundary. Root/mobile lint and TypeScript and the production
build passed. The local production-server recovery test also passed with stale
sign-in credentials and erased account data; its evidence is
`C:/Users/danie/AppData/Local/Temp/cyntch-deletion-status-2e54b466-a4f8-4c24-ac51-671d70572887.json`.
No production migration, provider mutation or deployment was performed for this
submission boundary.

### Native deletion review, recovery and local erasure

Settings now opens a native account-deletion review. The screen validates the
complete review response, shows authored-content counts, requires an explicit
ownership choice for each owned household and separate account/subscription
consents, and presents a final native confirmation dialog. Saved choices remain
bound to their original account, request, session and review. A stale or partial
review cannot enable submission. Wider screens use two columns; rotation keeps
the current choices. Store-management links remain available in recovery.

The submission/withdrawal hook uses Clerk's custom reverification interface with
native factor selection and password, email/phone code, TOTP, backup-code and
passkey handling. A changed session or unmounted screen cannot complete an old
verification. Completion and cancellation settle once. Credentials are fetched
again for the verified retry and the server remains the authority. These factor
paths still need real Clerk/device verification; successful compilation is not
evidence that every factor is configured or supported by the installed native
bridge. Enterprise SSO reverification is not implemented.

Recovery is initialized outside the signed-in runtime. A submitted request gates
that account's normal screens until acceptance or authenticated withdrawal is
resolved. Accepted requests resume local cleanup after restart without resending
deletion. Status checks use the original anonymous recovery capability. Receipt
persistence precedes erasure, and late responses cannot replace another saved
request, regress completion or remove manual Apple instructions. Sign-in loading
and notification-session errors offer read-only status access when the device is
not kiosk-locked. Kiosk protection wins over an uncertain deletion attempt; only
confirmed acceptance can release the deleted account's own lock.

Local database version 13 adds a permanent minimal deleted-account marker.
Erasure and the write fence commit together across all 17 account-scoped tables.
SQLite triggers reject delayed inserts and account reassignment after deletion,
including kiosk and deletion-intent JSON records. Other accounts, installation
identity and the separate recovery key survive. The exact deleted kiosk key ID
is retained until keychain removal succeeds. Native notification cleanup uses its
existing serialized queue and durable generation; a stalled OS call does not hold
the recovery controls indefinitely. This is logical app-data cleanup, not
forensic storage erasure.

Verification on 2026-11-04: 478 general checks passed with no skips or
cancellations. The final focused run passed 40 checks, including real SQLite
restart/interruption tests, real PostgreSQL review parsing, notification cleanup
and kiosk protection. Root/mobile lint and TypeScript passed. Android and iOS
Hermes exports passed. On the existing Android emulator, the live local review
rendered, submission stayed disabled until all choices/consents were selected,
the landscape overflow found during inspection was fixed, and selections
survived rotation to portrait. The final confirmation was opened and cancelled;
the test household remained usable. Screenshots and UI hierarchy evidence are
under `C:/Users/danie/.codex/tmp/cyntch-deletion-*.png` and
`C:/Users/danie/.codex/tmp/cyntch-deletion-*.xml`.

**Keep submission disabled.** Remaining release work includes real-device billing
SDK cleanup verification, identity SDK cache cleanup, the unresolved single-slot recovery edge,
Clerk's alternate self-deletion path and out-of-band deletion handling, durable
worker scheduling, provider purchase-proof/re-creation safeguards, and real
provider/OS deletion and reverification tests. The new device-cleanup checkpoint
now covers app SQLite data, billing SDK detachment, kiosk credentials and native notifications;
it does not yet prove erasure of every provider SDK cache. No production
migration, provider deletion, submission enablement or deployment was performed
for this UI integration.

### Durable native billing identity cleanup

Local database version 14 adds `native_billing_identity`. This singleton journal
keeps the current and pending SDK identity, their account/session/device/household
scope, public SDK key, store and environment. It contains no receipt, customer
object, token or offering. The journal commits before configure/login and keeps
both identities until the native SDK confirms which one is current. Account
erasure deliberately retains this journal until SDK detachment finishes.

`BillingIdentityController` serializes configure/login, purchases, restores and
logout in one queue. New transitions require an active matching local session,
unlocked parent controls and an account without a deletion marker. An accepted
deletion fences old callbacks, waits for any in-flight store operation, then
logs out only if the SDK still belongs to that account. A later account's
identity is preserved. Store callbacks cannot be reused after their queue
operation ends. Unknown native identities, corrupt journals and project/key
changes fail closed instead of guessing whose cache to remove.

On restart, the controller resumes the SDK's cached identity, reconciles it with
the durable current/pending records and finishes any required logout. If logout
succeeded but its acknowledgement was lost, the SDK's anonymous identity allows
cleanup to finish without logging out again. An eight-second UI wait limit keeps
recovery responsive; it never releases the underlying native operation's place
in the queue. Billing, PIN and notification cleanup run independently, and a
failure keeps the deletion receipt and incomplete-cleanup checkpoint.

Purchase operations require the server-issued household customer ID.
After logout, the SDK's anonymous identity must **not** be passed to `logIn`:
RevenueCat can merge it into a new customer and leave `originalAppUserId`
anonymous. The queue instead reconfigures the detached SDK with the explicit
household ID, preserving the existing client/server ownership checks. It first
resumes the cached anonymous configuration because both locked native SDKs
deduplicate their original configuration even after login/logout changed the
customer. This also permits returning to a previously configured household.
Normal identified-to-identified switching still uses `logIn`.

This narrowly scoped reconfiguration relies on the installed React Native
Purchases 11.0.0 / HybridCommon 20.1.0 bindings and their native implementations:
[Android 11.0.0](https://github.com/RevenueCat/purchases-android/blob/11.0.0/purchases/src/defaults/kotlin/com/revenuecat/purchases/Purchases.kt)
replaces and closes a differently configured singleton; [iOS 5.99.0](https://github.com/RevenueCat/purchases-ios/blob/5.99.0/Sources/Purchasing/Purchases/Purchases.swift)
releases the old singleton before replacing it. Both deduplicate equal original
configurations. Recheck this behaviour when upgrading the SDK and verify it on
real store builds before release. No in-flight purchase may overlap replacement.

This follows RevenueCat's documented [identity lifecycle](https://www.revenuecat.com/docs/customers/identifying-customers)
and [logout/cache behaviour](https://www.revenuecat.com/docs/test-and-launch/debugging/caching).
Logout is a local SDK detachment, not remote customer deletion. Resuming a cached
identity or synchronizing SDK attributes can contact RevenueCat before logout;
server tombstones and follow-up erasure for late SDK/webhook recreation remain
required before enabling deletion. Real provider/device verification is also
still required. An older development installation that used billing before
identity journaling has no reliable ownership proof for an untracked SDK cache;
do not treat that legacy cache as verified erased.

The final focused verification passed 47 tests covering real SQLite persistence and
restart, native configure/login/logout acknowledgement loss, account switching,
an in-flight purchase, cleanup timeout without queue release, retired callbacks,
kiosk/session guards, malformed/stale journals, SDK error sanitization and
independent PIN/notification cleanup. The SDK doubles model anonymous aliasing
and original-configuration deduplication; purchase/restore after deletion,
returning to a previous configuration and interrupted reconfiguration pass.
Native SDK calls are controlled doubles;
these tests do not establish real RevenueCat erasure or real store purchase
behaviour. Submission and purchase rollout settings remain unchanged.

The general regression run passed 500 tests with no skips/cancellations; the
final focused run also covers the subsequently added parent-access check inside
delayed native initialization. Root/mobile lint and TypeScript passed.
Final Android and iOS Hermes exports also passed; output and logs are under
`C:/Users/danie/.codex/tmp/cyntch-billing-identity-alias-export`.
An Android emulator cold start reached the existing household board after the
database initialization change. This cold-start check does not exercise a real
store identity or purchase. Its UI evidence is
`C:/Users/danie/.codex/tmp/cyntch-billing-identity-start.xml`.

### Deleted-account filtering for Clerk's offline cache

`ClerkProvider` now uses Cyntch's `nativeClerkResourceCache` through Clerk's
existing custom resource-cache interface. The installed Clerk Expo 4.14.5 cache
only exposes get/set, and its set operation acknowledges before its internal
keychain write finishes. Cyntch needs an awaited write and cleanup boundary so a
delayed SDK callback cannot restore an erased profile after cleanup succeeds.

The replacement keeps environment, client snapshots and the last session JWT
in Expo SecureStore with the existing `AFTER_FIRST_UNLOCK` accessibility. No
profile or token is copied into SQLite. A serialized owner reads the durable
deleted-account fence on every cache access. It removes matching sessions,
profiles and session tokens, preserves other identified sessions and their
original signed tokens, and clears an erased active-session reference. JWT
decoding is used only to discard cache entries, never to authorize access.
Malformed or unidentified session data is discarded. Once an account has been
erased on this device, offline copies of pending sign-in/sign-up flows are
omitted because those snapshots contain profile fields without a reliable
account ID. Live authentication flows and the native SDK are unchanged.

Chunk storage reserves its allocation in a small encrypted manifest before
writing data, commits the new slot before retiring the old one, and remembers
unfinished cleanup across process death. Missing committed chunks invalidate
and remove the remaining fragments; retired data is never a fallback. Legacy
Clerk slots are migrated before their known chunks and markers are removed.
An interrupted first migration retains the legacy source until the replacement
commits. Invalid allocation metadata fails closed. This is logical cache
cleanup, not forensic erasure; unindexed fragments from an interrupted older
SDK write cannot be enumerated through SecureStore's public API.

Accepted deletion runs offline-cache cleanup independently alongside billing,
notification and PIN cleanup. An eight-second UI timeout retains the underlying
queue operation and saved deletion receipt. Retrying cannot overtake an earlier
write. **Keep deletion submission disabled:** Clerk's shared device credential,
native SDK state and in-memory client are separate and still need coordinated
cleanup. The existing local-cleanup checkpoint does not establish erasure of
those remaining provider caches, and no real account was deleted for this work.

The general regression run passed 512 tests without skips/cancellations. Final
focused verification passed 36 tests, including every write/removal interruption
in migration and replacement, delayed writes, deletion during reads, preserving
another account, malformed/missing data, cleanup timeout, error sanitization and
the native adapter against a real SQLite deletion fence. The final focused run
also covers the subsequently added removal of unreadable cache fragments.
Root/mobile lint and mobile TypeScript passed. Verification logs are under
`C:/Users/danie/.codex/tmp/cyntch-clerk-cache-*`.

Final Android and iOS Hermes exports passed. On the Android emulator, an online
cold start opened the original household after migration; a metadata-only check
found all three new encrypted resource manifests and no legacy cache markers.
A second cold start with Wi-Fi and mobile data disabled (Android reported no
active default network) opened the same household and saved tasks with the
offline banner. The development bundle still arrived over ADB's local reverse
connection; Clerk's internet endpoint was unavailable. Both network settings
were restored and Android confirmed an active network. Evidence:
`cyntch-clerk-cache-loaded.xml` and `cyntch-clerk-cache-offline-board.xml` in the
same temporary evidence directory. This verifies ordinary offline startup on
Android, not real provider account deletion or iOS device behaviour.

### Native Clerk identity verification during deletion recovery

The local Expo module `modules/cyntch-clerk-state` inspects the existing native
Clerk client. It returns only readiness and three account-presence flags; tokens,
names, email addresses and other accounts' identifiers never cross this module's
boundary. It does not configure a second Clerk instance or reset a credential.
The JavaScript adapter checks the existing Clerk bridge's readiness before
inspection, including before accessing `Clerk.shared` on iOS. Missing modules,
loading state, malformed results and provider errors cannot establish cleanup.

Accepted deletion now requires this additional check before reporting local
cleanup complete. It first verifies the durable deleted-account fence, refreshes
the native client through Clerk's bridge, awaits the supported JavaScript
[`client.reload()`](https://clerk.com/docs/expo/reference/objects/client#reload)
and rechecks both clients. A retained deleted account, unidentified session or
unscoped sign-in/sign-up snapshot leaves the saved receipt available for retry.
An eight-second UI timeout keeps the underlying verification operation serialized.
Other independent cleanup phases still run even when this check fails.

Recovery starts outside Clerk so account expiry cannot hide the receipt. A small
component inside Clerk retries incomplete accepted cleanup when native/JS
readiness or session identity changes, using
[`useAuthViewState`](https://clerk.com/docs/reference/expo/native-hooks/use-auth-view-state).
Cleanup's own busy/error publications do not trigger more requests. There is no
polling timer or additional request during ordinary startup without an accepted
deletion receipt.

The module matches the installed native bridge's Android Clerk 1.3.0 and iOS
ClerkKit 1.6.2 dependencies; review these pins together with Clerk upgrades. A
native rebuild is required. Android compilation, APK installation and actual
bridge inspection on the emulator passed. The bridge distinguished the existing
account from an absent account, and the original household still displayed its
two tasks. Apple autolinking and iOS JavaScript export are separate checks and
do not prove Swift compilation or execution on iOS.

**Deletion submission remains disabled.** This check observes loaded clients;
it does not independently verify native SDK disk-cache writes, prove that no
late SDK response can restore a profile, erase a shared device credential or
complete remote provider deletion. Shared credentials can belong to other
accounts and must not be cleared indiscriminately. Real deletion/restart tests,
native persistence verification and out-of-band provider deletion handling are
still required before release.

Verification: the general regression run passed 520 tests without skips or
cancellations. The final focused run passed 29 tests, including the subsequently
added explicit JavaScript refresh and native recheck. Root/mobile lint and mobile
TypeScript passed. Build/test/runtime evidence is under
`C:/Users/danie/.codex/tmp/cyntch-clerk-native-*`; the native read-only result is
`cyntch-clerk-native-runtime-evidence.json` and the household UI is
`cyntch-clerk-native-loaded.xml`. No real account was deleted for these checks.
The same emulator also passed native refresh followed by JavaScript reload,
preserving the signed-in account (`cyntch-clerk-native-runtime-refresh-evidence.json`).
Final Android and iOS Hermes exports passed in
`C:/Users/danie/.codex/tmp/cyntch-clerk-native-export-final`.

### Verify the persisted native Clerk profile separately

Deletion recovery now also calls `inspectPersistence` after the native/JavaScript
refresh and before its final in-memory identity check. A retained profile,
unidentified session, sign-in/sign-up snapshot, malformed result, storage error
or older native build without this method keeps local cleanup incomplete and
retains the saved receipt. Ordinary task saves and startup without an accepted
deletion receipt do not perform this inspection.

The adapter is deliberately tied to the installed SDK formats. Android's
dependency is now constrained to exactly 1.3.0, matching the existing exact iOS
ClerkKit 1.6.2 pin. Review the adapter when updating either SDK. Sources inspected:
the [published Android 1.3.0 sources](https://repo.maven.apache.org/maven2/com/clerk/clerk-android-api/1.3.0/clerk-android-api-1.3.0-sources.jar)
(`StorageHelper`, `StorageCipher`, `CachedClerkState`, `ClientStateStore`) and
[ClerkKit's identity store](https://github.com/clerk/clerk-ios/blob/1.6.2/Sources/ClerkKit/Identity/ClerkIdentityStore.swift),
[storage configuration](https://github.com/clerk/clerk-ios/blob/1.6.2/Sources/ClerkKit/Dependencies/DependencyContainer.swift)
and [keychain adapter](https://github.com/clerk/clerk-ios/blob/1.6.2/Sources/ClerkKit/Storage/Keychain/SystemKeychain.swift).

Android reads the actual preferences XML and its recovery backup, not the
SharedPreferences memory view. It decrypts only the cached profile with the
existing Android Keystore key, without creating keys, migrating or writing data.
Legacy plaintext profiles are also inspected. Both files are reread to reject a
snapshot that changes during inspection; reads are bounded. An older account in
the backup still prevents success. Invalid XML, external entities, duplicate
cache entries and unexpected client fields cannot establish erasure.

iOS reads the configured `cachedClient` keychain items and, when a shared access
group is configured, both the app-local and legacy services. It handles current
wrapped and older bare client snapshots and rejects inconsistent rereads. The
keychain work runs outside the main actor. Neither platform exposes cached
profiles, tokens or other account identifiers to JavaScript; only verdict flags
cross the bridge. Neither platform changes another account or a shared token.

This supersedes the earlier limitation about observing loaded clients only.
It proves only a point-in-time profile-cache observation. Biometric credentials,
late SDK callbacks, shared device credentials, out-of-band deletion and complete
provider deletion/restart tests remain separate release requirements. **Keep
deletion submission disabled.** Native iOS compilation subsequently passed in
run `41807271365`; device execution is still unverified. An iOS JavaScript export
cannot establish either.

Verification: 31 JavaScript recovery/cache tests and eight Android native unit
tests passed, along with root/mobile lint, mobile TypeScript, Android APK build
and Android/iOS Hermes exports. The native tests include stale backup profiles,
read/decryption failures, concurrent storage changes, unknown sessions, corrupt
XML/JSON and other-account preservation. Run the native tests with
`:cyntch-clerk-state:testDebugUnitTest` from the generated Android project using
the toolchain settings at the top of this README. Evidence is under
`C:/Users/danie/.codex/tmp/cyntch-clerk-persistence-*`.

The rebuilt APK also passed actual Android emulator inspection of its encrypted
profile: the existing account was present, an absent account was absent, and the
in-memory client agreed. The same checks passed after force-stopping the app and
reopening with Wi-Fi/mobile data disabled; the household's original two tasks
remained available. The three read-only inspection calls together took 33 ms
online and 19 ms after the offline restart in these samples, not a release-device
performance guarantee. Evidence: `cyntch-clerk-persistence-runtime.json`,
`cyntch-clerk-persistence-runtime-offline.json` and the offline UI tree
`cyntch-live-1793774079544.xml`. No account was deleted, no credential was reset,
and network settings were restored after testing.

### Android biometric credential cleanup

After confirming the durable accepted-deletion fence, recovery now removes the
account's local biometric credentials before refreshing its provider profile.
Android calls Clerk 1.3.0's public
`biometricCredentials.forgetLocalCredentials(accountId)` off the UI thread. It
does not reset Clerk, clear the shared device token or erase another account's
credentials. Removing local keys does not replace remote identity/credential
revocation; the server deletion workflow remains required.

The native adapter validates the pinned SDK's credential metadata before calling
it. This matters because the SDK can treat unreadable or unsupported metadata as
an empty list. Unknown versions, malformed records, duplicate credential IDs or
shared key references cannot establish cleanup. The adapter checks both the
account and application scope, waits for the SDK operation, then verifies that
the target records and their previously recorded Android Keystore aliases are
gone. Unretired legacy preferences/backup records and concurrent file changes
keep cleanup incomplete. No key material or metadata is returned to JavaScript.

Failures retain the receipt. The existing eight-second UI timeout does not
cancel the underlying work or allow a retry to overtake it. There is no extra
request, key inspection or disk work on ordinary task saves.

ClerkKit 1.6.2 exposes its account-scoped local-forget method only within its Swift
package; inspection of 1.7.1 found the same restriction. Its public current-device
revocation method requires an active session, so it is not sufficient for
interrupted recovery after server-side deletion. The JavaScript boundary rejects
a missing erasure method in older native builds instead of reporting cleanup as
complete. The newer iOS private-store adapter and its verification are described
near the top of this README. Late enrollment callbacks, real biometric keys and
end-to-end deletion remain unfinished. Deletion submission stays
disabled. See the pinned
[ClerkKit implementation](https://github.com/clerk/clerk-ios/blob/1.6.2/Sources/ClerkKit/Core/BiometricCredentials.swift).

Android unit tests cover account/application selection, malformed metadata and
duplicate credential/key references. JavaScript tests cover the accepted-deletion
fence, missing/failed/incompatible native methods, offline refresh failure and
serialization across a timeout. The device test at
`android/src/androidTest/java/com/cyntch/clerkstate/ClerkBiometricCleanupDeviceTest.kt`
inside the local module uses the real pinned SDK and Android Keystore in the
separate `com.cyntch.clerkstate.test` APK. It creates only local fixture keys,
not provider users or enrolled biometric credentials. Build it with
`:cyntch-clerk-state:assembleDebugAndroidTest` and pass a development publishable
key as the `cyntchClerkPublishableKey` instrumentation argument. It refuses to run
in the household app's package or with a production key.

The API 36 Android emulator passed this isolated SDK/Keystore test five times,
including a run after clearing only the test package's data. These runs verify
selective key removal, preservation of another account/application's records and
keys, repeat cleanup, and refusal of an unsupported metadata version. They do
not verify biometric enrollment, an actual account deletion or iOS. One earlier
attempt failed without stage diagnostics; another failed in metadata validation
before SDK deletion. Their causes are not established. A separate attempt failed
to attach the test process. Native errors
now retain only the stage, exception type and source location for diagnosis;
JavaScript receives the same generic recovery message. Keep the deletion release
gate closed pending the remaining verification above.

The updated household app APK also loaded its existing two-task board unchanged
(0 of 2 complete). A read-only runtime check found the new native erasure method
registered and the persisted/loaded sign-in profiles consistent. No deletion or
credential mutation was invoked in that app. Validation: 33 JavaScript tests,
13 Android JVM tests, mobile lint/typecheck, root lint, Android APK build and
Android/iOS Hermes exports passed. Emulator evidence and artifact hashes are in
`C:/Users/danie/.codex/tmp/cyntch-clerk-biometric-evidence.json`; the isolated test
package was removed and the emulator stopped after verification.

### Processing accepted deletions in scheduled batches

`runAccountDeletions()` connects the durable PostgreSQL coordinator to the real
data, Stripe, native billing and Clerk/Apple adapters, in that order. The new
server setting `ACCOUNT_DELETION_PROCESSING_ENABLED` defaults off and must be
exactly `true` to run a batch. Keep both processing and submission disabled until
the complete provider/device workflow is verified. Processing is independent of
`ACCOUNT_DELETION_SUBMISSION_ENABLED` and purchase rollout flags: disabling new
requests or purchases must not prevent already accepted cleanup from continuing.

The existing authenticated `/api/cron` (and `/api/internal/recurrence`) starts
deletion work alongside recurrence work and registers that same promise with
Next's `after`; it does not run another batch from the callback. Durable jobs,
phase acknowledgements, retry times and reclaimable leases remain in PostgreSQL.
They survive process termination even when the platform cannot finish `after`.
Provider calls never run in the mobile submission request.

`GET /api/internal/account-deletions` is also available for a dedicated monitor
or scheduler. It requires the configured `CRON_SECRET` bearer header before
doing work and returns non-cacheable aggregate counts. Missing configuration is
503, invalid authentication is 401, processing failures are 503 and healthy or
disabled processing is 200. Failed pending jobs keep reporting unhealthy while
waiting for retry; a quiet backoff tick is not recovery. Ordinary planned
provider waits do not count as failure. The household cron includes this result
in its existing `ok` response; its HTTP status convention is unchanged.

Only the exact recovery-status and these three cron paths bypass Clerk
middleware. Their handlers enforce their own key/secret, so stale user cookies
and an unavailable identity provider cannot prevent cleanup or its monitoring.
Normal account, household and protected-page authentication remains in place.

A batch claims at most five requests with a 20-second working budget. Each
phase receives the actual remaining budget after its lease check. The data
transaction rechecks that deadline between statements and sets a transaction-local
PostgreSQL statement timeout; budget exhaustion rolls back partial erasure and
content moves. Provider adapters use the same remaining budget for their bounded
requests. A timeout never acknowledges a phase that did not finish. The dedicated
route allows 30 seconds for processing and response/connection overhead; the
existing household scheduler's broader timeout/monitoring review remains open.

No server schema migration or production configuration change is introduced by
this wiring. Live provider deletion, native persistence, out-of-band account
deletion and release/pilot verification are still outstanding.

Verification: 530 general regression tests passed without skips/cancellations,
including PostgreSQL statement cancellation, rollback after partial erasure,
phase budgets, lease recovery and provider backoff. The final middleware/worker
boundary run passed 19 tests after adding the exact cron middleware exemptions.
Root lint, standalone TypeScript and the production build passed. Native source
did not change in this checkpoint.

The built production HTTP worker also passed against an isolated local schema,
with all external credentials removed. It rejected unauthenticated calls, ran
real data cleanup for a fixture account with no households/purchases, preserved
an unrelated account, retained the identity phase and receipt when configuration
was unavailable, and returned 503 during backoff. This is not proof of real
provider erasure. Its evidence is
`C:/Users/danie/AppData/Local/Temp/cyntch-deletion-worker-fff86570-0fad-4d82-99bd-f5a0edfee853.json`.
After building, repeat this isolated check with:

```powershell
$env:CYNTCH_TEST_DATABASE_URL='postgresql://cyntch_test@localhost:55439/cyntch_mobile_test'
$env:CYNTCH_DELETION_WORKER_HTTP_TEST='true'
node --test tests/integration/account-deletion-worker.cjs
```

The test creates and removes its own schema and local server. It never enables
processing on a deployed environment or calls a real provider deletion API.

### Native run rename and deletion

Managers and supervisors can rename or delete an opened active or historical run
from the native Runs screen. These actions use the existing authenticated flow
handlers and their household, session and kiosk checks. Members have no management
controls. Both actions require a connection; ordinary task completion remains
available offline. Deletion requires a confirmation explaining that the template
and other runs stay, while this run and its history are removed for everyone.

The name editor keeps its entry during rotation and failed saves. It uses a
focused, scrollable native view with keyboard avoidance on iOS and disables
Android's fullscreen text extraction so the name stays visible in landscape.
A failed or ambiguous reply leaves the view available with a Refresh run action;
the client never automatically retries a destructive request.

Confirmed changes update Today, run details and cached lists in SQLite. Renaming
preserves pending task completion changes. Deletion removes the matching run from
the caches and marks unsent changes for that run as rejected for explicit review.
Each local update is transactional; a write failure rolls it back. In-flight
reads are invalidated around the update so an older response cannot put the old
name or deleted run back. Runtime identity/parent-access checks prevent a delayed
confirmation from operating on a newly selected account or household.

Verification on 4 November 2026: 536 general regression tests passed without skips,
including real SQLite restart/rollback and late-response checks. The native
transport also exercised the real flow handlers against an isolated PostgreSQL
schema: member and kiosk denials, household isolation, and preservation of the
template and other runs after deletion. Root and mobile lint/type checks passed,
as did Android and iOS Hermes exports. No native binary or production deployment
was changed for this checkpoint.

On the running Android emulator, a disposable local run was renamed through the
native editor, its draft survived rotation, and the corrected landscape editor
kept the name above the keyboard. Cancelling deletion retained it; confirming
deletion removed its server row, snapshot task and native list entry. The original
three runs were retained and the device's rotation settings restored. Evidence:
`C:/Users/danie/.codex/tmp/cyntch-run-ui-fixture.json`, with screenshots
`cyntch-run-controls.png` and `cyntch-run-landscape-keyboard.png` in that directory.
Physical iOS/Android device, accessibility and household pilot verification remain
part of the full release goal.

### Native routine practice verification

The native preview shares prerequisite ordering and upstream traversal with the
web planner. Its detached display model has no network or storage dependency.
Tests cover multiple prerequisite branches, cross-routine ancestors, rewards,
missing links, cycles, source refreshes, legacy assignments and a 1,000-task chain.
The native modal chooses its layout from its own available width, accounting for
large text and narrower sheets rather than assuming the full window is available.
Accessible task labels include assignment, reward status and ready-task notes.

Verification on 4 November 2026: 541 general regression tests passed with no
failures, skips or cancellations. The focused practice/planner/database run
passed 12 tests. Root/mobile lint and TypeScript checks and the production web
build passed, as did Android and iOS Hermes exports. These checks do not establish
signed-binary or physical-device release readiness.

Android emulator checks covered prerequisite unlocking, reward completion,
reset, offline use, reopening, hardware Back, both landscape orientations and
portrait, retaining practice progress during rotation and foreground resume.
At font scale 1.5, the resumed preview used a scrolling single-column layout.
Real task/run/state hashes and completion-operation/notification counts remained
unchanged throughout the practice interactions. Evidence is in
`C:/Users/danie/.codex/tmp/cyntch-practice-runtime.json`, with the
`cyntch-practice-portrait-final.png`, `cyntch-practice-wide-final.png` and
`cyntch-practice-large-font-top.png` captures in the same directory.

Reliability remains open: an input-dispatch ANR occurred during rotation and hot
refresh under substantial CPU, memory and I/O pressure; its stack capture failed.
A subsequent startup ANR caught React Native's SoLoader reading native-library
dependencies from the APK, before the practice screen loaded. After stopping an
idle build daemon, the next launch and repeated rotation checks passed. This is
not conclusive proof of the original freeze's cause or resolution. Release-like
startup, memory-pressure and rotation checks on physical devices remain required.
The emulator was closed after testing, with its font, rotation and connectivity
settings restored and application data retained.

### Today filters, task details and device display choices

Today now offers To do, Ready, Completed and All filters, combined with task/run
name search and the existing person selection. Ready tasks appear before completed
and waiting tasks; prerequisite depth and creation order preserve the web board's
ordering, with a stable fallback for older cached boards. Unassigned tasks appear
under the household leader. Opening a task's details does not toggle it. Details
show its notes, assignment, availability, expiry and current state, and follow
live changes without losing the selected task when a status filter hides its row.

Parents can choose which members appear and whose tasks are editable on this
device, independently for each account and household. Preferences save in SQLite,
work offline and survive restarting the app. An explicit empty edit selection
means view-only. Removed member IDs do not silently expand the display to everyone.
Unreadable preferences require an explicit retry or reset. Role loss, household
removal and kiosk activation prevent late preference writes; kiosk settings remain
separate and authoritative. These ordinary display choices are not a parental
lock: use kiosk mode to protect access to the controls.

Landscape moves the family selector and display settings to a scrollable sidebar,
combines the title/count and provides an expandable search field. Large text can
use a single-column layout with scrolling controls. Rejected saved changes are
identified as needing attention in task rows and details, rather than described
as still waiting to upload. The shared row preserves the existing Runs interaction.

Verification on 4 November 2026: all 546 general regression tests passed without
failures, skips or cancellations. The five new board-view tests cover combined
filters, deep/cyclic prerequisite ordering, legacy caches, role/kiosk restrictions,
real SQLite restart and write rollback, account/household isolation, retained
pending completions and revoked access. Root/mobile lint and TypeScript checks
passed, as did Android and iOS Hermes exports.

On the Android `medium_phone` emulator, checks covered Ready/Completed/All filters,
search with the keyboard, retained search through rotation, hiding landscape
search, task notes, hardware Back, disabled completion in both read-only views,
preferences after force-stop/relaunch, offline preference saving, and font scales
1.5 and 1.8. At 1.8 in landscape, controls and tasks remain reachable by scrolling;
the opening viewport does not show the task list immediately. The standard-size
landscape opening viewport shows a complete task. Details remain open and readable
when rotating back to portrait. Preferences were restored to everyone, font scale
to 1.0, rotation/connectivity settings restored, and the emulator stopped cleanly.

Captures and the case record are in
`C:/Users/danie/.codex/tmp/cyntch-board-view-runtime.json`, including
`cyntch-board-landscape-final.png`, `cyntch-board-final-portrait.png` and
`cyntch-board-largest-font-tasks.png` in the same directory. Development-client
startup was slow; these checks do not resolve the prior startup/ANR investigation
or establish physical-device performance, screen-reader support or iOS runtime
readiness. No production deployment, database migration or signed build was made.

Full functional coverage is still incomplete. In particular, the web canvas's
creation/editing of one-off task boards still needs an equivalent native workflow;
native Runs currently displays existing boards and supports their rename/removal.

### One-off board write transactions

The server now accepts an immutable `creationId` for `createTaskBoard`. The board
and its receipt commit together; retries return the original board/start time
without consuming another quota slot. Changed payloads conflict, deleted boards
are not recreated, and current role/kiosk restrictions still apply to replay.
Board names and optional start times are validated before database admission.

Structured `createTask`/`updateTask` requests containing both `occurrenceId` and
`prerequisiteIds` now edit live run tasks atomically. They validate the run, its
template association, household assignees, same-run prerequisites and cycles.
Creating/editing a live task cannot rewrite a template or another run. Cancelled
runs reject editing. Metadata, assignments, dependencies, optional time rules,
resulting task availability and creation receipts share one transaction. Existing
task-save revisions prevent old or repeated edits from reapplying timing rules.
Ordinary metadata edits retain resolved times and canvas positions; explicit
timing edits use the web editor's server edit-time baseline and can include exact
availability/expiry overrides. Timing overrides require the accompanying rules.

The existing entitlement checks apply to the actual target: standalone boards
remain Premium, existing metadata remains editable after downgrade, and Free
requests cannot introduce paid time rules or use a run ID to evade template
limits. The flow route reads membership once, after acquiring the household
write lock and before either a new write or receipt replay, so that permission
read cannot become stale before write admission.

Apply `database/0040_task_board_creation_receipts.sql` before enabling native
board-creation requests. Earlier receipt migrations now leave a newer superset
constraint intact when the migration runner reapplies them. Isolated PostgreSQL
tests exercise repeated migrations while newer receipt rows exist. No production
migration has been applied for this work.

Server checkpoint validation: 550 general regression tests and 19 isolated
billing tests passed, as did root lint/types and the production web build. The
broader native workflow continues below; live task editing was not yet wired to
the native interface at this server checkpoint.

### Native one-off board creation

Runs now includes a parent/supervisor creation sheet for a named one-off board.
Its unfinished name is stored per account/household/device, including offline
edits. Submission requires connectivity and returns after the local transaction;
the immutable request continues uploading/retrying in the background. A second
board request is blocked until the first has synced or been reviewed. Requests
with uncertain outcomes cannot be silently discarded.

The server response must match the saved household, board kind and name before
acknowledgement. The resulting run-list entry and request deletion commit in one
SQLite transaction. Disk failure retains the request; a delayed receipt cannot
replace a newer cached run or repopulate revoked parent data. In-flight run-list
reads are invalidated before acknowledgement. Drafts participate in kiosk
activation checks and are cleared when management access is revoked.

The creation sheet is mounted outside the list's column-count key, preserving
the open form and text during rotation. Large text and short landscape windows
can scroll to every action. At this checkpoint the native form did not yet
provide live task creation/editing; that work continues below.

Validation for this increment: 556 general tests passed (including real
PostgreSQL and SQLite), 19 isolated billing regression tests passed, and root
and mobile lint/types passed. The production web build and final Android/iOS
Hermes exports passed. Android device checks and export evidence are recorded in
`C:/Users/danie/.codex/tmp/cyntch-board-create-runtime.json`.
Migration 0040 was also applied to the verified local test database on port
55439 for emulator testing; no production migration or deployment was made.

On the Android development client, the unfinished name survived force-stop and
relaunch. The corrected sheet stayed open during rotation, and 1.5-scale text
in landscape could scroll to all actions. Offline submission was disabled; a
name edited offline survived a full emulator restart. A Free-plan rejection
remained available for review. Temporarily enabling Premium on only the local
fixture allowed retry of that same request, produced exactly one board and one
server receipt, and displayed/opened the new board in Runs. The test board was
deleted through the app, original fixture billing fields restored, and device
font/orientation/network defaults restored.

An Android input-dispatch ANR occurred during concurrent bundle compilation
and keyboard/offline testing (5,158ms KeyEvent timeout). Host free memory was
about 1GB; captured stacks show ART/CheckJNI and a runnable JavaScript thread,
but this does not establish the cause. The final creation test succeeded after
compilation finished and the emulator was restarted. The ANR investigation,
release-build performance and physical Android/iOS checks remain outstanding.
Diagnostic files are `cyntch-board-create-anr.txt` and
`cyntch-board-create-anr-dropbox.txt` in the same temporary evidence directory.

### Native live task editor

Parents and supervisors can open **Edit tasks** within a run to add, edit or
delete its tasks and rewards. The editor supports names, notes, multiple
assignees, prerequisites and activation/expiry rules using the shared native
form. Changes target that run; template tasks and other runs are preserved.
Existing-task edits can be saved offline. New tasks require connectivity, but
their unfinished forms can be entered and retained offline. Deletion requires
connectivity, a confirmation and no unfinished/saved editor changes to that run.

Live drafts, snapshots and queued edits have separate account/household/run
storage. Enqueue, optimistic editor state and draft removal share one SQLite
transaction. The controller returns after local persistence and uploads in the
background, with retry backoff only while work exists. Repeated edits retain
device order; uncertain creation requests retain their original ID and body.
Revocation, kiosk mode and account deletion fence access to this storage.
Failed draft writes retain the visible text and show that it has not been saved.

Save acknowledgements include authoritative assignments and prerequisites, so
an older revision cannot restore its stale graph. A recovered creation receipt
does not replace a newer already-loaded server task. Confirmed deletion updates
the editor, Today and run caches atomically, clears the deleted task's unfinished
draft and prevents late replies from restoring it. The server recomputes
dependent task availability in the deletion transaction, including rollback if
that recomputation fails. Cancelling navigation during delete admission sends
nothing; navigation after submission still applies cleanup to the original run.

The editor stays outside the list's responsive column key. Android Back closes
the keyboard first, then the task form, then the task workspace. A closed form
remains available as an unfinished draft. The embedded editor uses the run
sheet's safe area rather than adding a second set of insets.

Verification: 568 general regression tests and 19 isolated billing tests passed.
Root/mobile lint and type checking, the production web build and Android/iOS
Hermes exports also passed. The exports are in
`C:/Users/danie/.codex/tmp/cyntch-live-editor-export-final`.
The new real SQLite tests cover restart, failed transactions, coalesced timing,
late/stale receipts, role revocation, kiosk restrictions, deleted tasks and
navigation races. PostgreSQL tests exercise native API reads/writes, assignment
and dependency recovery, run isolation and atomic deletion/unlocking.

Android development-client checks confirmed offline save through force-stop and
relaunch, reconnection/upload, template/sibling-run isolation, portrait keyboard
handling, landscape rotation, enlarged text and scrolling to Save. A new reward
was created with the selected assignee and prerequisite, verified as locked on
the server, and deleted through the native confirmation flow. The original test
task title was restored through the editor; both the local edit queue and draft
list were empty afterwards. Device display/network settings were restored and
the emulator stopped. Evidence and hashes are recorded in
`C:/Users/danie/.codex/tmp/cyntch-live-editor-runtime.json`.

Pending metadata display is covered by the next section. Remaining work includes
the complete native feature-parity audit, live timing controls on devices,
physical Android/iOS testing and release-build performance. No ANR/crash was
reported in this emulator session's event log; the earlier ANR's cause remains
unresolved. These checks do not establish store readiness or fulfil the complete
mobile release specification.

### Pending live edits across task screens

Today, task details and run details now show locally saved names, notes, reward
flags and assignments, with separate pending/rejected edit indicators. They read
the existing durable queue, including after restart; they do not predict changes
to task availability, completion or timing. Prerequisite labels use the matching
task ID within the same run. The run API now includes that ID and its assignees;
older cached responses without the ID need one refresh to update these labels.

Acknowledgement applies the confirmed task metadata to the editor, Today and
run caches in the same transaction that removes the queue entry. A failed cache
write rolls the whole acknowledgement back. Newer queued completion changes
remain visible. Removed tasks are never reinserted. Discarding a rejected edit
uses fresh household data. Controllers invalidate earlier network and local
reads before acknowledgement, then reload the local views without waiting for
another server request. Role changes and kiosk restrictions hide edit overlays.

Verification includes 571 general regression tests before the final API/read
fence adjustments, followed by 16 passing focused PostgreSQL, SQLite and
controller tests covering those adjustments. Root/mobile lint and type checking,
the production web build and Android/iOS Hermes exports passed. Final exports:
`C:/Users/danie/.codex/tmp/cyntch-live-metadata-export-verified`.

Android emulator checks verified offline title changes across the editor, Today
and run details, task-detail status text, force-stop/relaunch recovery, upload,
and immediate prerequisite-label updates after the API correction. The original
title was restored using the native editor; the final queue and draft list were
empty, and template/sibling-run names were unchanged. Evidence and hashes:
`C:/Users/danie/.codex/tmp/cyntch-live-metadata-runtime.json`.

Rapid ADB keyboard input containing two R keys triggered the development client's
React Native reload shortcut in a modal. Separating those keys by more than its
200ms recognition window allowed the check to finish; the draft survived reload.
No ANR/crash event was recorded in this session. This does not resolve the earlier
ANR or establish release-device performance, physical iOS behavior or readiness
for store release.

### Live activation and expiry controls

Live task forms now show the resolved activation and expiry in the household's
timezone. Choosing a fixed date starts from the saved time. Changing expiry or
the prerequisite combiner preserves an untouched activation exactly, including
seconds, milliseconds and the later occurrence of a repeated daylight-saving
hour. Changing activation preserves independent expiry; expiry based on
activation is recalculated. Clear all timing explicitly removes both settings.
Edited relative rules retain the existing server sync-time baseline, explained
in the form. Ordinary metadata changes still omit timing entirely.

Verification: 23 focused timing/editor tests and 37 scheduling/planner tests
passed, including real PostgreSQL and SQLite. These cover timezone boundaries,
successive edits, dependent expiry, retries, exact saved times and clearing.
Mobile lint/types and targeted root lint passed. Final export/type results and
runtime evidence are recorded in
`C:/Users/danie/.codex/tmp/cyntch-live-timing-runtime.json`.

On the API 36 Android development client, a changed expiry date survived an app
stop and emulator restart in the local draft. Saving offline produced a durable
queue entry with the original exact activation override. Reconnection applied
the new household-local expiry and retained the activation on the server, then
cleared the queue. Native Clear all timing restored the fixture's original
timing and availability; the temporary local billing entitlement was restored,
with no pending edits or drafts left behind. No production changes were made.

The reduced-memory emulator run produced a 5,093ms focus-event ANR. Its captured
main-thread stack waited in window relayout/Binder, with high CPU pressure; this
does not establish its cause. A normal-memory restart initially could not reach
Metro with network disabled; after connectivity recovered, the test completed.
Diagnostics are `cyntch-live-timing-anr.txt` and
`cyntch-live-timing-anr-dropbox.txt` in the evidence directory. Release-build and
physical-device startup/performance checks remain open. During offline switching,
the form also moved back to its top while automation was targeting Save; an
unintended assignee selection was corrected before submission. The following
increment addresses the background-error and connection-status layout behavior.

### Keep editing through connection changes

Live editor refresh failures now have separate state from local draft/save
failures. Background refreshes cannot trigger the form's save-error scrolling
or overwrite a warning that the latest draft did not reach local storage.
Successful refreshes clear only their own warning; a local-save warning remains
until the write succeeds. Access revocation still invalidates the editor cache.
Refresh warnings remain visible in the task workspace with its retry control.

An always-present Connection row shows Online or Offline inside the live form.
Switching connectivity does not insert or remove content above the fields.
The 22 focused SQLite/controller/timing tests passed, including failed disk
writes combined with failed/successful refreshes, closed-editor responses and
permission revocation. An initial refresh finishing offline also retains any
local-save error raised while cached details were already open. Final mobile
lint/type and Android/iOS export results
are recorded with the runtime evidence in
`C:/Users/danie/.codex/tmp/cyntch-editor-refresh-runtime.json`.

The Android API 36 development client retained the exact Save button bounds
through online/offline/online transitions in portrait, landscape and landscape
with 1.5-scale text. The draft stayed intact. The unused test draft was discarded
through the native confirmation; final edit queue and draft counts were zero.
Device font, orientation and connectivity were restored and the emulator stopped.
The final session's ANR/crash event query was empty. This does not resolve the
earlier ANR or replace physical iOS/Android and release-build performance tests.

### Consistent routine names in Today and Runs

The member board (web and native Today), run list and run details now share a
display-name rule. An unnamed routine run or an internal recurrence title uses
its routine's name. Explicit run titles are preserved, including named one-off
boards that start with “Recurrence -”. Empty titles have readable fallbacks.
Routine lookups require the same household, including when an old reference is
inconsistent. This changes display data only; stored titles and recurrence keys
are not rewritten and no database migration is needed. Existing offline caches
receive the corrected name on their next successful refresh.

Native task checkboxes and detail controls include the board name in their
accessibility labels, matching the visible subtitle. Searching by routine name
now works for these previously unnamed or internally named runs as well.

Verification: 47 database/API, run-history, board-filter and SQLite/controller
tests passed, followed by the final database case with an explicitly inaccessible
foreign household. That case covers web/native name parity, manual and automatic
runs, blank/missing names, legacy recurrence identifiers, preserved custom titles,
template renaming, household boundaries and unchanged stored titles. Root lint,
types and the production web build passed. Native lint/type/export results and
runtime evidence are recorded in
`C:/Users/danie/.codex/tmp/cyntch-board-names-runtime.json`.

Android API 36 checks verified the “Evening reset” name in Today and Runs, routine
search online and offline, and names in both the visible text and accessibility
tree. The durable board cache contains the corrected names in its server and
display snapshots. No task edits were queued; no unfinished drafts remained.
Search and network settings were restored, the emulator was stopped, and the
session's ANR/crash event query was empty. Physical screen-reader use, iOS device
behavior and the broader release requirements still require verification.
