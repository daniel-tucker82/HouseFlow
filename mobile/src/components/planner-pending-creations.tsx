import { Alert, View } from "react-native"
import { useBoard, usePlanner, useRuntime } from "../providers/runtime"
import { Action, Copy } from "./ui"

export function PlannerPendingCreations({ householdId, excludeSchedules = false, onlyBoards = false }: { householdId?: string; excludeSchedules?: boolean; onlyBoards?: boolean }) {
  const { planner } = useRuntime(), state = usePlanner(), board = useBoard()
  const creations = state.creations.filter(item => (!householdId || item.householdId === householdId) && (!excludeSchedules || item.body.action !== "saveRoutineSchedule") && (!onlyBoards || item.body.action === "createTaskBoard"))
  function report(error: unknown) { Alert.alert("Unable to update", error instanceof Error ? error.message : "Please try again.") }
  return creations.map(item => <View key={item.id} style={{ gap: 12 }}>
    <Copy tone="label">{item.label}</Copy>
    <Copy tone="muted">{item.state === "pending" ? "Saved on this device. Waiting to sync with your household." : item.error}</Copy>
    {item.state === "rejected" ? <>
      {item.body.action === "saveRoutineSchedule" ? <Copy tone="muted">Open this household in Routines to review your saved schedule against its current settings.</Copy> : null}
      {board.households.some(household => household.id === item.householdId && household.role !== "member") ? <Action secondary label="Try syncing again" disabled={!state.online} onPress={() => void planner.retryCreation(item).catch(report)} /> : null}
      <Action secondary label="Discard saved request" onPress={() => Alert.alert("Discard this request?", "This removes the saved request from this device. It does not remove any item already in the household.", [
        { text: "Keep request", style: "cancel" }, { text: "Discard", style: "destructive", onPress: () => void planner.discardCreation(item).catch(report) },
      ])} />
    </> : null}
  </View>)
}
