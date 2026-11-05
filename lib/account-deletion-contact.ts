/** Publish the external request route only after an operator has confirmed that
 * this mailbox is monitored and has a process for verifying and handling requests.
 * This is separate from enabling automatic in-app deletion submissions. */
export function accountDeletionContact(env: NodeJS.ProcessEnv = process.env) {
  if (env.ACCOUNT_DELETION_WEB_REQUESTS_ENABLED !== "true") return null
  const email = env.ACCOUNT_DELETION_SUPPORT_EMAIL?.trim() ?? ""
  if (email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email)) return null
  return { email, href: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Request to delete my Cyntch account")}` }
}
