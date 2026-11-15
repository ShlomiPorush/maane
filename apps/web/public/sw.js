// Maane's service worker (plan 4.5): shows a browser notification for each push and opens its ticket when it is
// clicked. It handles no request and caches nothing, so the app always comes from the server. A push carries only
// the words to show and the ticket's number; the address it opens is built here from that number, never taken from
// the push.

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  // Open pages come under this worker at once, so a click can take one of them to the ticket.
  event.waitUntil(self.clients.claim())
})

const ticketNumber = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null)
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "")

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const number = ticketNumber(data.number)
  // A push must show a notification; one that cannot be read still shows the app's name.
  const title = text(data.title, 200) || "Maane"
  event.waitUntil(
    self.registration.showNotification(title, {
      body: text(data.body, 200),
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: number ? `ticket-${number}` : "maane",
      renotify: true,
      data: { number },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const number = ticketNumber(event.notification.data?.number)
  const url = new URL(number ? `/tickets/${number}` : "/", self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        try {
          const focused = await client.focus()
          await focused.navigate(url)
          return
        } catch {
          // A page this worker does not control cannot be navigated: a new one opens below.
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})
