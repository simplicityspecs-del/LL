import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/request-password-reset",
      supabaseUrlPresent: Boolean(process.env.SUPABASE_URL),
      supabaseAnonKeyPresent: Boolean(process.env.SUPABASE_ANON_KEY)
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !anonKey) {
      return res.status(500).json({ ok: false, error: "Missing Supabase environment variables." });
    }

    const body = parseBody(req.body);
    const email = String(body.email || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "Enter a valid subscriber email." });
    }

    const origin = getOrigin(req);
    const redirectTo = `${origin}/reset-password.html`;

    const supabase = createClient(supabaseUrl, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo
    });

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(200).json({
      ok: true,
      message: "Password reset email sent if the account exists."
    });
  } catch (error) {
    console.error("Password reset request error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Could not send password reset email."
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

function getOrigin(req) {
  const configuredUrl = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";

  return `${proto}://${host}`;
}
