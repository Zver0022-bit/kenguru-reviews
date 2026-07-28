import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_FILE = path.join(__dirname, 'data', 'reviews-cache-v6.json');
const CACHE_CANDIDATES = [
  CACHE_FILE,
  path.join(__dirname, 'data', 'reviews-cache-v5.json'),
  path.join(__dirname, 'data', 'reviews-cache.json'),
  path.join(__dirname, 'data', 'reviews-cache-v4.json')
];
const PORT = Number(process.env.PORT || 3000);
const ORG_ID = String(process.env.YANDEX_ORG_ID || '158191390944');
const REVIEWS_URL = process.env.YANDEX_REVIEWS_URL ||
  `https://yandex.ru/maps/org/kenguru/${ORG_ID}/reviews/?ll=39.717231%2C47.284135&z=17`;
const CACHE_TTL = Math.max(5, Number(process.env.CACHE_TTL_MINUTES || 30)) * 60_000;
const MAX_REVIEWS = Math.max(1, Math.min(500, Number(process.env.MAX_REVIEWS || 200)));

let cache = { updatedAt: 0, reviews: [] };
let activeRefresh = null;
let diagnostics = { lastRun: null, title: '', candidateUrls: [], parsedResponses: 0, errors: [] };

const clean = (value = '') => String(value).replace(/\s+/g, ' ').trim();

function normalizeDate(value) {
  if (!value) return '';
  if (typeof value === 'number') {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ms));
  }
  const text = clean(value);
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed) && /\d{4}/.test(text)) {
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(parsed));
  }
  return text;
}

function asObject(value) { return value && typeof value === 'object' ? value : {}; }

