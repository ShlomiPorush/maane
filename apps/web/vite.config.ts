import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

// The web UI. The build goes to apps/web/dist, which the server serves. The server's Content Security Policy allows
// only files from its own origin: no inline script or style, fonts as files (never data: URLs).

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const require = createRequire(import.meta.url)

/** The SIL Open Font License of each bundled font, shipped next to the font files. */
const FONT_LICENCES: Record<string, string> = {
  onest: "@fontsource-variable/onest/package.json",
  "noto-sans-hebrew": "@fontsource-variable/noto-sans-hebrew/package.json",
  "ibm-plex-mono": "@fontsource/ibm-plex-mono/package.json",
}

function fontLicences(): Plugin {
  return {
    name: "maane-font-licences",
    apply: "build",
    generateBundle() {
      for (const [name, manifest] of Object.entries(FONT_LICENCES)) {
        this.emitFile({
          type: "asset",
          fileName: `assets/${name}-LICENSE.txt`,
          source: readFileSync(join(dirname(require.resolve(manifest)), "LICENSE"), "utf8"),
        })
      }
    },
  }
}

export default defineConfig({
  root: here("."),
  publicDir: here("public"),
  envDir: false,
  plugins: [react(), fontLicences()],
  build: {
    outDir: here("dist"),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    // Fonts and images are always files: a data: font would break the policy's font-src 'self'.
    assetsInlineLimit: 0,
    // One bundle: React, the router, TanStack Query and Better Auth's client are most of it.
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Development talks to a server on the local stack.
    proxy: { "/api": "http://127.0.0.1:8090" },
  },
  preview: { host: "127.0.0.1", port: 4173 },
})
