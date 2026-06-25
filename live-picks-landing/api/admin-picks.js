import crypto from "node:crypto";

import {
  CURRENT_EVENT_SLUG,
  cleanText,
  ensureCurrentEvent,
  fightPayloadFromBody,
  getSupabaseAdmin,
  loadCurrentBoard,
  parseBody,
  pickNameForFight,
  requireAdmin,
  serializeFight
} from "./_premium-data.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const admin = requireAdmin(req);
  if (!admin.ok) {
    return res.status(admin.status).json({ ok: false, error: admin.error });
  }

  try {
    const supabase = getSupabaseAdmin();

    if (req.method === "GET") {
      const board = await loadCurrentBoard(supabase);
      return res.status(200).json({ ok: true, ...board });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = parseBody(req.body);
    const action = String(body.action || "").trim();

    if (action === "saveEvent") {
      const event = await saveEvent(supabase, body.event || body);
      const board = await loadCurrentBoard(supabase);
      return res.status(200).json({ ok: true, event, ...board });
    }

    if (action === "saveFight") {
      const event = await ensureCurrentEvent(supabase);
      const fight = await saveFight(supabase, event.id, body.fight || body);
      return res.status(200).json({ ok: true, fight });
    }

    if (action === "deleteFight") {
      const fightId = cleanText(body.fightId, 80);
      if (!fightId) return res.status(400).json({ ok: false, error: "fightId is required." });

      const { error } = await supabase
        .from("premium_fights")
        .delete()
        .eq("id", fightId);

      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (action === "lockPick") {
      const result = await lockPick(supabase, body.fight || body, getOrigin(req));
      return res.status(200).json({ ok: true, ...result });
    }

    if (action === "unlockPick") {
      const fightId = cleanText(body.fightId, 80);
      if (!fightId) return res.status(400).json({ ok: false, error: "fightId is required." });

      const { data, error } = await supabase
        .from("premium_fights")
        .update({
          status: "pending",
          locked_at: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", fightId)
        .select("*")
        .single();

      if (error) throw error;
      return res.status(200).json({ ok: true, fight: serializeFight(data) });
    }

    if (action === "grantLifetimeAccess") {
      const result = await grantLifetimeAccess(supabase, body.subscriber || body, getOrigin(req));
      return res.status(200).json({ ok: true, ...result });
    }

    return res.status(400).json({ ok: false, error: "Unknown admin action." });
  } catch (error) {
    console.error("Admin picks error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Admin action failed."
    });
  }
}

async function saveEvent(supabase, eventBody) {
  const payload = {
    slug: CURRENT_EVENT_SLUG,
    name: cleanText(eventBody.name, 160) || "UFC Fight Night",
    headline: cleanText(eventBody.headline, 180) || "Current event board.",
    event_date: cleanText(eventBody.eventDate, 80) || "Next week",
    venue: cleanText(eventBody.venue, 160) || "TBA",
    market: cleanText(eventBody.market, 80) || "Head to head",
    release_status: cleanText(eventBody.releaseStatus, 80) || "Picks pending",
    alert_channel: cleanText(eventBody.alertChannel, 80) || "Push + feed",
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("premium_events")
    .upsert(payload, { onConflict: "slug" })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function saveFight(supabase, eventId, fightBody) {
  const payload = fightPayloadFromBody(fightBody, eventId);
  const fightId = cleanText(fightBody.id || fightBody.fightId, 80);

  if (!payload.red_corner || !payload.blue_corner) {
    throw new Error("Both fighter names are required.");
  }

  if (fightId) {
    const { data, error } = await supabase
      .from("premium_fights")
      .update(payload)
      .eq("id", fightId)
      .select("*")
      .single();

    if (error) throw error;
    return serializeFight(data);
  }

  const { data, error } = await supabase
    .from("premium_fights")
    .insert({
      ...payload,
      status: "pending"
    })
    .select("*")
    .single();

  if (error) throw error;
  return serializeFight(data);
}

async function lockPick(supabase, fightBody, origin) {
  const event = await ensureCurrentEvent(supabase);
  const fightId = cleanText(fightBody.id || fightBody.fightId, 80);

  if (!fightId) {
    throw new Error("fightId is required before a pick can be locked.");
  }

  const payload = fightPayloadFromBody(fightBody, event.id);

  if (!payload.pick_side) {
    throw new Error("Choose the red or blue corner before locking the pick.");
  }

  const lockedAt = new Date().toISOString();
  const { data: lockedFight, error: lockError } = await supabase
    .from("premium_fights")
    .update({
      ...payload,
      status: "locked",
      locked_at: lockedAt
    })
    .eq("id", fightId)
    .select("*")
    .single();

  if (lockError) throw lockError;

  const [notificationResult, emailResult] = await Promise.all([
    sendAlertSafely("push", () => sendPickNotification(supabase, event, lockedFight)),
    sendAlertSafely("email", () => sendPickLockEmails(supabase, event, lockedFight, origin))
  ]);

  return {
    fight: serializeFight(lockedFight),
    notification: notificationResult,
    email: emailResult
  };
}

async function grantLifetimeAccess(supabase, subscriberBody, origin) {
  const email = normalizeEmail(subscriberBody.email);

  if (!email) {
    throw new Error("Enter a valid subscriber email.");
  }

  const temporaryPassword = generateTemporaryPassword();
  const now = new Date().toISOString();

  const { data: existingSubscriber, error: existingSubscriberError } = await supabase
    .from("subscribers")
    .select("id, email, auth_user_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_status, access_status")
    .eq("email", email)
    .maybeSingle();

  if (existingSubscriberError) throw existingSubscriberError;

  const authUser = await ensureSubscriberAuthUser(
    supabase,
    email,
    temporaryPassword,
    existingSubscriber?.auth_user_id
  );

  const { data: subscriber, error: subscriberError } = await supabase
    .from("subscribers")
    .upsert({
      email,
      auth_user_id: authUser.id,
      plan_name: "lifetime",
      access_status: "active",
      current_period_start: now,
      current_period_end: null,
      cancel_at_period_end: false
    }, { onConflict: "email" })
    .select("id, email, auth_user_id, plan_name, access_status")
    .single();

  if (subscriberError) throw subscriberError;

  const emailResult = await sendLifetimeAccessEmail({
    email,
    temporaryPassword,
    origin
  });

  return {
    subscriber: {
      email: subscriber.email,
      accessStatus: subscriber.access_status,
      planName: subscriber.plan_name,
      authUserId: subscriber.auth_user_id,
      authUserCreated: authUser.created
    },
    email: emailResult
  };
}

async function ensureSubscriberAuthUser(supabase, email, temporaryPassword, existingAuthUserId) {
  const metadata = {
    source: "live-picks-admin-lifetime",
    access_type: "lifetime",
    temporary_password_issued_at: new Date().toISOString()
  };

  if (existingAuthUserId) {
    const { data, error } = await supabase.auth.admin.updateUserById(existingAuthUserId, {
      password: temporaryPassword,
      user_metadata: metadata
    });

    if (error) throw error;

    return {
      id: data?.user?.id || existingAuthUserId,
      created: false
    };
  }

  const { data: createdUserData, error: createUserError } = await supabase.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: metadata
  });

  if (!createUserError && createdUserData?.user?.id) {
    return {
      id: createdUserData.user.id,
      created: true
    };
  }

  const message = createUserError?.message || "Could not create Supabase user.";
  const lowerMessage = message.toLowerCase();

  if (!lowerMessage.includes("already") && !lowerMessage.includes("registered") && !lowerMessage.includes("duplicate")) {
    throw new Error(message);
  }

  const existingAuthUser = await findAuthUserByEmail(supabase, email);

  if (!existingAuthUser?.id) {
    throw new Error("An auth account already exists for this email, but it could not be linked automatically.");
  }

  const { data, error } = await supabase.auth.admin.updateUserById(existingAuthUser.id, {
    password: temporaryPassword,
    user_metadata: metadata
  });

  if (error) throw error;

  return {
    id: data?.user?.id || existingAuthUser.id,
    created: false
  };
}

async function findAuthUserByEmail(supabase, email) {
  const target = normalizeEmail(email);
  const perPage = 1000;

  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const user = (data?.users || []).find((candidate) => normalizeEmail(candidate.email) === target);
    if (user) return user;

    if (!data?.users?.length || data.users.length < perPage) break;
  }

  return null;
}

async function sendLifetimeAccessEmail({ email, temporaryPassword, origin }) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = cleanEmailSender(
    process.env.ACCESS_EMAIL_FROM ||
    process.env.RESEND_FROM_EMAIL ||
    process.env.EMAIL_FROM ||
    process.env.LOCK_ALERT_FROM_EMAIL
  );

  if (!apiKey || !from) {
    return {
      attempted: false,
      sent: 0,
      failed: 0,
      disabled: true,
      message: "Access email is not configured yet."
    };
  }

  const emailContent = buildLifetimeAccessEmail({ email, temporaryPassword, origin });
  const replyTo = cleanEmailSender(process.env.ACCESS_EMAIL_REPLY_TO || process.env.LOCK_ALERT_REPLY_TO || process.env.ADMIN_EMAIL);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        ...(replyTo ? { reply_to: replyTo } : {})
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn("Lifetime access email failed:", {
        recipient: email,
        status: response.status,
        body: text.slice(0, 500)
      });

      return {
        attempted: true,
        sent: 0,
        failed: 1,
        total: 1,
        message: "Lifetime access was created, but the email did not send."
      };
    }

    return {
      attempted: true,
      sent: 1,
      failed: 0,
      total: 1,
      message: "Access email sent."
    };
  } catch (error) {
    console.warn("Lifetime access email failed:", {
      recipient: email,
      message: error.message
    });

    return {
      attempted: true,
      sent: 0,
      failed: 1,
      total: 1,
      message: "Lifetime access was created, but the email did not send."
    };
  }
}

