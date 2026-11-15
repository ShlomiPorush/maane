// Categories, /categories, admins only (plan 4.1): one shared list, each with how many tickets carry it
// (GET /api/v1/admin/categories). Add category and Rename ask for a name in a dialog; Delete asks first and says that
// every ticket loses the category. Agents set categories on a ticket from its page.

import { CATEGORY_NAME_MAX, type CategoryView } from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { Ellipsis, Pencil, Plus, Trash2 } from "lucide-react"
import { type FormEvent, useId, useRef, useState } from "react"
import { api, qk } from "../api/endpoints.ts"
import { errorText } from "../api/errors.ts"
import { formatNumber } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { confirmDialog, useDiscardGuard } from "../ui/confirm.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Menu, type MenuEntry } from "../ui/Menu.tsx"
import { useMounted } from "../ui/mounted.ts"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Empty, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { showToast } from "../ui/Toast.tsx"
import { AdminOnly } from "./AdminOnly.tsx"
import { FormError } from "./auth/parts.tsx"

export function CategoriesPage() {
  const { t } = useI18n()
  return (
    <AdminOnly title={t("categories.title")}>
      <Categories />
    </AdminOnly>
  )
}

function Categories() {
  const { t } = useI18n()
  usePageMeta(t("categories.title"))
  const query = usePageQuery({ queryKey: qk.categories, queryFn: api.categories, every: EVERY.live })
  const [editing, setEditing] = useState<{ category: CategoryView | null } | null>(null)
  const categories = query.data?.categories ?? []

  return (
    <div className="ui-page">
      <PageHead
        title={t("categories.title")}
        description={t("categories.description")}
        actions={
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditing({ category: null })}>
            <Plus aria-hidden="true" />
            {t("categories.create")}
          </button>
        }
      />
      <section className="ui-panel" aria-labelledby="categories-title">
        <div className="ui-panel-head">
          <h2 id="categories-title">{t("categories.listTitle")}</h2>
          {query.data ? <span className="ui-count">{formatNumber(categories.length)}</span> : null}
        </div>
        {query.isPending ? <Loading label={t("categories.loading")} /> : null}
        {query.isError && !query.data ? (
          <ErrorState title={t("categories.failed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        <StaleNote failed={query.isError && Boolean(query.data)} />
        {query.data && categories.length === 0 ? (
          <Empty title={t("categories.empty")} hint={t("categories.emptyHint")} />
        ) : null}
        {categories.map((category) => (
          <CategoryRow key={category.id} category={category} onRename={() => setEditing({ category })} />
        ))}
      </section>
      {editing ? <NameDialog category={editing.category} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

function CategoryRow({ category, onRename }: { category: CategoryView; onRename: () => void }) {
  const { t, tc } = useI18n()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const name = category.name

  const remove = async () => {
    const confirmed = await confirmDialog({
      title: t("categories.deleteTitle", { name }),
      message: tc("categories.deleteMessage", category.tickets),
      confirmText: t("categories.delete"),
      danger: true,
    })
    if (!confirmed) return
    try {
      await api.deleteCategory(category.id)
      showToast(t("categories.deleteDone", { name }), "success")
    } catch (error) {
      showToast(t("categories.actionFailed", { name, reason: errorText(t, error) }), "error")
    } finally {
      await queryClient.invalidateQueries({ queryKey: qk.categories })
    }
  }

  const entries: MenuEntry[] = [
    { kind: "item", label: t("categories.rename"), icon: <Pencil aria-hidden="true" />, onSelect: onRename },
    {
      kind: "item",
      label: t("categories.delete"),
      icon: <Trash2 aria-hidden="true" />,
      danger: true,
      onSelect: () => void remove(),
    },
  ]

  return (
    <div className="ui-item" data-category={name}>
      <div className="ui-item-main">
        <span className="ui-item-title">
          <bdi dir="auto">{name}</bdi>
        </span>
        <span className="ui-item-meta">
          <span>{tc("categories.ticketCount", category.tickets)}</span>
        </span>
      </div>
      <div className="ui-item-end">
        <button
          ref={button}
          type="button"
          className="ui-icon-btn"
          aria-label={t("categories.actions", { name })}
          title={t("categories.actions", { name })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <Ellipsis aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <Menu
          anchor={button}
          label={t("categories.actions", { name })}
          side="bottom"
          align="end"
          entries={entries}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

/** A name for a new category, or a new name for one (category set). */
function NameDialog({ category, onClose }: { category: CategoryView | null; onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const formId = useId()
  const nameId = useId()
  const hintId = useId()
  const mounted = useMounted()
  const [name, setName] = useState(category?.name ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guardedClose = useDiscardGuard(name !== (category?.name ?? ""), onClose)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0 || [...trimmed].length > CATEGORY_NAME_MAX)
      return setError(t("categories.nameRule", { max: CATEGORY_NAME_MAX }))
    setBusy(true)
    setError(null)
    try {
      if (category) {
        await api.renameCategory(category.id, trimmed)
        showToast(t("categories.renameDone", { name: trimmed }), "success")
      } else {
        const created = await api.createCategory(trimmed)
        showToast(t("categories.createDone", { name: created.category.name }), "success")
      }
      void queryClient.invalidateQueries({ queryKey: qk.categories })
      if (!mounted.current) return
      guardedClose.dismiss()
      onClose()
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  const action = category ? t("categories.rename") : t("categories.create")
  return (
    <Dialog
      title={category ? t("categories.renameTitle", { name: category.name }) : t("categories.createTitle")}
      size="sm"
      onClose={() => void guardedClose()}
      foot={
        <button type="submit" form={formId} className="ui-btn ui-btn-primary" disabled={busy}>
          {busy ? t("categories.saving") : action}
        </button>
      }
    >
      <form id={formId} className="ui-form-stack" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ui-field">
          <label className="ui-label" htmlFor={nameId}>
            {t("categories.name")}
          </label>
          <input
            id={nameId}
            className="ui-input"
            dir="auto"
            autoComplete="off"
            maxLength={CATEGORY_NAME_MAX * 2}
            value={name}
            aria-invalid={error ? true : undefined}
            aria-describedby={hintId}
            onChange={(event) => setName(event.target.value)}
          />
          <p id={hintId} className="ui-hint">
            {t("categories.nameRule", { max: CATEGORY_NAME_MAX })}
          </p>
        </div>
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Dialog>
  )
}
