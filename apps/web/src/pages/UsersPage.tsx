// Users, /users, admins only: every account, through the admin plugin's routes (/admin/list-users and the actions
// below). An admin creates a user with a username, a role and a first password; the user sets up two-factor at
// their first sign-in. Per user: make admin or agent (/admin/set-role), set a new password
// (/admin/set-user-password), end their sessions (/admin/revoke-user-sessions), disable or enable the account
// (/admin/ban-user, /admin/unban-user), and set the display name replies show as their sender (Maane's own
// /api/v1/admin/users/:id/name). A role change, a new password and a disable each end the user's sessions.
// The first admin, made at setup, is protected: the server refuses to demote or disable it, so it shows no such
// action; nor does the acting admin's own row. A refusal is explained in words (api/errors.ts).

import {
  AGENT_NAME_MAX,
  isValidUsername,
  PASSWORD_MAX,
  PASSWORD_MIN,
  ROLES,
  type Role,
  USERNAME_MAX,
  USERNAME_MIN,
  userEmail,
} from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { Ellipsis, IdCard, KeyRound, LogOut, ShieldCheck, ShieldOff, UserCheck, UserPlus, UserX } from "lucide-react"
import { type FormEvent, useId, useRef, useState } from "react"
import { authClient, authData } from "../api/auth.ts"
import { api, qk } from "../api/endpoints.ts"
import { errorText } from "../api/errors.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { useMe } from "../shell/session.ts"
import { confirmDialog, useDiscardGuard } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Menu, type MenuEntry } from "../ui/Menu.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { AdminOnly } from "./AdminOnly.tsx"
import { FormError, PasswordField } from "./auth/parts.tsx"

/** A user as the admin plugin lists them. */
export type ListedUser = {
  id: string
  username?: string | null
  name: string
  role?: string | null
  banned?: boolean | null
  twoFactorEnabled?: boolean | null
  setupAdmin?: boolean | null
  createdAt: Date | string
}

/** Maane is small: one read lists every user. */
const USER_LIMIT = 200

/** Every user, oldest first (/admin/list-users). */
export function readUsers(): Promise<{ users: ListedUser[]; total: number }> {
  return authData(
    authClient.admin.listUsers({ query: { limit: USER_LIMIT, sortBy: "createdAt", sortDirection: "asc" } }),
  ) as Promise<{ users: ListedUser[]; total: number }>
}

export function UsersPage() {
  const { t } = useI18n()
  return (
    <AdminOnly title={t("users.title")}>
      <Users />
    </AdminOnly>
  )
}

/** Which actions the acting admin may take on a user; the server checks the same rules on its own. */
export function userActions(user: ListedUser, meId: string | undefined) {
  const self = user.id === meId
  const protectedAdmin = user.setupAdmin === true
  return {
    changeRole: !self && !protectedAdmin,
    ban: !self && !protectedAdmin && !user.banned,
    unban: !self && Boolean(user.banned),
    setPassword: true,
    endSessions: !self,
  }
}

const nameOf = (user: ListedUser) => user.username ?? user.name

