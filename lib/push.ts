import webpush from "web-push"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getMessaging } from "firebase-admin/messaging"
import { db } from "@/lib/db"

let configured = false
let firebaseConfigured = false

function ensureVapidConfigured() {
  if (configured) return true
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY
  const contactEmail = process.env.WEB_PUSH_CONTACT_EMAIL
  if (!publicKey || !privateKey || !contactEmail) return false
  webpush.setVapidDetails(`mailto:${contactEmail}`, publicKey, privateKey)
  configured = true
  return true
}

export function getWebPushPublicKey() {
  return process.env.WEB_PUSH_VAPID_PUBLIC_KEY ?? ""
}

export function isWebPushEnabled() {
  return Boolean(
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY &&
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY &&
      process.env.WEB_PUSH_CONTACT_EMAIL,
  )
}

function ensureFirebaseConfigured() {
  if (firebaseConfigured) return true
  try {
    if (getApps().length === 0) {
      const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()
      if (rawServiceAccount) {
        initializeApp({
          credential: cert(JSON.parse(rawServiceAccount)),
        })
      } else {
        const projectId = process.env.FIREBASE_PROJECT_ID?.trim()
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim()
        const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
        if (!projectId || !clientEmail || !privateKey) return false
        initializeApp({
          credential: cert({
            projectId,
            clientEmail,
            privateKey,
          }),
        })
      }
    }
    firebaseConfigured = true
    return true
  } catch (error) {
    console.error("[mobile-push] firebase init failed", error)
    return false
  }
}

function shouldDeactivateFirebaseToken(error: unknown) {
  const code = String((error as { code?: string })?.code ?? "")
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  )
}

export async function dispatchPushForNotificationIds(notificationIds: string[]) {
  if (!notificationIds.length) return

  const webRows = ensureVapidConfigured()
    ? await db.query<{
        notification_id: string
        user_id: string
        title: string
        body: string
        household_id: string
        url: string | null
        endpoint: string
        p256dh: string
        auth: string
      }>(
        `select un.id as notification_id,
                un.user_id,
                un.title,
                un.body,
                ne.household_id::text as household_id,
                ne.metadata->>'url' as url,
                ps.endpoint,
                ps.p256dh,
                ps.auth
         from user_notifications un
         join notification_events ne on ne.id = un.event_id
         join push_subscriptions ps on ps.user_id = un.user_id and ps.is_active = true
         where un.id = any($1::uuid[])
           and un.suppressed = false`,
        [notificationIds],
      )
    : null

  for (const row of webRows?.rows ?? []) {
    try {
      await webpush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: {
            p256dh: row.p256dh,
            auth: row.auth,
          },
        },
        JSON.stringify({
          title: row.title,
          body: row.body,
          tag: `houseflow:${row.notification_id}`,
          url: row.url || `/member/dashboard?household=${encodeURIComponent(row.household_id)}`,
        }),
      )
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode ?? 0)
      if (statusCode === 404 || statusCode === 410) {
        await db.query(
          `update push_subscriptions
           set is_active = false,
               updated_at = now()
           where endpoint = $1`,
          [row.endpoint],
        )
      } else {
        console.error("[push] send notification failed", error)
      }
    }
  }

  if (!ensureFirebaseConfigured()) return
  const messaging = getMessaging()

  const mobileRows = await db.query<{
    notification_id: string
    title: string
    body: string
    household_id: string
    url: string | null
    token: string
  }>(
    `select un.id as notification_id,
            un.title,
            un.body,
            ne.household_id::text as household_id,
            ne.metadata->>'url' as url,
            mt.token
     from user_notifications un
     join notification_events ne on ne.id = un.event_id
     join mobile_push_tokens mt on mt.user_id = un.user_id and mt.is_active = true
     where un.id = any($1::uuid[])
       and un.suppressed = false`,
    [notificationIds],
  )

  for (const row of mobileRows.rows) {
    try {
      await messaging.send({
        token: row.token,
        notification: {
          title: row.title,
          body: row.body,
        },
        data: {
          notificationId: row.notification_id,
          url: row.url || `/member/dashboard?household=${encodeURIComponent(row.household_id)}`,
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
            },
          },
        },
      })
    } catch (error) {
      if (shouldDeactivateFirebaseToken(error)) {
        await db.query(
          `update mobile_push_tokens
           set is_active = false,
               updated_at = now()
           where token = $1`,
          [row.token],
        )
      } else {
        console.error("[mobile-push] send notification failed", error)
      }
    }
  }
}
