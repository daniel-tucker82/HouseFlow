"use server"

import { auth } from "@clerk/nextjs/server"
import { revalidatePath } from "next/cache"
import { setHideCompletedTasksPreference } from "@/lib/leader-dashboard-preferences"

export async function saveHideCompletedTasksPreference(
  hideCompletedTasks: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { userId } = await auth()
  if (!userId) return { ok: false, error: "Sign in to save your preference." }
  if (typeof hideCompletedTasks !== "boolean") {
    return { ok: false, error: "Invalid hide completed tasks preference." }
  }

  try {
    await setHideCompletedTasksPreference(userId, hideCompletedTasks)
  } catch (error) {
    console.error("Unable to save hide completed tasks preference.", error)
    return { ok: false, error: "Couldn't save your preference. Please try again." }
  }

  revalidatePath("/leader/dashboard")
  return { ok: true }
}
