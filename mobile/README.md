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
unchanged throughout each store operation; no anonymous identity is created.
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
real sandbox lifecycle verification remain outstanding, as do policy/support
links and actionable management for Stripe and other-platform subscriptions.
Those sources currently show provider instructions. Web reservations also still
need a polished change/cancel recovery flow. Keep the production billing gate off
until the complete purchase and management flows have been verified.

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
