import {
  getActiveSubscriberByEmail,
  getSupabaseAdmin,
  parseBody
} from "./_premium-data.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const supabase = getSupabaseAdmin();
    const body = parseBody(req.body);
    const email = String(body.email || "").trim().toLowerCase();
    const subscription = body.subscription;
    const endpoint = String(subscription?.endpoint || "").trim();

    if (!endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ ok: false, error: "A valid push subscription is required." });
    }

    const { subscriber, error: subscriberError } = await getActiveSubscriberByEmail(supabase, email);

    if (subscriberError || !subscriber) {
      return res.status(403).json({ ok: false, error: subscriberError || "Premium access required." });
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from("push_subscriptions")
      .upsert({
        subscriber_email: subscriber.email,
        endpoint,
        subscription,
        user_agent: String(req.headers["user-agent"] || "").slice(0, 500),
        active: true,
        updated_at: now
      }, { onConflict: "endpoint" });

    if (error) throw error;

    return res.status(200).json({
      ok: true,
      message: "Push notifications are enabled for this device."
    });
  } catch (error) {
    console.error("Push subscribe error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Could not enable push notifications."
    });
  }
}
