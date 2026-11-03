# Cyntch freemium operations

Status: released to https://www.cyntch.com on 2026-11-03. Application revision b2295302b726ae190075a597f78edc3cc14361fa, production deployment dpl_Beg7714frUP7H5ruNEabSLgCzdfc. FREEMIUM_ENFORCEMENT_ENABLED=true. The live custom-domain alias was verified against this deployment.

## Final release verification

- Production owner billing page shows Permanent Premium access with no subscription required, after enforcement was enabled. Actual entitlement code against production resolves 2 owner households and 6 free households. All 160 existing tasks and 5 templates remain intact.
- Original automated suite: 25 passed. Real Stripe sandbox suite: 8 passed. Targeted lint and production build passed. Deployed browser/API verification covered sign-in, household creation, free limits, hosted test payment, signed provider webhooks, Premium unlock and portal cancellation. The fixed cancellation label was reverified on preview.
- Public production home and sign-in return 200, production Clerk credentials are active, and an unsigned webhook returns 400. No runtime errors were found in the final 15-minute scan. No live payment was made; a real live payment/webhook lifecycle is not claimed as tested.
- Temporary TEST webhook is disabled; its automation bypass was revoked and verified blocked (302). Hosted-checkout test subscription was canceled after checks. Test credentials remain isolated from production. Owner data was not used for payment tests.
- Rollback targets: staged unrestricted production dpl_G1XqpoJn1hV8usWXf8oKvQPC9EYo (same application code, enforcement=false), or a prior verified release. Preserve additive billing tables and event history.
- Source is committed on codex/freemium-subscriptions in C:/dev/HouseFlow-freemium. Root workspace edits were preserved. Do not deploy older master without incorporating this release branch.

## Plans and safeguards

| Setting | Default | Configuration |
|---|---:|---|
| Free templates | 1 | Product policy |
| Free combined tasks/rewards per template or run | 15 | Product policy |
| Free active runs | 1 | Product policy |
| Premium templates | 50 | PREMIUM_MAX_TEMPLATES, maximum 500 |
| Premium items per template or run | 100 | PREMIUM_MAX_ITEMS, maximum 1,000 |
| Premium active runs | 100 | PREMIUM_MAX_ACTIVE_EXECUTIONS, maximum 1,000 |
| Retained task records, Free | 10,000 | FREE_MAX_RETAINED_TASKS, maximum 50,000 |
| Retained task records, Premium/owner | 100,000 | PREMIUM_MAX_RETAINED_TASKS, maximum 1,000,000 |
| New free household admission | 500 households | FREE_HOUSEHOLD_CAP; zero closes admission |
| New households per ordinary account | 1 during rollout | Permanent owner exempt |
| Background recurrence inactivity threshold | 365 days | AUTOMATION_INACTIVE_DAYS, maximum 3,650 |
| Cron batch | 100 households, 10 generated runs per household | Oldest checked first; 45-second scheduling budget |
| Flow API requests | 120 reads and 120 writes/user/minute | Atomic database counters |
| Billing requests | 6/user/minute | Atomic database counters |

Premium and owner have recurrence and timed activation/expiry. Free has manual reuse and completion dependencies. Manual runs are closed only after all items are complete. Owner access uses an independently stored Clerk-verified stable identity and applies to owned households without changing membership permissions.

No historical task, template, or run cleanup is enabled. Quotas reject new creation instead of deleting history. Only transient rate-limit counters older than one day are cleaned up, in batches of 1,000.

## Billing configuration

Required server variables: STRIPE_SECRET_KEY (prefer restricted key), STRIPE_WEBHOOK_SECRET, STRIPE_MONTHLY_PRICE_ID, STRIPE_YEARLY_PRICE_ID, NEXT_PUBLIC_APP_URL. The app URL must be the exact HTTPS origin used by the browser.

Use separate Stripe sandbox/test credentials and products for preview. Never use live financial transactions for tests. Keep credentials in Vercel Secret variables, scoped to the intended environment and branch; never commit them.

Verified live catalog in the user-selected Aspyre account, under Aspyre Pty Ltd (acct_1U4XwUAJcWjR3ecT):

- Product: prod_VYge51YKosH7b8 — Cyntch Premium.
- Monthly: price_1UXZHAAJcWjR3ecTIh1sDRNh — AUD $5.99 (599 cents).
- Annual: price_1UXZJYAJcWjR3ecTHfb4oXwN — AUD $49.99 (4999 cents).
- No trial. No charges were created during catalog setup.

Verified live configuration on 2026-11-03:

