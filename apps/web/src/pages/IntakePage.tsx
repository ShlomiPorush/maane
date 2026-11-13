// The intake log, /intake, admins only (plan 2.4): every message intake processed, newest first (GET /api/v1/intake),
// with what Maane did (live) or would have done (listening): the outcome, the reason, the support address and its
// organization, and the ticket it opened, joined, or would have joined. The review filter keeps the entries whose
// message, ticket, or listening conversation carries a review flag. Both filters live in the address
// (?mode=listening|live&review=1). "Show older entries" follows the cursor (TB-6); the page reads itself again every
// 30 seconds (SV-10).

import { INTAKE_REASONS, type IntakeEntry, type IntakeLog } from "@maane/shared"
import { useId } from "react"
import { Link, useSearchParams } from "react-router"
import { api, type IntakeFilters, qk } from "../api/endpoints.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { EVERY, usePageInfiniteQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { Tag } from "../ui/tags.tsx"
import { AdminOnly } from "./AdminOnly.tsx"
import { Sender, TicketNumber } from "./tickets/parts.tsx"

export function IntakePage() {
  const { t } = useI18n()
  return (
    <AdminOnly title={t("intake.title")}>
      <Intake />
    </AdminOnly>
  )
}

export function intakeFilters(search: URLSearchParams): IntakeFilters {
  const mode = search.get("mode")
  return {
    mode: mode === "listening" || mode === "live" ? mode : undefined,
    flagged: search.get("review") === "1",
  }
}

