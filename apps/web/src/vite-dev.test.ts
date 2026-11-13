// @vitest-environment node
// The development server serves pdf.js's decoders as the build does (pdfDecoders in vite.config.ts), and nothing else
// from pdfjs-dist's folder: the PDF preview of `pnpm --filter @maane/web run dev` decodes scans and faxes too.

import { createServer as createHttpServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { createServer, type ViteDevServer } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let vite: ViteDevServer
let http: Server
let base = ""

beforeAll(async () => {
  // Vite's documented middleware mode: its handlers behind a server of the test's own, on a free port.
  vite = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true },
    appType: "spa",
    logLevel: "silent",
  })
  http = createHttpServer(vite.middlewares)
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()))
  await vite.close()
})

describe("the dev server's pdf.js decoders", () => {
  it("serves the JBIG2 and JPEG 2000 decoders and their licences under /pdfjs/", async () => {
    for (const name of ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"]) {
      const answer = await fetch(`${base}/pdfjs/${name}`)
      expect(answer.status, name).toBe(200)
      expect(answer.headers.get("content-type"), name).toBe("text/javascript")
      expect(await answer.text(), name).toMatch(/^\/\* THIS FILE IS GENERATED/)
    }
    const licence = await fetch(`${base}/pdfjs/LICENSE_JBIG2`)
    expect(licence.headers.get("content-type")).toBe("text/plain; charset=utf-8")
  })

  it("serves nothing else of pdfjs-dist's folder", async () => {
    for (const name of ["quickjs-eval.js", "jbig2.wasm", "qcms_bg.wasm"]) {
      const answer = await fetch(`${base}/pdfjs/${name}`)
      expect(answer.headers.get("content-type") ?? "", name).not.toMatch(/javascript|wasm|json/)
    }
  })
})