- Restricted runtime key saved as sensitive production STRIPE_SECRET_KEY in Vercel. Read-only SDK checks passed for prices, customers, subscriptions, invoices, invoice payments, charges, disputes, Checkout Sessions and portal configuration.
- Webhook we_1UXZt8AJcWjR3ecT3np8Rt7c is active for exactly the 14 handled events at https://www.cyntch.com/api/billing/webhook, using snapshot API version 2026-10-28.endive. Its signing secret is saved as sensitive production STRIPE_WEBHOOK_SECRET. The endpoint is deployed and rejects unsigned requests. Provider-signed delivery was verified in test mode, without a live charge.
- Default portal bpc_1UXZvCAJcWjR3ecTk12fkbrf enables invoice history, payment-method updates and cancellation at period end. Subscription/product/quantity changes and public login links are disabled.
- Both live price IDs are saved in production environment variables. No secrets are stored in this repository; temporary credential transfer files were removed.
- The Stripe connector now correctly exposes Aspyre acct_1U4XwUAJcWjR3ecT in live mode. Earlier OAuth/account-selection problems are resolved for live configuration.
- Final verified preview was b229530 at dpl_4zKq6D4qjZsAFKCxNWb96mxuUuEA, followed by the production rollout above. The branch alias can change during redeployments; use immutable deployment URLs when diagnosing earlier checks.

Test configuration uses the same Aspyre account's isolated test mode: product prod_VYhfrMFyhX2nD5, monthly price_1UXaGbAJcWjR3ecTDUAt0h8Z, yearly price_1UXaGbAJcWjR3ecTXJIcElhm, and default portal bpc_1UXaGcAJcWjR3ecTE8q7DQks. The restricted test key and price IDs are scoped only to the codex/freemium-subscriptions Vercel preview branch. The opt-in tests/billing-stripe-sandbox.test.cjs passed all seven reported tests against real Stripe test-mode APIs and an isolated local PostgreSQL database: paid access, cancellation, reactivation, unpaid and declined payments, hosted Checkout and portal sessions. Test subscriptions were canceled after execution. No live charges were made.

Production migration checkpoint (2026-11-03): backup C:/Users/danie/.codex/backups/cyntch-pre-freemium-1793684589761.dump was restored into isolated local PostgreSQL and verified at 8 households, 160 tasks and 5 templates. Migration 0016 and owner grant committed in one transaction. Clerk's Cyntch production dashboard verified daniel@nexusaspyre.com for stable identity user_3D6gQipThknOd6XvpbBF3Lc5soH. A read-only execution of the actual entitlement code with enforcement enabled confirmed owner access for both owned households without a subscription. Production Vercel FREEMIUM_ENFORCEMENT_ENABLED remains false; no restrictions have been released.

Preview isolation checkpoint: inherited production Clerk credentials rejected the preview host. The existing Cyntch development instance now has an approved named test key, stored only for the preview branch and ignored local tests. These credentials require a new deployment before verification. An approved temporary Vercel automation bypass permits Stripe TEST webhook delivery; revoke it after verification. Test endpoint we_1UXafgAJcWjR3ecT7fAnKUk0 subscribes to the same 14 events, with its signing secret scoped to the preview branch. The bypass reached the endpoint before signing-secret deployment (503 as expected). Provider delivery and authenticated preview checks remain outstanding. No deployment protection was disabled; earlier temporary share links were revoked.

Preview end-to-end evidence (2026-11-03, revision 32cc423): development-user sign-in and household creation succeeded through Chrome. Authenticated deployed API checks rejected a second template, item 16 across tasks/rewards, task-board bypass, recurrence, timed activation and a second active run. Manual execution succeeded. The billing page showed Free and AUD $5.99/$49.99. Its hosted sandbox Checkout accepted Stripe's published test card, returned to the app, and provider-signed checkout/subscription/invoice events granted Premium. The UI showed Premium; a second template and item 16 then succeeded. Concurrent webhook reconciliation retried successfully; observed receipts reached processed state. No live charge was made.

The portal cancellation test exposed flexible-mode behavior: Stripe sets cancel_at while cancel_at_period_end stays false. Reconciliation now recognizes both representations; the UI says cancellation scheduled. The expanded real-Stripe regression suite reports eight passing tests, including cancel_at cancellation/reactivation and preservation of paid access. Reverify the fixed cancellation label on the next preview before production deployment.

Aspyre's owner corrected the business status: **not GST registered**. Automatic GST collection is not enabled. Revisit tax settings when registration or sales jurisdictions change; absence of Australian GST registration is not a conclusion about other jurisdictions.

The runtime needs customer read/write, price read, subscription read, invoice/invoice-payment read, Checkout Session read/write/expire, customer portal session creation, charge read, and dispute read access. Configure portal cancellation at period end and payment-method updates. Avoid enabling arbitrary product/quantity changes.

Webhook path: /api/billing/webhook. Subscribe to Checkout completion/async outcomes, subscription created/updated/deleted, invoice paid/failed/action-required/voided, charge refunds, dispute created/closed, and early fraud warnings. Signature verification uses the raw body. Receipt IDs deduplicate deliveries; handlers re-fetch current subscription state. Failed processing remains retryable. Scheduled reconciliation and the owner's Refresh billing status control recover missed deliveries.

