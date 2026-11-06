// Keep shared app settings in app.json. EAS file variables resolve to a local
// file on the builder; local development can provide the same path in .env.local.
module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON?.trim()
  // Only development tooling uses overlays. Keep its local/debug behaviour,
  // while distributed previews and production cannot draw over other apps.
  const distributed = ['preview', 'production'].includes(process.env.EAS_BUILD_PROFILE)
  return {
    ...config,
    android: {
      ...config.android,
      ...(distributed ? { blockedPermissions: [...new Set([
        ...(config.android?.blockedPermissions ?? []),
        'android.permission.SYSTEM_ALERT_WINDOW',
      ])] } : {}),
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  }
}
