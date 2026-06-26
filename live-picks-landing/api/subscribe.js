export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const body = parseBody(req.body);

    const email = String(body.email || "").trim().toLowerCase();
    const source = String(body.source || "unknown").trim();
    const honeypot = String(body.website || body.company || "").trim();

    // Quietly accept obvious bot submissions without storing them.
    if (honeypot) {
      return res.status(200).json({ ok: true });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: "Enter a valid email address."
      });
    }

    const webhookUrl = process.env.SUBSCRIBE_WEBHOOK_URL;

    if (!webhookUrl) {
      console.error("Missing SUBSCRIBE_WEBHOOK_URL environment variable.");
      return res.status(500).json({
        ok: false,
        error: "Newsletter storage is not configured yet."
      });
    }

    const payload = {
      email,
      source,
      subscribedAt: new Date().toISOString(),
      userAgent: req.headers["user-agent"] || "",
      ip:
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        ""
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("Newsletter webhook failed:", response.status, text);

      return res.status(502).json({
        ok: false,
        error: "Could not save email."
      });
    }

    return res.status(200).json({
      ok: true
    });
  } catch (error) {
    console.error("Newsletter signup error:", error);

    return res.status(500).json({
      ok: false,
      error: "Unexpected signup error."
    });
  }
}

function parseBody(body) {
  if (!body) return {};

  if (typeof body === "object") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch (_) {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
