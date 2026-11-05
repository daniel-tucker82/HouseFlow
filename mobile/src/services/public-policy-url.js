/** @param {string | undefined} value @returns {string | null} */
function publicPolicyUrl(value) {
  if (!value?.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    return url.href
  } catch { return null }
}
module.exports = { publicPolicyUrl }
