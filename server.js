import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_FILE = path.join(__dirname, 'data', 'reviews-cache.json');
const PORT = Number(process.env.PORT || 3000);
const ORG_ID = String(process.env.YANDEX_ORG_ID || '158191390944');
const REVIEWS_URL = process.env.YANDEX_REVIEWS_URL ||
  `https://yandex.ru/maps/org/kenguru/${ORG_ID}/reviews/?ll=39.717231%2C47.284135&z=17`;
const CACHE_TTL = Math.max(5, Number(process.env.CACHE_TTL_MINUTES || 60)) * 60_000;
const MAX_REVIEWS = Math.max(1, Math.min(500, Number(process.env.MAX_REVIEWS || 200)));

let cache = { updatedAt: 0, reviews: [] };
let activeRefresh = null;

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

function findReviewArrays(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    if (value.length && value.some(item => item && typeof item === 'object' &&
      ('text' in item || 'comment' in item || 'reviewText' in item) &&
      ('rating' in item || 'stars' in item || 'author' in item))) {
      found.push(value);
    }
    for (const item of value) findReviewArrays(item, found);
  } else {
    for (const child of Object.values(value)) findReviewArrays(child, found);
  }
  return found;
}

function normalizeReview(raw, index = 0) {
  const author = raw.author || raw.user || raw.reviewer || {};
  const name = clean(
    raw.authorName || raw.userName || raw.name || author.name || author.displayName || author.publicName || 'Гость'
  );
  const text = clean(raw.text || raw.comment || raw.reviewText || raw.body || raw.description || '');
  const dateRaw = raw.updateTime || raw.updatedAt || raw.createTime || raw.createdAt || raw.date || raw.time || raw.datetime;
  const avatar = clean(
    raw.authorAvatar || raw.avatar || raw.avatarUrl || author.avatar || author.avatarUrl || author.photo || ''
  );
  const rating = Math.max(1, Math.min(5, Math.round(Number(raw.rating || raw.stars || raw.score || 5))));
  const id = clean(raw.reviewId || raw.id || raw.uuid || `${name}-${dateRaw || index}-${text.slice(0, 30)}`);
  return { id, name, text, date: normalizeDate(dateRaw), avatar, rating };
}

function extractReviewsFromJson(json) {
  const candidates = findReviewArrays(json);
  const flattened = candidates.flatMap(array => array.map(normalizeReview));
  return deduplicate(flattened.filter(review => review.text && review.name));
}

function deduplicate(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.id || `${item.name}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.slice(0, MAX_REVIEWS);
}

async function loadDiskCache() {
  try {
    const parsed = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    if (Array.isArray(parsed.reviews)) cache = parsed;
  } catch {}
}

async function saveDiskCache() {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function scrapeYandex() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1440, height: 1100 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
      'DNT': '1'
    }
  });
  const page = await context.newPage();
  const intercepted = [];

  page.on('response', async response => {
    const url = response.url();
    if (!/fetchReviews|reviews/i.test(url) || !/maps\/api|api\/business/i.test(url)) return;
    try {
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json')) return;
      const json = await response.json();
      intercepted.push(...extractReviewsFromJson(json));
    } catch {}
  });

  try {
    await page.goto(REVIEWS_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(4_000);

    for (const selector of [
      'button[aria-label="Закрыть"]',
      'button:has-text("Принять")',
      'button:has-text("Понятно")'
    ]) {
      await page.locator(selector).first().click({ timeout: 500 }).catch(() => {});
    }

    let stable = 0;
    let previousTotal = 0;
    for (let round = 0; round < 80 && intercepted.length < MAX_REVIEWS; round += 1) {
      await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.business-review-view,[class*="business-review-view"],[data-testid*="review"]')];
        const last = cards.at(-1);
        if (last) last.scrollIntoView({ block: 'end', behavior: 'instant' });

        const scrollables = [...document.querySelectorAll('div,main,section')]
          .filter(el => el.scrollHeight > el.clientHeight + 150)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        const panel = scrollables.find(el => /review|scroll|отзыв/i.test(`${el.className} ${el.getAttribute('aria-label') || ''}`)) || scrollables[0];
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
        await page.locator(selector).last().click({ timeout: 400 }).catch(() => {});
      }

      await page.waitForTimeout(900);
      const total = deduplicate(intercepted).length;
      stable = total === previousTotal ? stable + 1 : 0;
      previousTotal = total;
      if (stable >= 10) break;
    }

    const domReviews = await page.evaluate(() => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const cards = [...document.querySelectorAll('.business-review-view,[class*="business-review-view"],[data-testid*="review"]')];
      return cards.map((card, index) => {
        const pick = selectors => {
          for (const selector of selectors) {
            const value = clean(card.querySelector(selector)?.textContent);
            if (value) return value;
          }
          return '';
        };
        const name = pick(['.business-review-view__author-name','[class*="author-name"]','[class*="author"]']);
        const text = pick(['.business-review-view__body-text','[class*="body-text"]','[class*="review-text"]']);
        const date = pick(['.business-review-view__date','[class*="review-date"]','time']);
        const aria = card.querySelector('[aria-label*="из 5"],[aria-label*="зв"]')?.getAttribute('aria-label') || '';
        const rating = Number((aria.match(/[1-5](?:[.,]\d)?/) || ['5'])[0].replace(',', '.'));
        const image = card.querySelector('img');
        return {
          id: card.getAttribute('data-review-id') || `${name}-${date}-${index}`,
          name, text, date,
          avatar: image?.currentSrc || image?.src || '',
          rating: Math.round(rating || 5)
        };
      }).filter(item => item.name && item.text);
    });

    const reviews = deduplicate([...intercepted, ...domReviews.map(normalizeReview)]);
    if (!reviews.length) {
      const title = await page.title().catch(() => '');
      throw new Error(`Яндекс не отдал отзывы. Заголовок страницы: ${title || 'не определён'}`);
    }
    return reviews;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function refreshReviews(force = false) {
  const isFresh = cache.reviews.length && Date.now() - cache.updatedAt < CACHE_TTL;
  if (!force && isFresh) return { ...cache, stale: false };
  if (activeRefresh) return activeRefresh;

  activeRefresh = scrapeYandex()
    .then(async reviews => {
      cache = { updatedAt: Date.now(), reviews };
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

await loadDiskCache();

app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));
app.get('/api/health', (req, res) => res.json({
  ok: true,
  cachedReviews: cache.reviews.length,
  updatedAt: cache.updatedAt || null
}));
app.get('/api/reviews', async (req, res) => {
  try {
    const data = await refreshReviews(req.query.refresh === '1');
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.json({ ok: true, source: REVIEWS_URL, ...data });
  } catch (error) {
    res.status(502).json({ ok: false, message: error.message, reviews: [], updatedAt: null });
  }
});
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`Kenguru reviews running on port ${PORT}`);
  refreshReviews(false).catch(error => console.error('Первичное обновление:', error.message));
});
