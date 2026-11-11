// First run, /setup: while GET /api/setup/status says setup is open (no user exists and the server started less
// than 5 minutes ago), it creates the first admin through Better Auth's sign-up (which signs them in), then sets up
// two-factor and shows the backup codes. When the window closed with no user, it says that a server restart opens it
// again for 5 minutes. Once a user exists, sign-in decides where to go.

import { isValidUsername, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, userEmail } from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useId, useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router"
import { authClient } from "../../api/auth.ts"
import { errorKey, errorText } from "../../api/errors.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { safeNext, useSetupStatus, withNext } from "../../shell/session.ts"
import { Banner, ErrorState, Loading } from "../../ui/states.tsx"
import { usePageTitle } from "../usePageTitle.ts"
import { AuthFrame, BackupCodes, FormError, PasswordField } from "./parts.tsx"
import { TotpStep } from "./TotpStep.tsx"

export function SetupPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const next = safeNext(params.get("next"))
  const status = useSetupStatus({ fresh: true })
  // The password typed in the account step starts the two-factor setup without asking for it again; in memory only.
  const [created, setCreated] = useState<{ password: string } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const step = codes ? 2 : created ? 1 : 0
  usePageTitle(step === 1 ? t("enroll.title") : step === 2 ? t("enroll.codesTitle") : t("setup.title"))

  if (codes)
    return (
      <AuthFrame
        title={t("enroll.codesTitle")}
        description={t("enroll.codesDescription")}
        above={<Steps current={2} />}
      >
        <BackupCodes
          codes={codes}
          doneLabel={t("enroll.continue")}
          onDone={() => {
            void queryClient.resetQueries().then(() => navigate(next, { replace: true }))
          }}
        />
      </AuthFrame>
    )
  if (created)
    return (
      <AuthFrame title={t("enroll.title")} description={t("enroll.description")} above={<Steps current={1} />}>
        <TotpStep known={created.password} onEnrolled={setCodes} />
      </AuthFrame>
    )
  if (status.isPending) return <Loading label={t("app.loading")} />
  if (status.isError)
    return (
      <div className="ui-auth">
        <ErrorState title={t("setup.loadFailed")} error={status.error} onRetry={() => void status.refetch()} />
      </div>
    )
  if (status.data.hasUser) return <Navigate to={withNext("/login", next)} replace />
  if (!status.data.open)
    return (
      <AuthFrame title={t("setup.title")}>
        <Banner tone="info" title={t("setup.closedTitle")}>
          {t("setup.closedText", { minutes: 5 })}
        </Banner>
        <button type="button" className="ui-btn" onClick={() => void status.refetch()}>
          {t("setup.checkAgain")}
        </button>
      </AuthFrame>
    )
  return (
    <AuthFrame title={t("setup.title")} description={t("setup.description")} above={<Steps current={0} />}>
      <AccountStep onCreated={(password) => setCreated({ password })} onClosed={() => void status.refetch()} />
    </AuthFrame>
  )
}

function Steps({ current }: { current: number }) {
  const { t } = useI18n()
  const names = [t("setup.stepAccount"), t("setup.stepTotp"), t("setup.stepCodes")]
  return (
    <ol className="ui-steps" aria-label={t("setup.steps")}>
      {names.map((name, index) => (
        <li key={name} aria-current={index === current ? "step" : undefined} data-done={index < current || undefined}>
          <span className="ui-step-n" aria-hidden="true">
            {index + 1}
          </span>
          {name}
          {index < current ? <span className="ui-sr-only"> ({t("setup.stepDone")})</span> : null}
        </li>
      ))}
    </ol>
  )
}

type Field = "username" | "password" | "repeat"

/** The first admin: a username and a password typed twice. The same rules the server applies are checked first. */
export function AccountStep({ onCreated, onClosed }: { onCreated: (password: string) => void; onClosed: () => void }) {
  const { t } = useI18n()
  const usernameId = useId()
  const usernameHintId = useId()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: Field | null; text: string } | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!isValidUsername(username))
      return setError({ field: "username", text: t("auth.usernameRule", { min: USERNAME_MIN, max: USERNAME_MAX }) })
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)
      return setError({ field: "password", text: t("auth.passwordRule", { min: PASSWORD_MIN, max: PASSWORD_MAX }) })
    if (password !== repeat) return setError({ field: "repeat", text: t("auth.mismatch") })
    setBusy(true)
    setError(null)
    try {
      const { error: answer } = await authClient.signUp.email({
        name: username,
        email: userEmail(username),
        username,
        password,
      })
      if (answer) {
        if (errorKey(answer) === "errors.code.setupClosed") {
          onClosed()
          return
        }
        setError({ field: null, text: errorText(t, answer) })
        return
      }
      onCreated(password)
    } catch {
      setError({ field: null, text: errorText(t, { status: 0 }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
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
          maxLength={USERNAME_MAX}
          value={username}
          readOnly={busy}
          aria-invalid={error?.field === "username" ? true : undefined}
          aria-describedby={usernameHintId}
          onChange={(event) => setUsername(event.target.value)}
          // biome-ignore lint/a11y/noAutofocus: the setup page has one job; the username is where it starts
          autoFocus
        />
        <p id={usernameHintId} className="ui-hint">
          {t("auth.usernameRule", { min: USERNAME_MIN, max: USERNAME_MAX })}
        </p>
      </div>
      <PasswordField
        label={t("auth.password")}
        hint={t("auth.passwordRule", { min: PASSWORD_MIN, max: PASSWORD_MAX })}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        invalid={error?.field === "password"}
        readOnly={busy}
      />
      <PasswordField
        label={t("auth.repeatPassword")}
        value={repeat}
        onChange={setRepeat}
        autoComplete="new-password"
        invalid={error?.field === "repeat"}
        readOnly={busy}
      />
      {error ? <FormError>{error.text}</FormError> : null}
      <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
        {busy ? t("setup.creating") : t("setup.create")}
      </button>
    </form>
  )
}