function buildLifetimeAccessEmail({ email, temporaryPassword, origin }) {
  const loginUrl = `${origin}/portal.html`;
  const accountUrl = `${origin}/account.html`;
  const feedUrl = `${origin}/premium-feed.html`;
  const pushGuideUrl = `${origin}/push-guide.html`;
  const subject = "Your Live Picks lifetime access is ready";
  const preview = "Congratulations, your Live Picks premium access is ready.";

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f6f1;color:#111511;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preview)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6f1;margin:0;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #dfe7dc;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:20px 24px;background:#071008;color:#ffffff;">
                <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#9df2bd;font-weight:800;">Lifetime premium access</div>
                <h1 style="margin:8px 0 0;font-size:28px;line-height:1.15;color:#ffffff;">Congratulations, you are in.</h1>
                <p style="margin:9px 0 0;font-size:14px;line-height:1.5;color:#d9e8dc;">Your Live Picks premium account has been activated with lifetime free access.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#243027;">Use these details to log in, then update your password from the account page.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f7faf5;border:1px solid #e1eadf;border-radius:10px;overflow:hidden;">
                  ${emailRow("Login email", email)}
                  ${emailRow("Temporary password", temporaryPassword)}
                </table>
                <div style="margin-top:22px;">
                  <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#25c26e;color:#061009;text-decoration:none;font-weight:900;font-size:14px;padding:13px 18px;border-radius:999px;">Log in to Live Picks</a>
                </div>
                <div style="margin-top:22px;padding:16px;background:#f7faf5;border:1px solid #e1eadf;border-radius:10px;">
                  <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#60705f;font-weight:800;">Next steps</div>
                  <ol style="margin:10px 0 0;padding-left:20px;color:#243027;font-size:14px;line-height:1.65;">
                    <li>Log in with your email and temporary password.</li>
                    <li>Open <a href="${escapeHtml(accountUrl)}" style="color:#1f8a53;font-weight:800;">Manage Account</a> and set your own password/details.</li>
                    <li>Open the <a href="${escapeHtml(feedUrl)}" style="color:#1f8a53;font-weight:800;">Premium Feed</a> and follow the push notification instructions so you receive live alerts.</li>
                  </ol>
                </div>
                <p style="margin:18px 0 0;font-size:13px;line-height:1.55;color:#59665c;">On iPhone, push alerts may need the Home Screen setup first. Use the <a href="${escapeHtml(pushGuideUrl)}" style="color:#1f8a53;font-weight:800;">push notification guide</a> if Safari says notifications are unsupported.</p>
                <p style="margin:18px 0 0;font-size:12px;line-height:1.55;color:#6a756b;">Live Picks is independent analytics and commentary. It does not operate as a bookmaker, accept wagers, place wagers for customers, or guarantee outcomes.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "Congratulations, you are in.",
    "",
    "Your Live Picks premium account has been activated with lifetime free access.",
    "",
    `Login email: ${email}`,
    `Temporary password: ${temporaryPassword}`,
    "",
    `Log in: ${loginUrl}`,
    `Manage account and set your details: ${accountUrl}`,
    `Premium feed: ${feedUrl}`,
    "",
    "Please follow the push notification instructions so you receive live alerts.",
    `Push notification guide: ${pushGuideUrl}`,
    "",
    "Live Picks is independent analytics and commentary. It does not operate as a bookmaker, accept wagers, place wagers for customers, or guarantee outcomes."
  ].join("\n");

  return { subject, html, text };
}

