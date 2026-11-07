# Release sequence for the mobile backend

The saved Play draft points at the production API and production Clerk instance.
A working development installation or a signed bundle does not establish that an
installation from Play can sign in. Keep build 2 in draft during these steps.

1. **Compare the release sources.** The verified public policy release was
   `6c1a5de`. Confirm the current production revision before promoting anything.
   Preserve its three public pages, the monitored contact address, and existing web
   account access. Run the public, private and recovery route boundary tests
   on the exact candidate. The mobile branch integrated the public release at
   `e74555f`; 15 public-page and account-recovery boundary checks passed.
   A branch name alone does not identify a deployment.
2. **Rehearse the populated schema upgrade.** Set `CYNTCH_REHEARSAL_ADMIN_URL` to
   an explicit loopback PostgreSQL URL for the `postgres` maintenance database on
   a disposable local cluster, then run `node scripts/rehearse-mobile-upgrade.cjs`.
   It creates a fresh database from template0, installs the published migrations,
   and seeds a household, tasks, assignments and legacy notification history.
   It checks every old row and column, including the three intended notification
   field changes, the new status versions and replay of the migration set. Success
   removes only that newly created database. On failure the printed database name
   identifies it for inspection. It never reads an application database URL from
   the repository environment file to choose a migration destination.
3. **Prepare the actual cutover.** Verify a recoverable database backup, migration
   target, schema version, expected table sizes and maintenance window. The
   rehearsal does not measure production locks or establish a recovery point.
   Stage the server and worker configuration on an isolated deployment first.
   Keep push delivery, billing, new account/household deletion requests and
   their processors at their separately approved settings. A web rollback cannot
   recall a notification or reverse provider deletion.
4. **Check sign-in before distribution.** Coordinate production Clerk native
   enablement, the Android package/signing certificate, and the API deployment.
   Do not remove web self-deletion until the replacement flow and recovery process
   are operational. On the deployed origin check anonymous public pages and
   unauthorized native API responses with `node scripts/check-mobile-backend.cjs <origin>`.
   The script makes 13 GET requests without credentials, rejects redirects, and
   checks page content and API error bodies. It never submits an operation. Sign
   in separately with a designated test
   household and verify bootstrap, board refresh and the server clock. An HTTP
   401 proves the route exists; it does not prove a signed-in session works.
5. **Open the testing track separately.** Keep production public purchase access
   closed. Use the internal track and licensed billing test accounts only after
   the release is usable and a tester rollout is authorized. Check that Play and
   RevenueCat agree on the package, both actual base plans, offering and entitlement.
   Test purchase, restore and cancellation with a **separate test installation**
   using the same Android package, actual Play catalogue, an isolated backend
   and an explicitly non-production sandbox runtime. Build 2 points to the live
   server. Its production entitlement guard deliberately rejects sandbox grants;
   do not change that guard or use a test grant as proof of live access.
   [Google's license testing guidance](https://developer.android.com/google/play/billing/test)
   allows a matching-package development installation for a license tester;
   [RevenueCat's Play sandbox guide](https://www.revenuecat.com/docs/test-and-launch/sandbox/google-play-store)
   also documents track opt-in and device account setup. Check real catalogue
   availability and the Play **test** payment prompt before any test transaction.
   Keep licensed billing evidence distinct from build 2's Play installation check.
   Do not repeat
   completed push or destructive deletion journeys to demonstrate backend readiness.

If cutover verification fails, withhold distribution, stop new submissions for
the affected feature and preserve its existing receipts and pending work. Restore
the known-good web deployment if needed. Do not drop mobile tables or discard
queued operations to roll the web code back.

On 8 November 2026 (Sydney), the local rehearsal upgraded 18 published migrations
through 27 pending migrations, taking 26 public tables to 54. All 93 populated
fixture rows matched their expected values, all 12 occurrence tasks received
distinct status versions, and rerunning the entire set changed no stored rows.
All 13 anonymous HTTP checks also passed against a local production-mode build
with the same server route and middleware sources as `e74555f`, using the
isolated fixture and development authentication configuration. Neither check
establishes production compatibility or proves a signed-in store install works.
