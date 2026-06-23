import {
  CURRENT_EVENT_SLUG,
  cleanText,
  ensureCurrentEvent,
  fightPayloadFromBody,
  getSupabaseAdmin,
  loadCurrentBoard,
  parseBody,
  pickNameForFight,
  requireAdmin,
  serializeFight
} from "./_premium-data.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const admin = requireAdmin(req);
  if (!admin.ok) {
    return res.status(admin.status).json({ ok: false, error: admin.error });
  }

  try {
    const supabase = getSupabaseAdmin();

    if (req.method === "GET") {
      const board = await loadCurrentBoard(supabase);
      return res.status(200).json({ ok: true, ...board });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = parseBody(req.body);
    const action = String(body.action || "").trim();

    if (action === "saveEvent") {
      const event = await saveEvent(supabase, body.event || body);
      const board = await loadCurrentBoard(supabase);
      return res.status(200).json({ ok: true, event, ...board });
    }

    if (action === "saveFight") {
      const event = await ensureCurrentEvent(supabase);
      const fight = await saveFight(supabase, event.id, body.fight || body);
      return res.status(200).json({ ok: true, fight });
    }

    if (action === "deleteFight") {
      const fightId = cleanText(body.fightId, 80);
      if (!fightId) return res.status(400).json({ ok: false, error: "fightId is required." });

      const { error } = await supabase
        .from("premium_fights")
        .delete()
        .eq("id", fightId);

      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (action === "lockPick") {
      const result = await lockPick(supabase, body.fight || body);
      return res.status(200).json({ ok: true, ...result });
    }

    if (action === "unlockPick") {
      const fightId = cleanText(body.fightId, 80);
      if (!fightId) return res.status(400).json({ ok: false, error: "fightId is required." });

      const { data, error } = await supabase
        .from("premium_fights")
        .update({
          status: "pending",
          locked_at: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", fightId)
        .select("*")
        .single();

      if (error) throw error;
      return res.status(200).json({ ok: true, fight: serializeFight(data) });
    }

    return res.status(400).json({ ok: false, error: "Unknown admin action." });
  } catch (error) {
    console.error("Admin picks error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Admin action failed."
    });
  }
}

async function saveEvent(supabase, eventBody) {
  const payload = {
    slug: CURRENT_EVENT_SLUG,
    name: cleanText(eventBody.name, 160) || "UFC Fight Night",
    headline: cleanText(eventBody.headline, 180) || "Current event board.",
    event_date: cleanText(eventBody.eventDate, 80) || "Next week",
    venue: cleanText(eventBody.venue, 160) || "TBA",
    market: cleanText(eventBody.market, 80) || "Head to head",
    release_status: cleanText(eventBody.releaseStatus, 80) || "Picks pending",
    alert_channel: cleanText(eventBody.alertChannel, 80) || "Push + feed",
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("premium_events")
    .upsert(payload, { onConflict: "slug" })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function saveFight(supabase, eventId, fightBody) {
  const payload = fightPayloadFromBody(fightBody, eventId);
  const fightId = cleanText(fightBody.id || fightBody.fightId, 80);

  if (!payload.red_corner || !payload.blue_corner) {
    throw new Error("Both fighter names are required.");
  }

  if (fightId) {
    const { data, error } = await supabase
      .from("premium_fights")
      .update(payload)
      .eq("id", fightId)
      .select("*")
      .single();

    if (error) throw error;
    return serializeFight(data);
  }

  const { data, error } = await supabase
    .from("premium_fights")
    .insert({
      ...payload,
      status: "pending"
    })
    .select("*")
    .single();

  if (error) throw error;
  return serializeFight(data);
}

async function lockPick(supabase, fightBody) {
  const event = await ensureCurrentEvent(supabase);
  const fightId = cleanText(fightBody.id || fightBody.fightId, 80);

  if (!fightId) {
    throw new Error("fightId is required before a pick can be locked.");
  }

  const payload = fightPayloadFromBody(fightBody, event.id);

  if (!payload.pick_side) {
    throw new Error("Choose the red or blue corner before locking the pick.");
  }

  const lockedAt = new Date().toISOString();
  const { data: lockedFight, error: lockError } = await supabase
    .from("premium_fights")
    .update({
      ...payload,
      status: "locked",
      locked_at: lockedAt
    })
    .eq("id", fightId)
    .select("*")
    .single();

  if (lockError) throw lockError;

  const notificationResult = await sendPickNotification(supabase, event, lockedFight);

  return {
    fight: serializeFight(lockedFight),
    notification: notificationResult
  };
}

async function sendPickNotification(supabase, event, fight) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || process.env.ADMIN_EMAIL || "mailto:admin@livepicks.local";

  if (!publicKey || !privateKey) {
    return {
      attempted: false,
      sent: 0,
      failed: 0,
      disabled: true,
      message: "VAPID keys are not configured, so the pick was locked without push notifications."
    };
  }

  let webpush;
  try {
    const imported = await import("web-push");
    webpush = imported.default || imported;
  } catch (error) {
    return {
      attempted: false,
      sent: 0,
      failed: 0,
      disabled: true,
      message: "Install the web-push dependency before sending notifications."
    };
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from("push_subscriptions")
    .select("id, subscription")
    .eq("active", true);

  if (subscriptionError) throw subscriptionError;

  const pickName = pickNameForFight(fight);
  const title = "Live Pick Locked";
  const body = `${pickName} locked for ${fight.red_corner} vs ${fight.blue_corner}.`;
  const payload = JSON.stringify({
    title,
    body,
    url: `/premium-feed.html#fight-${fight.id}`,
    fightId: fight.id,
    eventName: event.name
  });

  let sent = 0;
  let failed = 0;
  const inactiveIds = [];

  await Promise.all((subscriptions || []).map(async (record) => {
    try {
      await webpush.sendNotification(record.subscription, payload);
      sent += 1;
    } catch (error) {
      failed += 1;
      if (error.statusCode === 404 || error.statusCode === 410) {
        inactiveIds.push(record.id);
      }
    }
  }));

  if (inactiveIds.length) {
    await supabase
      .from("push_subscriptions")
      .update({ active: false, updated_at: new Date().toISOString() })
      .in("id", inactiveIds);
  }

  return {
    attempted: true,
    sent,
    failed,
    inactive: inactiveIds.length
  };
}
