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

The Routines tab provides native template and task management, assignments,
prerequisites, rewards and task activation/expiry rules. Existing task edits update the screen immediately and
commit to a separate SQLite queue. Unfinished task forms stay on this device;
submitting a form atomically clears its draft and retains its saved operation.
New routines, tasks and manual routine starts use durable requests with immutable
creation IDs. Apply `0020_planner_creations.sql` and `0021_routine_start_receipts.sql`
before deploying this version of the planner API. Receipts commit with the created item, allow retries at full quota, and
remain after item deletion to prevent resurrection. The queue is scoped to the
account, preserves rejected requests for review, and stops uploading after a
confirmed management-role revocation.

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
replace server-owned generation watermarks. This does not yet provide the native
recurrence editor or prove the production scheduler's throughput/delivery window.

Recurrence editing, full run management/history, kiosk protection,
push delivery and store billing are still under development. Rename/delete
actions currently require a connection; extending interruption recovery to those
remaining management actions is still required.

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

Changing Android system font size while the development app is running produced
an Expo Router multiple-linking-handlers warning; a clean launch did not. This
needs investigation and release-build verification before launch. No physical
device performance measurements, iOS native build, store release or household
pilot has been completed.
