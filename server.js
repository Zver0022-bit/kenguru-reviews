import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const BUSINESS_ID = process.env.YANDEX_BUSINESS_ID || '158191390944';
const ORGANIZATION_URL = process.env.YANDEX_ORG_URL ||
  `https://yandex.ru/maps/org/kenguru/${BUSINESS_ID}/reviews/`;
const CACHE_TTL = Number(process.env.CACHE_TTL || 6 * 60 * 60 * 1000);
const REVIEW_LIMIT = Math.max(1, Math.min(600, Number(process.env.MAX_REVIEWS || 200)));

let cache = { updatedAt: 0, reviews: [], method: null };
let activeRequest = null;

const clean = (value = '') => String(value).replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeDate(value) {
  if (!value) return '';
  if (typeof value === 'number') {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
    }
  }
  const stringValue = clean(value);
  const date = new Date(stringValue);
  if (!Number.isNaN(date.getTime()) && /\d{4}/.test(stringValue)) {
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  }
  return stringValue;
}

function pick(obj, paths) {
  for (const path of paths) {
    let value = obj;
    for (const part of path.split('.')) value = value?.[part];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function normalizeReview(raw, index = 0) {
  const author = raw.author || raw.user || raw.account || {};
  const name = clean(pick(raw, [
    'author.name', 'author.displayName', 'user.name', 'user.displayName',
    'account.name', 'name', 'authorName'
  ]));
  const text = clean(pick(raw, [
    'text', 'body', 'reviewText', 'comment', 'description', 'content.text'
  ]));
  const ratingValue = pick(raw, ['rating', 'stars', 'score', 'grade', 'rating.value']);
  const rating = Math.max(1, Math.min(5, Math.round(Number(ratingValue) || 5)));
  const date = normalizeDate(pick(raw, [
    'updatedTime', 'createdTime', 'publicationTime', 'date', 'createdAt', 'updatedAt', 'time'
  ]));
  const avatar = clean(pick(raw, [
    'author.avatarHref', 'author.avatarUrl', 'author.avatar', 'user.avatarUrl',
    'user.avatar', 'avatarHref', 'avatarUrl', 'avatar'
  ]));
  const id = clean(pick(raw, ['reviewId', 'id', 'uuid'])) || `${name}-${date}-${index}`;
  return { id, name, text, date, avatar, rating };
}

function findReviewArrays(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    if (value.length && value.some(item => item && typeof item === 'object' &&
      ('rating' in item || 'stars' in item || 'reviewId' in item) &&
      ('text' in item || 'body' in item || 'reviewText' in item))) {
      found.push(value);
    }
    for (const item of value) findReviewArrays(item, found);
    return found;
  }
  for (const child of Object.values(value)) findReviewArrays(child, found);
  return found;
}

function extractReviews(payload) {
  const preferred = [
    payload?.reviews,
    payload?.data?.reviews,
    payload?.result?.reviews,
    payload?.data?.items,
    payload?.items
  ].filter(Array.isArray);
  const arrays = preferred.length ? preferred : findReviewArrays(payload);
  const raw = arrays.sort((a, b) => b.length - a.length)[0] || [];
  const reviews = raw.map(normalizeReview).filter(item => item.name && item.text);
  const unique = [];
  const seen = new Set();
  for (const review of reviews) {
    const key = review.id || `${review.name}|${review.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(review);
    }
  }
  return unique;
}

async function fetchJson(url, options = {}, timeout = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`Яндекс вернул HTTP ${response.status}: ${text.slice(0, 140)}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`Яндекс вернул не JSON: ${text.slice(0, 140)}`); }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchReviewsViaInternalApi() {
  const all = [];
  const seen = new Set();
  const pageSize = 50;
  const hosts = ['https://yandex.ru', 'https://yandex.com'];
  let workingHost = null;

  for (let page = 1; page <= Math.ceil(REVIEW_LIMIT / pageSize); page += 1) {
    let payload = null;
    let lastError = null;
    for (const host of workingHost ? [workingHost] : hosts) {
      const url = new URL('/maps/api/business/fetchReviewsById', host);
      url.searchParams.set('businessId', BUSINESS_ID);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(pageSize));
      url.searchParams.set('ranking', 'by_time');
      url.searchParams.set('lang', 'ru_RU');
      url.searchParams.set('ajax', '1');
      try {
        payload = await fetchJson(url, {
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'ru-RU,ru;q=0.9',
            Referer: ORGANIZATION_URL,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });
        workingHost = host;
        break;
      } catch (error) { lastError = error; }
    }
    if (!payload) throw lastError || new Error('Не удалось получить ответ Яндекс Карт');

    const pageReviews = extractReviews(payload);
    if (!pageReviews.length) {
      if (page === 1) throw new Error('API Яндекс Карт ответил, но отзывы в ответе не найдены');
      break;
    }

    let added = 0;
    for (const review of pageReviews) {
      const key = review.id || `${review.name}|${review.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(review);
        added += 1;
      }
      if (all.length >= REVIEW_LIMIT) break;
    }
    if (!added || pageReviews.length < pageSize || all.length >= REVIEW_LIMIT) break;
    await sleep(250);
  }

  if (!all.length) throw new Error('Яндекс Карты не вернули ни одного отзыва');
  return all.slice(0, REVIEW_LIMIT);
}

async function fetchReviewsViaBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    locale: 'ru-RU',
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
  });
  const page = await context.newPage();
  const captured = [];

  page.on('response', async response => {
    if (!/fetchReviewsById|reviews/i.test(response.url())) return;
    const type = response.headers()['content-type'] || '';
    if (!type.includes('json')) return;
    try {
      const payload = await response.json();
      captured.push(...extractReviews(payload));
    } catch {}
  });

  try {
    const url = new URL(ORGANIZATION_URL);
    url.searchParams.set('tab', 'reviews');
    url.searchParams.set('sort', 'by_time');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const unique = new Map();
    for (const item of captured) unique.set(item.id || `${item.name}|${item.text}`, item);

    for (let i = 0; i < 35 && unique.size < REVIEW_LIMIT; i += 1) {
      await page.evaluate(() => {
        const candidates = [...document.querySelectorAll('div,main,section')]
          .filter(el => el.scrollHeight > el.clientHeight + 200)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        const panel = candidates.find(el => /review|отзыв/i.test(String(el.className) + ' ' + (el.getAttribute('aria-label') || ''))) || candidates[0];
        if (panel) {
          panel.scrollTop = Math.min(panel.scrollTop + Math.max(panel.clientHeight * .9, 700), panel.scrollHeight);
          panel.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        window.scrollBy(0, 800);
      });
      await page.waitForTimeout(650);
      for (const item of captured) unique.set(item.id || `${item.name}|${item.text}`, item);
    }

    if (!unique.size) throw new Error('Браузер открыл Яндекс Карты, но не перехватил ответы с отзывами');
    return [...unique.values()].slice(0, REVIEW_LIMIT);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function loadRealReviews() {
  const errors = [];
  try {
    const reviews = await fetchReviewsViaInternalApi();
    return { reviews, method: 'yandex-internal-api' };
  } catch (error) { errors.push(`API: ${error.message}`); }

  try {
    const reviews = await fetchReviewsViaBrowser();
    return { reviews, method: 'browser-network' };
  } catch (error) { errors.push(`Browser: ${error.message}`); }

  throw new Error(errors.join(' | '));
}

async function getReviews(force = false) {
  const fresh = Date.now() - cache.updatedAt < CACHE_TTL;
  if (!force && fresh && cache.reviews.length) return cache;
  if (activeRequest) return activeRequest;

  activeRequest = loadRealReviews()
    .then(({ reviews, method }) => {
      cache = { updatedAt: Date.now(), reviews, method };
      return cache;
    })
    .catch(error => {
      if (cache.reviews.length) return { ...cache, stale: true, warning: error.message };
      throw error;
    })
    .finally(() => { activeRequest = null; });
  return activeRequest;
}

app.use(express.static(PUBLIC_DIR));
app.get('/', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.get('/api/reviews', async (req, res) => {
  try {
    const data = await getReviews(req.query.refresh === '1');
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.json({ ok: true, source: ORGANIZATION_URL, ...data });
  } catch (error) {
    console.error('[reviews]', error);
    res.status(502).json({
      ok: false,
      message: error.message,
      cached: cache.reviews,
      updatedAt: cache.updatedAt || null
    });
  }
});

app.get('/api/health', (_, res) => {
  res.json({ ok: true, businessId: BUSINESS_ID, cachedReviews: cache.reviews.length, updatedAt: cache.updatedAt || null, method: cache.method });
});

app.listen(PORT, () => console.log(`Kenguru reviews widget: http://localhost:${PORT}`));
