/**
 * Discount / marketing email signup.
 * Wire this to Shopify Email, Klaviyo, Mailchimp, or a webhook (see README).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email || !EMAIL_RE.test(email)) {
    return Response.json({ error: 'Please enter a valid email address.' }, { status: 400 });
  }

  const webhook = process.env.SUBSCRIBE_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          source: 'storefront-discount-signup',
          subscribedAt: new Date().toISOString(),
        }),
      });
    } catch {
      return Response.json({ error: 'Could not complete signup. Try again later.' }, { status: 502 });
    }
  } else {
    // Dev / default: accept signup without external integration
    console.info('[subscribe]', email);
  }

  return Response.json({
    ok: true,
    message: "You're on the list — watch your inbox for discounts and new drops.",
  });
}
