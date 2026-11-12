import { createServer, type Server, type Socket } from "node:net"
import { ENCRYPTED_PDF, ENCRYPTED_ZIP } from "../files/samples.ts"

// A stand-in clamd for unit and integration tests: a small TCP server with deterministic answers, speaking the part of
// clamd's protocol Maane's client uses (PING, VERSION, and zINSTREAM with length-prefixed chunks), and peers that
// misbehave on the connection itself. Tests never
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
  /**
   * A peer that misbehaves on every connection: `silent` reads everything, never answers, and never closes, also
   * after the client stops writing (the case the clamscan package could not bound); `halfClose` reads everything and ends its
   * side without an answer; `noRead` accepts and never reads; `trickle` sends a byte every 50 ms and never ends the
   * reply; `flood` answers with a reply far longer than clamd ever gives; `padded` answers `stream: OK` after 4 KiB of
   * spaces, in one write; `paddedSplit` sends the same reply in two writes, the second crossing the limit.
   */
  peer?: "silent" | "halfClose" | "noRead" | "trickle" | "flood" | "padded" | "paddedSplit"
  /** Refuses a stream longer than this many bytes, as clamd does past StreamMaxLength. */
  streamMaxLength?: number
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
    // EICAR anywhere in the stream, as a signature without an offset finds it: intake scans text fields in which
    // a sender may have put it after other text (plan 2.3, review G1).
    (text.includes(MARKERS.infected) || (text.includes(EICAR_START) && text.includes(EICAR_END)))
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
  let total = 0
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
      } else {
        // A z command gets a NUL-terminated reply, an n command a line (man clamd).
        const end = head.startsWith("z") ? "\0" : "\n"
        if (/^[zn]?PING/.test(head)) return reply("PONG", end)
        if (/^[zn]?VERSION/.test(head)) return reply("ClamAV 1.5.4/0/stand-in", end)
        if (head.length >= 10) return reply("UNKNOWN COMMAND", end)
        return
      }
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
      total += length
      if (state.options.streamMaxLength !== undefined && total > state.options.streamMaxLength) {
        // As clamd: the error at once, then the connection closes while the client may still be writing.
        socket.removeAllListeners("data")
        socket.resume()
        reply("INSTREAM size limit exceeded. ERROR")
        return
      }
      chunks.push(buffer.subarray(4, 4 + length))
      buffer = buffer.subarray(4 + length)
    }
  })
}

/** Starts a stand-in clamd on a free port of 127.0.0.1. */
export async function startStandInClamd(options: StandInOptions = {}): Promise<StandInClamd> {
  const sockets = new Set<Socket>()
  const state: StandInClamd = { address: "", scanned: [], options, close: async () => {} }
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    switch (options.peer) {
      case "silent":
        socket.on("data", () => {})
        return
      case "halfClose":
        socket.on("data", () => socket.end())
        return
      case "noRead":
        socket.pause()
        return
      case "trickle": {
        const timer = setInterval(() => socket.write("s"), 50)
        socket.on("close", () => clearInterval(timer))
        socket.on("data", () => {})
        return
      }
      case "flood":
        socket.once("data", () => socket.write(Buffer.alloc(16 * 1024, 0x61)))
        return
      case "padded":
      case "paddedSplit": {
        const reply = Buffer.concat([Buffer.alloc(4096, 0x20), Buffer.from("stream: OK\0")])
        socket.once("data", () => {
          if (options.peer === "padded") socket.write(reply)
          else {
            socket.write(reply.subarray(0, 4000))
            setTimeout(() => socket.write(reply.subarray(4000)), 20)
          }
        })
        return
      }
      default:
        // A client that ends its side before an answer gets its side ended too, as clamd closes after answering.
        socket.on("end", () => socket.end())
        serve(socket, state)
    }
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
