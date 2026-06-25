import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/request-email-recovery",
      supabaseUrlPresent: Boolean(process.env.SUPABASE_URL),
      supabaseServiceRoleKeyPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return res.status(500).json({
        ok: false,
        error: "Account recovery is not configured yet."
      });
    }

    const body = parseBody(req.body);

    // Honeypot: quietly accept bot submissions without storing them.
    if (cleanText(body.company, 80)) {
      return res.status(200).json({ ok: true });
    }

    const contactEmail = cleanEmail(body.contactEmail);
    const cardLast4 = cleanDigits(body.cardLast4, 4);

    if (!contactEmail || !contactEmail.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "Enter an email we can contact you on."
      });
    }

    if (cardLast4 && cardLast4.length !== 4) {
      return res.status(400).json({
        ok: false,
        error: "Last 4 card digits should be four numbers, or left blank."
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const payload = {
      contact_email: contactEmail,
      full_name: cleanText(body.fullName, 160),
      possible_emails: cleanText(body.possibleEmails, 1500),
      stripe_receipt: cleanText(body.stripeReceipt, 240),
      payment_date: cleanText(body.paymentDate, 120),
      payment_amount: cleanText(body.paymentAmount, 80),
      card_last4: cardLast4 || null,
      message: cleanText(body.message, 2000),
      status: "new",
      user_agent: req.headers["user-agent"] || "",
      ip_address:
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        ""
    };

    const { error } = await supabase
      .from("account_recovery_requests")
      .insert(payload);

    if (error) {
      console.error("Account recovery insert failed:", error);
      return res.status(500).json({
        ok: false,
        error: "The request could not be saved."
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Thanks. If we can verify the subscription, we will contact you with the next step."
    });
  } catch (error) {
    console.error("Account recovery request error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "The request could not be submitted."
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

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanDigits(value, maxLength) {
  return String(value || "").replace(/\D/g, "").slice(0, maxLength);
}
