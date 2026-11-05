import { useRef, useState } from "react"
import { Pressable, Text, View } from "react-native"
import { openURL } from "expo-linking"
import { policyLinks } from "../services/policy-links"
import { Copy, usePalette } from "./ui"

const links = [
  { label: "Privacy policy", url: policyLinks.privacy },
  { label: "Terms of use", url: policyLinks.terms },
].filter((link): link is { label: string; url: string } => Boolean(link.url))

export function PolicyLinks() {
  const colors = usePalette(), opening = useRef(false)
  const [error, setError] = useState<string | null>(null)
  if (!links.length) return null
  async function open(label: string, url: string) {
    if (opening.current) return
    opening.current = true
    setError(null)
    try { await openURL(url) }
    catch { setError(`Unable to open ${label.toLowerCase()}. Check your connection and try again.`) }
    finally { opening.current = false }
  }
  return <View style={{ gap: 4 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 20 }}>
      {links.map(({ label, url }) => <Pressable key={label} accessibilityRole="link"
        accessibilityLabel={label} accessibilityHint="Opens in your browser"
        onPress={() => void open(label, url)}
        style={({ pressed }) => ({ minHeight: 48, maxWidth: "100%", justifyContent: "center", paddingVertical: 12, opacity: pressed ? 0.65 : 1 })}>
        <Text style={{ color: colors.primary, fontSize: 16, lineHeight: 24, textDecorationLine: "underline", flexShrink: 1 }}>{label}</Text>
      </Pressable>)}
    </View>
    {error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{error}</Copy></View> : null}
  </View>
}
