// The scripts and the deployment notes run this once in the image and append its output to an owner-only app.env that
// has no VAPID keys yet, so it prints exactly the two lines app.env takes and nothing else.
import { generateVAPIDKeys } from "web-push"

const keys = generateVAPIDKeys()
process.stdout.write(`MAANE_VAPID_PUBLIC_KEY=${keys.publicKey}\nMAANE_VAPID_PRIVATE_KEY=${keys.privateKey}\n`)
