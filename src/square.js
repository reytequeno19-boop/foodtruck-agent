// ============================================================================
// src/square.js — Cliente multi-location de Square
// ============================================================================
// "Square as source of truth" — leemos menú y horarios en tiempo real
// ============================================================================

const { Client, Environment } = require('square');
const config = require('./config');

const client = new Client({
  accessToken: config.square.accessToken,
  environment: config.square.environment === 'production'
    ? Environment.Production
    : Environment.Sandbox,
});

// In-memory cache para no martillar la API en cada llamada
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const cache = {
  catalog: { data: null, expiresAt: 0 },
  locations: { data: null, expiresAt: 0 },
};

function isCacheValid(entry) {
  return entry.data !== null && Date.now() < entry.expiresAt;
}

// ============================================================================
// LOCATIONS
// ============================================================================

async function listActiveLocations() {
  if (isCacheValid(cache.locations)) return cache.locations.data;

  const { result } = await client.locationsApi.listLocations();
  const active = (result.locations || []).filter(loc => loc.status === 'ACTIVE');

  cache.locations = {
    data: active,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return active;
}

async function getLocation(locationId) {
  const locations = await listActiveLocations();
  return locations.find(l => l.id === locationId);
}

function isLocationOpenNow(location, now = new Date()) {
  // Square business_hours format: { periods: [{ day_of_week, start_local_time, end_local_time }] }
  const hours = location.businessHours || location.business_hours;
  if (!hours || !hours.periods || hours.periods.length === 0) {
    // Si no hay horarios configurados, asumimos abierto (legacy behavior)
    return { isOpen: true, reason: 'no_hours_configured' };
  }

  const dayOfWeek = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][now.getDay()];
  const currentTime = now.toTimeString().slice(0, 8); // "HH:MM:SS"

  const todayPeriods = hours.periods.filter(p => p.dayOfWeek === dayOfWeek || p.day_of_week === dayOfWeek);

  for (const period of todayPeriods) {
    const start = period.startLocalTime || period.start_local_time;
    const end = period.endLocalTime || period.end_local_time;
    if (currentTime >= start && currentTime <= end) {
      return { isOpen: true, period };
    }
  }
  return {
    isOpen: false,
    reason: 'outside_hours',
    todayPeriods,
    nextOpening: getNextOpening(hours.periods, now),
  };
}

function getNextOpening(periods, now) {
  // Devuelve el próximo horario de apertura
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  for (let i = 0; i < 7; i++) {
    const checkDate = new Date(now.getTime() + i * 86400 * 1000);
    const dayOfWeek = days[checkDate.getDay()];
    const periodsForDay = periods.filter(p => (p.dayOfWeek || p.day_of_week) === dayOfWeek);
    if (periodsForDay.length === 0) continue;
    const start = periodsForDay[0].startLocalTime || periodsForDay[0].start_local_time;
    if (i === 0) {
      const currentTime = now.toTimeString().slice(0, 8);
      if (currentTime >= start) continue;
    }
    return {
      date: checkDate.toISOString().slice(0, 10),
      day: dayOfWeek,
      start_time: start,
    };
  }
  return null;
}

// ============================================================================
// CATALOG
// ============================================================================

