// Keep shared app settings in app.json. EAS file variables resolve to a local
// file on the builder; local development can provide the same path in .env.local.
module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON?.trim()
  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  }
}
