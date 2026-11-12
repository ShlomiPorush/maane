// The audit log, /audit, admins only: who did what and when, newest first (GET /api/v1/audit?before=<id>&limit=50).
// "Show older entries" follows the cursor after the last row shown (v3 TB-6); the page reads itself again every 30
// seconds and keeps every page it shows. Each action has its words in the locale files; one the UI does not know yet
// shows its code. A user an action names is shown by username when the user list knows them.

import { useQuery } from "@tanstack/react-query"
import { type AuditEntry, api, type AuditPage as Page, qk } from "../api/endpoints.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { Copyable } from "../ui/Copyable.tsx"
import { EVERY, usePageInfiniteQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { AdminOnly } from "./AdminOnly.tsx"
import { labelKey, SETTING_ROWS } from "./SettingsPage.tsx"
import { readUsers } from "./UsersPage.tsx"

/**
 * Every action the server writes, each with its words in the locale files (audit.action.*). guards.test.ts reads the
 * actions from the server's writeAudit calls and fails on one missing here.
 */
export const AUDIT_ACTIONS = [
  "account.setup",
  "account.password_change",
  "account.totp_enable",
  "account.totp_disable",
  "account.backup_codes_new",
  "session.sign_in",
  "session.sign_out",
  "session.revoke",
  "session.revoke_all",
  "session.revoke_others",
  "user.create",
  "user.set_role",
  "user.ban",
  "user.unban",
  "user.revoke_sessions",
  "user.set_password",
  "setting.update",
  "organization.create",
  "organization.rename",
  "organization.delete",
  "organization.member_add",
  "organization.member_remove",
  "organization.address_add",
  "organization.address_remove",
  "organization.address_default",
] as const

const KNOWN = new Set<string>(AUDIT_ACTIONS)

export function AuditPage() {
  const { t } = useI18n()
  return (
    <AdminOnly title={t("audit.title")}>
      <Audit />
    </AdminOnly>
  )
}

function Audit() {
  const { t } = useI18n()
  usePageMeta(t("audit.title"))
  const query = usePageInfiniteQuery<Page, number>({
    queryKey: qk.audit,
    queryFn: (before) => api.audit(before),
    nextCursor: (page) => page.next,
    every: EVERY.live,
  })
  const users = useQuery({ queryKey: qk.users, queryFn: readUsers, staleTime: EVERY.live })
  const names = new Map((users.data?.users ?? []).map((user) => [user.id, user.username ?? user.name]))
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? []

  return (
    <div className="ui-page">
      <PageHead title={t("audit.title")} description={t("audit.description")} />
      <section className="ui-panel" aria-labelledby="audit-title">
        <div className="ui-panel-head">
          <h2 id="audit-title">{t("audit.listTitle")}</h2>
          {query.data ? <span className="ui-count">{formatNumber(entries.length)}</span> : null}
        </div>
        {query.isPending ? <Loading label={t("audit.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("audit.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <StaleNote failed={query.isError && Boolean(query.data)} />
        {query.data && entries.length === 0 ? <Empty title={t("audit.empty")} /> : null}
        {entries.map((entry) => (
          <AuditRow key={entry.id} entry={entry} names={names} />
        ))}
        {query.hasNextPage ? (
          <div className="ui-list-more">
            {query.isFetchNextPageError ? <p className="ui-hint">{t("audit.moreFailed")}</p> : null}
            <button
              type="button"
              className="ui-btn"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage
                ? t("audit.loadingMore")
                : query.isFetchNextPageError
                  ? t("common.tryAgain")
                  : t("audit.more")}
            </button>
          </div>
        ) : query.data && entries.length > 0 ? (
          <p className="ui-list-note">{t("audit.end")}</p>
        ) : null}
      </section>
    </div>
  )
}

function AuditRow({ entry, names }: { entry: AuditEntry; names: Map<string, string> }) {
  const { t } = useI18n()
  const known = KNOWN.has(entry.action)
  const facts = describe(entry, names, t)
  return (
    <div className="ui-item" data-action={entry.action}>
      <div className="ui-item-main">
        <span className="ui-item-title">
          {known ? t(`audit.action.${entry.action}`) : <bdi className="ui-mono">{entry.action}</bdi>}
          {facts.length > 0 ? (
            <span className="ui-audit-facts">
              {facts.map((fact) => (
                <span key={fact.label} className="ui-audit-fact">
                  {fact.label}: <bdi dir={fact.ltr ? "ltr" : "auto"}>{fact.value}</bdi>
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span className="ui-item-meta">
          <Time value={entry.at} mode="full" /> · {t("audit.by")}{" "}
          {entry.actorUserId === null ? (
            t("audit.system")
          ) : (
            <bdi className="ui-mono" dir="ltr">
              {entry.actorLabel}
            </bdi>
          )}
          {entry.ipAddress ? (
            <>
              {" · "}
              <Copyable value={entry.ipAddress} />
            </>
          ) : null}
        </span>
      </div>
    </div>
  )
}

type Fact = { label: string; value: string; ltr?: boolean }

/**
 * The facts of an entry worth reading: the user, the role, the setting and its new value, the sign-in stage, and for
 * an organization its name, the address, and what came before.
 */
export function describe(
  entry: AuditEntry,
  names: Map<string, string>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): Fact[] {
  const details = entry.details ?? {}
  const facts: Fact[] = []
  // The user an admin acted on: named in the details when it was created, else found by its id. An action on one's
  // own account (account.*) names no one else.
  const named = typeof details.username === "string" ? details.username : null
  const target =
    named ?? (entry.action.startsWith("user.") && entry.entityId ? (names.get(entry.entityId) ?? null) : null)
  if (target) facts.push({ label: t("audit.fact.user"), value: target, ltr: true })
  if (typeof details.role === "string" && (details.role === "admin" || details.role === "agent"))
    facts.push({ label: t("audit.fact.role"), value: t(`role.${details.role}`) })
  if (entry.action === "setting.update" && entry.entityId) {
    const key = SETTING_ROWS.find((row) => row === entry.entityId)
    facts.push({ label: t("audit.fact.setting"), value: key ? t(labelKey(key)) : entry.entityId, ltr: !key })
    if (details.secret === true) facts.push({ label: t("audit.fact.value"), value: t("audit.secretChanged") })
    else if (entry.entityId === "intake.mode" && (details.value === "listening" || details.value === "live"))
      facts.push({ label: t("audit.fact.value"), value: t(`settings.intakeMode.mode.${details.value}`) })
    else if ("value" in details) facts.push({ label: t("audit.fact.value"), value: String(details.value), ltr: true })
  }
  if (entry.action.startsWith("organization.")) {
    if (typeof details.name === "string") facts.push({ label: t("audit.fact.organization"), value: details.name })
    if (entry.action === "organization.rename" && typeof details.previous === "string")
      facts.push({ label: t("audit.fact.previousName"), value: details.previous })
    if (typeof details.value === "string")
      facts.push({ label: t("audit.fact.address"), value: details.value, ltr: true })
    if (entry.action === "organization.address_default" && typeof details.previous === "string")
      facts.push({ label: t("audit.fact.previousDefault"), value: details.previous, ltr: true })
  }
  if (entry.action === "session.sign_in" && (details.stage === "password" || details.stage === "second_factor"))
    facts.push({ label: t("audit.fact.stage"), value: t(`audit.stage.${details.stage}`) })
  return facts
}
