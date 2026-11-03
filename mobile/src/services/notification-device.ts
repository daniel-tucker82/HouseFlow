import * as Notifications from "expo-notifications"
import { AndroidImportance, AndroidNotificationVisibility, IosAuthorizationStatus } from "expo-notifications"
import Constants from "expo-constants"
import * as Application from "expo-application"
import * as Device from "expo-device"
import { Linking, Platform } from "react-native"
import { notificationCatalog } from "../../../shared/mobile/notification-catalog"
import type { NotificationPermission } from "../../../shared/mobile/notification-settings"
import type { RegistrationIntent } from "../storage/notification-store"
import type { NotificationSessionStore } from "../storage/notification-session-store"
import { nativeNotificationGeneration, resetNativeNotificationSession, waitForNativeNotification, withNativeNotificationSession } from "./notification-native-session"

export interface NotificationPermissionState { permission: NotificationPermission; canAskAgain: boolean }
export interface NotificationDevice {
  inspect(): Promise<NotificationPermissionState>
  requestPermission(): Promise<NotificationPermissionState>
  token(): Promise<string>
  details(): Pick<RegistrationIntent, "platform" | "deviceName" | "appVersion">
  listenForTokenChange(listener: () => void): () => void
  openSettings(): Promise<void>
}
function permissionState(status: Notifications.NotificationPermissionsStatus): NotificationPermissionState {
  let permission: NotificationPermission = status.status === "granted" ? "granted" : status.status === "denied" ? "denied" : "undetermined"
  if (status.ios) {
    const ios = status.ios.status
    permission = ios === IosAuthorizationStatus.AUTHORIZED ? "granted" : ios === IosAuthorizationStatus.PROVISIONAL || ios === IosAuthorizationStatus.EPHEMERAL ? "provisional"
      : ios === IosAuthorizationStatus.DENIED ? "denied" : "undetermined"
  }
  return { permission, canAskAgain: status.canAskAgain }
}
export function createNotificationDevice(sessions: NotificationSessionStore): NotificationDevice {
  let nativeToken: { token: Notifications.DevicePushToken; generation: number } | undefined
  let tokenRequest: Promise<string> | undefined
  return {
    inspect: async () => permissionState(await Notifications.getPermissionsAsync()),
    requestPermission: async () => {
      // Android 13+ needs a channel before the runtime permission prompt can be shown.
      if (Platform.OS === "android") await Promise.all(Object.entries(notificationCatalog).map(([kind, category]) => Notifications.setNotificationChannelAsync(`cyntch-${kind}`, {
        name: category.label, importance: AndroidImportance.HIGH, showBadge: false, lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
      })))
      return permissionState(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }))
    },
    token: async () => {
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
      if (!projectId) throw new Error("Push notifications are not available in this build yet. Your notification choices can still be saved.")
      tokenRequest ??= (async () => {
        await resetNativeNotificationSession(sessions)
        return withNativeNotificationSession(async () => {
          if (await sessions.cleanupVersion() !== null) throw new Error("Notification sign-out is still finishing. Please try again.")
          return (await Notifications.getExpoPushTokenAsync({ projectId,
            devicePushToken: nativeToken?.generation === nativeNotificationGeneration() ? nativeToken.token : undefined })).data
        })
      })().finally(() => { tokenRequest = undefined })
      return waitForNativeNotification(tokenRequest)
    },
    details: () => ({ platform: Platform.OS === "ios" ? "ios" : "android", deviceName: Device.deviceName ?? Device.modelName, appVersion: Application.nativeApplicationVersion }),
    listenForTokenChange: listener => { const subscription = Notifications.addPushTokenListener(token => {
      nativeToken = { token, generation: nativeNotificationGeneration() }; listener()
    }); return () => subscription.remove() },
    openSettings: () => Linking.openSettings(),
  }
}
