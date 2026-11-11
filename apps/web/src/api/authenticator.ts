// The account name an authenticator app shows for Maane. Better Auth names the account after the user's e-mail,
// which in Maane is the synthetic <username>@maane.invalid. This changes only that label to the username; the
// secret, the issuer and every other part of the link stay exactly as Better Auth made them.

import { userEmail } from "@maane/shared"

const TOTP_URI_PREFIX = "otpauth://totp/"
/** "@maane.invalid": the part of every user's e-mail after the username. */
const EMAIL_DOMAIN = userEmail("")

export function authenticatorUri(uri: string): string {
  if (!uri.startsWith(TOTP_URI_PREFIX)) return uri
  const queryAt = uri.indexOf("?")
  const label = uri.slice(TOTP_URI_PREFIX.length, queryAt === -1 ? undefined : queryAt)
  const rest = queryAt === -1 ? "" : uri.slice(queryAt)
  // Better Auth encodes the issuer and the account each with encodeURIComponent, so the first raw colon parts them.
  const colon = label.indexOf(":")
  if (colon === -1) return uri
  let account: string
  try {
    account = decodeURIComponent(label.slice(colon + 1))
  } catch {
    return uri
  }
  if (!account.endsWith(EMAIL_DOMAIN) || account.length === EMAIL_DOMAIN.length) return uri
  const username = account.slice(0, -EMAIL_DOMAIN.length)
  return `${TOTP_URI_PREFIX}${label.slice(0, colon)}:${encodeURIComponent(username)}${rest}`
}

/** The secret of an otpauth link, shown as text for typing it into the app by hand. */
export function totpSecret(uri: string): string {
  const queryAt = uri.indexOf("?")
  if (queryAt === -1) return ""
  return new URLSearchParams(uri.slice(queryAt + 1)).get("secret") ?? ""
}
