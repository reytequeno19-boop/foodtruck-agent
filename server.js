// ============================================================================
// server.js — Backend multi-tenant para María (4 food trucks)
// ============================================================================
// Endpoints que María (Vapi) llama:
//   POST /tools/get_business_info
//   POST /tools/find_menu_item
//   POST /tools/create_order
//   POST /tools/send_payment_link
//   POST /tools/transfer_to_human
//   POST /tools/check_open_now
//
// Endpoint para el panel admin:
//   GET  /admin/trucks
//   GET  /admin/trucks/:id/metrics
//   POST /admin/maria-config/:truckId  (actualizar prompt/voz)
//   POST /admin/claude/chat            (proxy a Anthropic API)
// ============================================================================

const express = require('express');
const config = require('./src/config');
const db = require('./src/db');
const square = require('./src/square');
const tw = require('./src/twilio');

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS — permitir requests desde Claude.ai y otros orígenes
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-tool-secret, x-admin-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Logging básico
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================================
// HEALTHCHECK
// ============================================================================

app.get('/healthz', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.get('/', (_req, res) => res.json({
  name: 'Rey Tequeño Multi-Tenant Backend',
  version: '2.0.0',
  status: 'live',
  trucks_supported: 'multi (Davenport + Haines City + future)',
}));

// ============================================================================
// AUTH MIDDLEWARE para tools de Vapi
// ============================================================================

function requireToolSecret(req, res, next) {
  const provided = req.headers['x-tool-secret'];
  if (!provided || provided !== config.toolSecret) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  next();
}

// ============================================================================
// HELPER — resolver truck desde Vapi context
// ============================================================================

async function resolveTruckFromCall(req) {
  // Vapi puede pasar: phoneNumberId, phoneNumber, customer.number
  // O bien metadata explícito: req.body.truck_id, req.body.square_location_id
  
  // 1. Intento explícito (truck_id pasado por María en su prompt)
  if (req.body.truck_id) {
    return await db.getTruckById(req.body.truck_id);
  }
  if (req.body.square_location_id) {
    return await db.getTruckBySquareLocation(req.body.square_location_id);
  }

  // 2. Inferir por número Twilio que recibió la llamada
  const inboundNumber = req.body.phoneNumber
    || req.body.call?.phoneNumber
    || req.body.message?.call?.phoneNumber?.number
    || req.body.toolCallList?.[0]?.message?.call?.phoneNumber?.number;
  
  if (inboundNumber) {
    const truck = await db.getTruckByTwilioNumber(inboundNumber);
    if (truck) return truck;
  }

  // 3. Fallback: si solo hay 1 truck activo, úsalo
  const activeTrucks = await db.getActiveTrucks();
  if (activeTrucks.length === 1) return activeTrucks[0];

  // 4. Fallback final: Davenport (debugging)
  return activeTrucks.find(t => t.slug === 'davenport') || activeTrucks[0] || null;
}

function extractCustomerPhone(req) {
  return req.body.customer_phone
    || req.body.customerNumber
    || req.body.message?.call?.customer?.number
    || req.body.call?.customer?.number
    || null;
}

// ============================================================================
// TOOL: get_business_info
// ============================================================================

app.post('/tools/get_business_info', requireToolSecret, async (req, res) => {
  try {
    const truck = await resolveTruckFromCall(req);
    if (!truck) {
      return res.json({ success: false, error: 'Could not resolve truck' });
    }

    const location = await square.getLocation(truck.square_location_id);
    const openStatus = location ? square.isLocationOpenNow(location) : null;

    res.json({
      success: true,
      truck_name: truck.name,
      address: `${truck.address}, ${truck.city}, ${truck.state} ${truck.zip}`,
      phone: truck.tmobile_original_number,
      is_open_now: openStatus?.isOpen ?? true,
      hours_today: openStatus?.todayPeriods || null,
      next_opening: openStatus?.nextOpening || null,
      accepts_catering: truck.accepts_catering,
      accepts_after_hours_orders: truck.accepts_after_hours_orders,
    });
  } catch (err) {
    console.error('[get_business_info]', err);
    res.json({ success: false, error: err.message });
  }
});

// ============================================================================
// TOOL: find_menu_item (busca producto en el catálogo del truck)
// ============================================================================

app.post('/tools/find_menu_item', requireToolSecret, async (req, res) => {
  try {
    const truck = await resolveTruckFromCall(req);
    if (!truck) return res.json({ success: false, error: 'Could not resolve truck' });

    const query = req.body.item_name || req.body.query;
    if (!query) return res.json({ success: false, error: 'item_name required' });

    const matches = await square.findItemByNameForLocation(query, truck.square_location_id);
    
    if (matches.length === 0) {
      return res.json({
        success: false,
        error: 'No items matching that name found',
        suggestion: 'ask_for_alternative',
      });
    }

    res.json({
      success: true,
      truck: truck.name,
      matches: matches.slice(0, 5).map(m => ({
        item_name: m.item_name,
        variation_name: m.variation_name,
        variation_id: m.variation_id,
        price: m.price_for_location,
        description: m.item_description?.slice(0, 200) || '',
      })),
      total_matches: matches.length,
    });
  } catch (err) {
    console.error('[find_menu_item]', err);
    res.json({ success: false, error: err.message });
  }
});

// ============================================================================
// TOOL: create_order
// ============================================================================

app.post('/tools/create_order', requireToolSecret, async (req, res) => {
  try {
    const truck = await resolveTruckFromCall(req);
    if (!truck) return res.json({ success: false, error: 'Could not resolve truck' });

    const { items, customer_name, customer_phone, customer_notes } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ success: false, error: 'items array required' });
    }

    // Validar cada item: debe tener variation_id Y quantity
    const lineItems = [];
    for (const item of items) {
      if (!item.variation_id || !item.quantity) {
        return res.json({
          success: false,
          error: `Each item needs variation_id and quantity. Got: ${JSON.stringify(item)}`,
        });
      }
      lineItems.push({
        variation_id: item.variation_id,
        quantity: item.quantity,
        note: item.note,
      });
    }

    // Verificar si está abierto
    const location = await square.getLocation(truck.square_location_id);
    const openStatus = location ? square.isLocationOpenNow(location) : { isOpen: true };
    const isAfterHours = !openStatus.isOpen;

    // Si está cerrado y truck no acepta after-hours, rechazar
    if (isAfterHours && !truck.accepts_after_hours_orders) {
      return res.json({
        success: false,
        error: 'Closed and after-hours orders not accepted',
        next_opening: openStatus.nextOpening,
      });
    }

    // Crear orden en Square
    const sqOrder = await square.createOrderInLocation({
      locationId: truck.square_location_id,
      lineItems,
      customerNote: customer_notes,
    });

    const totalCents = Number(sqOrder.totalMoney?.amount || 0);
    const total = totalCents / 100;

    // Generar payment link
    const paymentLink = await square.createPaymentLink({
      orderId: sqOrder.id,
      description: `${truck.name} - Order ${sqOrder.id.slice(-6)}`,
    });

    // Buscar la llamada en BD por vapi_call_id si está disponible
    const vapiCallId = req.body.call_id || req.body.message?.call?.id;
    let dbCall = null;
    if (vapiCallId) {
      dbCall = await db.findCallByVapiId(vapiCallId);
      if (!dbCall) {
        dbCall = await db.createCall({
          truckId: truck.id,
          vapiCallId,
          customerPhone: customer_phone,
          inboundNumber: req.body.phoneNumber,
        });
      }
    }

    // Persistir orden en Supabase
    const dbOrder = await db.createOrder({
      truckId: truck.id,
      callId: dbCall?.id || null,
      squareOrderId: sqOrder.id,
      squarePaymentLink: paymentLink.url,
      customerName: customer_name,
      customerPhone: customer_phone,
      items: items,
      subtotal: total,
      total: total,
      orderType: isAfterHours ? 'after_hours' : 'pickup',
      isAfterHours,
    });

    if (dbCall) {
      await db.updateCall(dbCall.id, { has_order: true, order_id: dbOrder.id });
    }

    res.json({
      success: true,
      truck: truck.name,
      square_order_id: sqOrder.id,
      payment_link: paymentLink.url,
      total: total.toFixed(2),
      is_after_hours: isAfterHours,
      requires_payment_first: isAfterHours, // crítico para fuera de horario
    });
  } catch (err) {
    console.error('[create_order]', err);
    res.json({ success: false, error: err.message });
  }
});

