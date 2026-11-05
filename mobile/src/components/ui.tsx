import type { PropsWithChildren } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text, useColorScheme, View, type StyleProp, type ViewStyle } from "react-native"

const light = { background: "#f7f8f5", surface: "#ffffff", text: "#243e3b", muted: "#5b6b62", primary: "#23685b", onPrimary: "#ffffff", soft: "#e3eee6", border: "#dfe5dd", danger: "#ab3232", warning: "#78521b", reward: "#fff0cf" }
const dark: typeof light = { background: "#13231f", surface: "#1d302a", text: "#edf4ee", muted: "#b1c1b7", primary: "#9cd5bb", onPrimary: "#153d2d", soft: "#29463a", border: "#3a5146", danger: "#ffaaa3", warning: "#f0c97c", reward: "#493d25" }
export function usePalette() { return useColorScheme() === "dark" ? dark : light }

export function Copy({ children, tone = "body", style }: PropsWithChildren<{ tone?: "body" | "muted" | "heading" | "title" | "label"; style?: StyleProp<import("react-native").TextStyle> }>) {
  const colors = usePalette()
  return <Text accessibilityRole={tone === "heading" || tone === "title" ? "header" : undefined}
    style={[{ color: tone === "muted" ? colors.muted : colors.text, fontSize: 16, lineHeight: 24 },
      tone === "heading" && { fontSize: 24, lineHeight: 31, fontWeight: "700" },
      tone === "title" && { fontSize: 34, lineHeight: 42, fontWeight: "700", letterSpacing: -0.8 },
      tone === "label" && { fontSize: 14, lineHeight: 20, fontWeight: "600" }, style]}>{children}</Text>
}

export function Action({ label, onPress, secondary = false, disabled = false, selected }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean; selected?: boolean }) {
  const colors = usePalette()
  return <Pressable accessibilityRole="button" accessibilityLabel={selected !== undefined ? label : undefined}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, { backgroundColor: secondary ? colors.soft : colors.primary, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 }]}>
    <Text style={{ color: secondary ? colors.text : colors.onPrimary, fontWeight: "600", fontSize: 16, textAlign: "center" }}>{label}</Text>
  </Pressable>
}

export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const colors = usePalette()
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, style]}>{children}</View>
}

export function Loading({ label = "Opening your household…" }: { label?: string }) {
  const colors = usePalette()
  return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator size="large" color={colors.primary} /><Copy tone="muted">{label}</Copy></View>
}

export const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  content: { padding: 20, gap: 20, width: "100%", maxWidth: 1000, alignSelf: "center" },
  card: { borderRadius: 20, borderWidth: 1, padding: 20, gap: 12 },
  action: { minHeight: 48, paddingHorizontal: 20, paddingVertical: 14, borderRadius: 14, justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
})
