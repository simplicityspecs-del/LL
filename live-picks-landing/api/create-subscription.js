import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/create-subscription",
      stripeSecretKeyPresent: Boolean(process.env.STRIPE_SECRET_KEY),
      stripeSecretKeyMode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")
        ? "live"
        : process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
          ? "test"
          : "missing-or-invalid",
      priceWeeklyPresent: Boolean(process.env.STRIPE_PRICE_WEEKLY),
      priceWeeklyLooksValid: process.env.STRIPE_PRICE_WEEKLY?.startsWith("price_") || false,
      supabaseUrlPresent: Boolean(process.env.SUPABASE_URL),
      supabaseServiceRoleKeyPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const weeklyPriceId = process.env.STRIPE_PRICE_WEEKLY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
      return res.status(500).json({ error: "Missing or invalid STRIPE_SECRET_KEY in Vercel." });
    }

    if (!weeklyPriceId || !weeklyPriceId.startsWith("price_")) {
      return res.status(500).json({ error: "Missing or invalid STRIPE_PRICE_WEEKLY in Vercel." });
    }

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return res.status(500).json({ error: "Missing Supabase environment variables in Vercel." });
    }

    const body = parseBody(req.body);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "").trim();
    const plan = String(body.plan || "weekly").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    if (plan !== "weekly") {
      return res.status(400).json({ error: "Only the weekly plan is connected right now." });
    }

    const stripe = new Stripe(stripeSecretKey);
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const { data: existingSubscriber, error: existingSubscriberError } = await supabase
      .from("subscribers")
      .select("id, email, auth_user_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, access_status")
      .eq("email", email)
      .maybeSingle();

    if (existingSubscriberError) {
      return res.status(500).json({ error: existingSubscriberError.message });
    }

    if (
      existingSubscriber?.access_status === "active" ||
      ACTIVE_STRIPE_STATUSES.has(existingSubscriber?.stripe_subscription_status)
    ) {
      return res.status(409).json({
        error: "An active Live Picks account already exists for this email. Please log in or use password reset."
      });
    }

    let authUserId = existingSubscriber?.auth_user_id || null;

    if (!authUserId) {
      const { data: createdUserData, error: createUserError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          source: "live-picks-checkout"
        }
      });

      if (createUserError) {
        const message = createUserError.message || "Could not create Supabase user.";
        const lowerMessage = message.toLowerCase();

        if (lowerMessage.includes("already") || lowerMessage.includes("registered") || lowerMessage.includes("duplicate")) {
          return res.status(409).json({
            error: "An account already exists for this email. Please log in or use password reset instead of creating a new password."
          });
        }

        return res.status(500).json({ error: message });
      }

      authUserId = createdUserData?.user?.id || null;
    }

    if (!authUserId) {
      return res.status(500).json({ error: "Supabase did not return an auth user ID." });
    }

    let customerId = existingSubscriber?.stripe_customer_id || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: {
          source: "Live Picks on-site checkout",
          supabase_auth_user_id: authUserId
        }
      });

      customerId = customer.id;
    }

    const pendingSubscriberPayload = {
      email,
      auth_user_id: authUserId,
      stripe_customer_id: customerId,
      stripe_subscription_status: existingSubscriber?.stripe_subscription_status || "pending_payment",
      plan_name: "weekly",
      access_status: "pending_payment"
    };

    const { error: pendingSubscriberError } = await supabase
      .from("subscribers")
      .upsert(pendingSubscriberPayload, { onConflict: "email" });

    if (pendingSubscriberError) {
      return res.status(500).json({ error: pendingSubscriberError.message });
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: weeklyPriceId }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription"
      },
      billing_mode: {
        type: "flexible"
      },
      metadata: {
        source: "live-picks-checkout",
        email,
        supabase_auth_user_id: authUserId
      },
      expand: ["latest_invoice.confirmation_secret"]
    });

    const clientSecret = subscription.latest_invoice?.confirmation_secret?.client_secret;

    if (!clientSecret) {
      return res.status(500).json({
        error: "Stripe did not return an invoice confirmation secret.",
        subscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        latestInvoiceId: typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : subscription.latest_invoice?.id || null
      });
    }

    const { error: updateSubscriberError } = await supabase
      .from("subscribers")
      .update({
        stripe_subscription_id: subscription.id,
        stripe_subscription_status: subscription.status || "incomplete",
        access_status: accessStatusFromStripe(subscription.status),
        current_period_start: unixToIso(subscription.current_period_start),
        current_period_end: unixToIso(subscription.current_period_end),
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end)
      })
      .eq("email", email);

    if (updateSubscriberError) {
      return res.status(500).json({ error: updateSubscriberError.message });
    }

    return res.status(200).json({
      clientSecret,
      subscriptionId: subscription.id,
      customerId,
      authUserId
    });
  } catch (error) {
    console.error("Stripe/Supabase subscription error:", error);

    return res.status(500).json({
      error: error.message || "Subscription creation failed.",
      code: error.code || null,
      type: error.type || null
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