// ============================================================================
// TOOL: send_payment_link (manda link al cliente por WhatsApp)
// ============================================================================

app.post('/tools/send_payment_link', requireToolSecret, async (req, res) => {
  try {
    const truck = await resolveTruckFromCall(req);
    if (!truck) return res.json({ success: false, error: 'Could not resolve truck' });

    const { customer_phone, payment_link, total, customer_name } = req.body;
    if (!customer_phone || !payment_link) {
      return res.json({ success: false, error: 'customer_phone and payment_link required' });
    }

    const greeting = customer_name ? `¡Hola ${customer_name}!` : '¡Hola!';
    const body = `${greeting} 🥟 Aquí está tu link de pago de Rey Tequeño ${truck.name}:\n\n${payment_link}\n\nTotal: $${total || '?'}\n\n¡Gracias por tu pedido!`;

    const result = await tw.sendWhatsApp({ to: customer_phone, body });

    // Persistir en messages
    await db.logMessage({
      truckId: truck.id,
      orderId: req.body.order_id,
      callId: req.body.call_id,
      from: config.twilio.whatsappFrom,
      to: customer_phone,
      body,
      twilioMessageSid: result.sid,
      twilioStatus: result.status,
      errorCode: result.code,
      errorMessage: result.success ? null : result.error,
    });

    res.json({
      success: result.success,
      sid: result.sid,
      to: result.to,
      channel: 'whatsapp',
      error: result.error,
    });
  } catch (err) {
    console.error('[send_payment_link]', err);
    res.json({ success: false, error: err.message });
  }
});

