// Two-factor enrollment on Better Auth's routes. The password starts it (POST /two-factor/enable answers the
// authenticator link and the backup codes), the first code finishes it (/two-factor/verify-totp). Then every other
// session of the account is ended (/revoke-other-sessions), tried three times, before the backup codes are shown,
// so a browser that signed in with the password alone does not keep a session. The QR code is a data: image, which
// the Content Security Policy allows (img-src 'self' data:), and names the account after the username.

import QRCode from "qrcode"
import { useEffect, useRef, useState } from "react"
import { authClient } from "../../api/auth.ts"
import { authenticatorUri, totpSecret } from "../../api/authenticator.ts"
import { answered, errorText } from "../../api/errors.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { forgetEnrollmentPassword } from "../../shell/session.ts"
import { Copyable } from "../../ui/Copyable.tsx"
import { Loading } from "../../ui/states.tsx"
import { type CodeAnswer, CodeField, FormError, PasswordField } from "./parts.tsx"

/** How often enrollment tries to end the other sessions before it asks the user to try again. */
export const SIGN_OUT_OTHERS_TRIES = 3

export function TotpStep({
  known,
  onEnrolled,
  retryDelayMs = 500,
}: {
  /** The password typed just before (setup or sign-in): enrollment starts without asking for it again. */
  known: string | null
  onEnrolled: (backupCodes: string[]) => void
  /** The pause before each new try to end the other sessions (tests make it 0). */
  retryDelayMs?: number
}) {
  const { t } = useI18n()
  const [password, setPassword] = useState("")
  const [uri, setUri] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signOutOthersFailed, setSignOutOthersFailed] = useState(false)
  const started = useRef(false)
  // False once the step is left: a late answer must not start another account-wide request, which would go out with
  // whatever session the browser holds by then.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const start = async (typed: string) => {
    setBusy(true)
    setError(null)
    try {
      const { data, error: answer } = await authClient.twoFactor.enable({ password: typed })
      if (answer || !data || !("totpURI" in data)) {
        setError(errorText(t, answer ?? { status: 500 }))
        return
      }
      setPassword("")
      // The authenticator app names the account after the username, not the synthetic e-mail.
      setUri(authenticatorUri(data.totpURI))
      setBackupCodes(data.backupCodes)
    } catch {
      setError(errorText(t, { status: 0 }))
    } finally {
      forgetEnrollmentPassword()
      setBusy(false)
    }
  }

  // Starts once with the password typed just before; a ref keeps the development double effect from starting twice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once, as soon as the password is known
  useEffect(() => {
    if (known && !uri && !started.current) {
      started.current = true
      void start(known)
    }
  }, [known])

  useEffect(() => {
    if (!uri) return
    let current = true
    void QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: "M" }).then((url) => {
      if (current) setQr(url)
    })
    return () => {
      current = false
    }
  }, [uri])

  /** Better Auth's revokeOtherSessions, tried three times; the user can try again when all fail. */
  const signOutOthers = async (codes: string[]) => {
    setBusy(true)
    try {
      for (let attempt = 0; attempt < SIGN_OUT_OTHERS_TRIES; attempt++) {
        if (!mounted.current) return
        const answer = await authClient.revokeOtherSessions().catch(() => ({ error: { status: 0 } }))
        if (!mounted.current) return
        if (!answer.error) {
          setSignOutOthersFailed(false)
          onEnrolled(codes)
          return
        }
        if (attempt < SIGN_OUT_OTHERS_TRIES - 1)
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)))
      }
      setSignOutOthersFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const verify = async (code: string): Promise<CodeAnswer> => {
    setBusy(true)
    setError(null)
    try {
      const { error: answer } = await authClient.twoFactor.verifyTotp({ code })
      if (answer) {
        setError(errorText(t, answer))
        return answered(answer) ? "refused" : "kept"
      }
    } catch {
      setError(errorText(t, { status: 0 }))
      return "kept"
    } finally {
      setBusy(false)
    }
    await signOutOthers(backupCodes)
    return "done"
  }

  if (signOutOthersFailed)
    return (
      <div className="ui-form-stack">
        <FormError>{t("enroll.signOutOthersFailed")}</FormError>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={busy}
          onClick={() => void signOutOthers(backupCodes)}
        >
          {t("enroll.signOutOthersRetry")}
        </button>
      </div>
    )

  if (!uri)
    return known && !error ? (
      <Loading label={t("enroll.starting")} />
    ) : (
      <form
        className="ui-form-stack"
        onSubmit={(event) => {
          event.preventDefault()
          void start(password)
        }}
        noValidate
      >
        <PasswordField
          label={t("enroll.confirmPassword")}
          hint={t("enroll.confirmPasswordHint")}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          invalid={Boolean(error)}
          autoFocus
        />
        {error ? <FormError>{error}</FormError> : null}
        <button type="submit" className="ui-btn ui-btn-primary" disabled={busy || !password}>
          {busy ? t("enroll.starting") : t("enroll.start")}
        </button>
      </form>
    )

  return (
    <div className="ui-form-stack">
      <div className="ui-qr">
        {qr ? <img src={qr} alt={t("enroll.qrAlt")} width={220} height={220} /> : <div className="ui-qr-wait" />}
      </div>
      <div className="ui-field">
        <p className="ui-hint">{t("enroll.manual")}</p>
        <span className="ui-secret" data-testid="totp-secret">
          <Copyable value={totpSecret(uri)} />
        </span>
      </div>
      <p className="ui-auth-lead">{t("enroll.enterCode")}</p>
      <CodeField
        onSubmit={verify}
        busy={busy}
        submitLabel={t("enroll.finish")}
        busyLabel={t("enroll.finishing")}
        error={error}
      />
    </div>
  )
}
