// EAS runs this before installing dependencies. Check the cloud environment
// without reading .env.local or printing any configuration values.
const fail = message => { throw new Error(message) }
const profile = process.env.EAS_BUILD_PROFILE
const profiles = require('../eas.json').build
if (!profile || !Object.hasOwn(profiles, profile)) fail('Select a configured EAS build profile.')

const key = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? ''
if (!/^pk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(key)) {
  fail('Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY in the selected EAS environment.')
}
if (profile === 'production' && !key.startsWith('pk_live_')) {
  fail('Production builds require a live Clerk publishable key.')
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
console.log('Build environment checks passed.')
