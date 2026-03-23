/**
 * POST /api/order-lookup
 * Body: { orderNumber: string, email: string }
 *
 * Looks up a Shopify order via the Admin API and returns sanitized order data.
 * The email check in shopifyAdmin.lookupOrder ensures customers can only
 * see their own orders — no auth session required.
 */
import { lookupOrder } from '@/lib/shopifyAdmin';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const orderNumber = typeof body.orderNumber === 'string' ? body.orderNumber.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';

  if (!orderNumber || !email) {
    return Response.json({ error: 'Order number and email are required.' }, { status: 400 });
  }

  try {
    const order = await lookupOrder(orderNumber, email);
    if (!order) {
      return Response.json(
        { error: "We couldn't find an order matching that number and email. Please double-check and try again." },
        { status: 404 }
      );
    }
    return Response.json({ order });
  } catch (err) {
    console.error('[order-lookup]', err.message);
    return Response.json(
      { error: 'Unable to look up your order right now. Please try again later.' },
      { status: 502 }
    );
  }
}
