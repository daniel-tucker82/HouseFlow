import { context } from "esbuild"
import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const demoDirectory = dirname(fileURLToPath(import.meta.url))
const outputDirectory = join(demoDirectory, ".preview")
await mkdir(outputDirectory, { recursive: true })
await copyFile(join(demoDirectory, "index.html"), join(outputDirectory, "index.html"))
const build = await context({
  entryPoints: [join(demoDirectory, "entry.tsx")],
  outdir: outputDirectory,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "warning",
})
await build.watch()
await build.serve({ host: "127.0.0.1", port: 4178, servedir: outputDirectory })
console.log("Cyntch mobile demo: http://127.0.0.1:4178")
console.log("Sample data only. Changes are saved in this browser. Ctrl+C to stop.")
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => { await build.dispose(); process.exit(0) })
}
