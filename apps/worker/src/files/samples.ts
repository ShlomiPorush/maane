// The samples of the scanner self-test (plan 2.2, P15). Each one proves one alert a scanner must give before Maane
// trusts its "clean": EICAR, an encrypted ZIP, and an encrypted PDF, plus harmless text that must come back clean.

/**
 * The EICAR test file (eicar.org), built here from pieces so that no file of the repository holds the signature
 * itself: scanners and push protection flag the literal text. The backslash comes from its code point, because some
 * editing tools rewrite a backslash in a string.
 */
export function eicar(): Buffer {
  const backslash = String.fromCharCode(92)
  return Buffer.from(
    ["X5O!P%@AP[4", backslash, "PZX54(P^)7CC)7}$", "EICAR-STANDARD-", "ANTIVIRUS-", "TEST-FILE!$H+H*"].join(""),
    "latin1",
  )
}

/**
 * A ZIP archive with one entry, encrypted with a throwaway password (zip -P): a scanner with AlertEncryptedArchive
 * answers Heuristics.Encrypted.Zip. The entry is one line of harmless text.
 */
export const ENCRYPTED_ZIP = Buffer.from(
  "UEsDBAoACQAAANtybF10KvnnJAAAABgAAAAIABwAbm90ZS50eHRVVAkAA73L9Wq9y/VqdXgLAAEE6AMAAAToAwAA2ajqMAsSF0mMa1cIdUNFd42Q" +
    "GRsQZ1Yol/7RlSRNegWGtlJ9UEsHCHQq+eckAAAAGAAAAFBLAQIeAwoACQAAANtybF10KvnnJAAAABgAAAAIABgAAAAAAAEAAAD/gQAAAABub3Rl" +
    "LnR4dFVUBQADvcv1anV4CwABBOgDAAAE6AMAAFBLBQYAAAAAAQABAE4AAAB2AAAAAAA=",
  "base64",
)

/**
 * A one-page blank PDF, encrypted with AES-128 and a throwaway user password (qpdf --encrypt): a scanner with
 * AlertEncryptedDoc answers Heuristics.Encrypted.PDF.
 */
export const ENCRYPTED_PDF = Buffer.from(
  "JVBERi0xLjcKJb/3ov4KMSAwIG9iago8PCAvUGFnZXMgMiAwIFIgL1R5cGUgL0NhdGFsb2cgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL0NvdW50IDEg" +
    "L0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcyA+PgplbmRvYmoKMyAwIG9iago8PCAvQ29udGVudHMgNCAwIFIgL01lZGlhQm94IFsgMCAwIDIw" +
    "MCAyMDAgXSAvUGFyZW50IDIgMCBSIC9UeXBlIC9QYWdlID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggMzIgL0ZpbHRlciAvRmxhdGVEZWNv" +
    "ZGUgPj4Kc3RyZWFtCiJIbZ72pqKWOnTtck6QYy8sKJ0LxEDV7aZbLAxFRUXZZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9DRiA8PCAvU3Rk" +
    "Q0YgPDwgL0F1dGhFdmVudCAvRG9jT3BlbiAvQ0ZNIC9BRVNWMiAvTGVuZ3RoIDE2ID4+ID4+IC9GaWx0ZXIgL1N0YW5kYXJkIC9MZW5ndGggMTI4" +
    "IC9PIDw2ZmEyNDcwZjY2N2JiZmY4MGI2ODVhOTA4ODEzNWI4N2U3YjdhOGQzYjAzOTUzYjFlMjRmOWJjMTIxOWI5ZTE5PiAvUCAtNCAvUiA0IC9T" +
    "dG1GIC9TdGRDRiAvU3RyRiAvU3RkQ0YgL1UgPDUzODZiYjM0OGEzMjg2MzVlYzgxZWEyMzA5Y2YxODQxMDEyMjQ1NmE5MWJhZTUxMzQyNzNhNmRi" +
    "MTM0Yzg3YzQ+IC9WIDQgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0" +
    "IDAwMDAwIG4gCjAwMDAwMDAxMjMgMDAwMDAgbiAKMDAwMDAwMDIxMiAwMDAwMCBuIAowMDAwMDAwMzE0IDAwMDAwIG4gCnRyYWlsZXIgPDwgL1Jv" +
    "b3QgMSAwIFIgL1NpemUgNiAvSUQgWzxkYzVlMGYzMTMzMzg3OGM1N2I3MTU2OWQwOTc2NDE3YT48ZGM1ZTBmMzEzMzM4NzhjNTdiNzE1NjlkMDk3" +
    "NjQxN2E+XSAvRW5jcnlwdCA1IDAgUiA+PgpzdGFydHhyZWYKNjEzCiUlRU9GCg==",
  "base64",
)

/** Harmless text a working scanner finds nothing in. */
export const CLEAN_SAMPLE = Buffer.from("Maane scanner self-test: harmless text.\n", "utf8")
