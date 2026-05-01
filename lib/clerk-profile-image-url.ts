/**
 * Clerk can return an `imageUrl` even when the user has no uploaded photo — e.g. generated
 * initials on a colored circle (Boring Avatars). HouseFlow should treat that like "no photo"
 * so assignee chips use household token color + initials.
 *
 * Mirrors clerk-js `isDefaultImage` (see packages/clerk-js/src/utils/image.ts in clerk/javascript).
 */
export function isClerkGeneratedDefaultProfileImageUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false
  const u = url.trim()
  if (u.includes("gravatar") || u.includes("avatar_placeholder")) return true

  try {
    const parsed = new URL(u)
    const pathnameParts = parsed.pathname.split("/").filter(Boolean)
    const queryParts: string[] = []
    for (const [, value] of parsed.searchParams.entries()) {
      queryParts.push(value)
    }
    const candidateParts = [...pathnameParts, ...queryParts]

    for (const part of candidateParts) {
      const variants = [part]
      try {
        variants.push(decodeURIComponent(part))
      } catch {
        // Keep only the raw value.
      }
      for (const encoded of variants) {
        const normalized = encoded.replace(/\.[a-z0-9]+$/i, "")
        try {
          const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
          const b64 = normalized.replace(/-/g, "+").replace(/_/g, "/") + pad
          const decoded = atob(b64)
          const obj = JSON.parse(decoded) as { type?: string }
          if (obj.type === "default") return true
        } catch {
          // Not an encoded default-avatar payload, continue checking the next segment.
        }
      }
    }
  } catch {
    // Fall through to conservative host/path heuristics below.
  }

  try {
    const parsed = new URL(u)
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()
    const query = parsed.search.toLowerCase()
    if ((host.includes("clerk") || host.includes("img.clerk")) && query.includes("initials=")) {
      return true
    }
    if ((host.includes("clerk") || host.includes("img.clerk")) && path.includes("avatar")) {
      return true
    }
  } catch {
    return false
  }

  return false
}

/** True when we should render a real `<img>` for this URL (not a Clerk-generated placeholder). */
export function isRenderableUserProfilePhotoUrl(url: string | null | undefined): boolean {
  const trimmed = url?.trim()
  if (!trimmed) return false
  return !trimmed.includes("undefined") && !isClerkGeneratedDefaultProfileImageUrl(url)
}
