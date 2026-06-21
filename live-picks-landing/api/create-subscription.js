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
      priceWeeklyLooksValid: process.env.STRIPE_PRICE_WEEKLY?.startsWith("price_") || false
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const priceId = process.env.STRIPE_PRICE_WEEKLY;

    if (!secretKey || !secretKey.startsWith("sk_")) {
      return res.status(500).json({
        error: "Missing or invalid STRIPE_SECRET_KEY in Vercel."
      });
    }

    if (!priceId || !priceId.startsWith("price_")) {
      return res.status(500).json({
        error: "Missing or invalid STRIPE_PRICE_WEEKLY in Vercel."
      });
    }

    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(secretKey);

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const email = String(body.email || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    const customer = await stripe.customers.create({
      email,
      metadata: {
        source: "Live Picks on-site checkout"
      }
    });

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription"
      },
      billing_mode: {
        type: "flexible"
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

    return res.status(200).json({
      clientSecret,
      subscriptionId: subscription.id
    });
  } catch (error) {
    console.error("Stripe subscription error:", error);

    return res.status(500).json({
      error: error.message || "Subscription creation failed.",
      code: error.code || null,
      type: error.type || null
    });
  }
}
