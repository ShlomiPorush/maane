import { connect, type Socket } from "node:net"

// Maane's clamd client: the part of clamd's protocol that `man clamd` documents and Maane needs, over node:net. Owner's
// decision, 2026-11-12: it replaces the clamscan package, whose timeout is an idle timeout only: against a peer that
// keeps a half-closed connection open without answering, a clamscan scan never settled, and pg-boss's job expiry does
// not free the worker that awaits it. Every operation here has a hard deadline that destroys the socket and rejects,
// plus a connect timeout and a bounded reply. It never logs, and never puts content into an error.
//
// Commands use the `z` form: the command and every reply end with a NUL byte. INSTREAM sends the content as chunks,
// each prefixed by its length as 4 bytes in network order, and a zero length ends the stream. The reply is
// `stream: OK`, `stream: <signature> FOUND`, or `<message> ERROR` (`INSTREAM size limit exceeded. ERROR` for a stream
// longer than clamd's StreamMaxLength). clamd closes the connection after it answers.

/** Why an exchange gave no answer. Never holds content. */
export type ClamdFailure =
  | "connect_timeout"
  | "deadline"
  | "refused"
  | "connection"
  | "closed"
  | "reply_too_long"
  | "size_limit"
  | "error_reply"
  | "bad_reply"

export class ClamdError extends Error {
  override name = "ClamdError"
  constructor(readonly code: ClamdFailure) {
    super(`clamd: ${code}`)
  }
}

export interface ClamdTarget {
  host: string
  port: number
}

export interface ExchangeLimits {
  /** The whole operation, from connect to the last byte of the reply. */
  deadlineMs: number
  /** Connecting alone. */
  connectTimeoutMs?: number
}

/** A reply longer than this is not clamd's: a signature name and its frame fit easily. */
export const MAX_REPLY_BYTES = 4096
export const CONNECT_TIMEOUT_MS = 5_000
/** The size of each INSTREAM chunk. */
const CHUNK_BYTES = 64 * 1024

/**
 * One exchange: connect, send what `send` writes, read one NUL-terminated reply. Settles exactly once, always with
 * the socket destroyed: with the reply's text, or with a ClamdError when the deadline passes, connecting takes too
 * long, the connection fails or closes before a full reply, or the reply grows past MAX_REPLY_BYTES.
 */
function exchange(
  target: ClamdTarget,
  limits: ExchangeLimits,
  send: (socket: Socket, finished: () => boolean) => Promise<void>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let received = Buffer.alloc(0)
    const socket = connect({ host: target.host, port: target.port })
    const finish = (error: ClamdError | null, reply = "") => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(connecting)
      socket.destroy()
      if (error) reject(error)
      else resolve(reply)
    }
    const deadline = setTimeout(() => finish(new ClamdError("deadline")), limits.deadlineMs)
    const connecting = setTimeout(
      () => finish(new ClamdError("connect_timeout")),
      limits.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    )
    socket.on("connect", () => {
      clearTimeout(connecting)
      send(socket, () => settled).catch(() => {
        // A write that fails ends the exchange, unless clamd's reply (such as the size limit error) came first.
        if (!settled) finish(new ClamdError("connection"))
      })
    })
    socket.on("data", (data: Buffer) => {
      received = Buffer.concat([received, data])
      const end = received.indexOf(0)
      // The limit applies to the reply itself, also when its terminator has arrived: a padded reply is never read.
      if ((end >= 0 ? end : received.length) > MAX_REPLY_BYTES) finish(new ClamdError("reply_too_long"))
      else if (end >= 0) finish(null, received.subarray(0, end).toString("utf8").trim())
    })
    socket.on("end", () => finish(new ClamdError("closed")))
    socket.on("close", () => finish(new ClamdError("closed")))
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(new ClamdError(error.code === "ECONNREFUSED" ? "refused" : "connection")),
    )
  })
}

/** Writes and waits while the socket's buffer is full, so a peer that does not read holds us only until the deadline. */
async function write(socket: Socket, data: Uint8Array, finished: () => boolean): Promise<void> {
  if (finished()) throw new Error("finished")
  if (socket.write(data)) return
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      socket.off("drain", done)
      socket.off("close", closed)
      resolve()
    }
    const closed = () => {
      socket.off("drain", done)
      reject(new Error("closed"))
    }
    socket.once("drain", done)
    socket.once("close", closed)
  })
}

const length = (n: number) => {
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(n, 0)
  return prefix
}

/** A reply to INSTREAM. */
export type ScanReply = { found: string | null }

/**
 * Scans content through zINSTREAM. Resolves with the signature clamd found, or null for `stream: OK`; rejects with a
 * ClamdError for anything else, `size_limit` for clamd's StreamMaxLength refusal and `error_reply` for another ERROR.
 */
export async function scanStream(target: ClamdTarget, bytes: Uint8Array, limits: ExchangeLimits): Promise<ScanReply> {
  const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const reply = await exchange(target, limits, async (socket, finished) => {
    await write(socket, Buffer.from("zINSTREAM\0", "latin1"), finished)
    for (let offset = 0; offset < content.length; offset += CHUNK_BYTES) {
      const chunk = content.subarray(offset, offset + CHUNK_BYTES)
      await write(socket, length(chunk.length), finished)
      await write(socket, chunk, finished)
    }
    await write(socket, length(0), finished)
  })
  if (/ ERROR$/.test(reply)) throw new ClamdError(/size limit exceeded/i.test(reply) ? "size_limit" : "error_reply")
  const found = /^stream: (.+) FOUND$/.exec(reply)
  if (found?.[1]?.trim()) return { found: found[1].trim() }
  if (reply === "stream: OK") return { found: null }
  throw new ClamdError("bad_reply")
}

/** zPING: resolves when clamd answers PONG. */
export async function ping(target: ClamdTarget, limits: ExchangeLimits): Promise<void> {
  const reply = await exchange(target, limits, (socket, finished) =>
    write(socket, Buffer.from("zPING\0", "latin1"), finished),
  )
  if (reply !== "PONG") throw new ClamdError("bad_reply")
}

/** zVERSION: clamd's version line, such as `ClamAV 1.5.4/28181/<date of the signatures>`. */
export async function version(target: ClamdTarget, limits: ExchangeLimits): Promise<string> {
  const reply = await exchange(target, limits, (socket, finished) =>
    write(socket, Buffer.from("zVERSION\0", "latin1"), finished),
  )
  if (!/^ClamAV \S/.test(reply)) throw new ClamdError("bad_reply")
  return reply.slice(0, 200)
}
