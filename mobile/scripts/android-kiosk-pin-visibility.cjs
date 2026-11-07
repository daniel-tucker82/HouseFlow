// Inspect the focused PIN on an Android emulator, without typing or unlocking.
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { randomUUID } = require("node:crypto")
const { join } = require("node:path")

function inspectPin(serial, field, adb) {
  assert(/^emulator-\d+$/.test(serial), "Use a dedicated Android emulator")
  assert(["kiosk-parent-pin", "kiosk-confirm-pin"].includes(field), "Choose a setup PIN field")
  const run = (...args) => execFileSync(adb, ["-s", serial, ...args], {
    encoding: "utf8", timeout: 30000, maxBuffer: 10 * 1024 * 1024, windowsHide: true,
  }).trim()
  const tmp = "/sdcard/cyntch-pin-visibility-" + randomUUID() + ".xml"
  let xml
  try {
    assert(run("shell", "uiautomator", "dump", tmp).includes("dumped to"), "Could not observe this screen")
    xml = run("shell", "cat", tmp)
  } finally { run("shell", "rm", "-f", tmp) }
  const nodes = [...xml.matchAll(/<node\s+([^>]+)>/g)].map(node =>
    Object.fromEntries([...node[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]])))
  const app = nodes.filter(n => n.package === "com.cyntch.app")
  assert(app.some(n => n["resource-id"] === "kiosk-confirm-pin"), "Open family display setup")
  const focused = app.find(n => n["resource-id"] === field && n.focused === "true" && n.password === "true")
  assert(focused, "The requested secure field is not focused")
  const insets = run("shell", "dumpsys", "window", "displays").split(/\r?\n/).find(line =>
    /\b(?:mType|type)=ime\b/.test(line) && /\b(?:mVisible|visible)=true\b/.test(line) && /\b(?:mFrame|frame)=\[/.test(line))
  const keyboard = insets?.match(/(?:mFrame|frame)=\[\d+,(\d+)\]\[\d+,\d+\]/)
  assert(keyboard, "Open the software keyboard on this emulator")
  const density = [...run("shell", "wm", "density").matchAll(/(?:Physical|Override) density: (\d+)/g)].at(-1)
  assert(density, "No display density available")
  const pixelsPerDp = Number(density[1]) / 160
  const [, fieldTop, , fieldBottom] = focused.bounds.match(/\d+/g).map(Number)
  const keyboardTop = Number(keyboard[1])
  assert(fieldBottom - fieldTop >= Math.floor(52 * pixelsPerDp), "Focused field is clipped")
  assert(keyboardTop - fieldBottom >= Math.ceil(2 * pixelsPerDp), "Focused field meets or overlaps the keyboard")
  // Record geometry, never the entered PIN or other UI text.
  return { field, fieldTop, fieldBottom, keyboardTop, fontScale: run("shell", "settings", "get", "system", "font_scale") }
}

if (require.main === module) {
  try {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    const adb = sdk ? join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb") : "adb"
    console.log(JSON.stringify(inspectPin(process.argv[2], process.argv[3], adb)))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { inspectPin }
