import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/login",
      supabaseUrlPresent: Boolean(process.env.SUPABASE_URL),
      supabaseAnonKeyPresent: Boolean(process.env.SUPABASE_ANON_KEY),
      supabaseServiceRoleKeyPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      stripeSecretKeyPresent: Boolean(process.env.STRIPE_SECRET_KEY)
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return res.status(500).json({ ok: false, error: "Missing Supabase environment variables." });
    }

    const body = parseBody(req.body);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "").trim();

    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "Enter a valid subscriber email." });
    }

    if (!password) {
      return res.status(400).json({ ok: false, error: "Enter your password." });
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
      email,
      password
    });

    if (authError || !authData?.user) {
      return res.status(401).json({
        ok: false,
        error: "Email or password is incorrect."
      });
    }

    const user = authData.user;

    let { data: subscriber, error: subscriberError } = await adminClient
      .from("subscribers")
      .select("id, email, auth_user_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, access_status, current_period_end, cancel_at_period_end")
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (subscriberError) {
      return res.status(500).json({ ok: false, error: subscriberError.message });
    }

    if (!subscriber) {
      const result = await adminClient
        .from("subscribers")
        .select("id, email, auth_user_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, access_status, current_period_end, cancel_at_period_end")
        .eq("email", email)
        .maybeSingle();

      if (result.error) {
        return res.status(500).json({ ok: false, error: result.error.message });
      }

      subscriber = result.data;
    }

    if (!subscriber) {
      return res.status(403).json({
        ok: false,
        error: "No subscriber record was found for this account."
      });
    }

    if (!subscriber.auth_user_id) {
      await adminClient
        .from("subscribers")
        .update({ auth_user_id: user.id })
        .eq("id", subscriber.id);
    }

    let accessStatus = subscriber.access_status || "inactive";
    let stripeStatus = subscriber.stripe_subscription_status || "unknown";

    if (accessStatus !== "active" && subscriber.stripe_subscription_id && stripeSecretKey?.startsWith("sk_")) {
      const stripe = new Stripe(stripeSecretKey);
      const subscription = await stripe.subscriptions.retrieve(subscriber.stripe_subscription_id);

      stripeStatus = subscription.status || "unknown";
      accessStatus = accessStatusFromStripe(stripeStatus);

      const { error: updateError } = await adminClient
        .from("subscribers")
        .update({
          stripe_subscription_status: stripeStatus,
          access_status: accessStatus,
          current_period_start: unixToIso(subscription.current_period_start),
          current_period_end: unixToIso(subscription.current_period_end),
          cancel_at_period_end: Boolean(subscription.cancel_at_period_end)
        })
        .eq("id", subscriber.id);

      if (updateError) {
        return res.status(500).json({ ok: false, error: updateError.message });
      }
    }

    if (accessStatus !== "active") {
      return res.status(403).json({
        ok: false,
        error: "Your subscription is not active yet. If you just paid, wait a few seconds and try again.",
        accessStatus,
        stripeStatus
      });
    }

    return res.status(200).json({
      ok: true,
      email: subscriber.email || email,
      accessStatus,
      stripeStatus,
      currentPeriodEnd: subscriber.current_period_end || null,
      cancelAtPeriodEnd: Boolean(subscriber.cancel_at_period_end)
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Login failed."
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
