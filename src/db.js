// ============================================================================
// src/db.js — Cliente Supabase + helpers de queries
// ============================================================================
// Centraliza acceso a la BD. Todos los queries pasan por aquí.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
  db: { schema: config.supabase.schema },
  auth: { persistSession: false },
});

// ============================================================================
// TRUCKS — gestión de food trucks
// ============================================================================

async function getActiveTrucks() {
  const { data, error } = await supabase
    .from('trucks')
    .select('*')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data;
}

async function getTruckById(id) {
  const { data, error } = await supabase
    .from('trucks')
    .select('*, maria_config(*)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function getTruckByTwilioNumber(twilioNumber) {
  // Limpia el número (puede llegar con whatsapp: prefix o variantes)
  const cleanNumber = String(twilioNumber).replace(/^whatsapp:/, '').replace(/\s/g, '');
  const { data, error } = await supabase
    .from('trucks')
    .select('*, maria_config(*)')
    .or(`twilio_inbound_number.eq.${cleanNumber},tmobile_original_number.eq.${cleanNumber}`)
    .eq('is_active', true)
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
}

async function getTruckBySquareLocation(squareLocationId) {
  const { data, error } = await supabase
    .from('trucks')
    .select('*, maria_config(*)')
    .eq('square_location_id', squareLocationId)
    .eq('is_active', true)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

// ============================================================================
// CALLS — registro de llamadas
// ============================================================================

async function createCall({ truckId, vapiCallId, twilioCallSid, inboundNumber, customerPhone }) {
  const { data, error } = await supabase
    .from('calls')
    .insert({
      truck_id: truckId,
      vapi_call_id: vapiCallId,
      twilio_call_sid: twilioCallSid,
      inbound_number: inboundNumber,
      customer_phone: customerPhone,
      status: 'in_progress',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function findCallByVapiId(vapiCallId) {
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('vapi_call_id', vapiCallId)
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
}

async function updateCall(callId, updates) {
  const { data, error } = await supabase
    .from('calls')
    .update(updates)
    .eq('id', callId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ============================================================================
// ORDERS — pedidos
// ============================================================================

async function createOrder({
  truckId, callId, squareOrderId, squarePaymentLink,
  customerName, customerPhone, items,
  subtotal, tax, total,
  orderType = 'pickup', isAfterHours = false,
}) {
  const { data, error } = await supabase
    .from('orders')
    .insert({
      truck_id: truckId,
      call_id: callId,
      square_order_id: squareOrderId,
      square_payment_link: squarePaymentLink,
      customer_name: customerName,
      customer_phone: customerPhone,
      items,
      subtotal,
      tax,
      total,
      status: 'pending',
      payment_status: 'unpaid',
      order_type: orderType,
      is_after_hours: isAfterHours,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getRecentOrdersForTruck(truckId, limit = 50) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('truck_id', truckId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ============================================================================
// MESSAGES — WhatsApp/SMS log
// ============================================================================

async function logMessage({
  truckId, orderId, callId,
  channel = 'whatsapp', from, to, body,
  twilioMessageSid, twilioStatus, errorCode, errorMessage,
}) {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      truck_id: truckId,
      order_id: orderId,
      call_id: callId,
      channel,
      from_number: from,
      to_number: to,
      body,
      twilio_message_sid: twilioMessageSid,
      twilio_status: twilioStatus,
      error_code: errorCode,
      error_message: errorMessage,
      sent_at: errorCode ? null : new Date().toISOString(),
    })
    .select()
    .single();
  if (error) {
    console.error('[db.logMessage] Error:', error.message);
    return null;
  }
  return data;
}

// ============================================================================
// METRICS — dashboard
// ============================================================================

async function getDashboardMetrics(truckId, daysBack = 7) {
  const cutoff = new Date(Date.now() - daysBack * 86400 * 1000).toISOString();

  // Orders count + revenue
  const { data: orders, error: ordersErr } = await supabase
    .from('orders')
    .select('total, payment_status, created_at')
    .eq('truck_id', truckId)
    .gte('created_at', cutoff);
  if (ordersErr) throw ordersErr;

  // Calls count
  const { data: calls, error: callsErr } = await supabase
    .from('calls')
    .select('id, has_order, transferred_to_human, started_at, call_duration_seconds')
    .eq('truck_id', truckId)
    .gte('started_at', cutoff);
  if (callsErr) throw callsErr;

  const paidOrders = orders.filter(o => o.payment_status === 'paid');
  const totalRevenue = paidOrders.reduce((s, o) => s + Number(o.total || 0), 0);
  const avgTicket = paidOrders.length > 0 ? totalRevenue / paidOrders.length : 0;

  return {
    period_days: daysBack,
    total_calls: calls.length,
    calls_with_order: calls.filter(c => c.has_order).length,
    calls_transferred: calls.filter(c => c.transferred_to_human).length,
    conversion_rate: calls.length > 0
      ? (calls.filter(c => c.has_order).length / calls.length * 100).toFixed(1)
      : 0,
    total_orders: orders.length,
    paid_orders: paidOrders.length,
    pending_orders: orders.filter(o => o.payment_status === 'unpaid').length,
    revenue: totalRevenue.toFixed(2),
    avg_ticket: avgTicket.toFixed(2),
    avg_call_duration: calls.length > 0
      ? Math.round(calls.reduce((s, c) => s + (c.call_duration_seconds || 0), 0) / calls.length)
      : 0,
  };
}

module.exports = {
  supabase,
  // Trucks
  getActiveTrucks,
  getTruckById,
  getTruckByTwilioNumber,
  getTruckBySquareLocation,
  // Calls
  createCall,
  findCallByVapiId,
  updateCall,
  // Orders
  createOrder,
  getRecentOrdersForTruck,
  // Messages
  logMessage,
  // Metrics
  getDashboardMetrics,
};
