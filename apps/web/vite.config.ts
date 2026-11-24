import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const require = createRequire(import.meta.url)

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

const PDF_DECODERS = "pdfjs/"
const DECODER_FILES = [
  "jbig2_nowasm_fallback.js",
  "openjpeg_nowasm_fallback.js",
  "LICENSE_JBIG2",
  "LICENSE_PDFJS_JBIG2",
  "LICENSE_OPENJPEG",
  "LICENSE_PDFJS_OPENJPEG",
]

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
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8090" },
  },
  preview: { host: "127.0.0.1", port: 4173 },
})
