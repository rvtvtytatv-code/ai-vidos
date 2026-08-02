'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const MAX_BODY_SIZE = 24 * 1024;

function loadEnv(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[env error]', error.message);
  }
}

loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const SITE_NAME = process.env.SITE_NAME || 'Royal AI Studio';
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const botConfigured = Boolean(
  BOT_TOKEN &&
  CHAT_ID &&
  !BOT_TOKEN.includes('PASTE_') &&
  !CHAT_ID.includes('PASTE_')
);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8'
};

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': MIME_TYPES['.json'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  const body = String(text);
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function clean(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function getClientIp(req) {
  return clean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress, 80);
}

const rateBuckets = new Map();
function canSubmit(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (rateBuckets.get(ip) || []).filter((time) => now - time < windowMs);
  if (recent.length >= 5) return false;
  recent.push(now);
  rateBuckets.set(ip, recent);
  return true;
}

setInterval(() => {
  const threshold = Date.now() - 10 * 60 * 1000;
  for (const [key, times] of rateBuckets.entries()) {
    const fresh = times.filter((time) => time > threshold);
    if (fresh.length) rateBuckets.set(key, fresh);
    else rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(Object.assign(new Error('Слишком большой запрос.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Некорректный JSON.'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

async function saveLead(lead) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.appendFile(path.join(DATA_DIR, 'leads.jsonl'), `${JSON.stringify(lead)}\n`, 'utf8');
}

async function sendToTelegram(lead) {
  if (!botConfigured) return false;

  const message = [
    `👑 <b>Новая заявка — ${escapeHtml(SITE_NAME)}</b>`,
    '',
    `<b>Имя:</b> ${escapeHtml(lead.name)}`,
    `<b>Контакт:</b> ${escapeHtml(lead.contact)}`,
    `<b>Компания:</b> ${escapeHtml(lead.company || 'Не указана')}`,
    `<b>Тип задачи:</b> ${escapeHtml(lead.projectType || 'Не указан')}`,
    '',
    `<b>Задача:</b>\n${escapeHtml(lead.message)}`,
    '',
    `<b>Страница:</b> ${escapeHtml(lead.page || 'Не определена')}`,
    `<b>ID:</b> <code>${lead.id}</code>`,
    `<b>Время:</b> ${escapeHtml(lead.createdAt)}`
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.description || `Telegram API: HTTP ${response.status}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleLead(req, res) {
  const ip = getClientIp(req);
  if (!canSubmit(ip)) {
    sendJson(res, 429, { error: 'Слишком много заявок. Попробуйте через несколько минут.' });
    return;
  }

  const body = await readJsonBody(req);
  if (clean(body.website, 200)) {
    sendJson(res, 200, { ok: true });
    return;
  }

  const name = clean(body.name, 80);
  const contact = clean(body.contact, 120);
  const company = clean(body.company, 120);
  const projectType = clean(body.projectType, 120);
  const message = clean(body.message, 2000);
  const page = clean(body.page, 500);

  if (name.length < 2) return sendJson(res, 400, { error: 'Укажите имя.' });
  if (contact.length < 4) return sendJson(res, 400, { error: 'Укажите Telegram или телефон.' });
  if (message.length < 10) return sendJson(res, 400, { error: 'Опишите задачу подробнее.' });

  const lead = {
    id: crypto.randomUUID(),
    name,
    contact,
    company,
    projectType,
    message,
    page,
    ip,
    userAgent: clean(req.headers['user-agent'], 300),
    createdAt: new Date().toISOString()
  };

  await saveLead(lead);

  let delivered = false;
  try {
    delivered = await sendToTelegram(lead);
  } catch (error) {
    console.error('[telegram error]', error.message);
  }

  sendJson(res, 201, {
    ok: true,
    id: lead.id,
    delivered,
    message: delivered
      ? 'Заявка отправлена менеджеру.'
      : 'Заявка сохранена. Для отправки в Telegram заполните настройки в .env.'
  });
}

async function sendFile(req, res, filePath) {
  let stats;
  try {
    stats = await fsp.stat(filePath);
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  if (!stats.isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  const range = req.headers.range;

  if (range && (extension === '.mp4' || extension === '.webm')) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      res.end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stats.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stats.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600'
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stats.size,
    'Cache-Control': extension === '.html' || extension === '.gif' ? 'no-cache' : 'public, max-age=3600'
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);

  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, botConfigured });
    }

    if (req.method === 'POST' && pathname === '/api/lead') {
      return await handleLead(req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method not allowed');
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname.startsWith('/assets/')) {
        const assetName = pathname.slice('/assets/'.length);
        const safeName = path.basename(assetName);
        if (!assetName || safeName !== assetName) return sendText(res, 404, 'Not found');

        let resolvedName = safeName;
        let assetPath = path.join(ROOT, 'assets', resolvedName);

        // Для hero-01.gif, hero-02.gif и hero-03.gif автоматически берём
        // первые три GIF из папки assets, даже если пользователь назвал их иначе.
        try {
          await fsp.access(assetPath);
        } catch {
          const heroMatch = /^hero-0([1-3])\.gif$/i.exec(safeName);
          if (heroMatch) {
            try {
              const gifFiles = (await fsp.readdir(path.join(ROOT, 'assets')))
                .filter((name) => /\.gif$/i.test(name))
                .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' }));
              const fallbackName = gifFiles[Number(heroMatch[1]) - 1];
              if (fallbackName) {
                resolvedName = fallbackName;
                assetPath = path.join(ROOT, 'assets', fallbackName);
              }
            } catch {
              // Папка отсутствует или недоступна — ниже вернётся 404.
            }
          }
        }

        if (req.method === 'HEAD') {
          try {
            const stats = await fsp.stat(assetPath);
            res.writeHead(200, {
              'Content-Type': MIME_TYPES[path.extname(resolvedName).toLowerCase()] || 'application/octet-stream',
              'Content-Length': stats.size,
              'Cache-Control': /\.gif$/i.test(resolvedName) ? 'no-cache' : 'public, max-age=3600'
            });
            return res.end();
          } catch {
            return sendText(res, 404, 'Not found');
          }
        }
        return await sendFile(req, res, assetPath);
      }
    }

    const routes = new Map([
      ['/', 'index.html'],
      ['/index.html', 'index.html'],
      ['/privacy.html', 'privacy.html'],
      ['/consent.html', 'consent.html'],
      ['/styles.css', 'styles.css'],
      ['/script.js', 'script.js'],
      ['/favicon.svg', 'favicon.svg'],
      ['/case-01.mp4', 'case-01.mp4'],
      ['/case-02.mp4', 'case-02.mp4'],
      ['/case-03.mp4', 'case-03.mp4'],
      ['/case-01.webm', 'case-01.webm'],
      ['/case-02.webm', 'case-02.webm'],
      ['/case-03.webm', 'case-03.webm']
    ]);

    const filename = routes.get(pathname);
    if (!filename) return sendText(res, 404, 'Not found');

    if (req.method === 'HEAD') {
      const filePath = path.join(ROOT, filename);
      try {
        const stats = await fsp.stat(filePath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[path.extname(filename)] || 'application/octet-stream',
          'Content-Length': stats.size
        });
        return res.end();
      } catch {
        return sendText(res, 404, 'Not found');
      }
    }

    return await sendFile(req, res, path.join(ROOT, filename));
  } catch (error) {
    console.error('[request error]', error);
    if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: error.message || 'Ошибка сервера.' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n${SITE_NAME}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Telegram configured: ${botConfigured}`);
  console.log(`Cloudflare: cloudflared tunnel --url http://localhost:${PORT}\n`);
});
