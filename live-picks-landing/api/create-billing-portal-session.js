const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const ACTIVE_SUBSCRIPTION_PRIORITY = ['active', 'trialing', 'past_due', 'unpaid', 'paused'];
const VALID_FLOWS = new Set(['billing', 'change_plan', 'cancel', 'payment_method']);

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return req.body;
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function makeError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getOrigin(req) {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/$/, '');
  }

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}`;
}

async function stripeRequest(method, path, params) {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw makeError('Missing STRIPE_SECRET_KEY on the server.', 500);
  }

  const isGet = method.toUpperCase() === 'GET';
  const query = params ? params.toString() : '';
  const url = `${STRIPE_API_BASE}${path}${isGet && query ? `?${query}` : ''}`;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' })
    },
    ...(isGet ? {} : { body: query })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw makeError(data?.error?.message || 'Stripe request failed.', response.status);
  }

  return data;
}

async function verifySupabasePassword(email, password) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw makeError('Missing SUPABASE_URL or SUPABASE_ANON_KEY on the server.', 500);
  }

  const url = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/token?grant_type=password`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    throw makeError('Password verification failed. Check your current password and try again.', 401);
  }
}

async function listSubscriptionsForCustomer(customerId) {
  const params = new URLSearchParams({
    customer: customerId,
    status: 'all',
    limit: '10'
  });

  const subscriptions = await stripeRequest('GET', '/subscriptions', params);
  return subscriptions.data || [];
}

function chooseBestSubscription(subscriptions) {
  if (!subscriptions.length) return null;

  for (const status of ACTIVE_SUBSCRIPTION_PRIORITY) {
    const match = subscriptions.find((subscription) => subscription.status === status);
    if (match) return match;
  }

  return subscriptions[0];
}

async function findCustomerAndSubscription(email) {
  const customers = await stripeRequest('GET', '/customers', new URLSearchParams({
    email,
    limit: '10'
  }));

  const matchingCustomers = customers.data || [];

  if (!matchingCustomers.length) {
    throw makeError('No Stripe customer was found for this email.', 404);
  }

  let fallbackCustomer = matchingCustomers[0];
  let fallbackSubscription = null;

  for (const customer of matchingCustomers) {
    const subscriptions = await listSubscriptionsForCustomer(customer.id);
    const subscription = chooseBestSubscription(subscriptions);

    if (!fallbackSubscription && subscription) {
      fallbackCustomer = customer;
      fallbackSubscription = subscription;
    }

    if (subscription && ACTIVE_SUBSCRIPTION_PRIORITY.includes(subscription.status)) {
      return { customer, subscription };
    }
  }

  return { customer: fallbackCustomer, subscription: fallbackSubscription };
}

function buildPortalParams({ customerId, subscriptionId, flow, returnUrl }) {
  const params = new URLSearchParams({
    customer: customerId,
    return_url: returnUrl
  });

  if (process.env.STRIPE_PORTAL_CONFIGURATION_ID) {
    params.set('configuration', process.env.STRIPE_PORTAL_CONFIGURATION_ID);
  }

  if (flow === 'payment_method') {
    params.set('flow_data[type]', 'payment_method_update');
    params.set('flow_data[after_completion][type]', 'redirect');
    params.set('flow_data[after_completion][redirect][return_url]', returnUrl);
  }

  if (flow === 'change_plan') {
    if (!subscriptionId) {
      throw makeError('No Stripe subscription was found for plan changes.', 404);
    }

    params.set('flow_data[type]', 'subscription_update');
    params.set('flow_data[subscription_update][subscription]', subscriptionId);
    params.set('flow_data[after_completion][type]', 'redirect');
    params.set('flow_data[after_completion][redirect][return_url]', returnUrl);
  }

  if (flow === 'cancel') {
    if (!subscriptionId) {
      throw makeError('No Stripe subscription was found to cancel.', 404);
    }

    params.set('flow_data[type]', 'subscription_cancel');
    params.set('flow_data[subscription_cancel][subscription]', subscriptionId);
    params.set('flow_data[after_completion][type]', 'redirect');
    params.set('flow_data[after_completion][redirect][return_url]', returnUrl);
  }

  return params;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'Method not allowed.' });
  }

  try {
    const body = parseBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const currentPassword = String(body.currentPassword || '');
    const requestedFlow = String(body.flow || 'billing').trim();
    const flow = VALID_FLOWS.has(requestedFlow) ? requestedFlow : 'billing';

    if (!email || !email.includes('@')) {
      throw makeError('A valid account email is required.', 400);
    }

    if (!currentPassword) {
      throw makeError('Current password is required before opening billing settings.', 400);
    }

    await verifySupabasePassword(email, currentPassword);

    const { customer, subscription } = await findCustomerAndSubscription(email);
    const returnUrl = `${getOrigin(req)}/account.html?billing=return&flow=${encodeURIComponent(flow)}`;
    const params = buildPortalParams({
      customerId: customer.id,
      subscriptionId: subscription?.id,
      flow,
      returnUrl
    });

    const session = await stripeRequest('POST', '/billing_portal/sessions', params);

    return json(res, 200, {
      ok: true,
      url: session.url,
      customerId: customer.id,
      subscriptionStatus: subscription?.status || null
    });
  } catch (error) {
    console.error('create-billing-portal-session error:', error);
    const statusCode = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return json(res, statusCode, {
      ok: false,
      error: error.message || 'Could not create billing portal session.'
    });
  }
};
