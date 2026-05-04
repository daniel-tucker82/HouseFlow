"use client"

import { useEffect } from "react"
import { useAuth } from "@clerk/nextjs"
import { isCapacitorNativeShellSync } from "@/lib/native-shell-detect"

export function NativeMobileBridge() {
  const { isSignedIn } = useAuth()

  useEffect(() => {
    if (!isCapacitorNativeShellSync()) return
    void (async () => {
      const { Capacitor } = await import("@capacitor/core")
      if (!Capacitor.isNativePlatform()) return
      if (!("serviceWorker" in navigator)) return
      try {
        const registrations = await navigator.serviceWorker.getRegistrations()
        await Promise.all(registrations.map((registration) => registration.unregister()))
      } catch {
        /* ignore */
      }
    })()
  }, [])

  useEffect(() => {
    const tokenStorageKey = "houseflow_native_push_token"
    let removeRegistrationListener: (() => Promise<void>) | undefined
    let removeRegistrationErrorListener: (() => Promise<void>) | undefined
    let removeActionListener: (() => Promise<void>) | undefined

    const setupNativePush = async () => {
      const { Capacitor } = await import("@capacitor/core")
      if (!Capacitor.isNativePlatform()) return

      const [{ PushNotifications }, { Device }] = await Promise.all([
        import("@capacitor/push-notifications"),
        import("@capacitor/device"),
      ])

      if (!isSignedIn) {
        const previousToken = window.localStorage.getItem(tokenStorageKey)
        if (previousToken) {
          await fetch("/api/notifications/mobile/unregister", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: previousToken }),
          }).catch(() => undefined)
          window.localStorage.removeItem(tokenStorageKey)
        }
        const delivered = await PushNotifications.getDeliveredNotifications()
        if (delivered.notifications.length > 0) {
          await PushNotifications.removeAllDeliveredNotifications()
        }
        return
      }

      const [deviceInfo, { identifier: deviceInstallId }] = await Promise.all([
        Device.getInfo(),
        Device.getId(),
      ])
      const platform = deviceInfo.platform === "ios" ? "ios" : deviceInfo.platform === "android" ? "android" : null
      if (!platform) return

      const permissionStatus = await PushNotifications.checkPermissions()
      const permissions =
        permissionStatus.receive === "granted"
          ? permissionStatus
          : await PushNotifications.requestPermissions()
      if (permissions.receive !== "granted") return

      const registrationHandle = await PushNotifications.addListener("registration", async (token) => {
        window.localStorage.setItem(tokenStorageKey, token.value)
        await fetch("/api/notifications/mobile/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: token.value,
            platform,
            deviceId: deviceInstallId ?? null,
            deviceName: deviceInfo.model ?? null,
            appVersion: deviceInfo.osVersion ?? null,
          }),
        }).catch(() => undefined)
      })

      const registrationErrorHandle = await PushNotifications.addListener("registrationError", (error) => {
        console.error("[mobile-push] native push registration failed", error)
      })

      const actionHandle = await PushNotifications.addListener("pushNotificationActionPerformed", (event) => {
        const url = String(event.notification.data?.url ?? "").trim()
        if (url) window.location.href = url
      })

      removeRegistrationListener = async () => registrationHandle.remove()
      removeRegistrationErrorListener = async () => registrationErrorHandle.remove()
      removeActionListener = async () => actionHandle.remove()

      await PushNotifications.register()
    }

    void setupNativePush()

    return () => {
      void removeRegistrationListener?.()
      void removeRegistrationErrorListener?.()
      void removeActionListener?.()
    }
  }, [isSignedIn])

  return null
}