async function sendAlertSafely(channel, task) {
  try {
    return await task();
  } catch (error) {
    console.error(`${channel} lock alert failed:`, error);

    return {
      attempted: true,
      sent: 0,
      failed: 0,
      error: true,
      message: `${titleCase(channel)} alerts failed after the pick was locked.`
    };
  }
}

async function sendPickNotification(supabase, event, fight) {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
  const subject = normalizeVapidSubject(process.env.VAPID_SUBJECT || process.env.ADMIN_EMAIL);

  if (!publicKey || !privateKey) {
    return {
      attempted: false,
      sent: 0,
      failed: 0,
      disabled: true,
      message: "VAPID keys are not configured, so the pick was locked without push notifications."
    };
  }

  let webpush;
  try {
    const imported = await import("web-push");
    webpush = imported.default || imported;
  } catch (error) {
    return {
      attempted: false,
      sent: 0,
      failed: 0,
      disabled: true,
      message: "Install the web-push dependency before sending notifications."
    };
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  } catch (error) {
    console.error("Push VAPID configuration error:", error);

    return {
      attempted: false,
      sent: 0,
      failed: 0,
      disabled: true,
      message: "VAPID push settings are invalid, so the pick was locked without push notifications."
    };
  }

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from("push_subscriptions")
    .select("id, subscription")
    .eq("active", true);

  if (subscriptionError) throw subscriptionError;

  if (!subscriptions?.length) {
    return {
      attempted: true,
      sent: 0,
      failed: 0,
      inactive: 0,
      total: 0,
      message: "No active push subscriptions were found."
    };
  }

  const pickName = pickNameForFight(fight);
  const title = "Live Pick Locked";
  const body = `${pickName} locked for ${fight.red_corner} vs ${fight.blue_corner}.`;
  const payload = JSON.stringify({
    title,
    body,
    url: `/premium-feed.html#fight-${fight.id}`,
    fightId: fight.id,
    eventName: event.name
  });

  let sent = 0;
  let failed = 0;
  const inactiveIds = [];

  await Promise.all((subscriptions || []).map(async (record) => {
    try {
      await webpush.sendNotification(parseStoredSubscription(record.subscription), payload);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn("Push notification failed:", {
        id: record.id,
        statusCode: error.statusCode || null,
        message: error.message
      });

      if (error.statusCode === 404 || error.statusCode === 410) {
        inactiveIds.push(record.id);
      }
    }
  }));

  if (inactiveIds.length) {
    await supabase
      .from("push_subscriptions")
      .update({ active: false, updated_at: new Date().toISOString() })
      .in("id", inactiveIds);
  }

  return {
    attempted: true,
    sent,
    failed,
    inactive: inactiveIds.length,
    total: subscriptions.length,
    message: `Push sent: ${sent}. Failed: ${failed}.`
  };
}

