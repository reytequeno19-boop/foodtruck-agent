// ============================================================================
// src/twilio.js — Cliente Twilio (WhatsApp primary, SMS fallback)
// ============================================================================

const twilio = require('twilio');
const config = require('./config');

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

function normalizePhone(input, defaultCountry = '1') {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length === 11) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return null;
}

async function sendWhatsApp({ to, body }) {
  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) {
    return { success: false, error: `Invalid phone number: ${to}` };
  }

  const from = config.twilio.whatsappFrom;
  if (!from) {
    return { success: false, error: 'TWILIO_WHATSAPP_FROM not configured' };
  }

  try {
    const message = await client.messages.create({
      from: `whatsapp:${from}`,
      to: `whatsapp:${normalizedTo}`,
      body,
    });
    return {
      success: true,
      sid: message.sid,
      to: normalizedTo,
      from: `whatsapp:${from}`,
      status: message.status,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: err.code,
      to: normalizedTo,
    };
  }
}

async function sendSms({ to, body }) {
  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) {
    return { success: false, error: `Invalid phone: ${to}` };
  }
  const from = config.twilio.smsFromFallback;
  if (!from) {
    return { success: false, error: 'SMS not configured (use WhatsApp)' };
  }
  try {
    const message = await client.messages.create({ from, to: normalizedTo, body });
    return { success: true, sid: message.sid, status: message.status };
  } catch (err) {
    return { success: false, error: err.message, code: err.code };
  }
}

// Envía con fallback automático: intenta WhatsApp, si falla intenta SMS
async function sendMessageWithFallback({ to, body }) {
  const wa = await sendWhatsApp({ to, body });
  if (wa.success) return { ...wa, channel: 'whatsapp' };

  // Si WhatsApp falla y hay SMS configurado, fallback
  if (config.twilio.smsFromFallback) {
    const sms = await sendSms({ to, body });
    return { ...sms, channel: 'sms', whatsappError: wa.error };
  }
  return { ...wa, channel: 'whatsapp' };
}

module.exports = {
  client,
  normalizePhone,
  sendWhatsApp,
  sendSms,
  sendMessageWithFallback,
};
