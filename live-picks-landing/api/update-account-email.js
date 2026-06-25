import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/update-account-email",
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
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return res.status(500).json({ ok: false, error: "Missing Supabase environment variables." });
    }

    if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
      return res.status(500).json({ ok: false, error: "Missing or invalid STRIPE_SECRET_KEY." });
    }

    const body = parseBody(req.body);
    const email = String(body.email || "").trim().toLowerCase();
    const newEmail = String(body.newEmail || "").trim().toLowerCase();
    const currentPassword = String(body.currentPassword || "").trim();

    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "Current account email is required." });
    }

    if (!newEmail || !newEmail.includes("@")) {
      return res.status(400).json({ ok: false, error: "Enter a valid new email address." });
    }

    if (email === newEmail) {
      return res.status(400).json({ ok: false, error: "That email is already on this account." });
    }

    if (!currentPassword) {
      return res.status(400).json({ ok: false, error: "Current password is required." });
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const stripe = new Stripe(stripeSecretKey);

    const { data: signInData, error: signInError } = await supabaseAuth.auth.signInWithPassword({
      email,
      password: currentPassword
    });

    if (signInError || !signInData?.user?.id) {
      return res.status(401).json({ ok: false, error: "Current password did not match this account." });
    }

    const authUserId = signInData.user.id;

    const { data: subscriber, error: subscriberError } = await supabaseAdmin
      .from("subscribers")
      .select("id, email, auth_user_id, stripe_customer_id, stripe_subscription_status, access_status")
      .eq("auth_user_id", authUserId)
      .maybeSingle();

    if (subscriberError) {
      return res.status(500).json({ ok: false, error: subscriberError.message });
    }

    if (!subscriber) {
      return res.status(403).json({ ok: false, error: "No subscriber record was found for this login." });
    }

    if (subscriber.access_status !== "active" && !ACTIVE_STRIPE_STATUSES.has(subscriber.stripe_subscription_status)) {
      return res.status(403).json({ ok: false, error: "This account does not currently have active premium access." });
    }

    const { data: emailAlreadyUsed, error: emailCheckError } = await supabaseAdmin
      .from("subscribers")
      .select("id")
      .eq("email", newEmail)
      .maybeSingle();

    if (emailCheckError) {
      return res.status(500).json({ ok: false, error: emailCheckError.message });
    }

    if (emailAlreadyUsed && emailAlreadyUsed.id !== subscriber.id) {
      return res.status(409).json({ ok: false, error: "That email is already attached to another Live Picks account." });
    }

    const { error: updateAuthError } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
      email: newEmail,
      email_confirm: true,
      user_metadata: {
        source: "live-picks-account-email-update"
      }
    });

    if (updateAuthError) {
      return res.status(500).json({ ok: false, error: updateAuthError.message });
    }

    const { error: updateSubscriberError } = await supabaseAdmin
      .from("subscribers")
      .update({ email: newEmail })
      .eq("id", subscriber.id);

    if (updateSubscriberError) {
      return res.status(500).json({ ok: false, error: updateSubscriberError.message });
    }

    let stripeEmailUpdated = false;

    if (subscriber.stripe_customer_id) {
      await stripe.customers.update(subscriber.stripe_customer_id, {
        email: newEmail
      });
      stripeEmailUpdated = true;
    }

    return res.status(200).json({
      ok: true,
      email: newEmail,
      stripeEmailUpdated
    });
  } catch (error) {
    console.error("Account email update error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Could not update account email."
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
