import type { CapacitorConfig } from "@capacitor/cli"

const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim()

const config: CapacitorConfig = {
  appId: "com.houseflow.app",
  appName: "Cyntch",
  webDir: "mobile-shell",
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith("http://"),
      }
    : undefined,
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
}

export default config
