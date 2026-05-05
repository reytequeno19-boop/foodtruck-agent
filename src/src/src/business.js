// src/business.js
// Reads business-info.json and serves localized answers (ES/EN).
// Supports topic aliases so the agent can ask in many ways.

const fs = require('fs');
const path = require('path');

let businessInfo = null;
function loadBusinessInfo() {
  if (businessInfo) return businessInfo;
  const filePath = path.join(__dirname, '..', 'business-info.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  businessInfo = JSON.parse(raw);
  return businessInfo;
}

// Topic aliases: maps many ways the agent might ask to a canonical key in business-info.json.
// All keys are normalized to lowercase, no accents.
const TOPIC_ALIASES = {
  // Hours / schedule
  'hours': 'hours',
  'horario': 'hours',
  'horarios': 'hours',
  'schedule': 'hours',
  'open': 'hours',
  'abren': 'hours',
  'abierto': 'hours',
  'cuando': 'hours',
  'when': 'hours',

  // Location / address
  'location': 'location',
  'ubicacion': 'location',
  'donde': 'location',
  'where': 'location',
  'address': 'location',
  'direccion': 'location',

  // Contact / phone / email
  'contact': 'contact',
  'contacto': 'contact',
  'phone': 'phone',
  'telefono': 'phone',
  'numero': 'phone',
  'email': 'email',
  'correo': 'email',

  // Web
  'website': 'website',
  'web': 'website',
  'sitio': 'website',
  'pagina': 'website',
  'page': 'website',

  // Social
  'social': 'social',
  'redes': 'social',
  'instagram': 'instagram',
  'ig': 'instagram',

  // Payment
  'payment': 'payment',
  'pago': 'payment',
  'pagar': 'payment',
  'tarjeta': 'payment',
  'card': 'payment',

  // Parking
  'parking': 'parking',
  'estacionamiento': 'parking',
  'parqueo': 'parking',

  // Delivery / pickup
  'delivery': 'delivery',
  'envio': 'delivery',
  'pickup': 'delivery',
  'recoger': 'delivery',

  // Cuisine / what type of food
  'cuisine': 'cuisine',
  'comida': 'cuisine',
  'food': 'cuisine',
  'tipo': 'cuisine',
  'menu': 'cuisine',

  // Name
  'name': 'name',
  'nombre': 'name',

  // Languages
  'languages': 'languages',
  'idiomas': 'languages',
  'language': 'languages',
};

function normalize(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function detectLanguage(input) {
  if (!input) return 'es';
  const lang = String(input).toLowerCase();
  if (lang.startsWith('en')) return 'en';
  return 'es';
}

function getBusinessInfo(topic, language) {
  const info = loadBusinessInfo();
  const lang = detectLanguage(language);

  if (!topic) {
    return {
      success: true,
      answer: `${info.name[lang]}. ${info.cuisine[lang]}. ${info.hours[lang]} ${info.location[lang]}`,
      language: lang,
    };
  }

  const normalizedTopic = normalize(topic);
  const canonicalKey = TOPIC_ALIASES[normalizedTopic] || normalizedTopic;

  if (info[canonicalKey] && info[canonicalKey][lang]) {
    return {
      success: true,
      topic: canonicalKey,
      answer: info[canonicalKey][lang],
      language: lang,
    };
  }

  const fallback = lang === 'es'
    ? 'Disculpa, no tengo esa información a la mano. Te puedo conectar con un humano si lo prefieres.'
    : "Sorry, I don't have that information on hand. I can connect you with a human if you prefer.";
  return {
    success: false,
    topic: normalizedTopic,
    answer: fallback,
    language: lang,
  };
}

module.exports = {
  getBusinessInfo,
  loadBusinessInfo,
};
