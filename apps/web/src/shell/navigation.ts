import { Building2, DatabaseZap, History, Inbox, type LucideIcon, Mails, Settings, Tags, Users } from "lucide-react"

export type NavPage = {
  id: "home" | "intake" | "organizations" | "categories" | "import" | "users" | "settings" | "audit"
  to: string
  icon: LucideIcon
  admin: boolean
}

export const NAV: readonly NavPage[] = [
  { id: "home", to: "/", icon: Inbox, admin: false },
  { id: "intake", to: "/intake", icon: Mails, admin: true },
  { id: "organizations", to: "/organizations", icon: Building2, admin: true },
  { id: "categories", to: "/categories", icon: Tags, admin: true },
  { id: "import", to: "/import", icon: DatabaseZap, admin: true },
  { id: "users", to: "/users", icon: Users, admin: true },
  { id: "settings", to: "/settings", icon: Settings, admin: true },
  { id: "audit", to: "/audit", icon: History, admin: true },
]

export const ACCOUNT_PATH = "/account"

export function navFor(role: string | undefined): readonly NavPage[] {
  return NAV.filter((page) => !page.admin || role === "admin")
}

export function navPageFor(pathname: string): NavPage | null {
  if (pathname === "/" || pathname.startsWith("/tickets/")) return NAV[0] ?? null
  return NAV.find((page) => page.to !== "/" && (pathname === page.to || pathname.startsWith(`${page.to}/`))) ?? null
}