function Users() {
  const { t } = useI18n()
  usePageMeta(t("users.title"))
  const me = useMe()
  const query = usePageQuery({
    queryKey: qk.users,
    queryFn: readUsers,
    every: EVERY.live,
  })
  const [creating, setCreating] = useState(false)
  const [passwordFor, setPasswordFor] = useState<ListedUser | null>(null)
  const [nameFor, setNameFor] = useState<ListedUser | null>(null)
  const users = query.data?.users ?? []
  const total = query.data?.total ?? 0

  return (
    <div className="ui-page">
      <PageHead
        title={t("users.title")}
        description={t("users.description")}
        actions={
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setCreating(true)}>
            <UserPlus aria-hidden="true" />
            {t("users.create")}
          </button>
        }
      />
      <section className="ui-panel" aria-labelledby="users-title">
        <div className="ui-panel-head">
          <h2 id="users-title">{t("users.listTitle")}</h2>
          {query.data ? <span className="ui-count">{formatNumber(total)}</span> : null}
        </div>
        {query.isPending ? <Loading label={t("users.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("users.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <StaleNote failed={query.isError && Boolean(query.data)} />
        {query.data && users.length === 0 ? <Empty title={t("users.empty")} /> : null}
        {users.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            meId={me.data?.id}
            onSetPassword={() => setPasswordFor(user)}
            onRename={() => setNameFor(user)}
          />
        ))}
        {total > users.length ? (
          <p className="ui-list-note">{t("users.more", { shown: users.length, total })}</p>
        ) : null}
      </section>
      {creating ? <CreateUserDialog onClose={() => setCreating(false)} /> : null}
      {passwordFor ? <SetPasswordDialog user={passwordFor} onClose={() => setPasswordFor(null)} /> : null}
      {nameFor ? <NameDialog user={nameFor} onClose={() => setNameFor(null)} /> : null}
    </div>
  )
}

