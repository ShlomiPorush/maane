// Import from Zendesk, /import, admins only (plan 5.1): the archive at its read-only mount, the brand and tag
// mappings, the Maane user that Zendesk agents' comments and notes are attributed to, Start, the run's progress, and
// the paged report of the newest run (GET /api/v1/admin/import). The import runs only before Maane first goes live;
// after that the page says the import is closed for good. Imported tickets are read-only until then. A run that stopped
// on an error stays open; once its job has used up its retries the page offers Continue (the same Start), and the
// report names the ticket that stopped it and why. An open run can be cancelled: what it imported stays, and the next
// start is a full pass.

import {
  IMPORT_FAILURES,
  type ImportCounts,
  type ImportFailure,
  type ImportReportPage,
  type ImportReportRow,
  type ImportRunView,
  type ImportView,
} from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { Play, Save, X } from "lucide-react"
import { useEffect, useState } from "react"
import { api, qk } from "../api/endpoints.ts"
import { errorText } from "../api/errors.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { confirmDialog } from "../ui/confirm.tsx"
import { EVERY, usePageInfiniteQuery, usePageQuery } from "../ui/refresh.ts"
import { Banner, Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { AdminOnly } from "./AdminOnly.tsx"

/** How often the page reads again while a run works. */
const WHILE_RUNNING = 3_000

export function ImportPage() {
  const { t } = useI18n()
  return (
    <AdminOnly title={t("import.title")}>
      <Import />
    </AdminOnly>
  )
}

type Mapping = {
  brands: Record<string, string | null>
  tags: Record<string, string | null>
  agentUserId: string | null
}

const mappingOf = (view: ImportView): Mapping => ({
  brands: Object.fromEntries(view.brands.map((brand) => [brand.id, brand.organizationId])),
  tags: Object.fromEntries(view.tags.map((tag) => [tag.tag, tag.categoryId])),
  agentUserId: view.agentUserId,
})

const same = (a: Mapping, b: Mapping) => JSON.stringify(a) === JSON.stringify(b)

function Import() {
  const { t } = useI18n()
  usePageMeta(t("import.title"))
  // The page reads the archive's summary at the usual pace; a run's progress has its own, faster read (RunPanel).
  const query = usePageQuery({ queryKey: qk.importPage, queryFn: api.importPage, every: EVERY.live })
  const view = query.data

  return (
    <div className="ui-page">
      <PageHead title={t("import.title")} description={t("import.description")} />
      {query.isPending ? (
        <div className="ui-panel">
          <Loading label={t("import.loading")} />
        </div>
      ) : null}
      {query.isError && !view ? (
        <div className="ui-panel">
          <ErrorState title={t("import.failed")} error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : null}
      <StaleNote failed={query.isError && Boolean(view)} />
      {view ? <ImportBody view={view} /> : null}
    </div>
  )
}

function ImportBody({ view }: { view: ImportView }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // While a run works, only the run is read again, every few seconds: the page's summary reads the whole archive.
  const [running, setRunning] = useState(view.run?.state === "running" && view.run.jobActive)
  const progress = usePageQuery({
    queryKey: qk.importRun,
    queryFn: api.importRun,
    every: running ? WHILE_RUNNING : EVERY.live,
  })
  const run = progress.data ? progress.data.run : view.run
  useEffect(() => {
    const now = run?.state === "running" && run.jobActive
    if (running && !now) void queryClient.invalidateQueries({ queryKey: qk.importPage })
    setRunning(now)
  }, [run?.state, run?.jobActive, running, queryClient])
  const saved = mappingOf(view)
  const [mapping, setMapping] = useState<Mapping>(saved)
  const [base, setBase] = useState<Mapping>(saved)
  // A newer answer replaces what is shown unless the admin changed something since.
  useEffect(() => {
    const fresh = mappingOf(view)
    if (!same(fresh, base)) {
      setBase(fresh)
      setMapping((current) => (same(current, base) ? fresh : current))
    }
  }, [view, base])
  const dirty = !same(mapping, base)
  const open = view.window.open
  const runOpen = run?.state === "running"

  return (
    <>
      {!open ? (
        <Banner tone="info" title={t("import.closed")}>
          {view.window.wentLiveAt ? (
            <>
              {t("import.wentLive")} <Time value={view.window.wentLiveAt} mode="full" />
            </>
          ) : (
            t("import.notListening")
          )}
        </Banner>
      ) : null}
      <ArchivePanel view={view} />
      <MappingPanel
        view={view}
        mapping={mapping}
        dirty={dirty}
        disabled={!open || runOpen}
        onChange={setMapping}
        onSaved={() => setBase(mapping)}
      />
      <RunPanel run={run} canStart={open && !dirty && view.archive.present} />
      {run ? <ReportPanel run={run} /> : null}
    </>
  )
}

function ArchivePanel({ view }: { view: ImportView }) {
  const { t } = useI18n()
  const { archive } = view
  return (
    <section className="ui-panel" aria-labelledby="import-archive">
      <div className="ui-panel-head">
        <h2 id="import-archive">{t("import.archive.title")}</h2>
      </div>
      {!archive.present ? (
        <Empty title={t("import.archive.missing")} hint={t("import.archive.missingHint")} />
      ) : (
        <>
          {archive.backupRunning ? <Banner tone="warn" title={t("import.archive.backupRunning")} /> : null}
          {archive.otherOrigin ? <Banner tone="fail" title={t("import.archive.otherOrigin")} /> : null}
          <dl className="ui-facts">
            <div>
              <dt>{t("import.archive.origin")}</dt>
              <dd>
                <bdi className="ui-mono" dir="ltr">
                  {archive.origin}
                </bdi>
              </dd>
            </div>
            <div>
              <dt>{t("import.archive.tickets")}</dt>
              <dd>{formatNumber(archive.tickets)}</dd>
            </div>
            <div>
              <dt>{t("import.archive.runs")}</dt>
              <dd>{formatNumber(archive.runs)}</dd>
            </div>
            <div>
              <dt>{t("import.archive.coveredUntil")}</dt>
              <dd>
                {archive.coveredUntil ? (
                  <Time value={archive.coveredUntil} mode="full" />
                ) : (
                  <span className="ui-muted">{t("import.archive.unknown")}</span>
                )}
              </dd>
            </div>
          </dl>
        </>
      )}
    </section>
  )
}

function MappingPanel({
  view,
  mapping,
  dirty,
  disabled,
  onChange,
  onSaved,
}: {
  view: ImportView
  mapping: Mapping
  dirty: boolean
  disabled: boolean
  onChange: (mapping: Mapping) => void
  onSaved: () => void
}) {
  const { t, tc } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await api.saveImportMapping(mapping)
      onSaved()
      showToast(t("import.mapping.saved"), "success")
    } catch (error) {
      showToast(t("import.mapping.saveFailed", { reason: errorText(t, error) }), "error")
    } finally {
      await queryClient.invalidateQueries({ queryKey: qk.importPage })
      setBusy(false)
    }
  }

  return (
    <section className="ui-panel" aria-labelledby="import-mapping">
      <div className="ui-panel-head">
        <h2 id="import-mapping">{t("import.mapping.title")}</h2>
        <button
          type="button"
          className="ui-btn ui-btn-primary ui-btn-sm"
          disabled={disabled || busy || !dirty}
          onClick={() => void save()}
        >
          <Save aria-hidden="true" />
          {busy ? t("import.mapping.saving") : t("import.mapping.save")}
        </button>
      </div>
      <div className="ui-import-group">
        <label className="ui-label" htmlFor="import-agent">
          {t("import.mapping.agent")}
        </label>
        <select
          id="import-agent"
          className="ui-input ui-select"
          value={mapping.agentUserId ?? ""}
          disabled={disabled}
          onChange={(event) => onChange({ ...mapping, agentUserId: event.target.value || null })}
        >
          <option value="">{t("import.mapping.chooseAgent")}</option>
          {view.users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </select>
        <p className="ui-hint">{t("import.mapping.agentHint")}</p>
      </div>

      <h3 className="ui-import-subtitle">{t("import.mapping.brands")}</h3>
      <p className="ui-hint ui-import-hint">{t("import.mapping.brandsHint")}</p>
      {view.brands.length === 0 ? <Empty title={t("import.mapping.noBrands")} /> : null}
      {view.brands.map((brand) => (
        <div className="ui-item ui-import-row" key={brand.id} data-brand={brand.id}>
          <div className="ui-item-main">
            <span className="ui-item-title">
              <bdi dir="auto">{brand.name}</bdi>
            </span>
            <span className="ui-item-meta">{tc("import.ticketCount", brand.tickets)}</span>
          </div>
          <div className="ui-item-end">
            <select
              className="ui-input ui-select"
              aria-label={t("import.mapping.brandFor", { name: brand.name })}
              value={mapping.brands[brand.id] ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...mapping, brands: { ...mapping.brands, [brand.id]: event.target.value || null } })
              }
            >
              <option value="">{t("import.mapping.noOrganization")}</option>
              {view.organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}

      <h3 className="ui-import-subtitle">{t("import.mapping.tags")}</h3>
      <p className="ui-hint ui-import-hint">{t("import.mapping.tagsHint")}</p>
      {view.tags.length === 0 ? <Empty title={t("import.mapping.noTags")} /> : null}
      {view.tags.map((tag) => (
        <div className="ui-item ui-import-row" key={tag.tag} data-tag={tag.tag}>
          <div className="ui-item-main">
            <span className="ui-item-title">
              <bdi className="ui-mono" dir="auto">
                {tag.tag}
              </bdi>
            </span>
            <span className="ui-item-meta">{tc("import.ticketCount", tag.tickets)}</span>
          </div>
          <div className="ui-item-end">
            <select
              className="ui-input ui-select"
              aria-label={t("import.mapping.tagFor", { tag: tag.tag })}
              value={mapping.tags[tag.tag] ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...mapping, tags: { ...mapping.tags, [tag.tag]: event.target.value || null } })
              }
            >
              <option value="">{t("import.mapping.noCategory")}</option>
              {view.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
      {dirty ? <p className="ui-hint ui-import-hint">{t("import.mapping.unsaved")}</p> : null}
    </section>
  )
}

const COUNTS: (keyof ImportCounts)[] = [
  "tickets",
  "messages",
  "notes",
  "sideConversations",
  "links",
  "files",
  "skipped",
]

const TONES = { running: "info", done: "ok", stopped: "warn", refused: "fail" } as const

function RunPanel({ run, canStart }: { run: ImportRunView | null; canStart: boolean }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<"start" | "cancel" | null>(null)
  // An open run without a job (it used up its retries) goes on from its last ticket: Start is Continue then.
  const resumable = run?.state === "running" && !run.jobActive
  const working = run?.state === "running" && !resumable

  const act = async (kind: "start" | "cancel", call: () => Promise<unknown>, done: string, failed: string) => {
    setBusy(kind)
    try {
      await call()
      showToast(t(done), "success")
    } catch (error) {
      showToast(t(failed, { reason: errorText(t, error) }), "error")
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.importPage }),
        queryClient.invalidateQueries({ queryKey: qk.importRun }),
      ])
      setBusy(null)
    }
  }
  const start = () => act("start", api.startImport, "import.run.started", "import.run.startFailed")
  const cancel = async () => {
    const yes = await confirmDialog({
      title: t("import.run.cancelTitle"),
      message: t("import.run.cancelMessage"),
      confirmText: t("import.run.cancel"),
      cancelText: t("import.run.keep"),
      danger: true,
    })
    if (yes) await act("cancel", api.cancelImport, "import.run.cancelled", "import.run.cancelFailed")
  }

  return (
    <section className="ui-panel" aria-labelledby="import-run">
      <div className="ui-panel-head">
        <h2 id="import-run">{t("import.run.title")}</h2>
        <button
          type="button"
          className="ui-btn ui-btn-primary ui-btn-sm"
          disabled={!canStart || busy !== null || working}
          onClick={() => void start()}
        >
          <Play aria-hidden="true" />
          {busy === "start" ? t("import.run.starting") : resumable ? t("import.run.continue") : t("import.run.start")}
        </button>
        {run?.state === "running" ? (
          <button
            type="button"
            className="ui-btn ui-btn-danger ui-btn-sm"
            disabled={busy !== null}
            onClick={() => void cancel()}
          >
            <X aria-hidden="true" />
            {busy === "cancel" ? t("import.run.cancelling") : t("import.run.cancel")}
          </button>
        ) : null}
      </div>
      {!run ? <Empty title={t("import.run.none")} hint={t("import.run.noneHint")} /> : <RunView run={run} />}
    </section>
  )
}

