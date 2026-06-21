import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email } = req.body || {};

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    if (!process.env.STRIPE_PRICE_WEEKLY) {
      return res.status(500).json({ error: "Missing STRIPE_PRICE_WEEKLY environment variable" });
    }

    const customer = await stripe.customers.create({
      email,
      metadata: {
        source: "Live Picks on-site checkout"
      }
    });

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price: process.env.STRIPE_PRICE_WEEKLY
        }
      ],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription"
      },
      expand: ["latest_invoice.confirmation_secret", "latest_invoice.payment_intent"]
    });

    const invoice = subscription.latest_invoice;
    const clientSecret =
      invoice?.confirmation_secret?.client_secret ||
      invoice?.payment_intent?.client_secret;

    if (!clientSecret) {
      return res.status(500).json({ error: "Could not create payment confirmation secret" });
    }

    return res.status(200).json({
      clientSecret,
      subscriptionId: subscription.id,
      customerId: customer.id
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
        save_default_payment_method: "on_subscription"
      },
      expand: ["latest_invoice.confirmation_secret", "latest_invoice.payment_intent"]
    });

    const invoice = subscription.latest_invoice;
    const clientSecret =
      invoice?.confirmation_secret?.client_secret ||
      invoice?.payment_intent?.client_secret;

    if (!clientSecret) {
      return res.status(500).json({ error: "Could not create payment confirmation secret" });
    }

    return res.status(200).json({
      clientSecret,
      subscriptionId: subscription.id,
      customerId: customer.id
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
