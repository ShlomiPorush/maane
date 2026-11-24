import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { useNavigate } from "react-router"
import { authClient, authData } from "../api/auth.ts"
import { errorText } from "../api/errors.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { DeviceNotForgotten, forgetDevice } from "../notifications/forget.ts"
import { showToast } from "../ui/Toast.tsx"
import { useClearUnsaved, useConfirmLeave } from "../ui/unsaved.tsx"

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
