import { randomBytes } from "node:crypto"
import { createServer, type Server, type Socket } from "node:net"
import { generate } from "selfsigned"
import { SMTPServer, type SMTPServerAddress, type SMTPServerSession } from "smtp-server"
import { trustCertificate } from "./graph.ts"

// A stand-in SMTP server for the integration tests, the stack check, and the screenshots (plan 3.1): smtp-server, as it
// documents itself, with TLS from a certificate made for this stand-in (a subject of its own, trusted in this process
// only through Node's tls.setDefaultCACertificates) and a user and password generated for the run, the only ones it
// accepts. Nothing real is ever sent: it keeps what it received in memory.
//
// What it does with a recipient follows the recipient's local part, so one stand-in plays every outcome:
// - `refuse...`: RCPT TO answers 550; `defer...`: RCPT TO answers 451.
// - `drop...`: the message's data is read and kept, then the connection is cut before the final reply.
// - `reject...`: the final reply after the data is 554; `tempfail...`: 451.
// - `stall...`: the message's data is read and kept, and the final reply never comes; the connection stays open.
// Any other recipient is accepted, and the final reply is `250 OK id=<queue id>`, as SMTP2GO answers.

export interface ReceivedMessage {
  from: string
  to: string[]
  raw: Buffer
  queueId: string
  /** The connection was cut before the final reply. */
  dropped: boolean
}

export interface StandInSmtp {
  host: string
  port: number
  user: string
  password: string
  /** TLS from the first byte (else STARTTLS). */
  secure: boolean
  received: ReceivedMessage[]
  /** How many connections reached it. */
  connections(): number
  close(): Promise<void>
}

export interface StandInSmtpOptions {
  /** TLS from the first byte instead of STARTTLS. */
  secure?: boolean
  /** Speak no TLS at all: STARTTLS is neither offered nor accepted (a client that requires TLS must give up). */
  noTls?: boolean
  /** Accept every recipient and every message, whatever its local part (a failover that takes what the first refused). */
  acceptAll?: boolean
  /** Listen on this address (default 127.0.0.1). */
  host?: string
  /** Trust the certificate in this process (default true). */
  trust?: boolean
}

/** A certificate for one stand-in, with a subject of its own (two stand-ins with one subject would be confused). */
export async function standInCertificate(names: string[] = ["localhost"]) {
  return generate([{ name: "commonName", value: `maane-smtp-stand-in-${randomBytes(8).toString("hex")}` }], {
    keyType: "ec",
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      {
        name: "subjectAltName",
        altNames: [...names.map((value) => ({ type: 2 as const, value })), { type: 7 as const, ip: "127.0.0.1" }],
      },
    ],
  })
}

const localOf = (address: string) => address.slice(0, address.lastIndexOf("@")).toLowerCase()
const refusal = (message: string, responseCode: number) => Object.assign(new Error(message), { responseCode })

export async function startStandInSmtp(options: StandInSmtpOptions = {}): Promise<StandInSmtp> {
  const host = options.host ?? "127.0.0.1"
  const pems = await standInCertificate(host === "127.0.0.1" ? ["localhost"] : [host, "localhost"])
  if (options.trust !== false) trustCertificate(pems.cert)
  const user = `maane-${randomBytes(4).toString("hex")}`
  const password = randomBytes(24).toString("base64url")
  const received: ReceivedMessage[] = []
  const sockets = new Map<number, Socket>()
  let connections = 0

  const server = new SMTPServer({
    secure: options.secure === true,
    key: pems.private,
    cert: pems.cert,
    hideSTARTTLS: options.noTls === true,
    disabledCommands: options.noTls ? ["STARTTLS"] : [],
    authMethods: ["PLAIN", "LOGIN"],
    allowInsecureAuth: false,
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.username === user && auth.password === password) return callback(null, { user })
      return callback(refusal("5.7.8 Authentication failed", 535))
    },
    onRcptTo(address: SMTPServerAddress, _session, callback) {
      if (options.acceptAll) return callback()
      const local = localOf(address.address)
      if (local.startsWith("refuse")) return callback(refusal("5.1.1 No such user here", 550))
      if (local.startsWith("defer")) return callback(refusal("4.2.0 Try again later", 451))
      return callback()
    },
    onData(stream, session: SMTPServerSession, callback) {
      const chunks: Buffer[] = []
      stream.on("data", (chunk: Buffer) => chunks.push(chunk))
      stream.on("end", () => {
        const to = session.envelope.rcptTo.map((entry) => entry.address.toLowerCase())
        const locals = options.acceptAll ? [] : to.map(localOf)
        const queueId = randomBytes(8).toString("hex")
        const dropped = locals.some((local) => local.startsWith("drop"))
        const from = session.envelope.mailFrom ? session.envelope.mailFrom.address.toLowerCase() : ""
        received.push({ from, to, raw: Buffer.concat(chunks), queueId, dropped })
        if (locals.some((local) => local.startsWith("stall"))) return
        if (dropped) {
          // Stored, then the connection is cut before the final reply: the client cannot know.
          sockets.get(session.remotePort)?.destroy()
          return
        }
        if (locals.some((local) => local.startsWith("reject"))) return callback(refusal("5.7.1 Message refused", 554))
        if (locals.some((local) => local.startsWith("tempfail"))) return callback(refusal("4.3.0 Try again", 451))
        return callback(null, `OK id=${queueId}`)
      })
    },
  })
  server.server.on("connection", (socket: Socket) => {
    connections++
    if (socket.remotePort !== undefined) sockets.set(socket.remotePort, socket)
    socket.on("close", () => {
      if (socket.remotePort !== undefined) sockets.delete(socket.remotePort)
    })
  })
  server.on("error", () => {})
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()))
  const address = server.server.address()
  if (address === null || typeof address === "string") throw new Error("the stand-in SMTP server has no port")
  return {
    host,
    port: address.port,
    user,
    password,
    secure: options.secure === true,
    received,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets.values()) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/** A server that accepts connections and never says a word: the client's own deadlines must end the attempt. */
export async function startSilentServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the silent server has no port")
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
