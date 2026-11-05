import { useCallback } from "react"
import { useFocusEffect } from "expo-router"
import BoardScreen from "../components/board-screen"
import { useRuntime } from "../providers/runtime"

export default function Today() {
  const { controller } = useRuntime()
  useFocusEffect(useCallback(() => {
    controller.setBoardVisible(true)
    return () => controller.setBoardVisible(false)
  }, [controller]))
  return <BoardScreen />
}
