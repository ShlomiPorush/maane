/** The streams a hidden prompt needs: a terminal to read from and somewhere to write the question. */
export interface PromptInput extends NodeJS.EventEmitter {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
  setEncoding(encoding: BufferEncoding): unknown
  resume(): unknown
  pause(): unknown
}

const ENTER = ["\r", "\n"]
const CTRL_C = String.fromCharCode(3)
const CTRL_D = String.fromCharCode(4)
const BACKSPACE = [String.fromCharCode(8), String.fromCharCode(127)]

/**
 * Reads a secret from the terminal without echoing it. Refuses anything but a terminal, so the token is never
 * piped in from a file, a here-string or another program's output. The value stays in memory only.
 */
export function readHidden(
  question: string,
  input: PromptInput,
  output: { write(text: string): unknown },
): Promise<string> {
  if (!input.isTTY || !input.setRawMode) {
    return Promise.reject(new Error("the API token is read from a terminal only. Run the command in a terminal."))
  }
  const setRawMode = input.setRawMode.bind(input)
  output.write(question)
  setRawMode(true)
  input.setEncoding("utf8")
  input.resume()
  return new Promise((resolve, reject) => {
    let value = ""
    const finish = () => {
      input.off("data", onData)
      setRawMode(false)
      input.pause()
      output.write("\n")
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ENTER.includes(ch)) {
          finish()
          resolve(value)
          return
        }
        if (ch === CTRL_C || ch === CTRL_D) {
          finish()
          reject(new Error("cancelled"))
          return
        }
        if (BACKSPACE.includes(ch)) value = value.slice(0, -1)
        else if (ch >= " ") value += ch
      }
    }
    input.on("data", onData)
  })
}
