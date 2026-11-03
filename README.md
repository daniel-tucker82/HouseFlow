This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Background Processing

Time-based jobs are run by the endpoint `GET /api/cron`. The legacy
`GET /api/internal/recurrence` URL invokes the same runner.

- The endpoint always requires `Authorization: Bearer <CRON_SECRET>`.
- Configure a long, random `CRON_SECRET` in every environment where the runner is polled.
- Each run materializes due recurring workflows, unlocks due tasks, completes expired tasks,
  materializes deferred expiry times, and dispatches the resulting notifications.
- `vercel.json` schedules this endpoint once daily at **06:00 UTC** via Vercel Cron (Hobby-compatible). On **Vercel Pro**, you can use a tighter schedule (for example every five minutes) if you need faster materialization.
- With the app **closed**, only that cron (or an external cron hitting the same URL with `Authorization: Bearer <CRON_SECRET>`) runs these jobs. **Opening the leader or member dashboard** still catches up relevant state on the next visit.
- Recurrence date/time math in `lib/recurrence.ts` uses the **Node runtime’s default timezone** (typically **UTC** on Vercel). For household-local wall times, keep the household `timezone` field accurate; full “evaluate rules in household TZ” is not implemented yet—if results look offset by hours, compare rule times to UTC.

## Native Mobile App (Capacitor)

HouseFlow includes Capacitor configuration for Android/iOS wrapper builds.

1. Set `CAPACITOR_SERVER_URL` to your deployed HTTPS HouseFlow URL.
2. Add native projects:
   - `npm run mobile:add:android`
   - `npm run mobile:add:ios`
3. Sync web/native plugins:
   - `npm run mobile:sync`
4. Open and run:
   - `npm run mobile:open:android`
   - `npm run mobile:open:ios`

### Native push notifications

Native push delivery is wired through Firebase Admin on the server and Capacitor Push Notifications in the app shell.

- Configure one of:
  - `FIREBASE_SERVICE_ACCOUNT_JSON`, or
  - `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`
- Apply SQL migration `database/0012_mobile_push_tokens.sql`
- Complete platform credential setup in Firebase:
  - Android app registration (`google-services.json`)
  - iOS app registration (`GoogleService-Info.plist`, APNs key/cert)

For complete manual release/setup tasks, see `MOBILE_HANDOFF_CHECKLIST.md`.

## Public homepage and app entry

- `/` is the public Cyntch homepage, including an interactive example with illustrative data.
- `/auth/login` and `/auth/signup` use Clerk and default to `/app` after authentication.
- `/app` resolves the signed-in household, role and active kiosk session, or offers household onboarding.
- Existing leader, member, invitation and native-shell routes remain available.

The public homepage does not query the household database. The signed-in screens still require Clerk and PostgreSQL configuration.

## Task editing and background saves

Canvas task edits update the canvas/sidebar immediately. Updates submitted from the
routine list also return immediately. A shared, account-scoped queue persists each
edit in browser storage before accepting it, coalesces rapid changes to the same
task, and sends saves in order. Navigating between screens does not own or cancel
the queue. Reloads and reopening the app restore pending edits for the same account.
Closed/offline browsers resume syncing when the app is open and connected again.

Network errors, busy responses (429), and server errors retry with backoff. Other
rejections retain the edit and show a notice with retry/discard controls; an
optimistic update is never labelled server-confirmed until acknowledged. If browser
storage is unavailable, the editor reports that it cannot safely keep the edit.
Fresh reads overlay edits made while the read was in flight. Task fields and
assignments commit together on the server. New task creation still waits for server
confirmation; this queue only handles updates to existing tasks.

Apply `database/0017_task_edit_versions.sql` (via `npm run db:migrate`) before
deploying this change. The additive version table makes retries idempotent and
rejects an older request arriving after a newer edit from the same browser. No
existing tasks are rewritten. Browser clocks are persisted monotonically so clock
adjustments and reloads do not reverse the ordering.

Regression checks (no production writes):

```sh
node --experimental-strip-types --test tests/task-save-queue.test.mjs tests/task-save-route.test.cjs tests/routine-planner.test.mjs
npm run build
```

`tests/task-save-browser.cjs` bundles the real editors with isolated authentication
and a local API delayed by 1.2 seconds. With Playwright installed, run
`node tests/task-save-browser.cjs`; `CYNTCH_PLAYWRIGHT_PATH` and
`CYNTCH_CHROMIUM_PATH` can point to an existing package/browser installation. It
checks immediate feedback, overlapping edits, navigation, and offline recovery.
