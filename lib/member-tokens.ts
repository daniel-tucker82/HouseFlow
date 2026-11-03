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

