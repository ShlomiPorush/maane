// The pages in the navigation, in one list for the sidebar, the rail and the phone tab bar. Admin pages show only
// to admins; an agent who opens one by its address sees a locked page that says why (pages/AdminOnly.tsx).

import { Building2, History, Inbox, type LucideIcon, Settings, Users } from "lucide-react"

export type NavPage = {
  id: "home" | "organizations" | "users" | "settings" | "audit"
  to: string
  icon: LucideIcon
  /** Only for the admin role. */
  admin: boolean
}

export const NAV: readonly NavPage[] = [
  { id: "home", to: "/", icon: Inbox, admin: false },
  { id: "organizations", to: "/organizations", icon: Building2, admin: true },
  { id: "users", to: "/users", icon: Users, admin: true },
  { id: "settings", to: "/settings", icon: Settings, admin: true },
  { id: "audit", to: "/audit", icon: History, admin: true },
]

/** The Account page: outside the navigation, opened from the account menu. */
export const ACCOUNT_PATH = "/account"

/** The pages a role sees in the navigation. */
export function navFor(role: string | undefined): readonly NavPage[] {
  return NAV.filter((page) => !page.admin || role === "admin")
}

/** The navigation item that a path belongs to. */
export function navPageFor(pathname: string): NavPage | null {
  if (pathname === "/") return NAV[0] ?? null
  return NAV.find((page) => page.to !== "/" && (pathname === page.to || pathname.startsWith(`${page.to}/`))) ?? null
}
