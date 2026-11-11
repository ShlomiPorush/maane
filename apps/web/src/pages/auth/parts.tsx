// The parts the sign-in and setup pages share: the frame (a column on the page, no card, v3 FS-23), a password
// field with show and Caps Lock note, the six-digit code field that sends itself on the sixth digit, the backup
// code field, and the backup codes shown once with Copy, Download and "I saved them".

import { Copy, Download, Eye, EyeOff } from "lucide-react"
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import { useI18n } from "../../i18n/i18n.tsx"
import { BrandIcon } from "../../shell/Shell.tsx"
import { LanguageButton, ThemeButton } from "../../shell/ShellTools.tsx"
import { showToast } from "../../ui/Toast.tsx"

export function AuthFrame({
  title,
  description,
  above,
  children,
}: {
  title: string
  description?: ReactNode
  /** Between the brand and the title: the setup steps. */
  above?: ReactNode
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <main className="ui-auth">
      <div className="ui-auth-col">
        <div className="ui-auth-top">
          <div className="ui-brand">
            <span className="ui-brand-mark" aria-hidden="true">
              <BrandIcon />
            </span>
            <span>{t("app.name")}</span>
          </div>
          <div className="ui-auth-tools">
            <LanguageButton />
            <ThemeButton />
          </div>
        </div>
        {above}
        <div>
          <h1 className="ui-h1">{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {children}
      </div>
    </main>
  )
}

/** An error under a form, announced when it appears. */
export function FormError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div id={id} className="ui-banner ui-banner-fail" role="alert">
      <div>{children}</div>
    </div>
  )
}

export function PasswordField({
  label,
  hint,
  value,
  onChange,
  autoComplete,
  invalid,
  inputRef,
  autoFocus,
  readOnly,
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  autoComplete: "current-password" | "new-password"
  invalid?: boolean
  inputRef?: RefObject<HTMLInputElement | null>
  autoFocus?: boolean
  readOnly?: boolean
}) {
  const { t } = useI18n()
  const id = useId()
  const capsId = useId()
  const hintId = useId()
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const readCaps = (event: KeyboardEvent | MouseEvent) => setCaps(event.getModifierState("CapsLock"))
  const described = [caps ? capsId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined
  return (
    <div className="ui-field">
      <label className="ui-label" htmlFor={id}>
        {label}
      </label>
      <div className="ui-pass">
        <input
          id={id}
          ref={inputRef}
          className="ui-input"
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="off"
          spellCheck={false}
          dir="ltr"
          value={value}
          readOnly={readOnly}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={readCaps}
          onKeyUp={readCaps}
          onMouseDown={readCaps}
          onBlur={() => setCaps(false)}
          // biome-ignore lint/a11y/noAutofocus: the sign-in and setup pages have one job; this field is where it starts
          autoFocus={autoFocus}
        />
        <button
          type="button"
          className="ui-pass-toggle"
          aria-pressed={shown}
          aria-label={shown ? t("auth.hide") : t("auth.show")}
          title={shown ? t("auth.hide") : t("auth.show")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      </div>
      {caps ? (
        <p id={capsId} className="ui-caps">
          {t("auth.capsLock")}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="ui-hint">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** What became of a sent code: accepted, refused (it is cleared), or sent without an answer (it stays). */
export type CodeAnswer = "done" | "refused" | "kept"

/**
 * The six-digit code. It sends itself on the sixth digit; a refused code is cleared for the next try, one that
 * got no answer stays and can be sent again with the button (v3 FS-23).
 */
export function CodeField({
  onSubmit,
  busy,
  submitLabel,
  busyLabel,
  error,
  hint,
}: {
  onSubmit: (code: string) => Promise<CodeAnswer>
  busy: boolean
  submitLabel: string
  busyLabel: string
  error?: string | null
  /** The sentence under the field; the authenticator app's by default. */
  hint?: string
}) {
  const { t } = useI18n()
  const id = useId()
  const hintId = useId()
  const errorId = useId()
  const [value, setValue] = useState("")
  const [formatError, setFormatError] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sent = useRef("")

  // The field comes back to focus after an answer.
  useEffect(() => {
    if (!busy) input.current?.focus()
  }, [busy])

  const send = async (code: string) => {
    if (busy) return
    sent.current = code
    const answer = await onSubmit(code)
    if (answer === "refused") {
      setValue("")
      sent.current = ""
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!/^\d{6}$/.test(value)) {
      setFormatError(true)
      input.current?.focus()
      return
    }
    void send(value)
  }

  const shownError = formatError ? t("auth.error.codeFormat") : error
  return (
    <form className="ui-form-stack" onSubmit={submit} noValidate>
      <div className="ui-field">
        <label className="ui-label" htmlFor={id}>
          {t("auth.code")}
        </label>
        <input
          id={id}
          ref={input}
          className="ui-input ui-code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          dir="ltr"
          value={value}
          disabled={busy}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={shownError ? `${errorId} ${hintId}` : hintId}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "").slice(0, 6)
            setValue(digits)
            setFormatError(false)
            if (digits.length === 6 && digits !== sent.current) void send(digits)
          }}
          // biome-ignore lint/a11y/noAutofocus: the code step has one job; the code field is where it starts
          autoFocus
        />
        <p id={hintId} className="ui-hint">
          {hint ?? t("auth.codeHint")}
        </p>
      </div>
      {shownError ? <FormError id={errorId}>{shownError}</FormError> : null}
      <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  )
}

/** A backup code from enrolment: typed as shown (the dash may be left out). Each code works once. */
export function BackupCodeField({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (code: string) => Promise<CodeAnswer>
  busy: boolean
  error?: string | null
}) {
  const { t } = useI18n()
  const id = useId()
  const hintId = useId()
  const errorId = useId()
  const [value, setValue] = useState("")
  const [formatError, setFormatError] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!busy) input.current?.focus()
  }, [busy])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const code = value.trim()
    if (!/^[A-Za-z0-9-]{6,32}$/.test(code)) {
      setFormatError(true)
      input.current?.focus()
      return
    }
    if ((await onSubmit(code)) === "refused") setValue("")
  }

  const shownError = formatError ? t("auth.error.backupFormat") : error
  return (
    <form className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
      <div className="ui-field">
        <label className="ui-label" htmlFor={id}>
          {t("auth.backupCode")}
        </label>
        <input
          id={id}
          ref={input}
          className="ui-input ui-code-input"
          autoComplete="one-time-code"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={32}
          dir="ltr"
          value={value}
          disabled={busy}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={shownError ? `${errorId} ${hintId}` : hintId}
          onChange={(event) => {
            setValue(event.target.value)
            setFormatError(false)
          }}
          // biome-ignore lint/a11y/noAutofocus: the backup code step has one job; the field is where it starts
          autoFocus
        />
        <p id={hintId} className="ui-hint">
          {t("auth.backupCodeHint")}
        </p>
      </div>
      {shownError ? <FormError id={errorId}>{shownError}</FormError> : null}
      <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
        {busy ? t("login.verifying") : t("login.verify")}
      </button>
    </form>
  )
}

