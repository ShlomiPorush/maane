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

/**
 * pdf.js's own image decoders for JBIG2 and CCITT (scans, faxes) and JPEG 2000, in their JavaScript form (the files
 * pdfjs-dist ships for use without WebAssembly), served from Maane's origin under PDF_DECODERS, the documented
 * `wasmUrl` of the preview (src/pages/tickets/pdf.ts). With them the UI's policy needs no 'wasm-unsafe-eval'.
 */
const PDF_DECODERS = "pdfjs/"
const DECODER_FILES = [
  "jbig2_nowasm_fallback.js",
  "openjpeg_nowasm_fallback.js",
  "LICENSE_JBIG2",
  "LICENSE_PDFJS_JBIG2",
  "LICENSE_OPENJPEG",
  "LICENSE_PDFJS_OPENJPEG",
]

/**
 * The same files in the build (emitted beside the bundle) and in the dev server (Vite's documented configureServer
 * middleware, which answers only these names and leaves every other path to Vite).
 */
function pdfDecoders(): Plugin {
  const dir = join(dirname(require.resolve("pdfjs-dist/package.json")), "wasm")
  return {
    name: "maane-pdf-decoders",
    configureServer(server) {
      server.middlewares.use(`/${PDF_DECODERS}`, (request, response, next) => {
        const name = (request.url ?? "").split("?")[0]?.replace(/^\//, "") ?? ""
        if (!DECODER_FILES.includes(name)) return next()
        response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "text/plain; charset=utf-8")
        response.setHeader("X-Content-Type-Options", "nosniff")
        response.end(readFileSync(join(dir, name)))
      })
    },
    generateBundle() {
      for (const file of DECODER_FILES) {
        this.emitFile({ type: "asset", fileName: `${PDF_DECODERS}${file}`, source: readFileSync(join(dir, file)) })
      }
    },
  }
}

export default defineConfig({
  root: here("."),
  publicDir: here("public"),
  envDir: false,
  plugins: [react(), fontLicences(), pdfDecoders()],
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