async function sendPickLockEmails(supabase, event, fight, origin) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = cleanEmailSender(
    process.env.LOCK_ALERT_FROM_EMAIL ||
    process.env.RESEND_FROM_EMAIL ||
    process.env.EMAIL_FROM
  );

  if (!apiKey || !from) {
    return {
      attempted: false,
      sent: 0,
      failed: 0,
      disabled: true,
      message: "Email lock alerts are not configured yet."
    };
  }

  const { data: subscribers, error: subscribersError } = await supabase
    .from("subscribers")
    .select("id, email, access_status, stripe_subscription_status")
    .or("access_status.eq.active,stripe_subscription_status.in.(active,trialing)");

  if (subscribersError) throw subscribersError;

  const recipients = uniqueEmails((subscribers || [])
    .filter(isActiveSubscriber)
    .map((subscriber) => subscriber.email));

  if (!recipients.length) {
    return {
      attempted: true,
      sent: 0,
      failed: 0,
      total: 0,
      message: "No active subscriber emails were found."
    };
  }

  const email = buildPickLockEmail(event, fight, origin);
  const replyTo = cleanEmailSender(process.env.LOCK_ALERT_REPLY_TO || process.env.ADMIN_EMAIL);
  let sent = 0;
  let failed = 0;

  await Promise.all(recipients.map(async (recipient) => {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from,
          to: recipient,
          subject: email.subject,
          html: email.html,
          text: email.text,
          ...(replyTo ? { reply_to: replyTo } : {})
        })
      });

      if (!response.ok) {
        failed += 1;
        const text = await response.text().catch(() => "");
        console.warn("Lock email failed:", {
          recipient,
          status: response.status,
          body: text.slice(0, 500)
        });
        return;
      }

      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn("Lock email failed:", {
        recipient,
        message: error.message
      });
    }
  }));

  return {
    attempted: true,
    sent,
    failed,
    total: recipients.length,
    message: `Email sent: ${sent}. Failed: ${failed}.`
  };
}

