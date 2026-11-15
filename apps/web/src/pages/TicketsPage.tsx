// The ticket list, the home page (plan 2.4): one list across every organization the user may see, newest activity
// first (GET /api/v1/tickets), with an organization filter, the review filter, and (plan 4.1) a status filter whose
// default is open work (new, open, on hold) and a category filter, all kept in the address
// (?organization=<id>&review=1&status=<filter>&category=<id>; no status is open work). Plan 4.4 adds one search box
// (?q=<term>) over the subject, the customer's address and name, message text, and the ticket number; without a chosen
// status it searches every status, and a chosen one narrows it. It runs on Enter or its button (SR-9), narrows the list
// like a filter, and emptying the box ends it. "Show older tickets" follows the cursor after the last row shown (TB-6);
// the list reads itself again every 30 seconds and keeps every page it shows (SV-10). A row opens the ticket
// (/tickets/:n).

import {
  type CategoryRef,
  defaultStatusFilter,
  SEARCH_MAX_LENGTH,
  STATUS_FILTERS,
  type StatusFilter,
  type TicketList,
  type TicketSummary,
} from "@maane/shared"
import { ChevronRight, Search } from "lucide-react"
import { type FormEvent, useId, useState } from "react"
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
  const status = search.get("status") ?? ""
  const category = search.get("category") ?? ""
  const q = (search.get("q") ?? "").trim().slice(0, SEARCH_MAX_LENGTH)
  return {
    organization: UUID.test(organization) ? organization : undefined,
    flagged: search.get("review") === "1",
    status: (STATUS_FILTERS as readonly string[]).includes(status)
      ? (status as StatusFilter)
      : defaultStatusFilter(Boolean(q)),
    category: UUID.test(category) ? category : undefined,
    q: q || undefined,
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
  const categories = query.data?.pages[0]?.categories ?? []
  const filtered = Boolean(
    filters.organization ||
      filters.flagged ||
      filters.category ||
      filters.q ||
      filters.status !== defaultStatusFilter(Boolean(filters.q)),
  )

  // A filter replaces the address in place: Back leaves the list instead of undoing a filter (NL-4).
  const setFilter = (name: "organization" | "review" | "status" | "category" | "q", value: string | null) => {
    const next = new URLSearchParams(search)
    if (value) next.set(name, value)
    else next.delete(name)
    setSearch(next, { replace: true })
  }

  return (
    <div className="ui-page">
      <PageHead title={t("tickets.title")} description={t("tickets.description")} />
      <SearchBox value={filters.q ?? ""} onSearch={(q) => setFilter("q", q || null)} />
      <Filters
        organizations={organizations}
        organization={filters.organization ?? ""}
        flagged={Boolean(filters.flagged)}
        onOrganization={(id) => setFilter("organization", id || null)}
        onFlagged={(on) => setFilter("review", on ? "1" : null)}
        status={filters.status ?? defaultStatusFilter(Boolean(filters.q))}
        onStatus={(status) => setFilter("status", status === defaultStatusFilter(Boolean(filters.q)) ? null : status)}
        categories={categories}
        category={filters.category ?? ""}
        onCategory={(id) => setFilter("category", id || null)}
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
              <b>{filters.q ? t("tickets.searchEmpty", { query: filters.q }) : t("tickets.emptyFiltered")}</b>
              <span>
                {filters.q
                  ? t(filters.status === "all" ? "tickets.searchEmptyHint" : "tickets.searchEmptyStatusHint")
                  : t("tickets.emptyFilteredHint")}
              </span>
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

/**
 * The search box: the term runs on Enter or the button, not on each key (a server query, SR-9); emptying the box ends
 * the search at once. It follows the address (Clear filters, Back) without being drawn again, so the focus stays.
 */
function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const { t } = useI18n()
  const id = useId()
  const [typed, setTyped] = useState(value)
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setTyped(value)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSearch(typed.trim())
  }
  return (
    <search>
      <form className="ui-search" onSubmit={submit}>
        <label className="ui-label" htmlFor={id}>
          {t("tickets.search")}
        </label>
        <div className="ui-search-row">
          <input
            id={id}
            className="ui-input"
            type="search"
            dir="auto"
            enterKeyHint="search"
            autoComplete="off"
            maxLength={SEARCH_MAX_LENGTH}
            placeholder={t("tickets.searchPlaceholder")}
            data-testid="ticket-search"
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value)
              if (event.target.value === "" && value !== "") onSearch("")
            }}
          />
          <button type="submit" className="ui-btn">
            <Search aria-hidden="true" />
            {t("tickets.searchSubmit")}
          </button>
        </div>
      </form>
    </search>
  )
}

function Filters(props: {
  organizations: { id: string; name: string }[]
  organization: string
  flagged: boolean
  onOrganization: (id: string) => void
  onFlagged: (on: boolean) => void
  status: StatusFilter
  onStatus: (status: StatusFilter) => void
  categories: CategoryRef[]
  category: string
  onCategory: (id: string) => void
}) {
  const { t } = useI18n()
  const selectId = useId()
  // An organization in the address that the list does not offer (removed, or not visible) still shows as chosen.
  const known = props.organization === "" || props.organizations.some((o) => o.id === props.organization)
  const knownCategory = props.category === "" || props.categories.some((c) => c.id === props.category)
  return (
    <div className="ui-filters">
      <div className="ui-filter">
        <label className="ui-label" htmlFor={`${selectId}-status`}>
          {t("tickets.status")}
        </label>
        <select
          id={`${selectId}-status`}
          className="ui-input ui-select"
          value={props.status}
          data-testid="status-filter"
          onChange={(event) => props.onStatus(event.target.value as StatusFilter)}
        >
          {STATUS_FILTERS.map((status) => (
            <option key={status} value={status}>
              {t(`tickets.statusFilter.${status}`)}
            </option>
          ))}
        </select>
      </div>
      {props.categories.length > 0 || props.category !== "" ? (
        <div className="ui-filter">
          <label className="ui-label" htmlFor={`${selectId}-category`}>
            {t("tickets.category")}
          </label>
          <select
            id={`${selectId}-category`}
            className="ui-input ui-select"
            value={props.category}
            data-testid="category-filter"
            onChange={(event) => props.onCategory(event.target.value)}
          >
            <option value="">{t("tickets.allCategories")}</option>
            {props.categories.map((category) => (
              <option key={category.id} value={category.id} dir="auto">
                {category.name}
              </option>
            ))}
            {knownCategory ? null : <option value={props.category}>{props.category}</option>}
          </select>
        </div>
      ) : null}
      {props.organizations.length > 1 || props.organization !== "" ? (
        <div className="ui-filter">
          <label className="ui-label" htmlFor={selectId}>
            {t("tickets.organization")}
          </label>
          <select
            id={selectId}
            className="ui-input ui-select"
            data-testid="organization-filter"
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