async function loadFullCatalog() {
  if (isCacheValid(cache.catalog)) return cache.catalog.data;

  const items = [];
  let cursor = undefined;
  do {
    const { result } = await client.catalogApi.searchCatalogObjects({
      objectTypes: ['ITEM'],
      limit: 100,
      cursor,
    });
    if (result.objects) items.push(...result.objects);
    cursor = result.cursor;
  } while (cursor);

  // Index by name (lowercased) for fast matching
  const byName = {};
  const byVariationId = {};
  const allVariations = [];

  for (const item of items) {
    const name = (item.itemData?.name || '').trim();
    const lowerName = name.toLowerCase();
    if (!byName[lowerName]) byName[lowerName] = [];
    byName[lowerName].push(item);

    for (const variation of (item.itemData?.variations || [])) {
      const vd = variation.itemVariationData || {};
      const basePrice = vd.priceMoney?.amount ? Number(vd.priceMoney.amount) / 100 : 0;
      const flat = {
        item_id: item.id,
        item_name: name,
        item_description: item.itemData?.description || '',
        variation_id: variation.id,
        variation_name: vd.name || 'Default',
        base_price: basePrice,
        pricing_type: vd.pricingType || 'FIXED_PRICING',
        location_overrides: vd.locationOverrides || [],
        present_at_locations: item.presentAtLocationIds || [],
        absent_at_locations: item.absentAtLocationIds || [],
        present_at_all: item.presentAtAllLocations !== false,
      };
      byVariationId[variation.id] = flat;
      allVariations.push(flat);
    }
  }

  const catalog = { items, byName, byVariationId, allVariations };
  cache.catalog = { data: catalog, expiresAt: Date.now() + CACHE_TTL_MS };
  return catalog;
}

function getPriceForLocation(variationFlat, locationId) {
  // Si hay override con precio fijo para esa location, úsalo
  for (const override of variationFlat.location_overrides) {
    if (override.locationId === locationId || override.location_id === locationId) {
      const overridePrice = override.priceMoney?.amount;
      if (overridePrice !== undefined && overridePrice !== null) {
        return Number(overridePrice) / 100;
      }
    }
  }
  return variationFlat.base_price;
}

function isAvailableAtLocation(variationFlat, locationId) {
  if (variationFlat.absent_at_locations.includes(locationId)) return false;
  if (variationFlat.present_at_all) return true;
  return variationFlat.present_at_locations.includes(locationId);
}

async function findItemByNameForLocation(searchName, locationId) {
  const catalog = await loadFullCatalog();
  const cleanQuery = searchName.toLowerCase().trim();

  // Búsqueda flexible: contiene
  const matches = [];
  for (const variation of catalog.allVariations) {
    const itemName = variation.item_name.toLowerCase();
    const variationName = variation.variation_name.toLowerCase();
    const combined = `${itemName} ${variationName}`;
    
    if (combined.includes(cleanQuery) && isAvailableAtLocation(variation, locationId)) {
      const price = getPriceForLocation(variation, locationId);
      if (price > 0) { // Solo retornar items con precio válido
        matches.push({ ...variation, price_for_location: price });
      }
    }
  }
  return matches;
}

// ============================================================================
// ORDERS & PAYMENT LINKS
// ============================================================================

async function createOrderInLocation({ locationId, lineItems, customerNote }) {
  const idempotencyKey = `order-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  
  const { result } = await client.ordersApi.createOrder({
    idempotencyKey,
    order: {
      locationId,
      lineItems: lineItems.map(li => ({
        catalogObjectId: li.variation_id,
        quantity: String(li.quantity),
        note: li.note,
      })),
      ...(customerNote && { source: { name: customerNote } }),
    },
  });

  return result.order;
}

async function createPaymentLink({ orderId, description }) {
  const idempotencyKey = `link-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const { result } = await client.checkoutApi.createPaymentLink({
    idempotencyKey,
    order: { orderId },
    description: description || 'Rey Tequeño - Payment',
  });
  return result.paymentLink;
}

// ============================================================================
// CACHE INVALIDATION (manual)
// ============================================================================

function invalidateCache() {
  cache.catalog.expiresAt = 0;
  cache.locations.expiresAt = 0;
}

module.exports = {
  client,
  // Locations
  listActiveLocations,
  getLocation,
  isLocationOpenNow,
  // Catalog
  loadFullCatalog,
  findItemByNameForLocation,
  getPriceForLocation,
  isAvailableAtLocation,
  // Orders
  createOrderInLocation,
  createPaymentLink,
  // Cache
  invalidateCache,
};
