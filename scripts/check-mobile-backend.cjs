// Public, read-only HTTP checks. No account, credentials, redirects or writes.
const assert = require("node:assert/strict")

async function main() {
  const origin = new URL(process.argv[2])
  assert(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === "/",
    "Pass an origin without credentials, a path or query")
  assert(origin.protocol === "https:" || (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)),
    "Use HTTPS, except on loopback")
  const checks = []
  for (const [path, heading] of [
    ["/legal/privacy", "Privacy policy"], ["/legal/terms", "Terms of use"], ["/account-deletion", "Request account deletion"],
  ]) {
    const response = await fetch(new URL(path, origin), { redirect: "manual", signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200, path + ": expected public page")
    assert.match(response.headers.get("content-type") || "", /^text\/html\b/i, path)
    const body = await response.text()
    assert.match(body, new RegExp("<h1(?:\\s[^>]*)?>" + heading + "</h1>", "i"), path + ": public heading missing")
    if (path === "/account-deletion") assert.match(body, /href="mailto:[^"]+"/i, path + ": contact link missing")
    checks.push({ path, status: response.status })
  }
  for (const route of ["time", "bootstrap", "runs", "invitations", "notifications", "notification-history", "billing", "account-deletion", "terms", "safety-reports"]) {
    const path = "/api/mobile/" + route
    const response = await fetch(new URL(path, origin), { headers: { Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 401, path + ": expected signed-out response")
    assert.match(response.headers.get("content-type") || "", /^application\/json\b/i, path)
    const body = await response.json()
    assert.deepEqual(Object.keys(body), ["error"], path + ": expected only the error field")
    assert.equal(typeof body.error, "string", path)
    assert(body.error.trim(), path + ": empty authentication error")
    checks.push({ path, status: response.status })
  }
  console.log(JSON.stringify({ origin: origin.origin, checkedAt: new Date().toISOString(), authenticated: false, checks }))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
