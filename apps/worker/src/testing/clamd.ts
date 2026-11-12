import { createServer, type Server, type Socket } from "node:net"
import { ENCRYPTED_PDF, ENCRYPTED_ZIP } from "../files/samples.ts"

// A stand-in clamd for unit and integration tests: a small TCP server with deterministic answers, speaking the part of
// clamd's protocol the clamscan client uses (PING, VERSION, and zINSTREAM with length-prefixed chunks). Tests never
// reach a real scanner; the container stack stage of scripts/verify.sh runs the real ClamAV.

/** Text that makes the stand-in answer an alert or misbehave, when the scanned content contains it. */
export const MARKERS = {
  /** Answers like EICAR (the stand-in also recognizes the real EICAR text). */
  infected: "MAANE-TEST-INFECTED",
  /** Answers like a file beyond a scan limit. */
  limits: "MAANE-TEST-LIMITS",
  /** Never answers; closes when the client ends its side, as a scan that hits the client's timeout. */
  stall: "MAANE-TEST-STALL",
  /** Answers with an error reply, as clamd does for a stream over StreamMaxLength. */
  error: "MAANE-TEST-ERROR",
} as const

export interface StandInOptions {
  /** A scanner without AlertEncryptedArchive and AlertEncryptedDoc: the encrypted samples come back clean. */
  noEncryptedAlerts?: boolean
  /** A scanner without signatures: EICAR comes back clean. */
  noSignatures?: boolean
  /** A scanner that alerts on everything. */
  alertsOnEverything?: boolean
}

export interface StandInClamd {
  /** `127.0.0.1:<port>`, for the scanner.address setting. */
  address: string
  /** Every stream scanned so far, in order. */
  scanned: Buffer[]
  options: StandInOptions
  close(): Promise<void>
}

const EICAR_START = "X5O!P%@AP[4"
const EICAR_END = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"

function answer(content: Buffer, options: StandInOptions): string | null {
  const text = content.toString("latin1")
  if (text.includes(MARKERS.stall)) return null
  if (text.includes(MARKERS.error)) return "INSTREAM size limit exceeded. ERROR"
  if (options.alertsOnEverything) return "stream: Win.Test.StandIn FOUND"
  if (
    !options.noSignatures &&
    (text.includes(MARKERS.infected) || (text.startsWith(EICAR_START) && text.includes(EICAR_END)))
  )
    return "stream: Eicar-Test-Signature FOUND"
  if (text.includes(MARKERS.limits)) return "stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND"
  if (!options.noEncryptedAlerts && content.equals(ENCRYPTED_ZIP)) return "stream: Heuristics.Encrypted.Zip FOUND"
  if (!options.noEncryptedAlerts && content.equals(ENCRYPTED_PDF)) return "stream: Heuristics.Encrypted.PDF FOUND"
  return "stream: OK"
}

function serve(socket: Socket, state: StandInClamd): void {
  let buffer: Buffer = Buffer.alloc(0)
  let streaming = false
  const chunks: Buffer[] = []
  const reply = (text: string, terminator = "\0") => {
    socket.end(`${text}${terminator}`)
  }
  socket.on("error", () => {})
  socket.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data])
    if (!streaming) {
      const head = buffer.toString("latin1")
      if (head.startsWith("zINSTREAM\0")) {
        streaming = true
        buffer = buffer.subarray("zINSTREAM\0".length)
      } else if (/^[zn]?PING/.test(head)) return reply("PONG", "\n")
      else if (/^[zn]?VERSION/.test(head)) return reply("ClamAV 1.5.4/0/stand-in", "\n")
      else if (head.length >= 10) return reply("UNKNOWN COMMAND", "\n")
      else return
    }
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (length === 0) {
        buffer = Buffer.alloc(0)
        const content = Buffer.concat(chunks)
        state.scanned.push(content)
        const text = answer(content, state.options)
        // A stall: no answer; the socket closes when the client ends its side.
        if (text !== null) reply(text)
        return
      }
      if (buffer.length < 4 + length) return
      chunks.push(buffer.subarray(4, 4 + length))
      buffer = buffer.subarray(4 + length)
    }
  })
}

/** Starts a stand-in clamd on a free port of 127.0.0.1. */
export async function startStandInClamd(options: StandInOptions = {}): Promise<StandInClamd> {
  const sockets = new Set<Socket>()
  const state: StandInClamd = { address: "", scanned: [], options, close: async () => {} }
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    serve(socket, state)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  state.address = `127.0.0.1:${port}`
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    })
  return state
}

/** A local address where nothing listens: the connection is refused. */
export async function refusedAddress(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `127.0.0.1:${port}`
}
