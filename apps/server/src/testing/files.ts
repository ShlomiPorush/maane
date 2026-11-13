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

/** A PDF from its objects, numbered from 1 (the first is the catalog), with a correct cross-reference table. */
function pdfFile(objects: (string | Buffer)[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")]
  let length = chunks[0]?.length ?? 0
  const offsets: number[] = []
  const add = (chunk: Buffer) => {
    chunks.push(chunk)
    length += chunk.length
  }
  objects.forEach((object, index) => {
    offsets.push(length)
    add(Buffer.from(`${index + 1} 0 obj\n`, "latin1"))
    add(typeof object === "string" ? Buffer.from(object, "latin1") : object)
    add(Buffer.from("\nendobj\n", "latin1"))
  })
  const xref = length
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) tail += `${String(offset).padStart(10, "0")} 00000 n \n`
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  add(Buffer.from(tail, "latin1"))
  return Buffer.concat(chunks)
}

/** A stream object: its dictionary entries, then its bytes. */
const stream = (entries: string, data: Buffer) =>
  Buffer.concat([
    Buffer.from(`<< ${entries} /Length ${data.length} >>\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream", "latin1"),
  ])

/** A one-page PDF (A6) that shows one line of ASCII text in Helvetica. */
export function pdf(text = "Maane preview"): Buffer {
  const safe = text.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (char) => `\\${char}`)
  const content = `BT /F1 18 Tf 24 330 Td (${safe}) Tj ET\n0 0 1 RG 4 w 12 12 273 395 re S\n`
  return pdfFile([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 297 420] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    stream("", Buffer.from(content, "latin1")),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ])
}

/** Bits as bytes, padded with zeros to a whole byte. */
function bitsToBytes(bits: string): Buffer {
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0")
  return Buffer.from(
    Array.from({ length: padded.length / 8 }, (_, i) => Number.parseInt(padded.slice(i * 8, i * 8 + 8), 2)),
  )
}

/** The side of the square test image, and its black band: columns 8 to 23 of each of its 32 rows. */
const SIDE = 32
// ITU-T T.4 terminating codes: white runs of 8, black runs of 16.
const WHITE_8 = "10011"
const BLACK_16 = "0000010111"

/** The image as CCITT Group 3 one-dimensional data (T.4, K = 0, no end-of-line codes): every row the same band. */
function ccittRows(): Buffer {
  return bitsToBytes(`${WHITE_8}${BLACK_16}${WHITE_8}`.repeat(SIDE))
}

/**
 * The image as a JBIG2 embedded stream (T.88 with no file header, as PDF's JBIG2Decode reads it): a page information
 * segment, one immediate generic region coded with MMR (T.6, the first row in horizontal mode against an imagined white
 * row, every other row three vertical-zero codes, then the end-of-facsimile-block), and the end of the page.
 */
function jbig2Page(): Buffer {
  const u32 = (value: number) => {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32BE(value)
    return bytes
  }
  const segment = (number: number, type: number, data: Buffer) =>
    Buffer.concat([u32(number), Buffer.from([type, 0x00, 0x01]), u32(data.length), data])
  const firstRow = `001${WHITE_8}${BLACK_16}1`
  const eofb = "000000000001".repeat(2)
  const mmr = bitsToBytes(firstRow + "111".repeat(SIDE - 1) + eofb)
  const pageInfo = Buffer.concat([u32(SIDE), u32(SIDE), u32(0), u32(0), Buffer.from([0x00, 0x00, 0x00])])
  const region = Buffer.concat([u32(SIDE), u32(SIDE), u32(0), u32(0), Buffer.from([0x00]), Buffer.from([0x01]), mmr])
  return Buffer.concat([segment(0, 48, pageInfo), segment(1, 38, region), segment(2, 49, Buffer.alloc(0))])
}

/**
 * A one-page PDF whose only mark is a 32 by 32 one-bit image with a black band, drawn large in the middle of the
 * page, encoded as a fax (CCITT) or a scan (JBIG2) usually is.
 */
export function scannedPdf(kind: "ccitt" | "jbig2"): Buffer {
  const image =
    kind === "ccitt"
      ? stream(
          `/Type /XObject /Subtype /Image /Width ${SIDE} /Height ${SIDE} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K 0 /Columns ${SIDE} /Rows ${SIDE} /BlackIs1 false >>`,
          ccittRows(),
        )
      : stream(
          `/Type /XObject /Subtype /Image /Width ${SIDE} /Height ${SIDE} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode`,
          jbig2Page(),
        )
  const content = "q 120 0 0 120 40 40 cm /Im1 Do Q\n"
  return pdfFile([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
    stream("", Buffer.from(content, "latin1")),
    image,
  ])
}
