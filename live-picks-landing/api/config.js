export default function handler(req, res) {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || "";

  if (!publishableKey.startsWith("pk_")) {
    return res.status(500).json({
      ok: false,
      error: "Stripe publishable key is not configured."
    });
  }

  return res.status(200).json({
    ok: true,
    publishableKey
  });
}
