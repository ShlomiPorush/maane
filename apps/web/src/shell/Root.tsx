// The app root: the language, the session gate, the unsaved-changes guard, and the one confirm and toast hosts.
// GET /api/v1/me answering 401 goes to sign-in (/login?next=...); totp_required goes to the two-factor setup
// (/enroll). Any later 401 from Maane's API does the same, without asking about unsaved changes, and the page comes
// back afterwards. A 401 from Better Auth's routes (api/auth.ts) makes the gate ask GET /api/v1/me again: a session
// that is gone then goes to sign-in the same way, and a wrong password or code stays the page's own error. The
// sign-in, setup and enrollment pages are outside the gate: they decide for themselves.
// The gate also mounts Better Auth's useSession: its own refresh (on opening, coming back to the front or online,
// and another tab's change) is what keeps the session alive; Maane's polling never extends it. When it shows another
// user or another role than before, every cached read is dropped and read again for the user signed in now.

import { useQueryClient } from "@tanstack/react-query"
import { Fragment, type ReactNode, type RefObject, useEffect, useRef } from "react"
import { Navigate, Outlet, useLocation, useNavigate } from "react-router"
import { authClient, onAuthUnauthorized } from "../api/auth.ts"
import { ApiError, onUnauthorized } from "../api/client.ts"
import { qk } from "../api/endpoints.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { ConfirmHost, dismissQuestions } from "../ui/confirm.tsx"
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
  // The user and role the session showed last; kept here, so a user who changed while the page was elsewhere (sign-in)
  // is noticed when the keeper mounts again.
  const sessionUser = useRef<string | null>(null)
  // The last disagreement between the session and the pages that started a reset: the keeper remounts after each
  // reset, and a session answer that stays behind Maane's API (a role just changed) must not reset again and again.
  const handledMismatch = useRef<string | null>(null)

  useEffect(() => {
    onUnauthorized((error) => {
      // The router's own location: the sign-in pages decide for themselves.
      if (AUTH_PAGES.includes(pathRef.current)) return
      clearUnsaved()
      dismissQuestions()
      queryClient.removeQueries({ queryKey: qk.me })
      navigate(authPath(error, hereRef.current), { replace: true })
    })
    // Better Auth answered 401: whether the session is gone is Maane's API's answer to who is signed in.
    onAuthUnauthorized(() => {
      if (AUTH_PAGES.includes(pathRef.current)) return
      void queryClient.invalidateQueries({ queryKey: qk.me })
    })
    return () => {
      onUnauthorized(null)
      onAuthUnauthorized(null)
    }
  }, [clearUnsaved, navigate, queryClient])

  if (open) return children
  const error = me.error
  if (error instanceof ApiError && (error.status === 401 || error.code === "totp_required"))
    return <Navigate to={authPath(error, here)} replace />
  // A later read that failed for another reason keeps the page as it is.
  // The pages are keyed by who Maane's API says is signed in: another user or role mounts them afresh, so no page
  // keeps state (a draft, codes shown once) that the previous identity left.
  if (me.data)
    return (
      <>
        <SessionKeeper seen={sessionUser} handled={handledMismatch} shown={`${me.data.id}:${me.data.role}`} />
        <Fragment key={`${me.data.id}:${me.data.role}`}>{children}</Fragment>
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
 * again and goes to sign-in. When it shows another user, another role, or two-factor turned on or off (signed in as
 * someone else in another tab, a changed role, two-factor turned off in another tab), unsaved changes are dropped and
 * every cached read starts again: Maane's API then answers for the new state (another user, or enrollment). The same
 * happens when the session's user and role differ from those the pages show (`shown`, from Maane's API), also on the
 * session's first answer, once for each disagreement (`handled`).
 */
function SessionKeeper({
  seen,
  handled,
  shown,
}: {
  seen: RefObject<string | null>
  handled: RefObject<string | null>
  shown: string
}) {
  const queryClient = useQueryClient()
  const clearUnsaved = useClearUnsaved()
  const { data, isPending } = authClient.useSession()
  const user = data?.user as { id?: string; role?: string | null; twoFactorEnabled?: boolean | null } | undefined
  const identity = user?.id ? `${user.id}:${user.role ?? ""}:${user.twoFactorEnabled ? "2fa" : ""}` : null
  const sessionUser = user?.id ? `${user.id}:${user.role ?? ""}` : null
  useEffect(() => {
    if (identity) {
      const before = seen.current
      seen.current = identity
      const mismatch = sessionUser !== shown ? `${sessionUser}|${shown}` : null
      const newMismatch = mismatch !== null && mismatch !== handled.current
      // Remembered only while the disagreement lasts: once the two agree, the same pair counts as new again.
      handled.current = mismatch
      if ((before && before !== identity) || newMismatch) {
        clearUnsaved()
        // An open question (it lives outside the pages) must not run the previous identity's action.
        dismissQuestions()
        void queryClient.resetQueries()
      }
    } else if (!isPending && seen.current) void queryClient.invalidateQueries({ queryKey: qk.me })
  }, [identity, sessionUser, shown, isPending, seen, handled, clearUnsaved, queryClient])
  return null
}