function UserRow({
  user,
  meId,
  onSetPassword,
  onRename,
}: {
  user: ListedUser
  meId: string | undefined
  onSetPassword: () => void
  onRename: () => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const name = nameOf(user)
  const can = userActions(user, meId)
  const role = (user.role ?? "agent") as Role
  const otherRole: Role = role === "admin" ? "agent" : "admin"

  /** Asks first, runs the admin route, says what happened, and reads the list again. */
  const act = async (
    question: { title: string; message: string; confirmText: string; danger?: boolean },
    run: () => Promise<unknown>,
    done: string,
  ) => {
    if (!(await confirmDialog(question))) return
    try {
      await run()
      showToast(done, "success")
    } catch (error) {
      showToast(t("users.actionFailed", { name, reason: errorText(t, error) }), "error")
    }
    await queryClient.invalidateQueries({ queryKey: qk.users })
  }

  const entries: MenuEntry[] = [
    {
      kind: "item",
      label: t("users.setName"),
      icon: <IdCard aria-hidden="true" />,
      onSelect: onRename,
    },
  ]
  if (can.changeRole)
    entries.push({
      kind: "item",
      label: t(otherRole === "admin" ? "users.makeAdmin" : "users.makeAgent"),
      icon: otherRole === "admin" ? <ShieldCheck aria-hidden="true" /> : <ShieldOff aria-hidden="true" />,
      onSelect: () =>
        void act(
          {
            title: t(otherRole === "admin" ? "users.makeAdminTitle" : "users.makeAgentTitle", { name }),
            message: t(otherRole === "admin" ? "users.makeAdminMessage" : "users.makeAgentMessage"),
            confirmText: t(otherRole === "admin" ? "users.makeAdmin" : "users.makeAgent"),
          },
          () => authData(authClient.admin.setRole({ userId: user.id, role: otherRole })),
          t("users.roleDone", { name, role: t(`role.${otherRole}`) }),
        ),
    })
  if (can.setPassword)
    entries.push({
      kind: "item",
      label: t("users.setPassword"),
      icon: <KeyRound aria-hidden="true" />,
      onSelect: onSetPassword,
    })
  if (can.endSessions)
    entries.push({
      kind: "item",
      label: t("users.endSessions"),
      icon: <LogOut aria-hidden="true" />,
      onSelect: () =>
        void act(
          {
            title: t("users.endSessionsTitle", { name }),
            message: t("users.endSessionsMessage"),
            confirmText: t("users.endSessions"),
            danger: true,
          },
          () => authData(authClient.admin.revokeUserSessions({ userId: user.id })),
          t("users.endSessionsDone", { name }),
        ),
    })
  if (can.ban)
    entries.push({
      kind: "item",
      label: t("users.ban"),
      icon: <UserX aria-hidden="true" />,
      danger: true,
      onSelect: () =>
        void act(
          {
            title: t("users.banTitle", { name }),
            message: t("users.banMessage"),
            confirmText: t("users.ban"),
            danger: true,
          },
          () => authData(authClient.admin.banUser({ userId: user.id })),
          t("users.banDone", { name }),
        ),
    })
  if (can.unban)
    entries.push({
      kind: "item",
      label: t("users.unban"),
      icon: <UserCheck aria-hidden="true" />,
      onSelect: () =>
        void act(
          { title: t("users.unbanTitle", { name }), message: t("users.unbanMessage"), confirmText: t("users.unban") },
          () => authData(authClient.admin.unbanUser({ userId: user.id })),
          t("users.unbanDone", { name }),
        ),
    })

  return (
    <div className="ui-item" data-user={name}>
      <div className="ui-item-main">
        <span className="ui-item-title">
          <bdi className="ui-mono" dir="ltr">
            {name}
          </bdi>{" "}
          <Tag tone="neutral">{t(`role.${role}`)}</Tag>
          {user.id === meId ? <Tag tone="info">{t("users.you")}</Tag> : null}
          {user.setupAdmin ? <Tag tone="neutral">{t("users.protected")}</Tag> : null}
          {user.banned ? <Tag tone="fail">{t("users.banned")}</Tag> : null}
          {!user.banned && !user.twoFactorEnabled ? <Tag tone="warn">{t("users.noTwoFactor")}</Tag> : null}
        </span>
        <span className="ui-item-meta">
          {user.name && user.name !== name ? (
            <>
              <bdi dir="auto" data-display-name="">
                {user.name}
              </bdi>
              {" · "}
            </>
          ) : null}
          {t("users.created")}{" "}
          <Time
            value={typeof user.createdAt === "string" ? user.createdAt : user.createdAt.toISOString()}
            mode="full"
          />
          {user.setupAdmin ? ` · ${t("users.protectedHint")}` : null}
        </span>
      </div>
      <div className="ui-item-end">
        <button
          ref={button}
          type="button"
          className="ui-icon-btn"
          aria-label={t("users.actions", { name })}
          title={t("users.actions", { name })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Ellipsis aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <Menu
          anchor={button}
          label={t("users.actions", { name })}
          side="bottom"
          align="end"
          entries={entries}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

type CreateField = "username" | "password" | "repeat"

/** A new user: a username, a role, and a first password typed twice; they set up two-factor at their first sign-in. */
function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const formId = useId()
  const usernameId = useId()
  const usernameHintId = useId()
  const [username, setUsername] = useState("")
  const [role, setRole] = useState<Role>("agent")
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: CreateField | null; text: string } | null>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const guardedClose = useDiscardGuard(Boolean(username || password || repeat), onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!isValidUsername(username)) {
      setError({ field: "username", text: t("auth.usernameRule", { min: USERNAME_MIN, max: USERNAME_MAX }) })
      usernameRef.current?.focus()
      return
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)
      return setError({ field: "password", text: t("auth.passwordRule", { min: PASSWORD_MIN, max: PASSWORD_MAX }) })
    if (password !== repeat) return setError({ field: "repeat", text: t("auth.mismatch") })
    setBusy(true)
    setError(null)
    try {
      await authData(
        authClient.admin.createUser({
          email: userEmail(username),
          password,
          name: username,
          role,
          // Only the username: the server refuses anything else through data.
          data: { username },
        }),
      )
      guardedClose.dismiss()
      onClose()
      showToast(t("users.createDone", { name: username }), "success")
      await queryClient.invalidateQueries({ queryKey: qk.users })
    } catch (failure) {
      setError({ field: null, text: errorText(t, failure) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("users.createTitle")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("users.creating") : t("users.create")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <p className="ui-hint">{t("users.createHint")}</p>
        <div className="ui-field">
          <label className="ui-label" htmlFor={usernameId}>
            {t("auth.username")}
          </label>
          <input
            id={usernameId}
            ref={usernameRef}
            className="ui-input"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            dir="ltr"
            maxLength={USERNAME_MAX}
            value={username}
            aria-invalid={error?.field === "username" ? true : undefined}
            aria-describedby={usernameHintId}
            onChange={(event) => setUsername(event.target.value)}
          />
          <p id={usernameHintId} className="ui-hint">
            {t("auth.usernameRule", { min: USERNAME_MIN, max: USERNAME_MAX })}
          </p>
        </div>
        <fieldset className="ui-field ui-choice">
          <legend className="ui-label">{t("users.role")}</legend>
          {ROLES.map((option) => (
            <label key={option} className="ui-check-label">
              <input
                type="radio"
                name={`${formId}-role`}
                className="ui-check"
                value={option}
                checked={role === option}
                onChange={() => setRole(option)}
              />
              <span>
                <b>{t(`role.${option}`)}</b> <span className="ui-hint">{t(`users.roleHint.${option}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <PasswordField
          label={t("users.firstPassword")}
          hint={t("auth.passwordRule", { min: PASSWORD_MIN, max: PASSWORD_MAX })}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          invalid={error?.field === "password"}
        />
        <PasswordField
          label={t("auth.repeatPassword")}
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
          invalid={error?.field === "repeat"}
        />
        {error ? <FormError>{error.text}</FormError> : null}
      </form>
    </Dialog>
  )
}

/**
 * The name replies show as the sender, `Name (Organization)` (plan 3.1): Maane's own endpoint sets it through Better
 * Auth's documented adminUpdateUser, with the name only.
 */
function NameDialog({ user, onClose }: { user: ListedUser; onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const formId = useId()
  const fieldId = useId()
  const hintId = useId()
  const name = nameOf(user)
  const [value, setValue] = useState(user.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(value !== user.name, onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = value.trim()
    if (trimmed.length === 0 || [...trimmed].length > AGENT_NAME_MAX)
      return setError(t("users.nameRule", { max: AGENT_NAME_MAX }))
    setBusy(true)
    setError(null)
    try {
      await api.setAgentName(user.id, trimmed)
      guardedClose.dismiss()
      onClose()
      showToast(t("users.setNameDone", { name, display: trimmed }), "success")
      await queryClient.invalidateQueries({ queryKey: qk.users })
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("users.setNameTitle", { name })}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("users.setNameBusy") : t("users.setName")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={fieldId}>
            {t("users.displayName")}
          </label>
          <input
            id={fieldId}
            className="ui-input"
            dir="auto"
            autoComplete="off"
            maxLength={AGENT_NAME_MAX * 2}
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={hintId}
            onChange={(event) => setValue(event.target.value)}
          />
          <p id={hintId} className="ui-hint">
            {t("users.nameHint", { max: AGENT_NAME_MAX })}
          </p>
        </div>
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}

/** A new password for a user: typed twice; every session of that user ends. */
function SetPasswordDialog({ user, onClose }: { user: ListedUser; onClose: () => void }) {
  const { t } = useI18n()
  const formId = useId()
  const name = nameOf(user)
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(Boolean(password || repeat), onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)
      return setError(t("auth.passwordRule", { min: PASSWORD_MIN, max: PASSWORD_MAX }))
    if (password !== repeat) return setError(t("auth.mismatch"))
    setBusy(true)
    setError(null)
    try {
      await authData(authClient.admin.setUserPassword({ userId: user.id, newPassword: password }))
      guardedClose.dismiss()
      onClose()
      showToast(t("users.setPasswordDone", { name }), "success")
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t("users.setPasswordTitle", { name })}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("users.setPasswordBusy") : t("users.setPassword")}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <p className="ui-hint">{t("users.setPasswordHint")}</p>
        <PasswordField
          label={t("account.newPassword")}
          hint={t("auth.passwordRule", { min: PASSWORD_MIN, max: PASSWORD_MAX })}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          autoFocus
        />
        <PasswordField
          label={t("account.repeatNewPassword")}
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
        />
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}