function buildPickLockEmail(event, fight, origin) {
  const pickName = pickNameForFight(fight);
  const matchup = `${fight.red_corner || "Red corner"} vs ${fight.blue_corner || "Blue corner"}`;
  const lockedAt = formatLockTime(fight.locked_at);
  const feedUrl = `${origin}/premium-feed.html#fight-${encodeURIComponent(fight.id)}`;
  const confidence = cleanText(fight.confidence, 80) || "Official lock";
  const note = cleanText(fight.note, 900);
  const subject = `Live Pick Locked: ${pickName}`;
  const preview = `${pickName} has locked for ${matchup}.`;

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f6f1;color:#111511;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preview)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6f1;margin:0;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #dfe7dc;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:18px 22px;background:#071008;color:#ffffff;">
                <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#9df2bd;font-weight:800;">Premium lock alert</div>
                <h1 style="margin:8px 0 0;font-size:26px;line-height:1.15;color:#ffffff;">${escapeHtml(pickName)}</h1>
                <p style="margin:8px 0 0;font-size:14px;line-height:1.5;color:#d9e8dc;">${escapeHtml(matchup)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:22px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                  ${emailRow("Event", event.name || "Current event")}
                  ${emailRow("Status", "Official pick locked")}
                  ${emailRow("Confidence", confidence)}
                  ${emailRow("Locked", lockedAt)}
                </table>
                ${note ? `<div style="margin-top:18px;padding:16px;background:#f7faf5;border:1px solid #e1eadf;border-radius:10px;">
                  <div style="font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#60705f;font-weight:800;">Final read note</div>
                  <p style="margin:8px 0 0;font-size:15px;line-height:1.55;color:#1d251f;">${escapeHtml(note)}</p>
                </div>` : ""}
                <div style="margin-top:22px;">
                  <a href="${escapeHtml(feedUrl)}" style="display:inline-block;background:#25c26e;color:#061009;text-decoration:none;font-weight:900;font-size:14px;padding:13px 18px;border-radius:999px;">Open premium feed</a>
                </div>
                <p style="margin:20px 0 0;font-size:12px;line-height:1.55;color:#6a756b;">Live Picks is independent analytics and commentary. It does not operate as a bookmaker, accept wagers, place wagers for customers, or guarantee outcomes.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "Live Picks premium lock alert",
    "",
    `Pick: ${pickName}`,
    `Matchup: ${matchup}`,
    `Event: ${event.name || "Current event"}`,
    `Confidence: ${confidence}`,
    `Locked: ${lockedAt}`,
    note ? `Final read note: ${note}` : "",
    "",
    `Open premium feed: ${feedUrl}`,
    "",
    "Live Picks is independent analytics and commentary. It does not operate as a bookmaker, accept wagers, place wagers for customers, or guarantee outcomes."
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

function emailRow(label, value) {
  return `<tr>
    <td style="padding:11px 0;border-bottom:1px solid #edf2ea;font-size:12px;letter-spacing:0.05em;text-transform:uppercase;color:#667267;font-weight:800;width:34%;">${escapeHtml(label)}</td>
    <td style="padding:11px 0;border-bottom:1px solid #edf2ea;font-size:15px;line-height:1.45;color:#111511;font-weight:800;">${escapeHtml(value)}</td>
  </tr>`;
}

function normalizeVapidSubject(value) {
  const subject = String(value || "").trim();

  if (!subject) return "mailto:admin@livepicks.local";
  if (/^(mailto:|https:\/\/)/i.test(subject)) return subject;
  if (subject.includes("@")) return `mailto:${subject}`;

  return "mailto:admin@livepicks.local";
}

function parseStoredSubscription(subscription) {
  const parsed = typeof subscription === "string" ? JSON.parse(subscription) : subscription;

  if (!parsed?.endpoint || !parsed?.keys?.p256dh || !parsed?.keys?.auth) {
    const error = new Error("Stored push subscription is invalid.");
    error.statusCode = 410;
    throw error;
  }

  return parsed;
}

function isActiveSubscriber(subscriber) {
  return (
    subscriber?.access_status === "active" ||
    subscriber?.stripe_subscription_status === "active" ||
    subscriber?.stripe_subscription_status === "trialing"
  );
}

function uniqueEmails(values) {
  return [...new Set(values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))];
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function cleanEmailSender(value) {
  const sender = String(value || "").trim().replace(/^mailto:/i, "");
  return sender && sender.includes("@") ? sender : "";
}

function generateTemporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.randomBytes(18);
  let password = "";

  for (const byte of bytes) {
    password += alphabet[byte % alphabet.length];
  }

  return password;
}

function formatLockTime(value) {
  if (!value) return "Just now";

  try {
    return new Intl.DateTimeFormat("en-AU", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: process.env.LOCK_ALERT_TIME_ZONE || "Australia/Perth"
    }).format(new Date(value));
  } catch (_) {
    return new Date(value).toUTCString();
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[character]));
}

function titleCase(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function getOrigin(req) {
  const configuredUrl = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";

  return `${proto}://${host}`;
}
