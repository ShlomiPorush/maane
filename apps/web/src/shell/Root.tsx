import { useQueryClient } from "@tanstack/react-query"
import { Fragment, type ReactNode, type RefObject, useEffect, useRef } from "react"
import { Navigate, Outlet, useLocation, useNavigate } from "react-router"
import { authClient, onAuthUnauthorized } from "../api/auth.ts"
import { ApiError, onUnauthorized } from "../api/client.ts"
import { qk } from "../api/endpoints.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { followSubscription } from "../notifications/forget.ts"
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
  const sessionUser = useRef<string | null>(null)
  const handledMismatch = useRef<string | null>(null)

  useEffect(() => {
    onUnauthorized((error) => {
      if (AUTH_PAGES.includes(pathRef.current)) return
      clearUnsaved()
      dismissQuestions()
      queryClient.removeQueries({ queryKey: qk.me })
      navigate(authPath(error, hereRef.current), { replace: true })
    })
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
  if (me.data)
    return (
      <>
        <SessionKeeper seen={sessionUser} handled={handledMismatch} shown={`${me.data.id}:${me.data.role}`} />
        <BrowserSubscription key={me.data.id} />
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
      handled.current = mismatch
      if ((before && before !== identity) || newMismatch) {
        clearUnsaved()
        dismissQuestions()
        void queryClient.resetQueries()
      }
    } else if (!isPending && seen.current) void queryClient.invalidateQueries({ queryKey: qk.me })
  }, [identity, sessionUser, shown, isPending, seen, handled, clearUnsaved, queryClient])
  return null
}

const SUBSCRIPTION_RECHECK_MS = 30_000

function BrowserSubscription() {
  const { language } = useI18n()
  const queryClient = useQueryClient()
  useEffect(() => {
    let answered = false
    let checking = false
    const stop = () => {
      clearInterval(timer)
      window.removeEventListener("focus", check)
    }
    function check() {
      if (answered || checking) return
      checking = true
      followSubscription(language)
        .then((ended) => {
          answered = true
          stop()
          if (ended) void queryClient.invalidateQueries({ queryKey: qk.notifications })
        })
        .catch(() => {})
        .finally(() => {
          checking = false
        })
    }
    const timer = setInterval(check, SUBSCRIPTION_RECHECK_MS)
    window.addEventListener("focus", check)
    check()
    return () => {
      answered = true
      stop()
    }
  }, [queryClient, language])
  return null
}
