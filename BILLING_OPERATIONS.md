# Cyntch freemium operations

Status: implementation and preview verification in progress. This document is not evidence of production deployment.

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
- Monthly: price_1UXZHAAJcWjR3ecTIh1sDRNh — AUD 599.
- Annual: price_1UXZJYAJcWjR3ecTHfb4oXwN — AUD 4999.
- No trial. No charges were created during catalog setup.

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

Run scripts/billing-usage-report.cjs with an explicitly supplied POSTGRES_URL and optional USAGE_REPORT_DAYS (1–366, default 30) for aggregate workload, retained records and billing health. This read-only report was verified against the isolated preview database. Provider spending alerts still need configuration/verification. The existing Vercel cron runs daily on the current configuration; active web clients also check recurrence. Do not silently upgrade infrastructure to obtain more frequent cron.

## Native release follow-up

The user confirmed neither Android nor iOS has been released. Both are required in a separate release objective. Web purchase links are hidden in native wrappers.

Google permits consumption-only apps under its [Payments policy](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en). Apple's current [review guidelines](https://developer.apple.com/app-store/review/guidelines/) do not establish that Cyntch qualifies for the limited companion-app exemption. Complete an iOS-compliant purchase strategy, store configuration, server verification/restoration/lifecycle handling where applicable, and device/store review testing before native release. This web launch does not claim native billing completion.

Security checks: the existing Next.js 16.2.4 and Zod versions had applicable advisories. Release branch upgrades Next.js/eslint-config-next to 16.4.4 and Zod to 4.6.6. Remaining dependency findings include native Capacitor and transitive tools; native releases require a separate security review. No forced major dependency downgrade was applied.

Account selection note: an earlier unused catalog was created in Aspyre Pty Ltd account acct_1S5hWjAeXJvRlwAS. The user subsequently selected Aspyre acct_1U4XwUAJcWjR3ecT in Chrome; the catalog above belongs to that selected account. Do not mix account credentials or price IDs. No payments or subscriptions were created in either account.