// ============================================================================
// TOOL: transfer_to_human
// ============================================================================

app.post('/tools/transfer_to_human', requireToolSecret, async (req, res) => {
  try {
    const truck = await resolveTruckFromCall(req);
    if (!truck) return res.json({ success: false, error: 'Could not resolve truck' });

    const transferTo = truck.manager_phone || config.operatorPhoneFallback;
    if (!transferTo) {
      return res.json({
        success: false,
        error: 'No human operator available',
        action: 'take_message',
      });
    }

    res.json({
      success: true,
      transfer_to: transferTo,
      manager_name: truck.manager_name || 'el manager',
      truck: truck.name,
    });
  } catch (err) {
    console.error('[transfer_to_human]', err);
    res.json({ success: false, error: err.message });
  }
});

// ============================================================================
// TOOL: check_open_now
// ============================================================================

app.post('/tools/check_open_now', requireToolSecret, async (req, res) => {
  try {
    const truck = await resolveTruckFromCall(req);
    if (!truck) return res.json({ success: false, error: 'Could not resolve truck' });

    const location = await square.getLocation(truck.square_location_id);
    const openStatus = location ? square.isLocationOpenNow(location) : { isOpen: true };

    res.json({
      success: true,
      truck: truck.name,
      is_open: openStatus.isOpen,
      hours_today: openStatus.todayPeriods,
      next_opening: openStatus.nextOpening,
      accepts_after_hours_orders: truck.accepts_after_hours_orders,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ============================================================================
// ADMIN ENDPOINTS (para el panel HTML)
// ============================================================================

function requireAdminSecret(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== config.toolSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/admin/trucks', requireAdminSecret, async (_req, res) => {
  try {
    const trucks = await db.getActiveTrucks();
    res.json({ success: true, trucks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/trucks/:id/metrics', requireAdminSecret, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const metrics = await db.getDashboardMetrics(req.params.id, days);
    res.json({ success: true, metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/trucks/:id/orders', requireAdminSecret, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const orders = await db.getRecentOrdersForTruck(req.params.id, limit);
    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(config.port, () => {
  console.log(`✅ Rey Tequeño multi-tenant backend listening on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Square: ${config.square.environment}`);
});
