self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
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
        } catch {}
      }
      await self.clients.openWindow(url)
    })(),
  )
})
