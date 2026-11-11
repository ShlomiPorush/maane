// The Account page, /account, opened from the account menu: the user's own account on Better Auth's routes, each
// action at once and outside any save bar. Signed in as; the signed-in sessions with End per session and End all
// other sessions (/list-sessions, /revoke-session, /revoke-other-sessions); the password, changed in a dialog
// (/change-password, which ends the other sessions); new backup codes (/two-factor/generate-backup-codes); and
// two-factor turned off (/two-factor/disable) to set up a new authenticator app at once (/enroll). Every dialog with
// typed input asks before dropping it (DS-9). Signing out of this browser is in the account menu.

import { PASSWORD_MAX, PASSWORD_MIN } from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { UserRound } from "lucide-react"
import { type FormEvent, useId, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { AuthCallError, authClient, authData } from "../api/auth.ts"
import { qk } from "../api/endpoints.ts"
import { errorKey, errorText } from "../api/errors.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { ACCOUNT_PATH } from "../shell/navigation.ts"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { rememberForEnrollment, useMe, withNext } from "../shell/session.ts"
import { Copyable } from "../ui/Copyable.tsx"
import { confirmDialog, useDiscardGuard } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { describeAgent } from "./agent.ts"
import { BackupCodes, FormError, PasswordField } from "./auth/parts.tsx"
import { Group, Row } from "./parts.tsx"

/** A signed-in session as Better Auth lists it. */
type BrowserSession = {
  id: string
  token: string
  userAgent?: string | null
  ipAddress?: string | null
  createdAt: Date | string
  expiresAt: Date | string
}

const iso = (value: Date | string) => (typeof value === "string" ? value : value.toISOString())

export function AccountPage() {
  const { t } = useI18n()
  usePageMeta(t("account.title"))
  return (
    <div className="ui-page">
      <PageHead title={t("account.title")} description={t("account.description")} icon={UserRound} />
      <div className="ui-account">
        <AccountSections />
      </div>
    </div>
  )
}

function AccountSections() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useMe()
  const current = authClient.useSession().data?.session.id
  const query = usePageQuery({
    queryKey: qk.sessions,
    queryFn: () => authData(authClient.listSessions()) as Promise<BrowserSession[]>,
    every: EVERY.slow,
  })
  const [dialog, setDialog] = useState<"password" | "codes" | "authenticator" | null>(null)
  const sessions = [...(query.data ?? [])].sort(
    (a, b) => Number(b.id === current) - Number(a.id === current) || iso(b.createdAt).localeCompare(iso(a.createdAt)),
  )

  const sessionName = (session: BrowserSession) => {
    const agent = describeAgent(session.userAgent ?? null)
    return agent ? t("account.browserOn", agent) : t("account.unknownBrowser")
  }

  const endOne = async (session: BrowserSession) => {
    const name = sessionName(session)
    const ok = await confirmDialog({
      title: t("account.endOneTitle"),
      message: t("account.endOneMessage", { name }),
      confirmText: t("account.endOne"),
      danger: true,
    })
    if (!ok) return
    try {
      await authData(authClient.revokeSession({ token: session.token }))
      showToast(t("account.endOneDone", { name }), "success")
    } catch (error) {
      showToast(t("account.endFailed", { reason: errorText(t, error) }), "error")
    }
    await queryClient.invalidateQueries({ queryKey: qk.sessions })
  }

  const endOthers = async () => {
    const others = sessions.filter((session) => session.id !== current).length
    const ok = await confirmDialog({
      title: t("account.endOthersTitle"),
      message: t("account.endOthersMessage", { count: others }),
      confirmText: t("account.endOthers"),
      danger: true,
    })
    if (!ok) return
    try {
      await authData(authClient.revokeOtherSessions())
      showToast(t("account.endOthersDone"), "success")
    } catch (error) {
      showToast(t("account.endFailed", { reason: errorText(t, error) }), "error")
    }
    await queryClient.invalidateQueries({ queryKey: qk.sessions })
  }

  return (
    <>
      <Group id="account-signed-in" title={t("account.signedInGroup")}>
        <Row label={t("account.signedInAs")}>
          <bdi className="ui-mono ui-set-value" dir="ltr">
            {me.data?.username ?? "-"}
          </bdi>
        </Row>
        <Row label={t("account.role")}>
          <span className="ui-set-value">{me.data ? t(`role.${me.data.role}`) : "-"}</span>
        </Row>
      </Group>
      <Group
        id="account-sessions"
        title={t("account.sessions")}
        count={query.data ? sessions.length : undefined}
        intro={t("account.sessionsHint")}
        extra={
          sessions.length > 1 ? (
            <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" onClick={() => void endOthers()}>
              {t("account.endOthers")}
            </button>
          ) : null
        }
      >
        {query.isPending ? <Loading label={t("account.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("account.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <StaleNote failed={query.isError && Boolean(query.data)} />
        {sessions.map((session) => (
          <div key={session.id} className="ui-item">
            <div className="ui-item-main">
              <span className="ui-item-title">
                <bdi dir="auto">{sessionName(session)}</bdi>{" "}
                {session.id === current ? <Tag tone="info">{t("account.thisSession")}</Tag> : null}
              </span>
              <span className="ui-item-meta">
                {session.ipAddress ? (
                  <>
                    <Copyable value={session.ipAddress} />{" "}
                  </>
                ) : null}
                {t("account.signedIn")} <Time value={iso(session.createdAt)} mode="full" /> · {t("account.until")}{" "}
                <Time value={iso(session.expiresAt)} mode="full" />
              </span>
            </div>
            {session.id !== current ? (
              <div className="ui-item-end">
                <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" onClick={() => void endOne(session)}>
                  {t("account.endOne")}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </Group>
      <Group id="account-password" title={t("account.passwordGroup")}>
        <Row label={t("account.passwordRow")} hint={t("account.passwordHint")}>
          <button type="button" className="ui-btn" onClick={() => setDialog("password")}>
            {t("account.change")}
          </button>
        </Row>
      </Group>
      <Group id="account-two-factor" title={t("account.twoFactor")}>
        <Row label={t("account.codesRow")} hint={t("account.codesHint")}>
          <button type="button" className="ui-btn" onClick={() => setDialog("codes")}>
            {t("account.newCodes")}
          </button>
        </Row>
        <Row label={t("account.authenticatorRow")} hint={t("account.authenticatorHint")}>
          <button type="button" className="ui-btn ui-btn-danger" onClick={() => setDialog("authenticator")}>
            {t("account.newAuthenticator")}
          </button>
        </Row>
      </Group>
      {dialog === "password" ? <PasswordDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "codes" ? <NewCodesDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "authenticator" ? (
        <TwoFactorOffDialog
          onClose={() => setDialog(null)}
          onDisabled={(password) => {
            setDialog(null)
            // The setup starts at once with the password just typed, held in memory only.
            rememberForEnrollment(password)
            navigate(withNext("/enroll", ACCOUNT_PATH), { replace: true })
          }}
        />
      ) : null}
    </>
  )
}

type PasswordFieldName = "current" | "next" | "repeat"

/**
 * Change password, in a dialog: the current one, the new one twice. The page checks what it can before it sends,
 * naming and focusing the field; Better Auth ends the other sessions and this one stays. A refusal keeps the dialog
 * open (only the current password is emptied when it was wrong); a change closes it.
 */
function PasswordDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const formId = useId()
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: PasswordFieldName | null; text: string } | null>(null)
  const currentRef = useRef<HTMLInputElement>(null)
  const nextRef = useRef<HTMLInputElement>(null)
  const repeatRef = useRef<HTMLInputElement>(null)
  const refs = { current: currentRef, next: nextRef, repeat: repeatRef }
  const guardedClose = useDiscardGuard(Boolean(current || next || repeat), onClose)

  const refuse = (field: PasswordFieldName | null, text: string) => {
    setError({ field, text })
    if (field) refs[field].current?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!current) return refuse("current", t("account.currentMissing"))
    if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX)
      return refuse("next", t("auth.passwordRule", { min: PASSWORD_MIN, max: PASSWORD_MAX }))
    if (next !== repeat) return refuse("repeat", t("auth.mismatch"))
    setBusy(true)
    setError(null)
    try {
      const { error: answer } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      })
      if (answer) {
        const wrong = errorKey(answer) === "errors.code.wrongPassword"
        if (wrong) setCurrent("")
        refuse(wrong ? "current" : null, errorText(t, answer))
        return
      }
      guardedClose.dismiss()
      onClose()
      showToast(t("account.changed"), "success")
      await queryClient.invalidateQueries({ queryKey: qk.sessions })
    } catch {
      refuse(null, errorText(t, { status: 0 }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("account.passwordTitle")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("account.changing") : t("account.change")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <p className="ui-hint">{t("account.passwordHint")}</p>
        <PasswordField
          label={t("account.currentPassword")}
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          invalid={error?.field === "current"}
          inputRef={currentRef}
        />
        <PasswordField
          label={t("account.newPassword")}
          hint={t("auth.passwordRule", { min: PASSWORD_MIN, max: PASSWORD_MAX })}
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          invalid={error?.field === "next"}
          inputRef={nextRef}
        />
        <PasswordField
          label={t("account.repeatNewPassword")}
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
          invalid={error?.field === "repeat"}
          inputRef={repeatRef}
        />
        {error ? <FormError>{error.text}</FormError> : null}
      </form>
    </Dialog>
  )
}

/** New backup codes: the password, then the new codes shown once; the old ones stop working. */
function NewCodesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const formId = useId()
  const [password, setPassword] = useState("")
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(Boolean(password) && !codes, onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { data, error: answer } = await authClient.twoFactor.generateBackupCodes({ password })
      if (answer || !data) {
        setError(errorText(t, answer ?? { status: 500 }))
        return
      }
      guardedClose.dismiss()
      setPassword("")
      setCodes(data.backupCodes)
    } catch {
      setError(errorText(t, { status: 0 }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("account.newCodesTitle")}
      size="sm"
      onClose={codes ? onClose : () => void guardedClose()}
      foot={
        codes ? null : (
          <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy || !password}>
            {busy ? t("account.newCodesBusy") : t("account.newCodesSubmit")}
          </button>
        )
      }
    >
      {codes ? (
        <BackupCodes codes={codes} doneLabel={t("account.done")} onDone={onClose} />
      ) : (
        <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
          <p className="ui-hint">{t("account.newCodesHint")}</p>
          <PasswordField
            label={t("account.currentPassword")}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            invalid={Boolean(error)}
            autoFocus
          />
          {error ? <FormError>{error}</FormError> : null}
        </form>
      )}
    </Dialog>
  )
}

/**
 * Two-factor off, to set up a new authenticator app: Better Auth's disable with the password, then the two-factor
 * setup at once. Until it is done, Maane answers this account only with the setup.
 */
function TwoFactorOffDialog({ onClose, onDisabled }: { onClose: () => void; onDisabled: (password: string) => void }) {
  const { t } = useI18n()
  const formId = useId()
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(Boolean(password), onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await authData(authClient.twoFactor.disable({ password }))
      guardedClose.dismiss()
      onDisabled(password)
    } catch (failure) {
      setError(errorText(t, failure instanceof AuthCallError ? failure : { status: 0 }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("account.newAuthenticatorTitle")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-danger-solid" disabled={busy || !password}>
          {busy ? t("account.newAuthenticatorBusy") : t("account.newAuthenticatorSubmit")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <p className="ui-hint">{t("account.newAuthenticatorHint")}</p>
        <PasswordField
          label={t("account.currentPassword")}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          invalid={Boolean(error)}
          autoFocus
        />
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}