function RunView({ run }: { run: ImportRunView }) {
  const { t } = useI18n()
  const share = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0
  return (
    <div className="ui-import-run" data-state={run.state}>
      <div className="ui-import-progress-head">
        <Tag tone={TONES[run.state]}>{t(`import.run.state.${run.state}`)}</Tag>
        <span>{t("import.run.progress", { done: formatNumber(run.done), total: formatNumber(run.total) })}</span>
      </div>
      <div
        className="ui-import-progress"
        role="progressbar"
        aria-label={t("import.run.title")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share}
      >
        <span style={{ inlineSize: `${share}%` }} />
      </div>
      {run.reason ? (
        <Banner tone={run.state === "running" ? "warn" : "fail"} title={t(`import.run.reason.${run.reason}`)}>
          {run.failure ? (
            <span data-failure={run.failure.stage}>
              {t(`import.run.stage.${run.failure.stage}`)} {t(`import.report.failure.${run.failure.kind}`)}
              {run.failure.constraint ? (
                <>
                  {" "}
                  <bdi className="ui-mono" dir="ltr">
                    {run.failure.constraint}
                  </bdi>
                </>
              ) : null}
            </span>
          ) : null}
        </Banner>
      ) : null}
      {run.state === "running" && !run.jobActive ? (
        <p className="ui-hint ui-import-hint">{t("import.run.waiting")}</p>
      ) : null}
      {run.problems.length > 0 ? (
        <ul className="ui-import-problems" aria-label={t("import.run.problems")}>
          {run.problems.map((problem) => (
            <li key={problem}>
              <bdi className="ui-mono" dir="ltr">
                {problem}
              </bdi>
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="ui-facts">
        <div>
          <dt>{t("import.run.startedAt")}</dt>
          <dd>
            <Time value={run.createdAt} mode="full" />
          </dd>
        </div>
        {run.finishedAt ? (
          <div>
            <dt>{t("import.run.finishedAt")}</dt>
            <dd>
              <Time value={run.finishedAt} mode="full" />
            </dd>
          </div>
        ) : null}
        {run.coveredUntil ? (
          <div>
            <dt>{t("import.run.coveredUntil")}</dt>
            <dd>
              <Time value={run.coveredUntil} mode="full" />
            </dd>
          </div>
        ) : null}
        {run.highestNumber !== null ? (
          <div>
            <dt>{t("import.run.highest")}</dt>
            <dd>
              <bdi dir="ltr">{t("import.zendeskNumber", { number: formatNumber(run.highestNumber) })}</bdi>
            </dd>
          </div>
        ) : null}
        {COUNTS.map((key) => (
          <div key={key}>
            <dt>{t(`import.run.counts.${key}`)}</dt>
            <dd>{formatNumber(run.counts[key])}</dd>
          </div>
        ))}
      </dl>
      <p className="ui-hint ui-import-hint">{t("import.run.filesNext")}</p>
    </div>
  )
}

function ReportPanel({ run }: { run: ImportRunView }) {
  const { t } = useI18n()
  const query = usePageInfiniteQuery<ImportReportPage, string>({
    queryKey: qk.importReport(run.id),
    queryFn: (after) => api.importReport(run.id, after),
    nextCursor: (page) => page.next,
    every: run.state === "running" && run.jobActive ? WHILE_RUNNING : EVERY.live,
  })
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? []
  return (
    <section className="ui-panel" aria-labelledby="import-report">
      <div className="ui-panel-head">
        <h2 id="import-report">{t("import.report.title")}</h2>
        <span className="ui-count">{formatNumber(run.reportRows)}</span>
      </div>
      <p className="ui-hint ui-import-hint">{t("import.report.hint")}</p>
      {query.isPending ? <Loading label={t("import.report.loading")} /> : null}
      {query.isError && !query.data ? (
        <ErrorState title={t("import.report.failed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <StaleNote failed={query.isError && Boolean(query.data)} />
      {query.data && rows.length === 0 ? <Empty title={t("import.report.empty")} /> : null}
      {rows.map((row) => (
        <div className="ui-item" key={row.id} data-reason={row.reason}>
          <div className="ui-item-main">
            <span className="ui-item-title">
              <bdi dir="ltr">{t("import.zendeskNumber", { number: formatNumber(row.zendeskId) })}</bdi>
            </span>
            <span className="ui-item-meta">
              <span>{t(`import.report.reason.${row.reason}`)}</span>
              <ReportDetail row={row} />
            </span>
          </div>
        </div>
      ))}
      {query.hasNextPage ? (
        <div className="ui-list-more">
          {query.isFetchNextPageError ? <p className="ui-hint">{t("import.report.moreFailed")}</p> : null}
          <button
            type="button"
            className="ui-btn"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage
              ? t("import.report.loadingMore")
              : query.isFetchNextPageError
                ? t("common.tryAgain")
                : t("import.report.more")}
          </button>
        </div>
      ) : query.data && rows.length > 0 ? (
        <p className="ui-list-note">{t("import.report.end")}</p>
      ) : null}
    </section>
  )
}

/** A report row's detail: for a ticket that stopped the run, why in plain words and the database rule it named. */
function ReportDetail({ row }: { row: ImportReportRow }) {
  const { t } = useI18n()
  if (!row.detail) return null
  if (row.reason === "ticket_failed") {
    const [kind = "", constraint] = row.detail.split(":")
    const known: ImportFailure = (IMPORT_FAILURES as readonly string[]).includes(kind)
      ? (kind as ImportFailure)
      : "other"
    return (
      <>
        <span>{t(`import.report.failure.${known}`)}</span>
        {constraint ? (
          <bdi className="ui-mono" dir="ltr">
            {constraint}
          </bdi>
        ) : null}
      </>
    )
  }
  return (
    <bdi className="ui-mono" dir="auto">
      {row.detail}
    </bdi>
  )
}
