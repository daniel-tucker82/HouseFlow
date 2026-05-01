/******/ (() => { // webpackBootstrap
self.addEventListener("push", event => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch (_unused) {
    payload = {
      title: "HouseFlow notification",
      body: event.data.text()
    };
  }
  const title = typeof payload.title === "string" ? payload.title : "HouseFlow";
  const body = typeof payload.body === "string" ? payload.body : "";
  const tag = typeof payload.tag === "string" ? payload.tag : undefined;
  const url = typeof payload.url === "string" ? payload.url : "/";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    data: {
      url
    },
    icon: "/next.svg",
    badge: "/vercel.svg"
  }));
});
self.addEventListener("notificationclick", event => {
  var _event$notification;
  event.notification.close();
  const targetUrl = ((_event$notification = event.notification) === null || _event$notification === void 0 || (_event$notification = _event$notification.data) === null || _event$notification === void 0 ? void 0 : _event$notification.url) || "/";
  event.waitUntil(self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  }).then(clientList => {
    for (const client of clientList) {
      if ("focus" in client) {
        client.navigate(targetUrl);
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    return undefined;
  }));
});
/******/ })()
;