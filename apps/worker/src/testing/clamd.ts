import { createServer, type Server, type Socket } from "node:net"
import { ENCRYPTED_PDF, ENCRYPTED_ZIP } from "../files/samples.ts"

export const MARKERS = {
  infected: "MAANE-TEST-INFECTED",
  limits: "MAANE-TEST-LIMITS",
  stall: "MAANE-TEST-STALL",
  error: "MAANE-TEST-ERROR",
} as const

export interface StandInOptions {
  noEncryptedAlerts?: boolean
  noSignatures?: boolean
  alertsOnEverything?: boolean
  peer?: "silent" | "halfClose" | "noRead" | "trickle" | "flood" | "padded" | "paddedSplit"
  streamMaxLength?: number
}

export interface StandInClamd {
  address: string
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
        if (text !== null) reply(text)
        return
      }
      if (buffer.length < 4 + length) return
      total += length
      if (state.options.streamMaxLength !== undefined && total > state.options.streamMaxLength) {
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

export async function refusedAddress(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `127.0.0.1:${port}`
}
