// Small, valid files for tests, built at run time so no binary sample is tracked: a PNG (an image the browser decodes)
// and a one-page PDF (pdf.js renders it). The worker's stack checks import them too (@maane/server/testing/files).

import { crc32, deflateSync } from "node:zlib"

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

/** A PNG of `width` by `height` pixels in one RGB colour, with a darker frame so a preview shows its edges. */
export function png(width = 48, height = 32, rgb: [number, number, number] = [31, 95, 191]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(2, 9) // colour type: RGB
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2
      const [r, g, b] = edge ? rgb.map((value) => Math.floor(value / 2)) : rgb
      row.writeUInt8(r ?? 0, 1 + x * 3)
      row.writeUInt8(g ?? 0, 2 + x * 3)
      row.writeUInt8(b ?? 0, 3 + x * 3)
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** A one-page PDF (A6) that shows one line of ASCII text in Helvetica, with a correct cross-reference table. */
export function pdf(text = "Maane preview"): Buffer {
  const safe = text.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (char) => `\\${char}`)
  const stream = `BT /F1 18 Tf 24 330 Td (${safe}) Tj ET\n0 0 1 RG 4 w 12 12 273 395 re S\n`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 297 420] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"))
    out += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, "latin1")
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}
