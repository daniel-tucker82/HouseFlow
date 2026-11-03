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

The remaining run management actions, kiosk protection,
push delivery and store billing are still under development. Rename/delete
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
The installation secret is retained in SecureStore. Token rotation is observed,
but complete sign-out cleanup, background settings sync, kiosk integration, event
creation and push delivery/receipts remain to be implemented. An EAS project ID and
FCM/APNs credentials must be configured before push can register and deliver.
This build reports their absence while allowing preference editing. A registration
or a passing JavaScript export is not evidence of delivered push.

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

Changing Android system font size while the development app is running produced
an Expo Router multiple-linking-handlers warning; a clean launch did not. This
needs investigation and release-build verification before launch. No physical
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
