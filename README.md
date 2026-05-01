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

## Recurrence Background Processing

Recurring routine occurrences are materialized by the internal endpoint `GET /api/internal/recurrence`.

- In production, this endpoint requires `Authorization: Bearer <CRON_SECRET>`.
- Configure `CRON_SECRET` in your deployment environment.
- `vercel.json` schedules this endpoint once daily at **06:00 UTC** via Vercel Cron (Hobby-compatible). On **Vercel Pro**, you can use a tighter schedule (for example every five minutes) if you need faster materialization.

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
