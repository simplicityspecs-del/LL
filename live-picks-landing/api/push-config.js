export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";

  return res.status(200).json({
    ok: true,
    pushReady: Boolean(vapidPublicKey && process.env.VAPID_PRIVATE_KEY),
    vapidPublicKey
  });
}
