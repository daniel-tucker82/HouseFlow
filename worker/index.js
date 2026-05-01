self.addEventListener("push", (event) => {
  if (!event.data) return
  let payload = {}
  try {
    payload = event.data.json()
  } catch {
    payload = { title: "Cyntch notification", body: event.data.text() }
  }
  const title = typeof payload.title === "string" ? payload.title : "Cyntch"
  const body = typeof payload.body === "string" ? payload.body : ""
  const tag = typeof payload.tag === "string" ? payload.tag : undefined
  const url = typeof payload.url === "string" ? payload.url : "/"
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      data: { url },
      icon: "/next.svg",
      badge: "/vercel.svg",
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const targetUrl = event.notification?.data?.url || "/"
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl)
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
      return undefined
    }),
  )
})
