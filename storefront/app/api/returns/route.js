/**
 * POST /api/returns
 * Body: { orderNumber, email, lineItemId, quantity, reason, customerNote }
 *
 * Verifies the order belongs to the email, then creates a Shopify return.
 * Shopify automatically notifies the customer and generates a return label
 * if your shipping settings are configured in the Admin.
 */
import { lookupOrder, createReturn } from '@/lib/shopifyAdmin';

const VALID_REASONS = [
  'Item damaged / DOA',
  'Wrong item received',
  'Changed my mind',
  'Compatibility issue',
  'Other',
];

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { orderNumber, email, lineItemId, quantity, reason, customerNote } = body;

  // Basic validation
  if (!orderNumber || !email || !lineItemId || !reason) {
    return Response.json({ error: 'Missing required fields.' }, { status: 400 });
  }
  if (!VALID_REASONS.includes(reason)) {
    return Response.json({ error: 'Invalid return reason.' }, { status: 400 });
  }
  const qty = parseInt(quantity, 10);
  if (!qty || qty < 1) {
    return Response.json({ error: 'Invalid quantity.' }, { status: 400 });
  }

  try {
    // Re-verify ownership before creating the return
    const order = await lookupOrder(orderNumber, email);
    if (!order) {
      return Response.json(
        { error: "We couldn't verify your order. Please check your order number and email." },
        { status: 404 }
      );
    }

    // Make sure the lineItem belongs to this order
    const lineItems = order.lineItems?.nodes ?? [];
    const lineItem = lineItems.find((li) => li.id === lineItemId);
    if (!lineItem) {
      return Response.json({ error: 'Line item not found on this order.' }, { status: 400 });
    }
    if (lineItem.refundableQuantity < qty) {
      return Response.json(
        { error: `Only ${lineItem.refundableQuantity} unit(s) are eligible for return.` },
        { status: 400 }
      );
    }

    const result = await createReturn({
      orderId: order.id,
      lineItemId,
      quantity: qty,
      reason,
      customerNote: typeof customerNote === 'string' ? customerNote.slice(0, 500) : '',
    });

    return Response.json({
      ok: true,
      rmaNumber: result.rmaNumber,
      message:
        "Your return has been submitted. Check your email for a prepaid return label. " +
        "Once we receive the item, your refund will be processed within 5–10 business days.",
    });
  } catch (err) {
    console.error('[returns]', err.message);
    return Response.json(
      { error: err.message || 'Unable to submit your return right now. Please try again later.' },
      { status: 502 }
    );
  }
}
