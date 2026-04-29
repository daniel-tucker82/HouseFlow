import { currentUser } from "@clerk/nextjs/server"
import { db } from "@/lib/db"

export async function ensureCurrentUserRecord() {
  const clerkUser = await currentUser()
  if (!clerkUser) return null

  const email = clerkUser.emailAddresses[0]?.emailAddress ?? null
  const fullName = `${clerkUser.firstName ?? ""} ${clerkUser.lastName ?? ""}`.trim() || null
  const avatarUrl = clerkUser.hasImage ? clerkUser.imageUrl : null

  try {
    await db.query(
      `insert into users (id, email, full_name, avatar_url)
       values ($1, $2, $3, $4)
       on conflict (id)
       do update set email = excluded.email,
                     full_name = excluded.full_name,
                     avatar_url = excluded.avatar_url,
                     updated_at = now()`,
      [clerkUser.id, email, fullName, avatarUrl],
    )
  } catch (error) {
    console.error("Unable to sync Clerk user into PostgreSQL.", error)
  }

  return clerkUser
}
