// Whether a component is still on the page. A dialog that sent a save checks it when the answer arrives: if the user
// closed that dialog meanwhile (and perhaps opened a new one) or left the page, the late answer must not close the
// dialog now open or navigate anywhere.

import { type RefObject, useEffect, useRef } from "react"

export function useMounted(): RefObject<boolean> {
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}
