// Prints a new VAPID key pair for browser notifications (plan 4.5), made by web-push's documented generateVAPIDKeys,
// as the two lines app.env takes. The scripts and the deployment notes run it once in the image and append its output
// to an owner-only app.env that has no VAPID keys yet; it reads nothing and writes nothing else.
import webpush from "web-push"

const keys = webpush.generateVAPIDKeys()
process.stdout.write(`MAANE_VAPID_PUBLIC_KEY=${keys.publicKey}\nMAANE_VAPID_PRIVATE_KEY=${keys.privateKey}\n`)
