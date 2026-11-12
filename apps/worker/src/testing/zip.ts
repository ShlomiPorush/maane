import { crc32 } from "node:zlib"

// Tiny ZIP archives for the stack check, built at run time so that no binary fixture is tracked: one entry, stored
// without compression (PKWARE APPNOTE, local file header, central directory, end of central directory).

/** A ZIP archive with one stored entry. */
export function storedZip(name: string, content: Buffer): Buffer {
  const fileName = Buffer.from(name, "utf8")
  const crc = crc32(content)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x21, 12) // 1980-01-01
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(content.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(fileName.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x21, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(content.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(fileName.length, 28)
  const centralOffset = local.length + fileName.length + content.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + fileName.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, fileName, content, central, fileName, end])
}

/** Text inside `depth` archives, each inside the next: deeper than clamd's MaxRecursion (17) when depth exceeds it. */
export function nestedZip(depth: number): Buffer {
  let content: Buffer = Buffer.from("Maane stack check: nested archives.\n", "utf8")
  let name = "note.txt"
  for (let level = 1; level <= depth; level++) {
    content = storedZip(name, content)
    name = `level-${level}.zip`
  }
  return content
}
