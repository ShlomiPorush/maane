import { generateVAPIDKeys } from "web-push"

const keys = generateVAPIDKeys()
process.stdout.write(`MAANE_VAPID_PUBLIC_KEY=${keys.publicKey}\nMAANE_VAPID_PRIVATE_KEY=${keys.privateKey}\n`)
