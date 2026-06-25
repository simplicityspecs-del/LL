export default function handler(req, res) {
  return res.status(200).json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
  });
}
