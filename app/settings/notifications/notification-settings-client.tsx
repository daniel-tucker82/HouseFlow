"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"

type Membership = {
  role: "manager" | "supervisor" | "member" | "leader"
  household: { id: string; name: string }
}

type Member = { id: string; name: string }

type Prefs = {
  task_unlocked_self_enabled: boolean
  task_unlocked_other_enabled: boolean
  reward_unlocked_self_enabled: boolean
  reward_unlocked_other_enabled: boolean
  routine_occurrence_generated_enabled: boolean
  member_joined_via_link_enabled: boolean
  member_left_household_enabled: boolean
  task_unlocked_other_member_ids: string[]
  reward_unlocked_other_member_ids: string[]
}

export function NotificationSettingsClient({
  memberships,
  members,
  initialHouseholdId,
}: {
  memberships: Membership[]
  members: Member[]
  initialHouseholdId: string
}) {
  const [householdId, setHouseholdId] = useState(initialHouseholdId)
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [saving, setSaving] = useState(false)
  const [pushEnabled, setPushEnabled] = useState<boolean | null>(null)
  const [pushAvailable, setPushAvailable] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const router = useRouter()

  const activeMembership = useMemo(
    () => memberships.find((membership) => membership.household.id === householdId) ?? memberships[0],
    [memberships, householdId],
  )
  const effectiveRole = activeMembership?.role === "leader" ? "manager" : activeMembership?.role ?? "member"
  const canWatchOthers = effectiveRole === "manager" || effectiveRole === "supervisor"
  const isManager = effectiveRole === "manager"
  const closeSettings = () => {
    if (window.history.length > 1) {
      router.back()
      return
    }
    const fallback =
      effectiveRole === "manager" || effectiveRole === "supervisor" ? "/leader/dashboard" : "/member/dashboard"
    router.push(`${fallback}?household=${encodeURIComponent(householdId)}`)
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const response = await fetch(`/api/notifications/preferences?householdId=${encodeURIComponent(householdId)}`, {
        cache: "no-store",
      })
      if (!response.ok) return
      const payload = (await response.json()) as { preferences: Prefs | null }
      if (!cancelled) setPrefs(payload.preferences)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [householdId])

  useEffect(() => {
    const checkPushState = async () => {
      if (typeof window === "undefined") return
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setPushAvailable(false)
        setPushEnabled(false)
        return
      }
      const keyRes = await fetch("/api/notifications/push/public-key", { cache: "no-store" })
      if (!keyRes.ok) {
        setPushAvailable(false)
        setPushEnabled(false)
        return
      }
      const keyPayload = (await keyRes.json()) as { enabled?: boolean; publicKey?: string }
      const enabled = Boolean(keyPayload.enabled && keyPayload.publicKey)
      setPushAvailable(enabled)
      if (!enabled) {
        setPushEnabled(false)
        return
      }
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      setPushEnabled(Boolean(subscription))
    }
    void checkPushState()
  }, [])

  const patchPrefs = (patch: Partial<Prefs>) => {
    setPrefs((current) => (current ? { ...current, ...patch } : current))
  }

  const save = async () => {
    if (!prefs) return
    setSaving(true)
    try {
      await fetch("/api/notifications/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          householdId,
          taskUnlockedSelfEnabled: prefs.task_unlocked_self_enabled,
          taskUnlockedOtherEnabled: prefs.task_unlocked_other_enabled,
          rewardUnlockedSelfEnabled: prefs.reward_unlocked_self_enabled,
          rewardUnlockedOtherEnabled: prefs.reward_unlocked_other_enabled,
          routineOccurrenceGeneratedEnabled: prefs.routine_occurrence_generated_enabled,
          memberJoinedViaLinkEnabled: prefs.member_joined_via_link_enabled,
          memberLeftHouseholdEnabled: prefs.member_left_household_enabled,
          taskUnlockedOtherMemberIds: prefs.task_unlocked_other_member_ids,
          rewardUnlockedOtherMemberIds: prefs.reward_unlocked_other_member_ids,
        }),
      })
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  const urlBase64ToUint8Array = (base64String: string) => {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
    const rawData = window.atob(base64)
    const outputArray = new Uint8Array(rawData.length)
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
    return outputArray
  }

  const enablePush = async () => {
    setPushBusy(true)
    try {
      const keyRes = await fetch("/api/notifications/push/public-key", { cache: "no-store" })
      if (!keyRes.ok) return
      const keyPayload = (await keyRes.json()) as { enabled?: boolean; publicKey?: string }
      if (!keyPayload.enabled || !keyPayload.publicKey) return

      const permission = await Notification.requestPermission()
      if (permission !== "granted") return

      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyPayload.publicKey),
        }))
      const deviceIdStorageKey = "houseflow_push_device_id"
      let deviceId = window.localStorage.getItem(deviceIdStorageKey)
      if (!deviceId) {
        deviceId = crypto.randomUUID()
        window.localStorage.setItem(deviceIdStorageKey, deviceId)
      }
      await fetch("/api/notifications/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          subscription: subscription.toJSON(),
        }),
      })
      setPushEnabled(true)
    } finally {
      setPushBusy(false)
    }
  }

  const disablePush = async () => {
    setPushBusy(true)
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await fetch("/api/notifications/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        })
        await subscription.unsubscribe()
      }
      setPushEnabled(false)
    } finally {
      setPushBusy(false)
    }
  }

  const sendPushTest = async () => {
    await fetch("/api/notifications/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ householdId }),
    })
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Notification settings</h1>
        <button
          type="button"
          onClick={closeSettings}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Close notification settings
        </button>
      </div>
      <label className="text-sm">
        Household
        <select
          className="mt-1 block h-9 w-full rounded-md border bg-background px-2"
          value={householdId}
          onChange={(event) => setHouseholdId(event.target.value)}
        >
          {memberships.map((membership) => (
            <option key={membership.household.id} value={membership.household.id}>
              {membership.household.name}
            </option>
          ))}
        </select>
      </label>

      {!prefs ? (
        <p className="text-sm text-muted-foreground">Loading preferences...</p>
      ) : (
        <div className="space-y-4 rounded-lg border p-4">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>Task for me unlocked</span>
            <input
              type="checkbox"
              checked={prefs.task_unlocked_self_enabled}
              onChange={(event) => patchPrefs({ task_unlocked_self_enabled: event.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>Reward for me unlocked</span>
            <input
              type="checkbox"
              checked={prefs.reward_unlocked_self_enabled}
              onChange={(event) => patchPrefs({ reward_unlocked_self_enabled: event.target.checked })}
            />
          </label>

          {canWatchOthers ? (
            <>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>Task for other household members unlocked</span>
                <input
                  type="checkbox"
                  checked={prefs.task_unlocked_other_enabled}
                  onChange={(event) => patchPrefs({ task_unlocked_other_enabled: event.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>Reward for other household members unlocked</span>
                <input
                  type="checkbox"
                  checked={prefs.reward_unlocked_other_enabled}
                  onChange={(event) => patchPrefs({ reward_unlocked_other_enabled: event.target.checked })}
                />
              </label>
              <div className="rounded border p-3 text-sm">
                <p className="mb-2 font-medium">Watch members for task unlocks</p>
                <div className="flex flex-wrap gap-2">
                  {members.map((member) => (
                    <label key={`task:${member.id}`} className="inline-flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={prefs.task_unlocked_other_member_ids.includes(member.id)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...prefs.task_unlocked_other_member_ids, member.id]
                            : prefs.task_unlocked_other_member_ids.filter((id) => id !== member.id)
                          patchPrefs({ task_unlocked_other_member_ids: [...new Set(next)] })
                        }}
                      />
                      {member.name}
                    </label>
                  ))}
                </div>
              </div>
              <div className="rounded border p-3 text-sm">
                <p className="mb-2 font-medium">Watch members for reward unlocks</p>
                <div className="flex flex-wrap gap-2">
                  {members.map((member) => (
                    <label key={`reward:${member.id}`} className="inline-flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={prefs.reward_unlocked_other_member_ids.includes(member.id)}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...prefs.reward_unlocked_other_member_ids, member.id]
                            : prefs.reward_unlocked_other_member_ids.filter((id) => id !== member.id)
                          patchPrefs({ reward_unlocked_other_member_ids: [...new Set(next)] })
                        }}
                      />
                      {member.name}
                    </label>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {isManager ? (
            <>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>Routine occurrence generated</span>
                <input
                  type="checkbox"
                  checked={prefs.routine_occurrence_generated_enabled}
                  onChange={(event) => patchPrefs({ routine_occurrence_generated_enabled: event.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>Member joined via link</span>
                <input
                  type="checkbox"
                  checked={prefs.member_joined_via_link_enabled}
                  onChange={(event) => patchPrefs({ member_joined_via_link_enabled: event.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>Member left household</span>
                <input
                  type="checkbox"
                  checked={prefs.member_left_household_enabled}
                  onChange={(event) => patchPrefs({ member_left_household_enabled: event.target.checked })}
                />
              </label>
            </>
          ) : null}
        </div>
      )}

      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-semibold">Mobile lock screen notifications</h2>
        {!pushAvailable ? (
          <p className="text-xs text-muted-foreground">
            Push is unavailable. Set `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and
            `WEB_PUSH_CONTACT_EMAIL`, then rebuild the app.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {pushEnabled ? (
              <button
                type="button"
                onClick={() => void disablePush()}
                disabled={pushBusy}
                className="rounded border px-3 py-1.5 text-sm"
              >
                {pushBusy ? "Updating..." : "Disable push on this device"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void enablePush()}
                disabled={pushBusy}
                className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white"
              >
                {pushBusy ? "Updating..." : "Enable push on this device"}
              </button>
            )}
            <button type="button" onClick={() => void sendPushTest()} className="rounded border px-3 py-1.5 text-sm">
              Send test push
            </button>
          </div>
        )}
      </section>

      <div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!prefs || saving}
          className="rounded-md bg-black px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
      </div>
    </main>
  )
}
