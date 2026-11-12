// The ticket list, the home page (plan 2.4): one list across every organization the user may see, newest activity
// first (GET /api/v1/tickets), with an organization filter and the review filter, both kept in the address
// (?organization=<id>&review=1). "Show older tickets" follows the cursor after the last row shown (TB-6); the list
// reads itself again every 30 seconds and keeps every page it shows (SV-10). A row opens the ticket (/tickets/:n).

import type { TicketList, TicketSummary } from "@maane/shared"
import { ChevronRight } from "lucide-react"
import { useId } from "react"
import { Link, useSearchParams } from "react-router"
import { api, qk, type TicketFilters } from "../api/endpoints.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { EVERY, usePageInfiniteQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { Sender, TicketNumber, TicketTags } from "./tickets/parts.tsx"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The filters the address holds; anything else in it is ignored. */
export function ticketFilters(search: URLSearchParams): TicketFilters {
  const organization = search.get("organization") ?? ""
  return {
    organization: UUID.test(organization) ? organization : undefined,
    flagged: search.get("review") === "1",
  }
}

export function TicketsPage() {
  const { t } = useI18n()
  usePageMeta(t("tickets.title"))
  const [search, setSearch] = useSearchParams()
  const filters = ticketFilters(search)
  const query = usePageInfiniteQuery<TicketList, string>({
    queryKey: qk.tickets(filters),
    queryFn: (after) => api.tickets(filters, after),
    nextCursor: (page) => page.next,
    every: EVERY.live,
    keepPrevious: true,
  })
  const tickets = query.data?.pages.flatMap((page) => page.tickets) ?? []
  const organizations = query.data?.pages[0]?.organizations ?? []
  const filtered = Boolean(filters.organization || filters.flagged)

  // A filter replaces the address in place: Back leaves the list instead of undoing a filter (NL-4).
  const setFilter = (name: "organization" | "review", value: string | null) => {
    const next = new URLSearchParams(search)
    if (value) next.set(name, value)
    else next.delete(name)
    setSearch(next, { replace: true })
  }

  return (
    <div className="ui-page">
      <PageHead title={t("tickets.title")} description={t("tickets.description")} />
      <Filters
        organizations={organizations}
        organization={filters.organization ?? ""}
        flagged={Boolean(filters.flagged)}
        onOrganization={(id) => setFilter("organization", id || null)}
        onFlagged={(on) => setFilter("review", on ? "1" : null)}
      />
      <section
        className="ui-panel"
        aria-labelledby="tickets-title"
        aria-busy={query.isPlaceholderData || undefined}
        data-reloading={query.isPlaceholderData || undefined}
      >
        <div className="ui-panel-head">
          <h2 id="tickets-title">{t("tickets.listTitle")}</h2>
          {query.data ? <span className="ui-count">{formatNumber(tickets.length)}</span> : null}
        </div>
        {query.isPending ? <Loading label={t("tickets.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("tickets.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <StaleNote failed={query.isError && Boolean(query.data)} />
        {query.data && tickets.length === 0 ? (
          filtered ? (
            <div className="ui-empty">
              <b>{t("tickets.emptyFiltered")}</b>
              <span>{t("tickets.emptyFilteredHint")}</span>
              <button type="button" className="ui-btn ui-btn-sm" onClick={() => setSearch(new URLSearchParams())}>
                {t("tickets.clearFilters")}
              </button>
            </div>
          ) : (
            <Empty title={t("tickets.empty")} hint={t("tickets.emptyHint")} />
          )
        ) : null}
        {tickets.map((ticket) => (
          <TicketRow key={ticket.number} ticket={ticket} />
        ))}
        {query.hasNextPage ? (
          <div className="ui-list-more">
            {query.isFetchNextPageError ? <p className="ui-hint">{t("tickets.moreFailed")}</p> : null}
            <button
              type="button"
              className="ui-btn"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage
                ? t("tickets.loadingMore")
                : query.isFetchNextPageError
                  ? t("common.tryAgain")
                  : t("tickets.more")}
            </button>
          </div>
        ) : query.data && tickets.length > 0 ? (
          <p className="ui-list-note">{t("tickets.end")}</p>
        ) : null}
      </section>
    </div>
  )
}

function Filters(props: {
  organizations: { id: string; name: string }[]
  organization: string
  flagged: boolean
  onOrganization: (id: string) => void
  onFlagged: (on: boolean) => void
}) {
  const { t } = useI18n()
  const selectId = useId()
  // An organization in the address that the list does not offer (removed, or not visible) still shows as chosen.
  const known = props.organization === "" || props.organizations.some((o) => o.id === props.organization)
  return (
    <div className="ui-filters">
      {props.organizations.length > 1 || props.organization !== "" ? (
        <div className="ui-filter">
          <label className="ui-label" htmlFor={selectId}>
            {t("tickets.organization")}
          </label>
          <select
            id={selectId}
            className="ui-input ui-select"
            value={props.organization}
            onChange={(event) => props.onOrganization(event.target.value)}
          >
            <option value="">{t("tickets.allOrganizations")}</option>
            {props.organizations.map((organization) => (
              <option key={organization.id} value={organization.id} dir="auto">
                {organization.name}
              </option>
            ))}
            {known ? null : <option value={props.organization}>{props.organization}</option>}
          </select>
        </div>
      ) : null}
      <div className="ui-filter">
        <span className="ui-label" id={`${selectId}-review`}>
          {t("tickets.review")}
        </span>
        <fieldset className="ui-seg" aria-labelledby={`${selectId}-review`}>
          <button type="button" aria-pressed={!props.flagged} onClick={() => props.onFlagged(false)}>
            {t("tickets.all")}
          </button>
          <button type="button" aria-pressed={props.flagged} onClick={() => props.onFlagged(true)}>
            {t("tickets.needsReview")}
          </button>
        </fieldset>
      </div>
    </div>
  )
}

/** The whole row is the link to the ticket (TB-8); it holds no control of its own. */
function TicketRow({ ticket }: { ticket: TicketSummary }) {
  const { t, tc } = useI18n()
  return (
    <Link
      to={`/tickets/${ticket.number}`}
      className="ui-item ui-item-link ui-ticket-row"
      data-row-open=""
      data-number={ticket.number}
      data-tone={ticket.reviewFlags.length > 0 ? "warn" : undefined}
    >
      <span className="ui-item-main">
        <span className="ui-item-title ui-item-tags">
          <TicketNumber number={ticket.number} />
          <bdi dir="auto" className="ui-ticket-subject">
            {ticket.subject ?? t("tickets.noSubject")}
          </bdi>
          <TicketTags status={ticket.status} flags={ticket.reviewFlags} />
        </span>
        <span className="ui-item-meta">
          <Sender sender={ticket.customer} />
          <span aria-hidden="true">·</span>
          <bdi dir="auto">{ticket.organization.name}</bdi>
          <span aria-hidden="true">·</span>
          <span>{tc("tickets.messages", ticket.messages)}</span>
        </span>
      </span>
      <span className="ui-item-end">
        <Time value={ticket.lastActivityAt} />
        <ChevronRight className="ui-item-chevron" aria-hidden="true" />
      </span>
    </Link>
  )
}
