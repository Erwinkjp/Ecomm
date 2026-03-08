/**
 * AWS Lambda handler – Synnex data/inventory sync.
 * Uses the synnex script in this repo to fetch products and price/availability from TD Synnex.
 */
const synnex = require('./synnex');

exports.handler = async (event, context) => {
  const result = {
    productsFetched: 0,
    productsWithAvailability: [],
    errors: [],
    requestId: context.awsRequestId,
  };

  try {
    const products = await synnex.getProductsWithAvailability();
    result.productsFetched = products.length;
    result.productsWithAvailability = products.map((p) => ({
      partNumber: p.partNumber,
      description: p.description,
      quantityAvailable: p.quantityAvailable,
      price: p.price,
      currency: p.currency,
    }));
  } catch (err) {
    result.errors.push(err.message || String(err));
  }

  return result;
};
