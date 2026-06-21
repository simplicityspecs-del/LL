import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const OLD_EMAIL = "ben.mace.work+test@gmail.com";
const NEW_EMAIL = "ben.mace.work@gmail.com";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

    if (!supabaseUrl || !supabaseServiceRoleKey || !stripeSecretKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing Supabase or Stripe environment variables."
      });
    }

    const oldEmail = OLD_EMAIL.trim().toLowerCase();
    const newEmail = NEW_EMAIL.trim().toLowerCase();

    if (!oldEmail.includes("@") || !newEmail.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "Set OLD_EMAIL and NEW_EMAIL inside this file first."
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const stripe = new Stripe(stripeSecretKey);

    const { data: subscriber, error: subscriberError } = await supabase
      .from("subscribers")
      .select("*")
      .eq("email", oldEmail)
      .maybeSingle();

    if (subscriberError) {
      return res.status(500).json({ ok: false, error: subscriberError.message });
    }

    if (!subscriber) {
      return res.status(404).json({
        ok: false,
        error: `No subscriber row found for ${oldEmail}`
      });
    }

    if (!subscriber.auth_user_id) {
      return res.status(400).json({
        ok: false,
        error: "Subscriber row does not have an auth_user_id."
      });
    }

    const { error: updateAuthError } = await supabase.auth.admin.updateUserById(
      subscriber.auth_user_id,
      {
        email: newEmail,
        email_confirm: true
      }
    );

    if (updateAuthError) {
      return res.status(500).json({
        ok: false,
        error: updateAuthError.message
      });
    }

    const { error: updateSubscriberError } = await supabase
      .from("subscribers")
      .update({
        email: newEmail
      })
      .eq("id", subscriber.id);

    if (updateSubscriberError) {
      return res.status(500).json({
        ok: false,
        error: updateSubscriberError.message
      });
    }

    if (subscriber.stripe_customer_id) {
      await stripe.customers.update(subscriber.stripe_customer_id, {
        email: newEmail
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Test subscriber email updated.",
      oldEmail,
      newEmail,
      authUserId: subscriber.auth_user_id,
      stripeCustomerId: subscriber.stripe_customer_id || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Could not update test email."
    });
  }
}