// The app root: the language, the session gate, the unsaved-changes guard, and the one confirm and toast hosts.
// GET /api/v1/me answering 401 goes to sign-in (/login?next=...); totp_required goes to the two-factor setup
// (/enroll). Any later 401 from Maane's API does the same, without asking about unsaved changes, and the page comes
// back afterwards. The sign-in, setup and enrollment pages are outside the gate: they decide for themselves.
// The gate also mounts Better Auth's useSession: its own refresh (on opening, coming back to the front or online,
// and another tab's change) is what keeps the session alive; Maane's polling never extends it.

import { useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useEffect, useRef } from "react"
import { Navigate, Outlet, useLocation, useNavigate } from "react-router"
import { authClient } from "../api/auth.ts"
import { ApiError, onUnauthorized } from "../api/client.ts"
import { qk } from "../api/endpoints.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { ConfirmHost } from "../ui/confirm.tsx"
import { ErrorState, Loading } from "../ui/states.tsx"
import { ToastHost } from "../ui/Toast.tsx"
import { UnsavedProvider, useClearUnsaved } from "../ui/unsaved.tsx"
import { AUTH_PAGES, authPath, useMe, useSetupStatus } from "./session.ts"

export function Root() {
  return (
    <UnsavedProvider>
      <DefaultLanguage />
      <SessionGate>
        <Outlet />
      </SessionGate>
      <ConfirmHost />
      <ToastHost />
    </UnsavedProvider>
  )
}

/** The server's default language, followed while this browser has no choice of its own. */
function DefaultLanguage() {
  const { followDefault } = useI18n()
  const status = useSetupStatus()
  const locale = status.data?.defaultLocale
  useEffect(() => {
    if (locale === "he" || locale === "en") followDefault(locale)
  }, [locale, followDefault])
  return null
}

export function SessionGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const clearUnsaved = useClearUnsaved()
  const here = `${location.pathname}${location.search}`
  const hereRef = useRef(here)
  hereRef.current = here
  const pathRef = useRef(location.pathname)
  pathRef.current = location.pathname
  const open = AUTH_PAGES.includes(location.pathname)
  const me = useMe()

  useEffect(() => {
    onUnauthorized((error) => {
      // The router's own location: the sign-in pages decide for themselves.
      if (AUTH_PAGES.includes(pathRef.current)) return
      clearUnsaved()
      queryClient.removeQueries({ queryKey: qk.me })
      navigate(authPath(error, hereRef.current), { replace: true })
    })
    return () => onUnauthorized(null)
  }, [clearUnsaved, navigate, queryClient])

  if (open) return children
  const error = me.error
  if (error instanceof ApiError && (error.status === 401 || error.code === "totp_required"))
    return <Navigate to={authPath(error, here)} replace />
  // A later read that failed for another reason keeps the page as it is.
  if (me.data)
    return (
      <>
        <SessionKeeper />
        {children}
      </>
    )
  if (me.isPending) return <Loading label={t("app.loading")} />
  return (
    <div className="ui-auth">
      <ErrorState title={t("app.unreachable")} error={error} onRetry={() => void me.refetch()} />
    </div>
  )
}

/**
 * Better Auth's client session: mounted, it refreshes the session by itself (a GET, then the POST that extends it
 * when the answer says so). When it learns that the session is gone (signed out in another tab), the gate checks
 * again and goes to sign-in.
 */
function SessionKeeper() {
  const queryClient = useQueryClient()
  const { data, isPending } = authClient.useSession()
  const seen = useRef(false)
  const signedIn = Boolean(data)
  useEffect(() => {
    if (signedIn) seen.current = true
    else if (!isPending && seen.current) void queryClient.invalidateQueries({ queryKey: qk.me })
  }, [signedIn, isPending, queryClient])
  return null
}
