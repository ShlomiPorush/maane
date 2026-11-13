// The composer's uploads (plan 3.1), the `upload-scan` job: the server kept the bytes in the upload's row; the worker
// scans them with the 2.2 file service and stores what may be kept, under its hash's lock, in one transaction with the
// row's new status. An upload is refused when it is infected, of a blocked type, too large, or when no scanner can
// answer and the policy blocks (a file that would wait is refused, never attached unscanned). The bytes leave the
// row in every case.

import type { Db } from "@maane/server/db/client"
import { upload } from "@maane/server/db/schema"
import { log } from "@maane/server/log"
import type { UploadStatus } from "@maane/shared"
import { and, eq } from "drizzle-orm"
import { auditBlockedPart, type FileService, FileTooLargeError, type ScanOutcome } from "../files/service.ts"

export async function scanUpload(db: Db, files: FileService, uploadId: string): Promise<UploadStatus | null> {
  const [row] = await db
    .select({ content: upload.content, fileName: upload.fileName })
    .from(upload)
    .where(and(eq(upload.id, uploadId), eq(upload.status, "scanning")))
  if (!row?.content) return null
  const bytes = row.content
  let outcome: ScanOutcome | null = null
  try {
    outcome = await files.scan(bytes, row.fileName)
  } catch (error) {
    if (!(error instanceof FileTooLargeError)) throw error
  }
  const status: UploadStatus =
    outcome === null ? "too_large" : outcome.status === "waiting" ? "scanner_unavailable" : outcome.status
  await db.transaction(async (tx) => {
    const decided = { content: null, status, scannedAt: new Date() }
    if (outcome && (status === "clean" || status === "not_fully_scanned" || status === "not_scanned")) {
      const stored = await files.storeIn(tx, bytes, outcome)
      await tx
        .update(upload)
        .set({ ...decided, storedSha256: stored.sha256, signature: outcome.signature })
        .where(and(eq(upload.id, uploadId), eq(upload.status, "scanning")))
      return
    }
    const blocked =
      outcome?.status === "infected"
        ? { signature: outcome.signature }
        : outcome?.status === "blocked_type"
          ? { blockedBy: outcome.blockedBy }
          : {}
    await tx
      .update(upload)
      .set({ ...decided, ...blocked })
      .where(and(eq(upload.id, uploadId), eq(upload.status, "scanning")))
    if (outcome)
      await auditBlockedPart(tx, null, outcome, {
        ticketId: null,
        messageId: null,
        partId: null,
        fileName: row.fileName,
      })
  })
  if (status !== "clean") log.info("an upload was scanned", { status })
  return status
}