function normalizedKey(value = '') {
  return clean(value)
    .toLocaleLowerCase('ru-RU')
    .replace(/[«»"'`´’]/g, '')
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .trim();
}

function isStrictYandexReview(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;

  // У настоящего отзыва Яндекс.Карт есть текст отзыва, автор и служебные
  // признаки отзыва. Обычные карточки организаций, акции и рекламные блоки
  // сюда не проходят.
  const text = clean(raw.text || raw.comment || raw.reviewText || raw.reviewBody || '');
  const author = raw.author || raw.user || raw.reviewer || raw.account || raw.profile;
  const authorName = clean(raw.authorName || raw.userName || author?.name || author?.displayName || author?.publicName || '');
  const ratingRaw = raw.rating ?? raw.stars ?? raw.score ?? raw.grade ?? raw.ratingValue;
  const rating = Number(ratingRaw);
  const hasReviewIdentity = Boolean(raw.reviewId || raw.review_id || raw.uuid || raw.id);
  const hasReviewDate = Boolean(raw.updateTime || raw.updatedAt || raw.createTime || raw.createdAt || raw.date || raw.datetime || raw.publishedAt);

  return text.length >= 3 && authorName.length >= 1 && Number.isFinite(rating) && rating >= 1 && rating <= 5 && (hasReviewIdentity || hasReviewDate);
}

function collectStrictReviewObjects(value, found = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (isStrictYandexReview(value)) found.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStrictReviewObjects(item, found, seen);
  } else {
    for (const child of Object.values(value)) collectStrictReviewObjects(child, found, seen);
  }
  return found;
}

function normalizeReview(raw, index = 0) {
  const author = asObject(raw.author || raw.user || raw.reviewer || raw.account || raw.profile);
  const name = clean(raw.authorName || raw.userName || author.name || author.displayName || author.publicName || author.fullName || 'Гость');
  const text = clean(raw.text || raw.comment || raw.reviewText || raw.reviewBody || '');
  const dateRaw = raw.updateTime || raw.updatedAt || raw.createTime || raw.createdAt || raw.date || raw.datetime || raw.publishedAt || raw.publicationTime;
  const avatarObj = asObject(author.avatar || author.photo);
  const avatar = clean(raw.authorAvatar || raw.avatarUrl || author.avatarUrl || author.photoUrl || avatarObj.url || avatarObj.href || '');
  const rating = Math.max(1, Math.min(5, Math.round(Number(raw.rating ?? raw.stars ?? raw.score ?? raw.grade ?? raw.ratingValue ?? 5) || 5)));
  const id = clean(raw.reviewId || raw.review_id || raw.uuid || raw.id || `${normalizedKey(name)}-${normalizedKey(text).slice(0, 80)}`);
  return { id, name, text, date: normalizeDate(dateRaw), avatar, rating };
}

function extractReviewsFromJson(json) {
  return deduplicate(collectStrictReviewObjects(json).map(normalizeReview));
}

function deduplicate(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.text || !item?.name) continue;
    // Не используем ID как главный ключ: один и тот же отзыв может прийти
    // из XHR и DOM с разными служебными ID.
    const key = `${normalizedKey(item.name)}|${normalizedKey(item.text)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.slice(0, MAX_REVIEWS);
}

function tryParseJson(text) {
  const trimmed = String(text || '').trim(); if (!trimmed) return null;
  const candidates = [trimmed];
  const positions = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter(n => n >= 0).sort((a,b)=>a-b);
  if (positions[0] > 0) candidates.push(trimmed.slice(positions[0]));
  for (const candidate of candidates) { try { return JSON.parse(candidate); } catch {} }
  return null;
}

async function loadDiskCache() {
  let best = null;
  for (const file of CACHE_CANDIDATES) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(parsed.reviews) && parsed.reviews.length) {
        if (!best || Number(parsed.updatedAt || 0) > Number(best.updatedAt || 0)) best = parsed;
      }
    } catch {}
  }
  if (best) cache = { updatedAt: Number(best.updatedAt || 0), reviews: deduplicate(best.reviews) };
}

async function saveDiskCache() {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function scrapeYandex() {
  diagnostics = {
    lastRun: new Date().toISOString(),
    title: '',
    candidateUrls: [],
    parsedResponses: 0,
    cdpBodies: 0,
    domReviews: 0,
    errors: []
  };

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const context = await browser.newContext({
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1440, height: 1100 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7' }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable', { maxTotalBufferSize: 100000000, maxResourceBufferSize: 20000000 });

  const intercepted = [];
  const bodyTasks = new Set();

  const inspectBody = async (requestId, url, mimeType = '') => {
    try {
      const result = await cdp.send('Network.getResponseBody', { requestId });
      const text = result.base64Encoded
        ? Buffer.from(result.body, 'base64').toString('utf8')
        : result.body;
      if (!text || text.length > 20_000_000) return;
      const json = tryParseJson(text);
      if (!json) return;
      diagnostics.parsedResponses += 1;
      diagnostics.cdpBodies += 1;
      intercepted.push(...extractReviewsFromJson(json));
    } catch (error) {
      if (/review|business|organization|search|maps/i.test(url) && diagnostics.errors.length < 30) {
        diagnostics.errors.push(`CDP ${url}: ${error.message}`);
      }
    }
  };

  cdp.on('Network.responseReceived', event => {
    const { response, requestId, type } = event;
    const url = response.url || '';
    const isTargetReviewRequest =
      /fetchReviews|businessReviews|reviews/i.test(url) &&
      (url.includes(ORG_ID) || /businessId|business_id|orgId|organizationId/i.test(url));

    if (isTargetReviewRequest && diagnostics.candidateUrls.length < 150) {
      diagnostics.candidateUrls.push(`${Math.round(response.status)} ${type} ${url}`);
    }
    if (!isTargetReviewRequest) return;
    if (response.status < 200 || response.status >= 400) return;
    if (!['XHR', 'Fetch'].includes(type)) return;
    if (!/json|text|octet-stream/i.test(response.mimeType || '')) return;

    const task = new Promise(resolve => setTimeout(resolve, 80))
      .then(() => inspectBody(requestId, url, response.mimeType))
      .finally(() => bodyTasks.delete(task));
    bodyTasks.add(task);
  });

  try {
    await page.goto(REVIEWS_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(7_000);
    diagnostics.title = await page.title().catch(() => '');
    if (!diagnostics.title.toLocaleLowerCase('ru-RU').includes('кенгуру')) {
      throw new Error(`Открылась не карточка клуба «Кенгуру»: ${diagnostics.title || 'без заголовка'}`);
    }

    for (const selector of [
      'button[aria-label="Закрыть"]',
      'button:has-text("Принять")',
      'button:has-text("Понятно")'
    ]) {
      await page.locator(selector).first().click({ timeout: 700 }).catch(() => {});
    }

    for (const selector of [
      'a[href*="/reviews"]',
      '[role="tab"]:has-text("Отзывы")',
      'button:has-text("Отзывы")',
      '[data-id="reviews"]'
    ]) {
      const loc = page.locator(selector).first();
      if (await loc.count()) {
        await loc.click({ timeout: 1800 }).catch(() => {});
        await page.waitForTimeout(2500);
        break;
      }
    }

    let stable = 0;
    let previous = 0;
    for (let round = 0; round < 80 && deduplicate(intercepted).length < MAX_REVIEWS; round++) {
      await page.evaluate(() => {
        const candidates = [...document.querySelectorAll('div, main, section, ul')]
          .filter(el => el.scrollHeight > el.clientHeight + 120)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        const panel = candidates.find(el => /review|отзыв|scroll|card|business/i.test(
          `${el.className} ${el.getAttribute('aria-label') || ''}`
        )) || candidates[0];
        if (panel) {
          panel.scrollTop = panel.scrollHeight;
          panel.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        window.scrollTo(0, document.body.scrollHeight);
      });

      for (const selector of [
        'button:has-text("Показать ещё")',
        'button:has-text("Загрузить ещё")',
        '[role="button"]:has-text("Показать ещё")'
      ]) {
        await page.locator(selector).last().click({ timeout: 350 }).catch(() => {});
      }

      await page.waitForTimeout(900);
      const total = deduplicate(intercepted).length;
      stable = total === previous ? stable + 1 : 0;
      previous = total;
      if (stable >= 14) break;
    }

    await Promise.allSettled([...bodyTasks]);

    const domReviews = await page.evaluate(() => {
      const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
      const cards = [...document.querySelectorAll(
        '.business-review-view, [class*="business-review-view"], [data-review-id], [itemprop="review"]'
      )];
      return cards.map((card, index) => {
        const pick = selectors => {
          for (const selector of selectors) {
            const el = card.querySelector(selector);
            const value = cleanText(el?.textContent);
            if (value) return value;
          }
          return '';
        };
        const name = pick([
          '.business-review-view__author-name',
          '[class*="review-view__author"]',
          '[itemprop="author"]',
          '[class*="author"]'
        ]);
        const text = pick([
          '.business-review-view__body-text',
          '.business-review-view__body',
          '[itemprop="reviewBody"]',
          '[class*="review-view__body"]'
        ]);
        const date = pick([
          '.business-review-view__date',
          '[itemprop="datePublished"]',
          '[class*="review-view__date"]'
        ]);
        const aria = cleanText(card.querySelector('[aria-label*="оцен"]')?.getAttribute('aria-label'));
        const width = card.querySelector('[class*="stars"] [style*="width"]')?.style?.width || '';
        let rating = Number((aria.match(/[1-5]/) || [])[0] || 0);
        if (!rating && width) rating = Math.max(1, Math.min(5, Math.round(parseFloat(width) / 20)));
        return { id: card.getAttribute('data-review-id') || `dom-${index}`, name, text, date, rating: rating || 5 };
      }).filter(item => item.name && item.text);
    }).catch(() => []);

    diagnostics.domReviews = domReviews.length;
    intercepted.push(...domReviews);

    const reviews = deduplicate(intercepted);
    if (!reviews.length) {
      throw new Error(
        `Яндекс открыл страницу, но не передал отзывы. Заголовок: ${diagnostics.title || 'не определён'}. Диагностика: /api/debug`
      );
    }
    return reviews;
  } finally {
    await context.close();
    await browser.close();
  }
}
async function runRefresh() {
  if (activeRefresh) return activeRefresh;
  activeRefresh = scrapeYandex()
    .then(async reviews => {
      cache = { updatedAt: Date.now(), reviews: deduplicate(reviews) };
      await saveDiskCache().catch(() => {});
      return { ...cache, stale: false };
    })
    .catch(error => {
      if (cache.reviews.length) return { ...cache, stale: true, warning: error.message };
      throw error;
    })
    .finally(() => { activeRefresh = null; });
  return activeRefresh;
}

function getReviewsFast(force = false) {
  const isFresh = cache.reviews.length && Date.now() - cache.updatedAt < CACHE_TTL;
  if (cache.reviews.length) {
    if (force || !isFresh) runRefresh().catch(error => console.error('Фоновое обновление:', error.message));
    return { ...cache, stale: !isFresh, refreshing: Boolean(activeRefresh) };
  }
  return null;
}

await loadDiskCache();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));
app.get('/api/health', (req, res) => res.json({
  ok: true,
  cachedReviews: cache.reviews.length,
  updatedAt: cache.updatedAt || null
}));
app.get('/api/debug', (req, res) => res.json({ ok: true, diagnostics }));
app.get('/api/reviews', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const wait = req.query.wait === '1';
    const fast = getReviewsFast(force);
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    if (fast && !wait) return res.json({ ok: true, source: REVIEWS_URL, ...fast });
    const data = await runRefresh();
    res.json({ ok: true, source: REVIEWS_URL, ...data, refreshing: false });
  } catch (error) {
    res.status(502).json({ ok: false, message: error.message, reviews: [], updatedAt: null, debug: '/api/debug' });
  }
});
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`Kenguru reviews final cache v7 running on port ${PORT}`);
  // Сразу отдаём сохранённые отзывы, а обновление выполняем отдельно.
  runRefresh().catch(error => console.error('Первичное фоновое обновление:', error.message));
  setInterval(() => {
    runRefresh().catch(error => console.error('Плановое фоновое обновление:', error.message));
  }, 30 * 60_000);
});
