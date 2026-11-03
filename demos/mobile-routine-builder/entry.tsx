import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MobileRoutineBuilder } from "./mobile-routine-builder"
import "./reset.css"

createRoot(document.getElementById("root")!).render(<StrictMode><MobileRoutineBuilder /></StrictMode>)
