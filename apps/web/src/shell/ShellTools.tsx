// The shell's own tools (v3 NL-7, NL-9; after Mikud's shell): the toggle that folds the sidebar, the theme button,
// the language button, and the account menu with the theme, the language, the Account page and sign-out. The theme
// and the language are this browser's own choices.

import { LOCALES } from "@maane/shared"
import {
  Languages,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Sun,
  UserRound,
} from "lucide-react"
import { useRef, useState } from "react"
import { type Language, translate, useI18n } from "../i18n/i18n.tsx"
import { Menu } from "../ui/Menu.tsx"
import { isMac } from "./navFold.ts"
import { ACCOUNT_PATH } from "./navigation.ts"
import { useMe } from "./session.ts"
import { useSignOut } from "./signOut.ts"
import { THEMES, type Theme, useTheme } from "./theme.ts"

/** The order the theme button walks through: the system's, then light, then dark. */
export const THEME_CYCLE: readonly Theme[] = ["system", "light", "dark"]
export const nextTheme = (theme: Theme): Theme =>
  THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length] ?? "system"

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const

/** A language's name in that language (its own locale file), so a reader of the other one still finds it. */
export const nativeName = (language: Language): string => translate(language, "language.self")

export function NavToggle({ folded, toggle }: { folded: boolean; toggle: () => void }) {
  const { t } = useI18n()
  const label = folded ? t("shell.expandMenu") : t("shell.collapseMenu")
  return (
    <button
      type="button"
      className="ui-icon-btn ui-nav-toggle"
      aria-label={label}
      aria-expanded={!folded}
      aria-keyshortcuts={isMac() ? "Meta+B" : "Control+B"}
      title={`${label} (${isMac() ? "Cmd+B" : "Ctrl+B"})`}
      onClick={toggle}
    >
      {folded ? (
        <PanelLeftOpen className="ui-flip-rtl" aria-hidden="true" />
      ) : (
        <PanelLeftClose className="ui-flip-rtl" aria-hidden="true" />
      )}
    </button>
  )
}

/** Walks through the system's theme, light and dark; the name says the current one and the next. */
export function ThemeButton() {
  const { t } = useI18n()
  const [theme, setTheme] = useTheme()
  const next = nextTheme(theme)
  const Icon = THEME_ICON[theme]
  const label = t("shell.themeButton", { theme: t(`theme.${theme}`), next: t(`theme.${next}`) })
  return (
    <button
      type="button"
      className="ui-icon-btn"
      aria-label={label}
      title={label}
      data-theme-button=""
      onClick={() => setTheme(next)}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}

/** Switches to the other language; its name is written in that language. */
export function LanguageButton() {
  const { t, language, setLanguage } = useI18n()
  const other: Language = language === "he" ? "en" : "he"
  const label = t("shell.languageButton", { language: nativeName(other) })
  return (
    <button
      type="button"
      className="ui-icon-btn"
      aria-label={label}
      title={label}
      data-language-button=""
      onClick={() => setLanguage(other)}
    >
      <Languages aria-hidden="true" />
    </button>
  )
}

/** The account: its name, the theme, the language, the Account page and Sign out (unsaved changes asked first). */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { t, language, setLanguage } = useI18n()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const me = useMe()
  const name = me.data?.username ?? ""
  const [theme, setTheme] = useTheme()
  const signOut = useSignOut()
  const menuName = t("shell.accountMenu")
  return (
    <>
      <button
        ref={button}
        type="button"
        className={compact ? "ui-account-btn is-compact" : "ui-account-btn"}
        // The name holds the words it shows, so a voice command that says them reaches it.
        aria-label={[name, menuName].filter(Boolean).join(", ")}
        title={menuName}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ui-avatar" aria-hidden="true">
          {name.slice(0, 2).toUpperCase()}
        </span>
        {compact ? null : (
          <span className="ui-account-text" aria-hidden="true">
            <bdi className="ui-account-name">{name}</bdi>
            <span className="ui-account-sub">{me.data ? t(`role.${me.data.role}`) : ""}</span>
          </span>
        )}
      </button>
      {open ? (
        <Menu
          anchor={button}
          label={menuName}
          side={compact ? "bottom" : "top"}
          align={compact ? "end" : "start"}
          onClose={() => setOpen(false)}
          entries={[
            {
              kind: "header",
              content: (
                <>
                  <bdi className="ui-account-head-name">{name}</bdi>
                  <span className="ui-account-head-sub">
                    <ShieldCheck aria-hidden="true" />
                    {t("shell.twoFactorOn")}
                  </span>
                </>
              ),
            },
            { kind: "separator" },
            {
              kind: "radios",
              label: t("shell.theme"),
              options: THEMES.map((option) => {
                const Icon = THEME_ICON[option]
                return {
                  label: t(`theme.${option}`),
                  icon: <Icon aria-hidden="true" />,
                  checked: theme === option,
                  onSelect: () => setTheme(option),
                }
              }),
            },
            {
              kind: "radios",
              label: t("shell.language"),
              options: LOCALES.map((option) => ({
                label: nativeName(option),
                lang: option,
                checked: language === option,
                onSelect: () => setLanguage(option),
              })),
            },
            { kind: "separator" },
            { kind: "link", label: t("account.title"), icon: <UserRound aria-hidden="true" />, to: ACCOUNT_PATH },
            {
              kind: "item",
              label: t("account.signOut"),
              icon: <LogOut aria-hidden="true" />,
              onSelect: () => void signOut(),
            },
          ]}
        />
      ) : null}
    </>
  )
}
