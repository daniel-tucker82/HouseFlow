import * as Notifications from "expo-notifications"
import { AndroidImportance, AndroidNotificationVisibility, IosAlertStyle, IosAuthorizationStatus } from "expo-notifications"
import Constants from "expo-constants"
import * as Application from "expo-application"
import * as Device from "expo-device"
import { Linking, Platform } from "react-native"
import { notificationCatalog, type MobileNotificationKind } from "../../../shared/mobile/notification-catalog"
import type { NotificationPermission } from "../../../shared/mobile/notification-settings"
import type { RegistrationIntent } from "../storage/notification-store"
import type { NotificationSessionStore } from "../storage/notification-session-store"
import { nativeNotificationGeneration, resetNativeNotificationSession, waitForNativeNotification, withNativeNotificationSession } from "./notification-native-session"

export type ChannelRestrictions = Partial<Record<MobileNotificationKind, "blocked" | "lower-priority">>
export interface NotificationPermissionState {
  permission: NotificationPermission; canAskAgain: boolean;
  iosPresentation?: { alertsOff: boolean; centerOff: boolean } | null;
}
export interface NotificationDevice {
  inspect(): Promise<NotificationPermissionState>
  requestPermission(): Promise<NotificationPermissionState>
  token(): Promise<string>
  details(): Pick<RegistrationIntent, "platform" | "deviceName" | "appVersion">
  listenForTokenChange(listener: () => void): () => void
  channelRestrictions(): Promise<ChannelRestrictions>
  openSettings(kind?: MobileNotificationKind): Promise<void>
}
function permissionState(status: Notifications.NotificationPermissionsStatus): NotificationPermissionState {
  let permission: NotificationPermission = status.status === "granted" ? "granted" : status.status === "denied" ? "denied" : "undetermined"
  if (status.ios) {
    const ios = status.ios.status
    permission = ios === IosAuthorizationStatus.AUTHORIZED ? "granted" : ios === IosAuthorizationStatus.PROVISIONAL || ios === IosAuthorizationStatus.EPHEMERAL ? "provisional"
      : ios === IosAuthorizationStatus.DENIED ? "denied" : "undetermined"
  }
  const ios = status.ios
  return { permission, canAskAgain: status.canAskAgain, iosPresentation: ios && permission === "granted" ? {
    alertsOff: ios.allowsAlert === false || ios.alertStyle === IosAlertStyle.NONE,
    centerOff: ios.allowsDisplayInNotificationCenter === false,
  } : null }
}
async function ensureAndroidChannels() {
  if (Platform.OS !== "android" || Number(Platform.Version) < 26) return
  const existing = new Set((await Notifications.getNotificationChannelsAsync()).map(channel => channel.id))
  // Existing importance, sound and visibility belong to the user. Only fill
  // missing categories, including after an app update or pre-granted install.
  const results = await Promise.allSettled(Object.entries(notificationCatalog).filter(([kind]) => !existing.has(`cyntch-${kind}`)).map(async ([kind, category]) => {
    const id = `cyntch-${kind}`
    const channel = await Notifications.setNotificationChannelAsync(id, {
      name: category.label, importance: AndroidImportance.HIGH, showBadge: false, lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
    })
    if (channel?.id !== id) throw new Error("This device could not set up notification categories. Please try again.")
  }))
  const failure = results.find(result => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
}
export function createNotificationDevice(sessions: NotificationSessionStore): NotificationDevice {
  let nativeToken: { token: Notifications.DevicePushToken; generation: number } | undefined
  let tokenRequest: Promise<string> | undefined
  return {
    inspect: async () => permissionState(await Notifications.getPermissionsAsync()),
    requestPermission: async () => {
      if (await sessions.kioskRestricted()) throw new Error("Unlock kiosk mode to change notifications.")
      // Android 13+ needs a channel before the runtime permission prompt can be shown.
      await ensureAndroidChannels()
      if (await sessions.kioskRestricted()) throw new Error("Unlock kiosk mode to change notifications.")
      return permissionState(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }))
    },
    token: async () => {
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
      if (!projectId) throw new Error("Push notifications are not available in this build yet. Your notification choices can still be saved.")
      tokenRequest ??= (async () => {
        await resetNativeNotificationSession(sessions)
        return withNativeNotificationSession(async () => {
          if (await sessions.cleanupVersion() !== null) throw new Error("Notification sign-out is still finishing. Please try again.")
          if (await sessions.kioskRestricted()) throw new Error("Unlock kiosk mode to register notifications.")
          // Android 8–12 permits notifications without the runtime prompt. A
          // granted permission is also retained through upgrades and restores.
          // Configure channels before a provider can deliver on their IDs.
          await ensureAndroidChannels()
          if (await sessions.kioskRestricted()) throw new Error("Unlock kiosk mode to register notifications.")
          const token = (await Notifications.getExpoPushTokenAsync({ projectId,
            devicePushToken: nativeToken?.generation === nativeNotificationGeneration() ? nativeToken.token : undefined })).data
          if (await sessions.kioskRestricted()) {
            await Notifications.unregisterForNotificationsAsync()
            throw new Error("Unlock kiosk mode to register notifications.")
          }
          return token
        })
      })().finally(() => { tokenRequest = undefined })
      return waitForNativeNotification(tokenRequest)
    },
    details: () => ({ platform: Platform.OS === "ios" ? "ios" : "android", deviceName: Device.deviceName ?? Device.modelName, appVersion: Application.nativeApplicationVersion }),
    listenForTokenChange: listener => { const subscription = Notifications.addPushTokenListener(token => {
      nativeToken = { token, generation: nativeNotificationGeneration() }; listener()
    }); return () => subscription.remove() },
    channelRestrictions: async () => {
      const restrictions: ChannelRestrictions = {}
      if (Platform.OS !== "android" || Number(Platform.Version) < 26) return restrictions
      const channels = await Notifications.getNotificationChannelsAsync()
      const byId = new Map(channels.map(channel => [channel.id, channel.importance]))
      for (const kind of Object.keys(notificationCatalog) as MobileNotificationKind[]) {
        const importance = byId.get(`cyntch-${kind}`)
        if (importance === AndroidImportance.NONE) restrictions[kind] = "blocked"
        else if (importance === AndroidImportance.MIN || importance === AndroidImportance.LOW || importance === AndroidImportance.DEFAULT) restrictions[kind] = "lower-priority"
      }
      return restrictions
    },
    openSettings: async kind => {
      if (Platform.OS === "android" && Number(Platform.Version) >= 26 && Application.applicationId) {
        const extras = [{ key: "android.provider.extra.APP_PACKAGE", value: Application.applicationId }]
        if (kind) extras.push({ key: "android.provider.extra.CHANNEL_ID", value: `cyntch-${kind}` })
        try {
          await Linking.sendIntent(kind ? "android.settings.CHANNEL_NOTIFICATION_SETTINGS" : "android.settings.APP_NOTIFICATION_SETTINGS", extras)
          return
        } catch { /* Some devices only expose the app settings page. */ }
      }
      await Linking.openSettings()
    },
  }
}
