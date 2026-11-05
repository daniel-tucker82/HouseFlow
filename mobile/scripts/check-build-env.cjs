// EAS runs this before installing dependencies. Check the cloud environment
// without reading .env.local or printing any configuration values.
const fail = message => { throw new Error(message) }
const profile = process.env.EAS_BUILD_PROFILE
const profiles = require('../eas.json').build
const { publicPolicyUrl } = require('../src/services/public-policy-url')
if (!profile || !Object.hasOwn(profiles, profile)) fail('Select a configured EAS build profile.')

const key = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? ''
if (!/^pk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(key)) {
  fail('Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY in the selected EAS environment.')
}
if (profile === 'production' && !key.startsWith('pk_live_')) {
  fail('Production builds require a live Clerk publishable key.')
}
for (const name of ['EXPO_PUBLIC_PRIVACY_POLICY_URL', 'EXPO_PUBLIC_TERMS_URL']) {
  const value = process.env[name]
  if ((profile === 'production' || value?.trim()) && !publicPolicyUrl(value)) {
    fail(`Set ${name} to the verified public HTTPS page, without credentials, a query or fragment.`)
  }
}

let api
try { api = new URL(process.env.EXPO_PUBLIC_API_URL) }
catch { fail('Set a valid EXPO_PUBLIC_API_URL in the selected EAS environment.') }
const development = profile === 'development' || profile === 'development-simulator'
const localHttp = development && api.protocol === 'http:' &&
  ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(api.hostname)
if ((api.protocol !== 'https:' && !localHttp) || api.username || api.password || api.search || api.hash) {
  fail('EXPO_PUBLIC_API_URL must use HTTPS without credentials, a query or fragment. Development profiles also allow local HTTP.')
}

if (process.env.EAS_BUILD_PLATFORM === 'android') {
  const servicesPath = process.env.GOOGLE_SERVICES_JSON?.trim()
  if (!servicesPath && (profile === 'preview' || profile === 'production')) {
    fail('Android preview/production builds require the GOOGLE_SERVICES_JSON file variable for push registration.')
  }
  if (servicesPath) {
    let services
    try { services = JSON.parse(require('node:fs').readFileSync(servicesPath, 'utf8')) }
    catch { fail('GOOGLE_SERVICES_JSON must point to a readable Firebase Android client configuration file.') }
    // A service-account credential belongs in provider credentials, never in
    // the app. Do not include file contents or keys in validation errors.
    if (services?.type === 'service_account' || services?.private_key || services?.private_key_id) {
      fail('GOOGLE_SERVICES_JSON must be client configuration, never a service-account private key.')
    }
    const packageName = require('../app.json').expo.android.package
    const clients = Array.isArray(services?.client) ? services.client.filter(client =>
      client?.client_info?.android_client_info?.package_name === packageName) : []
    const number = services?.project_info?.project_number
    if (!/^\d+$/.test(number ?? '') || !services?.project_info?.project_id ||
        clients?.length !== 1 ||
        !clients[0].client_info.mobilesdk_app_id?.startsWith(`1:${number}:android:`) ||
        !Array.isArray(clients[0].api_key) ||
        !clients[0].api_key.some(entry => typeof entry?.current_key === 'string' && entry.current_key.trim())) {
      fail('GOOGLE_SERVICES_JSON must contain one matching Android app, its Firebase project and client API key.')
    }
  }
}
console.log('Build environment checks passed.')