/**
 * The backup codes, shown once: the only way in without the authenticator. Copy and Download keep them; Continue
 * waits for "I saved them".
 */
export function BackupCodes({ codes, onDone, doneLabel }: { codes: string[]; onDone: () => void; doneLabel: string }) {
  const { t } = useI18n()
  const savedId = useId()
  const [saved, setSaved] = useState(false)
  const text = codes.join("\n")
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(t("backupCodes.copied"), "success")
    } catch {
      showToast(t("backupCodes.copyFailed"), "error")
    }
  }
  const download = () => {
    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob([`${t("backupCodes.fileHeading")}\n\n${text}\n`], { type: "text/plain" }))
    link.download = "maane-backup-codes.txt"
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }
  return (
    <div className="ui-form-stack">
      <p className="ui-hint">{t("backupCodes.hint", { count: codes.length })}</p>
      <ol className="ui-backup-codes" dir="ltr" data-testid="backup-codes">
        {codes.map((code) => (
          <li key={code} className="ui-mono">
            {code}
          </li>
        ))}
      </ol>
      <div className="ui-account-actions">
        <button type="button" className="ui-btn" onClick={() => void copy()}>
          <Copy size={14} aria-hidden="true" /> {t("backupCodes.copy")}
        </button>
        <button type="button" className="ui-btn" onClick={download}>
          <Download size={14} aria-hidden="true" /> {t("backupCodes.download")}
        </button>
      </div>
      <label className="ui-check-label" htmlFor={savedId}>
        <input
          id={savedId}
          type="checkbox"
          className="ui-check"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        <span>{t("backupCodes.saved")}</span>
      </label>
      <button type="button" className="ui-btn ui-btn-primary" disabled={!saved} onClick={onDone}>
        {doneLabel}
      </button>
    </div>
  )
}
