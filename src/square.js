// src/square.js
// Square integration: fetch menu, create order, create payment link, get order status.
// Uses Square SDK v39+ pattern.

const { Client, Environment } = require('square');
const crypto = require('crypto');

let client = null;
function getClient() {
  if (client) return client;
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('SQUARE_ACCESS_TOKEN must be set');
  }
  const envName = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const environment = envName === 'sandbox' ? Environment.Sandbox : Environment.Production;
  client = new Client({
    accessToken,
    environment,
  });
  return client;
}

function getLocationId() {
  const id = process.env.SQUARE_LOCATION_ID;
  if (!id) throw new Error('SQUARE_LOCATION_ID must be set');
  return id;
}

// BigInt-safe JSON conversion (Square SDK returns BigInt for money amounts)
function bigIntSafe(obj) {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  );
}

/**
 * Fetch the menu from the Square catalog (only active items at our location).
 */
async function getMenu() {
  const c = getClient();
  const locationId = getLocationId();

  const { result } = await c.catalogApi.searchCatalogObjects({
    objectTypes: ['ITEM'],
    includeRelatedObjects: false,
    limit: 200,
  });

  const objects = result.objects || [];
  const items = [];

  for (const obj of objects) {
    if (obj.isDeleted) continue;
    const data = obj.itemData || {};
    if (data.isArchived) continue;

    const presentAtAll = obj.presentAtAllLocations;
    const presentIds = obj.presentAtLocationIds || [];
    const absentIds = obj.absentAtLocationIds || [];
    const presentHere = presentAtAll
      ? !absentIds.includes(locationId)
      : presentIds.includes(locationId);
    if (!presentHere) continue;

    const variations = (data.variations || []).map((v) => {
      const vd = v.itemVariationData || {};
      const price = vd.priceMoney
        ? Number(vd.priceMoney.amount) / 100
        : null;
      return {
        id: v.id,
        name: vd.name || 'Default',
        price_usd: price,
      };
    });

    items.push({
      id: obj.id,
      name: data.name,
      description: data.description || '',
      variations,
    });
  }

  return { success: true, items, count: items.length };
}

/**
 * Create a Square order with given line items.
 */
async function createOrder(lineItems, customerName = '') {
  const c = getClient();
  const locationId = getLocationId();

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { success: false, error: 'No line items provided' };
  }

  const orderLineItems = lineItems.map((li) => ({
    catalogObjectId: li.catalog_object_id || li.catalogObjectId,
    quantity: String(li.quantity || 1),
  }));

  try {
    const { result } = await c.ordersApi.createOrder({
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId,
        lineItems: orderLineItems,
        ...(customerName
          ? { metadata: { customer_name: customerName.slice(0, 60) } }
          : {}),
      },
    });

    const order = result.order || {};
    const total = order.totalMoney ? Number(order.totalMoney.amount) : 0;
    return {
      success: true,
      order_id: order.id,
      total_money_cents: total,
      total_money_usd: total / 100,
      currency: order.totalMoney ? order.totalMoney.currency : 'USD',
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      details: err.errors || null,
    };
  }
}

/**
 * Create a Square Payment Link for an existing order.
 */
async function createPaymentLink(orderId, customerName = '') {
  const c = getClient();
  const locationId = getLocationId();

  if (!orderId) {
    return { success: false, error: 'order_id required' };
  }

  try {
    const { result } = await c.checkoutApi.createPaymentLink({
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId,
      },
    });

    return bigIntSafe({
      success: true,
      payment_link: result.paymentLink,
      url: result.paymentLink ? result.paymentLink.url : null,
    });
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      details: err.errors || null,
    };
  }
}

/**
 * Combined helper: create order + create payment link in one call.
 */
async function createOrderWithPaymentLink(lineItems, customerName = '', note = '') {
  const c = getClient();
  const locationId = getLocationId();

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { success: false, error: 'No line items provided' };
  }

  const orderLineItems = lineItems.map((li) => ({
    catalogObjectId: li.catalog_object_id || li.catalogObjectId,
    quantity: String(li.quantity || 1),
  }));

  try {
    const { result } = await c.checkoutApi.createPaymentLink({
      idempotencyKey: crypto.randomUUID(),
      order: {
        locationId,
        lineItems: orderLineItems,
        ...(customerName
          ? {
              metadata: {
                customer_name: customerName.slice(0, 60),
                source: 'voice_agent',
              },
            }
          : { metadata: { source: 'voice_agent' } }),
      },
      checkoutOptions: {
        allowTipping: true,
        ...(note ? { customFields: [{ title: note.slice(0, 50) }] } : {}),
      },
    });

    const link = result.paymentLink || {};
    const order = result.relatedResources && result.relatedResources.orders
      ? result.relatedResources.orders[0]
      : null;
    const totalCents = order && order.totalMoney
      ? Number(order.totalMoney.amount)
      : 0;

    return bigIntSafe({
      success: true,
      order_id: link.orderId,
      payment_url: link.url,
      payment_link_id: link.id,
      total_usd: totalCents / 100,
      total_cents: totalCents,
    });
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      details: err.errors || null,
    };
  }
}

/**
 * Retrieve an order by ID (status check).
 */
async function getOrder(orderId) {
  const c = getClient();
  if (!orderId) {
    return { success: false, error: 'order_id required' };
  }
  try {
    const { result } = await c.ordersApi.retrieveOrder(orderId);
    return bigIntSafe({ success: true, order: result.order });
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      details: err.errors || null,
    };
  }
}

module.exports = {
  getMenu,
  createOrder,
  createPaymentLink,
  createOrderWithPaymentLink,
  getOrder,
};