function Intake() {
  const { t } = useI18n()
  usePageMeta(t("intake.title"))
  const ids = useId()
  const [search, setSearch] = useSearchParams()
  const filters = intakeFilters(search)
  const query = usePageInfiniteQuery<IntakeLog, string>({
    queryKey: qk.intake(filters),
    queryFn: (after) => api.intake(filters, after),
    nextCursor: (page) => page.next,
    every: EVERY.live,
    keepPrevious: true,
  })
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? []
  const filtered = Boolean(filters.mode || filters.flagged)
  const setFilter = (name: "mode" | "review", value: string | null) => {
    const next = new URLSearchParams(search)
    if (value) next.set(name, value)
    else next.delete(name)
    setSearch(next, { replace: true })
  }

  return (
    <div className="ui-page">
      <PageHead title={t("intake.title")} description={t("intake.description")} />
      <div className="ui-filters">
        <div className="ui-filter">
          <span className="ui-label" id={`${ids}-mode`}>
            {t("intake.modeLabel")}
          </span>
          <fieldset className="ui-seg" aria-labelledby={`${ids}-mode`}>
            <button type="button" aria-pressed={!filters.mode} onClick={() => setFilter("mode", null)}>
              {t("intake.all")}
            </button>
            {(["listening", "live"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={filters.mode === mode}
                onClick={() => setFilter("mode", mode)}
              >
                {t(`intake.mode.${mode}`)}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="ui-filter">
          <span className="ui-label" id={`${ids}-review`}>
            {t("intake.review")}
          </span>
          <fieldset className="ui-seg" aria-labelledby={`${ids}-review`}>
            <button type="button" aria-pressed={!filters.flagged} onClick={() => setFilter("review", null)}>
              {t("intake.all")}
            </button>
            <button type="button" aria-pressed={Boolean(filters.flagged)} onClick={() => setFilter("review", "1")}>
              {t("intake.needsReview")}
            </button>
          </fieldset>
        </div>
      </div>
      <section
        className="ui-panel"
        aria-labelledby="intake-title"
        aria-busy={query.isPlaceholderData || undefined}
        data-reloading={query.isPlaceholderData || undefined}
      >
        <div className="ui-panel-head">
          <h2 id="intake-title">{t("intake.listTitle")}</h2>
          {query.data ? <span className="ui-count">{formatNumber(entries.length)}</span> : null}
        </div>
        {query.isPending ? <Loading label={t("intake.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("intake.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <StaleNote failed={query.isError && Boolean(query.data)} />
        {query.data && entries.length === 0 ? (
          filtered ? (
            <Empty title={t("intake.emptyFiltered")} />
          ) : (
            <Empty title={t("intake.empty")} hint={t("intake.emptyHint")} />
          )
        ) : null}
        {entries.map((entry) => (
          <IntakeRow key={entry.messageId} entry={entry} />
        ))}
        {query.hasNextPage ? (
          <div className="ui-list-more">
            {query.isFetchNextPageError ? <p className="ui-hint">{t("intake.moreFailed")}</p> : null}
            <button
              type="button"
              className="ui-btn"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage
                ? t("intake.loadingMore")
                : query.isFetchNextPageError
                  ? t("common.tryAgain")
                  : t("intake.more")}
            </button>
          </div>
        ) : query.data && entries.length > 0 ? (
          <p className="ui-list-note">{t("intake.end")}</p>
        ) : null}
      </section>
    </div>
  )
}

/** One entry: it holds links to tickets, so the row itself opens nothing (AX-5). */
function IntakeRow({ entry }: { entry: IntakeEntry }) {
  const { t } = useI18n()
  const listening = entry.mode === "listening"
  return (
    <div
      className="ui-item ui-intake-row"
      data-message={entry.messageId}
      data-mode={entry.mode}
      data-outcome={entry.outcome}
      data-tone={entry.flags.length > 0 ? "warn" : undefined}
    >
      <div className="ui-item-main">
        <span className="ui-item-title ui-item-tags">
          <bdi dir="auto">{entry.subject ?? t("intake.noSubject")}</bdi>
          <Tag tone={listening ? "info" : "ok"}>{t(`intake.mode.${entry.mode}`)}</Tag>
          {entry.flags.map((flag) => (
            <Tag key={flag} tone="warn">
              {t(`flag.${flag}`)}
            </Tag>
          ))}
        </span>
        <span className="ui-intake-outcome">
          <b>{listening ? t(`intake.outcomeWould.${entry.outcome}`) : t(`intake.outcome.${entry.outcome}`)}</b>
          {entry.ticket !== null ? (
            <span>
              {t("intake.ticket")}{" "}
              <Link to={`/tickets/${entry.ticket}`}>
                <TicketNumber number={entry.ticket} />
              </Link>
            </span>
          ) : null}
          {entry.matchedTicket !== null && entry.matchedTicket !== entry.ticket ? (
            <span>
              {t("intake.matched")}{" "}
              <Link to={`/tickets/${entry.matchedTicket}`}>
                <TicketNumber number={entry.matchedTicket} />
              </Link>
            </span>
          ) : null}
          {entry.reasons.length > 0 ? (
            <span className="ui-intake-reasons">
              {t("intake.reasonLabel")}: <ReasonWords codes={entry.reasons} />
            </span>
          ) : null}
        </span>
        <span className="ui-item-meta">
          <Sender sender={entry.from} unknownKey="intake.unknownSender" />
          {entry.supportAddress ? (
            <>
              <span aria-hidden="true">·</span>
              <bdi className="ui-mono" dir="ltr">
                {entry.supportAddress}
              </bdi>
            </>
          ) : null}
          {entry.organization ? (
            <>
              <span aria-hidden="true">·</span>
              <bdi dir="auto">{entry.organization.name}</bdi>
            </>
          ) : null}
        </span>
      </div>
      <span className="ui-item-end">
        <Time value={entry.receivedAt} />
      </span>
    </div>
  )
}

const KNOWN_REASONS = new Set<string>(INTAKE_REASONS)

/** Each reason in words; a code the UI does not know yet shows as it is, in mono, left to right. */
function ReasonWords({ codes }: { codes: string[] }) {
  const { t } = useI18n()
  return (
    <>
      {codes.map((code, index) => (
        <span key={code} data-reason={code}>
          {index > 0 ? ", " : null}
          {KNOWN_REASONS.has(code) ? (
            t(`intake.reason.${code}`)
          ) : (
            <bdi className="ui-mono" dir="ltr">
              {code}
            </bdi>
          )}
        </span>
      ))}
    </>
  )
}
