// Every page and its address. guards.test.ts reads PAGES and fails on a page module that registers no refresh of its
// own (v3 SV-10), unless it is listed there with its reason.

import type { ComponentType } from "react"
import { createBrowserRouter, type RouteObject } from "react-router"
import { AccountPage } from "./pages/AccountPage.tsx"
import { AuditPage } from "./pages/AuditPage.tsx"
import { EnrollPage } from "./pages/auth/EnrollPage.tsx"
import { LoginPage } from "./pages/auth/LoginPage.tsx"
import { SetupPage } from "./pages/auth/SetupPage.tsx"
import { HomePage } from "./pages/HomePage.tsx"
import { NotFoundPage } from "./pages/NotFoundPage.tsx"
import { SettingsPage } from "./pages/SettingsPage.tsx"
import { UsersPage } from "./pages/UsersPage.tsx"
import { Root } from "./shell/Root.tsx"
import { Shell } from "./shell/Shell.tsx"

type PageRoute = { id: string; path: string; Component: ComponentType }

/** The pages inside the shell: they need a full session (two-factor on). */
export const PAGES: readonly PageRoute[] = [
  { id: "home", path: "/", Component: HomePage },
  { id: "users", path: "/users", Component: UsersPage },
  { id: "settings", path: "/settings", Component: SettingsPage },
  { id: "audit", path: "/audit", Component: AuditPage },
  { id: "account", path: "/account", Component: AccountPage },
  { id: "not-found", path: "*", Component: NotFoundPage },
]

export const ROUTES: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/setup", element: <SetupPage /> },
      { path: "/enroll", element: <EnrollPage /> },
      {
        element: <Shell />,
        children: PAGES.map(({ path, Component }) => ({ path, element: <Component /> })),
      },
    ],
  },
]

export function createRouter() {
  return createBrowserRouter(ROUTES)
}
