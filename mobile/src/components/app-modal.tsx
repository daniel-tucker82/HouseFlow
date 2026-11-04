import { Modal, type ModalProps } from "react-native"
import { useReducedMotion } from "../providers/motion-preferences"

/** Retain each screen's native presentation and dismissal behavior, while
 * respecting the current device preference for both opening and closing. */
export function AppModal({ animationType, ...props }: ModalProps) {
  const reducedMotion = useReducedMotion()
  return <Modal {...props} animationType={reducedMotion ? "none" : animationType} />
}
