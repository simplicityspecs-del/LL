import {
  getActiveSubscriberByEmail,
  getSupabaseAdmin,
  loadCurrentBoard
} from "./_premium-data.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const email = String(req.query?.email || "").trim().toLowerCase();
    const supabase = getSupabaseAdmin();
    const { subscriber, error: subscriberError } = await getActiveSubscriberByEmail(supabase, email);

    if (subscriberError || !subscriber) {
      return res.status(403).json({ ok: false, error: subscriberError || "Premium access required." });
    }

    const board = await loadCurrentBoard(supabase);

    return res.status(200).json({
      ok: true,
      subscriber: {
        email: subscriber.email
      },
      ...board
    });
  } catch (error) {
    console.error("Premium feed error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Could not load the premium feed."
    });
  }
}