Paid access follows paid invoice service periods, including legitimate credit-settled invoices. Failed renewals do not extend paid-through. Cancellation preserves already-paid time. Refunds of old periods do not revoke a newer period. Disputes use current Stripe state; permanent owner access remains independent.

## Migration and rollout order

1. Verify the target team/project and database. Back up production before changes.
2. Use an isolated preview database. The branch codex/freemium-subscriptions has a dedicated database role without production users-table access. Do not use the project's inherited shared preview database.
3. Apply database/0016_household_billing.sql. It is additive and idempotent. Test all preceding migrations on an empty preview database first.
4. Set FREEMIUM_ENFORCEMENT_ENABLED=false for staged production rollout; subscription restrictions and timed-task gating stay disabled while the owner grant is established.
5. Sign in as the verified owner and open Household plan. Confirm owner_entitlements contains the verified stable Clerk identity and the page shows permanent access. This check must happen before enabling restrictions.
6. Verify sandbox checkout, webhook delivery, portal cancellation, reconciliation, free limits and member access on preview.
7. Stage production, verify health, then set FREEMIUM_ENFORCEMENT_ENABLED=true and release the verified revision. Recheck permanent owner access and ordinary household limits.

Existing data remains readable. On downgrade, pick a free template under Household plan. Finish existing runs before switching. Existing saved timing definitions remain stored but do not drive free task activation/expiry; remove timed settings from the selected template before starting a free manual run. Scheduled generation stops without automation entitlement.

Rollback: first disable new Checkout entry through deployment configuration if needed, then restore the previous verified deployment. Keep additive tables and billing event history; do not drop them or delete existing data. FREEMIUM_ENFORCEMENT_ENABLED=false is an emergency compatibility setting that temporarily restores ordinary households' feature access, not a billing cancellation.

## Monitoring and cost evidence

household_usage_daily records tier, API/job request counts, processing milliseconds, and generated task/run counts; it contains no task descriptions. These are workload indicators, not provider-billed compute measurements. application_rate_limits records bounded request counters.

Read-only production baseline on 2026-11-03: 8 households, 5 templates, 160 task records, 13 runs, 1 active run. These counts do not validate prior dollar estimates. Reconcile provider invoices, actual egress/database storage, active household counts and payment fees before publishing per-household cost claims.

Run scripts/billing-usage-report.cjs with an explicitly supplied POSTGRES_URL and optional USAGE_REPORT_DAYS (1–366, default 30) for aggregate workload, retained records and billing health. The read-only report was verified on preview and production. Production reported zero pending webhooks, stale billing accounts or waitlisted accounts immediately after release. Initial operations include rollout checks; they are not a representative per-customer cost sample. The existing Vercel cron runs daily; active web clients also check recurrence. Do not silently upgrade infrastructure to obtain more frequent cron.

Vercel's existing team budget is US$200 per billing cycle in on-demand metered charges, with alerts at 50%, 75% and 100%. The user explicitly approved enabling automatic pausing for all projects in Daniel's projects; the final Dashboard row shows Pause On. This can interrupt other projects and paying customers at the threshold. It is not a cap on base fees, other providers or total business expenditure. Current team usage showed $2.94 of $20 included credit and $0 on-demand spend; it cannot be attributed entirely to Cyntch. Railway and Clerk costs were not independently reconciled in this release. Per-household dollar estimates remain unverified.

## Native release follow-up

The user confirmed neither Android nor iOS has been released. Both are required in a separate release objective. Web purchase links are hidden in native wrappers.

Google permits consumption-only apps under its [Payments policy](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en). Apple's current [review guidelines](https://developer.apple.com/app-store/review/guidelines/) do not establish that Cyntch qualifies for the limited companion-app exemption. Complete an iOS-compliant purchase strategy, store configuration, server verification/restoration/lifecycle handling where applicable, and device/store review testing before native release. This web launch does not claim native billing completion.

Security checks: the existing Next.js 16.2.4 and Zod versions had applicable advisories. Release branch upgrades Next.js/eslint-config-next to 16.4.4 and Zod to 4.6.6. Remaining dependency findings include native Capacitor and transitive tools; native releases require a separate security review. No forced major dependency downgrade was applied.

Account selection note: an earlier unused catalog was created in Aspyre Pty Ltd account acct_1S5hWjAeXJvRlwAS. The user subsequently selected Aspyre acct_1U4XwUAJcWjR3ecT in Chrome; the catalog above belongs to that selected account. Do not mix account credentials or price IDs. No live payments or subscriptions were created in either account; isolated test-mode subscriptions were created and canceled for verification.
