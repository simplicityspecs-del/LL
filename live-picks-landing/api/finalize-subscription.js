import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/finalize-subscription",
      stripeSecretKeyPresent: Boolean(process.env.STRIPE_SECRET_KEY),
      supabaseUrlPresent: Boolean(process.env.SUPABASE_URL),
      supabaseServiceRoleKeyPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
      return res.status(500).json({ ok: false, error: "Missing or invalid STRIPE_SECRET_KEY." });
    }

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return res.status(500).json({ ok: false, error: "Missing Supabase environment variables." });
    }

    const body = parseBody(req.body);
    const subscriptionId = String(body.subscriptionId || "").trim();

    if (!subscriptionId || !subscriptionId.startsWith("sub_")) {
      return res.status(400).json({ ok: false, error: "Valid Stripe subscription ID is required." });
    }

    const stripe = new Stripe(stripeSecretKey);
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["customer", "latest_invoice"]
    });

    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id || null;

    if (!customerId) {
      return res.status(500).json({ ok: false, error: "Stripe customer ID was not found." });
    }

    const accessStatus = accessStatusFromStripe(subscription.status);

    const { error } = await supabase
      .from("subscribers")
      .update({
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        stripe_subscription_status: subscription.status || "unknown",
        access_status: accessStatus,
        current_period_start: unixToIso(subscription.current_period_start),
        current_period_end: unixToIso(subscription.current_period_end),
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end)
      })
      .eq("stripe_subscription_id", subscription.id);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(200).json({
      ok: true,
      subscriptionId: subscription.id,
      stripeStatus: subscription.status,
      accessStatus,
      accessGranted: accessStatus === "active"
    });
  } catch (error) {
    console.error("Finalize subscription error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Could not finalize subscription."
    });
  }
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;

  try {
    return JSON.parse(body);
  } catch (_) {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

function unixToIso(value) {
  if (!value) return null;
  return new Date(value * 1000).toISOString();
}

function accessStatusFromStripe(status) {
  if (ACTIVE_STRIPE_STATUSES.has(status)) return "active";
  if (status === "past_due") return "past_due";
  if (status === "canceled" || status === "unpaid") return "inactive";
  return "pending_payment";
}