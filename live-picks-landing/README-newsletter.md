# Live Picks newsletter flow

This update adds:

- `index.html` with the top-right **Free Newsletter** button changed to `newsletter.html`
- `newsletter.html` with an email capture form
- `thank-you.html` with a premium upsell CTA
- `api/subscribe.js` as a Vercel serverless function

## Important setup step

The Vercel function needs somewhere external to store the email address.

Create a webhook using Google Sheets via Apps Script, Make, Zapier, Airtable, ConvertKit, Mailchimp or another email tool, then add this environment variable in Vercel:

```txt
SUBSCRIBE_WEBHOOK_URL=https://your-webhook-url-here
```

In Vercel:

1. Open your project.
2. Go to Settings → Environment Variables.
3. Add `SUBSCRIBE_WEBHOOK_URL`.
4. Redeploy the project.

The form sends this JSON to your webhook:

```json
{
  "email": "person@example.com",
  "source": "free-newsletter-page",
  "subscribedAt": "2026-06-21T00:00:00.000Z",
  "userAgent": "browser user agent"
}
```

## Premium CTA

The thank-you page premium button currently points to:

```txt
checkout.html
```

Change that link if your premium checkout or login URL is somewhere else.
