// Sign-in on Better Auth's routes, /login: username and password (/sign-in/username), then the second factor: the
// code from the authenticator app (/two-factor/verify-totp) or a backup code (/two-factor/verify-backup-code).
// trustDevice is never sent: Maane asks for the code at every sign-in. An account without two-factor yet goes on to
// set it up. `next` (a page of this app only) is where it goes afterwards. A wrong password or code stays on its form.

import { useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useRef, useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router"
import { type AuthError, authClient } from "../../api/auth.ts"
import { ApiError } from "../../api/client.ts"
import { answered, challengeExpired, errorKey, errorText } from "../../api/errors.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { rememberForEnrollment, safeNext, useMe, useSetupStatus, withNext } from "../../shell/session.ts"
import { ErrorState, Loading } from "../../ui/states.tsx"
import { usePageTitle } from "../usePageTitle.ts"
import { AuthFrame, BackupCodeField, type CodeAnswer, CodeField, FormError, PasswordField } from "./parts.tsx"

type Method = "totp" | "backup"

export function LoginPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const next = safeNext(params.get("next"))
  const usernameId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<"password" | "code">("password")
  const [method, setMethod] = useState<Method>("totp")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  usePageTitle(step === "code" ? t("login.codeTitle") : t("login.title"))

  const status = useSetupStatus({ fresh: true })
  const me = useMe({ fresh: true })
  // The session is judged only by a read made after this page opened, never by a cached answer.
  if (status.isPending || ((me.isPending || me.isFetching) && step === "password"))
    return <Loading label={t("app.loading")} />
  if (status.isError)
    return (
      <div className="ui-auth">
        <ErrorState title={t("app.unreachable")} error={status.error} onRetry={() => void status.refetch()} />
      </div>
    )
  if (!status.data.hasUser) return <Navigate to={withNext("/setup", next)} replace />
  // A failed read keeps the old answer beside its error: the error decides.
  if (me.error instanceof ApiError && me.error.code === "totp_required")
    return <Navigate to={withNext("/enroll", next)} replace />
  if (!me.error && me.data) return <Navigate to={next} replace />

  const finish = async () => {
    await queryClient.resetQueries()
    navigate(next, { replace: true })
  }

  const backToPassword = (message: string | null) => {
    setStep("password")
    setMethod("totp")
    setError(message)
  }

  const signIn = async (event: FormEvent) => {
    event.preventDefault()
    if (!username || !password) {
      setError(t("login.missing"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { data, error: answer } = await authClient.signIn.username({ username, password })
      if (answer) {
        if (errorKey(answer) === "errors.code.wrongCredentials") {
          setPassword("")
          passwordRef.current?.focus()
        }
        setError(errorText(t, answer))
        return
      }
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
        setPassword("")
        setStep("code")
        return
      }
      // Signed in without two-factor (a new account): it is set up next, without asking for the password again.
      rememberForEnrollment(password)
      setPassword("")
      await queryClient.resetQueries()
      navigate(withNext("/enroll", next), { replace: true })
    } catch {
      setError(errorText(t, { status: 0 }))
    } finally {
      setBusy(false)
    }
  }

  /** Sends the second factor; an expired challenge goes back to the password. */
  const verify = async (call: () => Promise<{ error: AuthError }>): Promise<CodeAnswer> => {
    setBusy(true)
    setError(null)
    try {
      const { error: answer } = await call()
      if (answer) {
        if (challengeExpired(answer)) {
          backToPassword(errorText(t, answer))
          return "refused"
        }
        setError(errorText(t, answer))
        return answered(answer) ? "refused" : "kept"
      }
      await finish()
      return "done"
    } catch {
      setError(errorText(t, { status: 0 }))
      return "kept"
    } finally {
      setBusy(false)
    }
  }

  const choose = (nextMethod: Method) => {
    setMethod(nextMethod)
    setError(null)
  }

  if (step === "code")
    return (
      <AuthFrame
        title={t("login.codeTitle")}
        description={t(method === "backup" ? "login.backupDescription" : "login.codeDescription")}
      >
        {method === "totp" ? (
          <CodeField
            onSubmit={(code) => verify(() => authClient.twoFactor.verifyTotp({ code }))}
            busy={busy}
            submitLabel={t("login.verify")}
            busyLabel={t("login.verifying")}
            error={error}
          />
        ) : (
          <BackupCodeField
            onSubmit={(code) => verify(() => authClient.twoFactor.verifyBackupCode({ code }))}
            busy={busy}
            error={error}
          />
        )}
        <div className="ui-auth-alt">
          {method === "backup" ? (
            <button type="button" className="ui-link-btn" onClick={() => choose("totp")}>
              {t("login.useApp")}
            </button>
          ) : (
            <button type="button" className="ui-link-btn" onClick={() => choose("backup")}>
              {t("login.useBackup")}
            </button>
          )}
        </div>
        <button type="button" className="ui-btn" onClick={() => backToPassword(null)}>
          {t("login.back")}
        </button>
      </AuthFrame>
    )

  return (
    <AuthFrame title={t("login.title")} description={t("login.description")}>
      <form className="ui-form-stack" onSubmit={(event) => void signIn(event)} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={usernameId}>
            {t("auth.username")}
          </label>
          <input
            id={usernameId}
            className="ui-input"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            dir="ltr"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            // biome-ignore lint/a11y/noAutofocus: the sign-in page has one job; the username is where it starts
            autoFocus
          />
        </div>
        <PasswordField
          label={t("auth.password")}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          inputRef={passwordRef}
          invalid={Boolean(error)}
        />
        {error ? <FormError>{error}</FormError> : null}
        <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("login.signingIn") : t("login.submit")}
        </button>
      </form>
      <div className="ui-auth-note">
        <p>{t("login.forgot")}</p>
      </div>
    </AuthFrame>
  )
}
