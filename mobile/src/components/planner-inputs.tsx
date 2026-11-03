import { useState } from "react"
import { Modal, Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import NativeDateTimePicker from "@expo/ui/community/datetime-picker"
import { Check, ChevronDown } from "lucide-react-native"
import { Action, Copy, styles, usePalette } from "./ui"

export function PlannerSelect<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void
}) {
  const [open, setOpen] = useState(false), colors = usePalette()
  return <View style={{ gap: 8 }}><Copy tone="label">{label}</Copy>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${options.find(item => item.value === value)?.label ?? value}`} onPress={() => setOpen(true)}
      style={[styles.row, { minHeight: 52, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface }]}>
      <Copy style={{ flex: 1 }}>{options.find(item => item.value === value)?.label ?? value}</Copy><ChevronDown size={20} color={colors.muted} />
    </Pressable>
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><ScrollView contentContainerStyle={[styles.content, { maxWidth: 720 }]}>
        <Copy tone="heading">{label}</Copy>
        {options.map(item => <Pressable key={item.value} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: item.value === value }}
          onPress={() => { onChange(item.value); setOpen(false) }} style={[styles.row, { minHeight: 52, padding: 14, backgroundColor: item.value === value ? colors.soft : colors.surface, borderRadius: 12 }]}>
          <Copy style={{ flex: 1 }}>{item.label}</Copy>{item.value === value ? <Check size={22} color={colors.primary} /> : null}
        </Pressable>)}
        <Action secondary label="Cancel" onPress={() => setOpen(false)} />
      </ScrollView></SafeAreaView>
    </Modal>
  </View>
}

export function PlannerNumber({ label, value, onChange, minimum = 0, maximum = 36500 }: {
  label: string; value: number; onChange: (value: number) => void; minimum?: number; maximum?: number
}) {
  const colors = usePalette()
  return <View style={{ gap: 8 }}><Copy tone="label">{label}</Copy><TextInput accessibilityLabel={label} keyboardType="number-pad" value={Number.isFinite(value) ? String(value) : ""}
    onChangeText={text => onChange(text === "" ? NaN : /^\d+$/.test(text) ? Number(text) : value)}
    accessibilityHint={`Whole number from ${minimum} to ${maximum}`}
    style={{ minHeight: 52, padding: 14, fontSize: 17, color: colors.text, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }} />
    {Number.isFinite(value) && (value < minimum || value > maximum) ? <Copy style={{ color: colors.danger }}>Enter a whole number from {minimum} to {maximum}.</Copy> : null}</View>
}

/** Pick wall-clock components, not an instant. The server applies household time.
 * A fixed date for time pickers avoids device-local DST gaps changing the hour.
 */
export function PlannerDateTime({ label, mode, value, onChange }: { label: string; mode: "date" | "time"; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false), colors = usePalette()
  const { height, fontScale } = useWindowDimensions()
  // Material's calendar dialog clips on short windows. Embed the native picker
  // in the scrolling form there, keeping every date and Done reachable.
  const compact = Platform.OS === "android" && height / Math.max(1, fontScale) < 600
  const [year, month, day] = (mode === "date" ? value : "2000-01-15").split("-").map(Number)
  const [hour, minute] = (mode === "time" ? value : "12:00").split(":").map(Number)
  const date = new Date(year, month - 1, day, hour, minute)
  const chosen = Number.isFinite(date.getTime()) ? date : new Date()
  const display = mode === "date" ? chosen.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : value
  const pad = (n: number) => String(n).padStart(2, "0")
  return <View style={{ gap: 8 }}><Copy tone="label">{label}</Copy><Action secondary label={`${label}: ${display}`} onPress={() => setOpen(true)} />
    {open ? <><NativeDateTimePicker value={chosen} mode={mode} display={Platform.OS === "ios" ? "spinner" : "default"} presentation={compact ? "inline" : "dialog"} accentColor={colors.primary}
      onDismiss={() => setOpen(false)} onValueChange={(_event, next) => {
        onChange(mode === "date" ? `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}` : `${pad(next.getHours())}:${pad(next.getMinutes())}`)
        if (Platform.OS === "android" && !compact) setOpen(false)
      }} />{Platform.OS === "ios" || compact ? <Action secondary label="Done" onPress={() => setOpen(false)} /> : null}</> : null}
  </View>
}
