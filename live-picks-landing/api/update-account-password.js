import { createClient } from "@supabase/supabase-js";

const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/update-account-password",
      supabaseUrlPresent: Boolean(process.env.SUPABASE_URL),
      supabaseAnonKeyPresent: Boolean(process.env.SUPABASE_ANON_KEY),
      supabaseServiceRoleKeyPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return res.status(500).json({ ok: false, error: "Missing Supabase environment variables." });
    }

    const body = parseBody(req.body);
    const email = String(body.email || "").trim().toLowerCase();
    const currentPassword = String(body.currentPassword || "").trim();
    const newPassword = String(body.newPassword || "").trim();

    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "Current account email is required." });
    }

    if (!currentPassword) {
      return res.status(400).json({ ok: false, error: "Current password is required." });
    }

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ ok: false, error: "New password must be at least 6 characters." });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ ok: false, error: "Choose a new password that is different from your current password." });
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
      .select("id, stripe_subscription_status, access_status")
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

    const { error: updatePasswordError } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
      password: newPassword
    });

    if (updatePasswordError) {
      return res.status(500).json({ ok: false, error: updatePasswordError.message });
    }

    return res.status(200).json({
      ok: true,
      message: "Password updated."
    });
  } catch (error) {
    console.error("Account password update error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Could not update account password."
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
