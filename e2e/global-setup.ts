import { randomBytes } from "node:crypto"
import { connect, createServer } from "node:net"
import { resetState, saveState } from "./state.ts"

/**
 * Forgets the shared state of an earlier run, makes a password for the first admin of this run, and, with E2E_TARGET
 * (host:port, set by scripts/verify.sh for its throwaway stack), forwards 127.0.0.1:8095 to the server, so pages load
 * from the stack's public URL and every request carries its Origin.
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  resetState()
  const target = process.env.E2E_TARGET
  if (!target) throw new Error("E2E_TARGET is not set: the end-to-end tests run only from scripts/verify.sh")
  saveState({ password: randomBytes(18).toString("base64url") })
  const [host = "server", port = "8080"] = target.split(":")
  const server = createServer((socket) => {
    const upstream = connect(Number(port), host)
    socket.pipe(upstream).pipe(socket)
    const close = () => {
      socket.destroy()
      upstream.destroy()
    }
    socket.on("error", close)
    upstream.on("error", close)
  })
  await new Promise<void>((resolve) => server.listen(8095, "127.0.0.1", resolve))
  return () => new Promise<void>((resolve) => server.close(() => resolve()))
}
