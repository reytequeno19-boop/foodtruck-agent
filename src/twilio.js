// src/twilio.js
// Sends SMS via Twilio. Used to deliver the Square payment link to the customer.

const twilio = require('twilio');

let client = null;
function getClient() {
  if (client) return client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
  }
  client = twilio(sid, token);
  return client;
}

/**
 * Normalize a phone number to E.164 format (e.g., +14073619274).
 */
function normalizePhone(input, defaultCountryCode = '1') {
  if (!input) return null;
  let s = String(input).trim();

  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    if (digits.length < 10) return null;
    return `+${digits}`;
  }

  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+${defaultCountryCode}${digits}`;
  }
  if (digits.length === 11 && digits.startsWith(defaultCountryCode)) {
    return `+${digits}`;
  }
  if (digits.length > 11) {
    return `+${digits}`;
  }
  return null;
}

/**
 * Send an SMS using Twilio.
 */
async function sendSms(to, body) {
  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) {
    return { success: false, error: `Invalid phone number: ${to}` };
  }

  const from = process.env.TWILIO_FROM_PHONE_NUMBER;
  if (!from) {
    return { success: false, error: 'TWILIO_FROM_PHONE_NUMBER not configured' };
  }

  try {
    const message = await getClient().messages.create({
      to: normalizedTo,
      from,
      body,
    });
    return { success: true, sid: message.sid, to: normalizedTo };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      to: normalizedTo,
    };
  }
}

module.exports = {
  sendSms,
  normalizePhone,
};
