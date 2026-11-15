// Signing out of this browser from the shell (v3 SV-1, NL-9; n8n-ops shell.tsx UserMenu). Unsaved changes are
// asked about first; this device's notifications are removed (plan 4.5); Better Auth's signOut ends the session; only once it worked are the changes dropped and the
// page leaves for sign-in. A failed sign-out says so and keeps every draft and its guard in place.

import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { useNavigate } from "react-router"
import { authClient, authData } from "../api/auth.ts"
import { errorText } from "../api/errors.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { DeviceNotForgotten, forgetDevice } from "../notifications/forget.ts"
import { showToast } from "../ui/Toast.tsx"
import { useClearUnsaved, useConfirmLeave } from "../ui/unsaved.tsx"

/** Leaves for sign-in after this browser's session ended on purpose; nothing asks about unsaved changes. */
export function useSignedOut() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const clearUnsaved = useClearUnsaved()
  return useCallback(() => {
    clearUnsaved()
    queryClient.clear()
    navigate("/login", { replace: true })
  }, [clearUnsaved, queryClient, navigate])
}

/**
 * Sign out: the unsaved question, then this device's notifications removed, then Better Auth's signOut; resolves when
 * it is done or refused.
 */
export function useSignOut() {
  const { t } = useI18n()
  const confirmLeave = useConfirmLeave()
  const signedOut = useSignedOut()
  return useCallback(async () => {
    if (!(await confirmLeave())) return
    try {
      await forgetDevice()
      await authData(authClient.signOut())
    } catch (error) {
      if (error instanceof DeviceNotForgotten) showToast(t("notifications.notForgotten"), "error")
      else showToast(t("account.signOutFailed", { reason: errorText(t, error) }), "error")
      return
    }
    signedOut()
  }, [confirmLeave, signedOut, t])
}
