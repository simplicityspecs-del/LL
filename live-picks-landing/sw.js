self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {
      title: "Live Pick Locked",
      body: event.data ? event.data.text() : "A Live Picks play has been locked."
    };
  }

  const title = data.title || "Live Pick Locked";
  const options = {
    body: data.body || "A Live Picks play has been locked.",
    badge: "/icon-192.png?v=2",
    icon: "/icon-512.png?v=2",
    tag: data.fightId ? `live-picks-${data.fightId}` : "live-picks-lock",
    data: {
      url: data.url || "/premium-feed.html"
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(event.notification.data?.url || "/premium-feed.html", self.location.origin).href;

  event.waitUntil((async () => {
    const clientList = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existingClient = clientList.find((client) => client.url.startsWith(self.location.origin));

    if (existingClient) {
      await existingClient.focus();
      return existingClient.navigate(targetUrl);
    }

    return clients.openWindow(targetUrl);
  })());
});
      await existingClient.focus();
      return existingClient.navigate(targetUrl);
    }

    return clients.openWindow(targetUrl);
  })());
});
