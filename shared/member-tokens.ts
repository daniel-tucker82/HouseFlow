export const TOKEN_COLOR_OPTIONS = [
  { id: "rose", className: "bg-rose-200 text-rose-900" },
  { id: "amber", className: "bg-amber-200 text-amber-900" },
  { id: "lime", className: "bg-lime-200 text-lime-900" },
  { id: "emerald", className: "bg-emerald-200 text-emerald-900" },
  { id: "teal", className: "bg-teal-200 text-teal-900" },
  { id: "cyan", className: "bg-cyan-200 text-cyan-900" },
  { id: "sky", className: "bg-sky-200 text-sky-900" },
  { id: "blue", className: "bg-blue-200 text-blue-900" },
  { id: "indigo", className: "bg-indigo-200 text-indigo-900" },
  { id: "violet", className: "bg-violet-200 text-violet-900" },
  { id: "fuchsia", className: "bg-fuchsia-200 text-fuchsia-900" },
  { id: "pink", className: "bg-pink-200 text-pink-900" },
  { id: "orange", className: "bg-orange-200 text-orange-900" },
  { id: "red", className: "bg-red-200 text-red-900" },
  { id: "slate", className: "bg-slate-200 text-slate-900" },
  { id: "zinc", className: "bg-zinc-200 text-zinc-900" },
] as const

/** Native equivalents of the web palette; colour is always accompanied by a name. */
const nativeColors = {
  rose: ["#fecdd3", "#881337"], amber: ["#fde68a", "#78350f"],
  lime: ["#d9f99d", "#365314"], emerald: ["#a7f3d0", "#064e3b"],
  teal: ["#99f6e4", "#134e4a"], cyan: ["#a5f3fc", "#164e63"],
  sky: ["#bae6fd", "#0c4a6e"], blue: ["#bfdbfe", "#1e3a8a"],
  indigo: ["#c7d2fe", "#312e81"], violet: ["#ddd6fe", "#4c1d95"],
  fuchsia: ["#f5d0fe", "#701a75"], pink: ["#fbcfe8", "#831843"],
  orange: ["#fed7aa", "#7c2d12"], red: ["#fecaca", "#7f1d1d"],
  slate: ["#e2e8f0", "#0f172a"], zinc: ["#e4e4e7", "#18181b"],
} as const

export const NATIVE_TOKEN_COLOR_OPTIONS = TOKEN_COLOR_OPTIONS.map(option => ({
  ...option, label: option.id[0].toUpperCase() + option.id.slice(1),
  background: nativeColors[option.id][0], foreground: nativeColors[option.id][1],
}))
export type NativeMemberColor = (typeof NATIVE_TOKEN_COLOR_OPTIONS)[number]

/** Use the complete household, before filtering members, to match web defaults. */
export function buildNativeMemberColorMap(members: { id: string; token_color?: string | null }[]) {
  const byClass = new Map(NATIVE_TOKEN_COLOR_OPTIONS.map(option => [option.className, option]))
  return new Map(Array.from(buildMemberTokenColorMap(members), ([id, className]) =>
    [id, byClass.get(className as NativeMemberColor["className"])!]))
}

export function memberColorFor(seed: string) {
  const palette = TOKEN_COLOR_OPTIONS.map((c) => c.className)
  const sum = seed.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return palette[sum % palette.length]
}

export function buildMemberTokenColorMap(members: { id: string; token_color?: string | null }[]) {
  const palette = TOKEN_COLOR_OPTIONS.map((c) => c.className)
  const classById = new Map(TOKEN_COLOR_OPTIONS.map((c) => [c.id, c.className]))

  const map = new Map<string, string>()
  const used = new Set<string>()

  members.forEach((member) => {
    if (!member.token_color) return
    const cls = classById.get(member.token_color as (typeof TOKEN_COLOR_OPTIONS)[number]["id"])
    if (!cls) return
    map.set(member.id, cls)
    used.add(cls)
  })

  let nextIdx = 0
  members.forEach((member) => {
    if (map.has(member.id)) return
    while (nextIdx < palette.length && used.has(palette[nextIdx])) nextIdx += 1
    const chosen =
      nextIdx < palette.length ? palette[nextIdx] : palette[map.size % palette.length]
    map.set(member.id, chosen)
    used.add(chosen)
    nextIdx += 1
  })
  return map
}

