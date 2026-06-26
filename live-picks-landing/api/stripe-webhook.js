import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: false
  }
};

const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/stripe-webhook",
      stripeSecretKeyPresent: Boolean(process.env.STRIPE_SECRET_KEY),
      stripeWebhookSecretPresent: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      supabaseUrlPresent: Boolean(process.env.SUPABASE_URL),
      supabaseServiceRoleKeyPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
      return res.status(500).json({ ok: false, error: "Missing or invalid STRIPE_SECRET_KEY." });
    }

    if (!stripeWebhookSecret || !stripeWebhookSecret.startsWith("whsec_")) {
      return res.status(500).json({ ok: false, error: "Missing or invalid STRIPE_WEBHOOK_SECRET." });
    }

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return res.status(500).json({ ok: false, error: "Missing Supabase environment variables." });
    }

    const stripe = new Stripe(stripeSecretKey);
    const signature = req.headers["stripe-signature"];
    const rawBody = await readRawBody(req);
    const event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    if (event.type.startsWith("customer.subscription.")) {
      await syncSubscription(supabase, event.data.object);
    }

    if (event.type === "invoice.payment_succeeded" || event.type === "invoice.payment_failed") {
      const subscriptionId = getInvoiceSubscriptionId(event.data.object);

      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["customer"]
        });
        await syncSubscription(supabase, subscription);
      }
    }

    return res.status(200).json({ ok: true, received: true, eventType: event.type });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return res.status(400).json({
      ok: false,
      error: error.message || "Stripe webhook failed."
    });
  }
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return Buffer.from(req.body);
  }

  if (req.body && typeof req.body === "object") {
    return Buffer.from(JSON.stringify(req.body));
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function getInvoiceSubscriptionId(invoice) {
  if (!invoice) return "";
  if (typeof invoice.subscription === "string") return invoice.subscription;
  if (invoice.subscription?.id) return invoice.subscription.id;
  if (typeof invoice.parent?.subscription_details?.subscription === "string") {
    return invoice.parent.subscription_details.subscription;
  }
  return "";
}

async function syncSubscription(supabase, subscription) {
  const customerId = getCustomerId(subscription.customer);
  const customerEmail = getCustomerEmail(subscription.customer) || normalizeEmail(subscription.metadata?.email);
  const payload = {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    stripe_subscription_status: subscription.status || "unknown",
    access_status: accessStatusFromStripe(subscription.status),
    current_period_start: unixToIso(subscription.current_period_start),
    current_period_end: unixToIso(subscription.current_period_end),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    plan_name: subscription.metadata?.plan || "weekly"
  };

  const updatedBySubscription = await supabase
    .from("subscribers")
    .update(payload)
    .eq("stripe_subscription_id", subscription.id)
    .select("id");

  if (updatedBySubscription.error) {
    throw updatedBySubscription.error;
  }

  if (updatedBySubscription.data?.length) {
    return;
  }

  if (customerId) {
    const updatedByCustomer = await supabase
      .from("subscribers")
      .update(payload)
      .eq("stripe_customer_id", customerId)
      .select("id");

    if (updatedByCustomer.error) {
      throw updatedByCustomer.error;
    }

    if (updatedByCustomer.data?.length) {
      return;
    }
  }

  if (!customerEmail) {
    return;
  }

  const { error } = await supabase
    .from("subscribers")
    .upsert({
      ...payload,
      email: customerEmail
    }, { onConflict: "email" });

  if (error) {
    throw error;
  }
}

function getCustomerId(customer) {
  if (!customer) return "";
  return typeof customer === "string" ? customer : customer.id || "";
}

function getCustomerEmail(customer) {
  if (!customer || typeof customer === "string") return "";
  return normalizeEmail(customer.email);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function unixToIso(value) {
  if (!value) return null;
  return new Date(value * 1000).toISOString();
}

function accessStatusFromStripe(status) {
  if (ACTIVE_STRIPE_STATUSES.has(status)) return "active";
  if (status === "past_due") return "past_due";
  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") return "inactive";
  return "pending_payment";
}
