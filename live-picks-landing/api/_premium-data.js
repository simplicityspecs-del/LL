import { createClient } from "@supabase/supabase-js";

export const CURRENT_EVENT_SLUG = "current";

export const DEFAULT_EVENT = {
  slug: CURRENT_EVENT_SLUG,
  name: "UFC Fight Night",
  headline: "Next event board.",
  event_date: "Next week",
  venue: "TBA",
  market: "Head to head",
  release_status: "Picks pending",
  alert_channel: "Push + feed"
};

const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing"]);

export function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;

  try {
    return JSON.parse(body);
  } catch (_) {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

export function getSupabaseAdmin() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

export function requireAdmin(req) {
  const configuredSecret = process.env.ADMIN_SECRET;

  if (!configuredSecret) {
    return { ok: false, status: 500, error: "Missing ADMIN_SECRET environment variable." };
  }

  const authorization = req.headers.authorization || req.headers.Authorization || "";
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const headerToken = String(req.headers["x-admin-secret"] || "").trim();
  const token = bearerToken || headerToken;

  if (!token || token !== configuredSecret) {
    return { ok: false, status: 401, error: "Admin access denied." };
  }

  return { ok: true };
}

export async function getActiveSubscriberByEmail(supabase, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return { subscriber: null, error: "Valid subscriber email is required." };
  }

  const { data, error } = await supabase
    .from("subscribers")
    .select("id, email, stripe_subscription_status, access_status")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (error) {
    return { subscriber: null, error: error.message };
  }

  if (!data) {
    return { subscriber: null, error: "No subscriber record was found for this email." };
  }

  const accessStatus = data.access_status || "inactive";
  const stripeStatus = data.stripe_subscription_status || "unknown";

  if (accessStatus !== "active" && !ACTIVE_STRIPE_STATUSES.has(stripeStatus)) {
    return { subscriber: null, error: "This account does not currently have active premium access." };
  }

  return { subscriber: data, error: null };
}

export async function ensureCurrentEvent(supabase) {
  const { data: existingEvent, error: readError } = await supabase
    .from("premium_events")
    .select("*")
    .eq("slug", CURRENT_EVENT_SLUG)
    .maybeSingle();

  if (readError) throw readError;
  if (existingEvent) return existingEvent;

  const { data: createdEvent, error: createError } = await supabase
    .from("premium_events")
    .insert(DEFAULT_EVENT)
    .select("*")
    .single();

  if (createError) throw createError;
  return createdEvent;
}

export async function loadCurrentBoard(supabase) {
  const event = await ensureCurrentEvent(supabase);
  const { data: fights, error: fightsError } = await supabase
    .from("premium_fights")
    .select("*")
    .eq("event_id", event.id)
    .order("order_index", { ascending: true })
    .order("created_at", { ascending: true });

  if (fightsError) throw fightsError;

  return {
    event: serializeEvent(event),
    fights: (fights || []).map(serializeFight)
  };
}

export function serializeEvent(event) {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name || DEFAULT_EVENT.name,
    headline: event.headline || DEFAULT_EVENT.headline,
    eventDate: event.event_date || DEFAULT_EVENT.event_date,
    venue: event.venue || DEFAULT_EVENT.venue,
    market: event.market || DEFAULT_EVENT.market,
    releaseStatus: event.release_status || DEFAULT_EVENT.release_status,
    alertChannel: event.alert_channel || DEFAULT_EVENT.alert_channel,
    updatedAt: event.updated_at || null
  };
}

export function serializeFight(fight) {
  return {
    id: fight.id,
    eventId: fight.event_id,
    orderIndex: fight.order_index ?? 0,
    redCorner: fight.red_corner || "",
    blueCorner: fight.blue_corner || "",
    redOdds: fight.red_odds || "",
    blueOdds: fight.blue_odds || "",
    pickSide: fight.pick_side || "",
    pickLabel: fight.pick_label || "",
    confidence: fight.confidence || "",
    note: fight.note || "",
    status: fight.status || "pending",
    lockedAt: fight.locked_at || null,
    updatedAt: fight.updated_at || null
  };
}

export function fightPayloadFromBody(body, eventId) {
  const pickSide = cleanText(body.pickSide, 20).toLowerCase();

  return {
    event_id: eventId,
    order_index: Number.isFinite(Number(body.orderIndex)) ? Number(body.orderIndex) : 0,
    red_corner: cleanText(body.redCorner, 160),
    blue_corner: cleanText(body.blueCorner, 160),
    red_odds: cleanText(body.redOdds, 32),
    blue_odds: cleanText(body.blueOdds, 32),
    pick_side: pickSide === "red" || pickSide === "blue" ? pickSide : null,
    pick_label: cleanText(body.pickLabel, 180),
    confidence: cleanText(body.confidence, 80),
    note: cleanText(body.note, 900),
    updated_at: new Date().toISOString()
  };
}

export function cleanText(value, maxLength = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function pickNameForFight(fight) {
  if (fight.pick_side === "red") return fight.red_corner || "Red corner";
  if (fight.pick_side === "blue") return fight.blue_corner || "Blue corner";
  return fight.pick_label || "Live pick";
}
