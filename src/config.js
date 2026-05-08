// ============================================================================
// src/config.js — Configuración centralizada
// ============================================================================
// Carga env vars, valida que estén presentes, y expone un objeto config limpio
// ============================================================================

require('dotenv').config();

const required = [
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_ENVIRONMENT',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TOOL_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
];

const optional = {
  PORT: 10000,
  NODE_ENV: 'production',
  TWILIO_WHATSAPP_FROM: '+14155238886',  // Sandbox por default
  TWILIO_FROM_PHONE_NUMBER: null,         // SMS fallback (deshabilitado por A2P)
  OPERATOR_PHONE_NUMBER: null,            // Default manager si no hay por truck
  ANTHROPIC_API_KEY: null,                // Para panel admin Claude
  VAPI_API_KEY: null,                     // Para sincronizar prompts vía API
};

const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('❌ Missing required env vars:', missing.join(', '));
  console.error('Set them in Render Environment or .env file');
  process.exit(1);
}

const config = {
  // Server
  port: parseInt(process.env.PORT || optional.PORT, 10),
  nodeEnv: process.env.NODE_ENV || optional.NODE_ENV,
  isProduction: (process.env.NODE_ENV || optional.NODE_ENV) === 'production',

  // Square
  square: {
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT,  // production | sandbox
  },

  // Twilio
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || optional.TWILIO_WHATSAPP_FROM,
    smsFromFallback: process.env.TWILIO_FROM_PHONE_NUMBER,
  },

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
    schema: 'reytequeno',
  },

  // Auth
  toolSecret: process.env.TOOL_SECRET,

  // Anthropic (panel admin)
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },

  // Vapi (panel admin)
  vapi: {
    apiKey: process.env.VAPI_API_KEY,
  },

  // Defaults
  operatorPhoneFallback: process.env.OPERATOR_PHONE_NUMBER,
};

console.log(`[config] Environment: ${config.nodeEnv}`);
console.log(`[config] Square: ${config.square.environment}`);
console.log(`[config] Supabase schema: ${config.supabase.schema}`);
console.log(`[config] WhatsApp from: ${config.twilio.whatsappFrom}`);

module.exports = config;
