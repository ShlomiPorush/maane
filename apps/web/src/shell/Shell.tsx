// The app frame, after Mikud's shell (v3 NL-1, NL-6, NL-7, NL-9). From 761px a top bar runs across: the brand over
// the sidebar's column, then in the page's card the fold toggle (above 1100px), the trail with the page title, and
// the page's own actions. Above 1100px a 240px sidebar on the grey canvas that folds into the 72px icon rail,
// remembered in this browser; from 761 to 1100px always the rail. The sidebar foot holds the account menu, the
// language and the theme buttons. Up to 760px a slim top bar with the account menu, and a bottom tab bar with every
// page of the navigation (at most four, so no More sheet).

import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { Link, NavLink, Outlet } from "react-router"
import { useI18n } from "../i18n/i18n.tsx"
import { ChromeContext } from "./chrome.tsx"
import { useNavFolded } from "./navFold.ts"
import { navFor } from "./navigation.ts"
import { PageMetaProvider, useCurrentMeta } from "./pageMeta.tsx"
import { AccountMenu, LanguageButton, NavToggle, ThemeButton } from "./ShellTools.tsx"
import { useMe } from "./session.ts"

export function Shell() {
  return (
    <PageMetaProvider>
      <ShellFrame />
    </PageMetaProvider>
  )
}

function ShellFrame() {
  const { t } = useI18n()
  const nav = useNavFolded()
  const me = useMe()
  const pages = navFor(me.data?.role)
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null)
  return (
    <ChromeContext.Provider value={{ actionsSlot }}>
      <div className="ui-shell">
        {/* The page's card is drawn behind the bar and the page, so their order for the keyboard stays as is. */}
        <div className="ui-frame" aria-hidden="true" />
        <TopBar nav={nav} setActionsSlot={setActionsSlot} />
        <PhoneTopBar />
        <nav className="ui-sidenav" aria-label={t("nav.main")}>
          <div className="ui-nav">
            {pages.map((page) => (
              <NavLink
                key={page.id}
                to={page.to}
                end={page.to === "/"}
                className="ui-nav-item"
                title={t(`nav.${page.id}`)}
              >
                <page.icon aria-hidden="true" />
                <span className="ui-nav-label">{t(`nav.${page.id}`)}</span>
              </NavLink>
            ))}
          </div>
          <div className="ui-side-foot">
            <div className="ui-utilities">
              <AccountMenu />
              <LanguageButton />
              <ThemeButton />
            </div>
          </div>
        </nav>
        <main className="ui-content" id="main">
          <Outlet />
        </main>
        <nav className="ui-tabbar" aria-label={t("nav.main")}>
          {pages.map((page) => (
            <NavLink key={page.id} to={page.to} end={page.to === "/"} className="ui-tabbar-item">
              <page.icon aria-hidden="true" />
              <span>{t(`nav.${page.id}`)}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </ChromeContext.Provider>
  )
}

export function BrandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <rect x="3.5" y="6" width="17" height="12" rx="1.5" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  )
}

/** The trail: earlier levels as links, then the page title, which is the page's one h1 from 761px. */
function Trail() {
  const { t } = useI18n()
  const meta = useCurrentMeta()
  return (
    <nav aria-label={t("nav.youAreHere")} className="ui-trail">
      <ol className="ui-crumbs">
        {meta.crumbs.map((crumb) => (
          <li key={`${crumb.label}${crumb.to ?? ""}`}>
            {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
            <ChevronRight className="ui-crumb-sep" aria-hidden="true" />
          </li>
        ))}
        <li className="ui-crumb-current">
          <h1 dir="auto">
            <span aria-current="page">{meta.title}</span>
          </h1>
        </li>
      </ol>
    </nav>
  )
}

function TopBar({
  nav,
  setActionsSlot,
}: {
  nav: ReturnType<typeof useNavFolded>
  setActionsSlot: (element: HTMLDivElement | null) => void
}) {
  const { t } = useI18n()
  return (
    // A subgrid of the shell: the brand above the sidebar's column, the bar above the page's.
    <header className="ui-topbar">
      <div className="ui-topbar-brand">
        <Link to="/" className="ui-bar-brand" aria-label={t("nav.homeLabel")}>
          <span className="ui-brand-mark" aria-hidden="true">
            <BrandIcon />
          </span>
        </Link>
        <span className="ui-bar-brand-text" aria-hidden="true">
          <b>{t("app.name")}</b>
          <span>{t("shell.tagline")}</span>
        </span>
      </div>
      <div className="ui-topbar-main">
        {/* The sidebar folds from the start of the bar, behind a short divider; only above 1100px. */}
        <span className="ui-topbar-fold">
          <NavToggle {...nav} />
          <span className="ui-topbar-divider" aria-hidden="true" />
        </span>
        <Trail />
        {/* The page's own actions come here (PageActions). */}
        <div ref={setActionsSlot} className="ui-topbar-actions" />
      </div>
    </header>
  )
}

/** Phone: a slim top bar with the page name and the account menu (NL-9). */
function PhoneTopBar() {
  const { t } = useI18n()
  const meta = useCurrentMeta()
  return (
    <header className="ui-mtop">
      <Link to="/" className="ui-mtop-home ui-brand-mark" aria-label={t("nav.homeLabel")}>
        <BrandIcon />
      </Link>
      <div className="ui-mtop-titles">
        <span className="ui-mtop-app">{t("app.name")}</span>
        <span className="ui-mtop-page" dir="auto">
          {meta.title}
        </span>
      </div>
      <div className="ui-mtop-end">
        <AccountMenu compact />
      </div>
    </header>
  )
}
