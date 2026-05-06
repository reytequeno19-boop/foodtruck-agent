// server.js
// Express backend for Vapi voice-agent tools.
// Exposes 6 endpoints under /tools/* protected by x-tool-secret.

require('dotenv').config();
const express = require('express');
const square = require('./src/square');
const { sendSms, normalizePhone } = require('./src/twilio');
const { getBusinessInfo } = require('./src/business');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.json({
    service: 'foodtruck-agent',
    status: 'running',
    endpoints: [
      'POST /tools/get_menu',
      'POST /tools/create_order',
      'POST /tools/send_payment_link',
      'POST /tools/send_sms',
      'POST /tools/get_business_info',
      'POST /tools/transfer_to_human',
    ],
  });
});

function requireToolSecret(req, res, next) {
  const expected = process.env.TOOL_SECRET;
  if (!expected) {
    return res.status(500).json({ success: false, error: 'TOOL_SECRET not configured on server' });
  }
  const got = req.header('x-tool-secret');
  if (got !== expected) {
    return res.status(401).json({ success: false, error: 'Unauthorized: invalid or missing x-tool-secret' });
  }
  next();
}

function extractArgs(req) {
  const body = req.body || {};
  if (body.message && Array.isArray(body.message.toolCalls) && body.message.toolCalls.length > 0) {
    const call = body.message.toolCalls[0];
    let args = call.function && call.function.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return { args: args || {}, toolCallId: call.id };
  }
  return { args: body, toolCallId: null };
}

function wrapResult(toolCallId, result) {
  if (toolCallId) {
    return {
      results: [
        {
          toolCallId,
          result: typeof result === 'string' ? result : JSON.stringify(result),
        },
      ],
    };
  }
  return result;
}

app.post('/tools/get_menu', requireToolSecret, async (req, res) => {
  const { toolCallId } = extractArgs(req);
  try {
    const result = await square.getMenu();
    res.json(wrapResult(toolCallId, result));
  } catch (err) {
    res.status(500).json(wrapResult(toolCallId, { success: false, error: err.message }));
  }
});

app.post('/tools/create_order', requireToolSecret, async (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  const items = args.items || args.line_items || [];
  const customerName = args.customer_name || args.name || '';
  try {
    const result = await square.createOrder(items, customerName);
    res.json(wrapResult(toolCallId, result));
  } catch (err) {
    res.status(500).json(wrapResult(toolCallId, { success: false, error: err.message }));
  }
});

app.post('/tools/send_payment_link', requireToolSecret, async (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  const items = args.items || args.line_items || [];
  const customerName = args.customer_name || args.name || '';
  const customerPhone = args.customer_phone || args.phone || '';
  const note = args.note || '';
  const language = args.language || 'es';

  if (!items || items.length === 0) {
    return res.json(wrapResult(toolCallId, { success: false, error: 'items array is required' }));
  }
  if (!customerPhone) {
    return res.json(wrapResult(toolCallId, { success: false, error: 'customer_phone is required' }));
  }

  try {
    const orderResult = await square.createOrderWithPaymentLink(items, customerName, note);
    if (!orderResult.success) {
      return res.json(wrapResult(toolCallId, orderResult));
    }

    const smsBody =
      language === 'en'
        ? `Rey Tequeno Davenport: thanks ${customerName || 'for your order'}! Total $${orderResult.total_usd.toFixed(2)}. Pay here: ${orderResult.payment_url}`
        : `Rey Tequeno Davenport: gracias ${customerName || 'por tu pedido'}! Total $${orderResult.total_usd.toFixed(2)}. Paga aqui: ${orderResult.payment_url}`;

    const smsResult = await sendSms(customerPhone, smsBody);

    res.json(
      wrapResult(toolCallId, {
        success: true,
        order_id: orderResult.order_id,
        payment_url: orderResult.payment_url,
        total_usd: orderResult.total_usd,
        sms_sent: smsResult.success,
        sms_to: smsResult.to,
        sms_error: smsResult.success ? null : smsResult.error,
      })
    );
  } catch (err) {
    res.status(500).json(wrapResult(toolCallId, { success: false, error: err.message }));
  }
});

app.post('/tools/send_sms', requireToolSecret, async (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  const to = args.to || args.phone || args.customer_phone;
  const body = args.body || args.message || '';

  if (!to || !body) {
    return res.json(wrapResult(toolCallId, { success: false, error: 'to and body are required' }));
  }

  try {
    const result = await sendSms(to, body);
    res.json(wrapResult(toolCallId, result));
  } catch (err) {
    res.status(500).json(wrapResult(toolCallId, { success: false, error: err.message }));
  }
});

app.post('/tools/get_business_info', requireToolSecret, (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  const topic = args.topic || '';
  const language = args.language || 'es';
  const result = getBusinessInfo(topic, language);
  res.json(wrapResult(toolCallId, result));
});

app.post('/tools/transfer_to_human', requireToolSecret, async (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  const reason = args.reason || 'unspecified';
  const customerPhone = args.customer_phone || '';
  const customerName = args.customer_name || 'Unknown';
  const summary = args.summary || '';
  const language = args.language || 'es';

  const operator = process.env.OPERATOR_PHONE_NUMBER;
  if (!operator) {
    return res.json(wrapResult(toolCallId, { success: false, error: 'OPERATOR_PHONE_NUMBER not configured' }));
  }

  const smsBody =
    `[Rey Tequeno] Cliente necesita ayuda humana.\n` +
    `Nombre: ${customerName}\n` +
    `Tel: ${customerPhone || 'no provisto'}\n` +
    `Razon: ${reason}\n` +
    (summary ? `Resumen: ${summary}\n` : '') +
    `Idioma: ${language}`;

  try {
    const smsResult = await sendSms(operator, smsBody);
    res.json(
      wrapResult(toolCallId, {
        success: smsResult.success,
        notified: smsResult.success,
        operator_phone: operator,
        message_to_customer:
          language === 'en'
            ? "I've notified our team. Someone will call or text you back shortly."
            : 'He notificado a nuestro equipo. Alguien se comunicara contigo en breve.',
        sms_error: smsResult.success ? null : smsResult.error,
      })
    );
  } catch (err) {
    res.status(500).json(wrapResult(toolCallId, { success: false, error: err.message }));
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.path}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`foodtruck-agent listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Square environment: ${process.env.SQUARE_ENVIRONMENT || 'production'}`);
});
