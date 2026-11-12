// The web UI entry: fonts and the one stylesheet, the query client, the router. Fonts are bundled files (the
// Content Security Policy allows fonts only from Maane's own origin).

import "@fontsource-variable/onest/wght.css"
import "@fontsource-variable/noto-sans-hebrew/wght.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "@fontsource/ibm-plex-mono/600.css"
import "@fontsource/ibm-plex-mono/700.css"
import "./styles/ui.css"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "react-router/dom"
import { ApiError } from "./api/client.ts"
import { I18nProvider } from "./i18n/i18n.tsx"
import { createRouter } from "./routes.tsx"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // One more try for a network hiccup; never for an answer that will not change.
      retry: (failures, error) =>
        failures < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      staleTime: 10_000,
    },
  },
})

const router = createRouter()
const root = document.getElementById("root")
if (!root) throw new Error("index.html has no #root")

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
)
