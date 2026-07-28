import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const ORGANIZATION_URL = process.env.YANDEX_ORG_URL ||
  'https://yandex.ru/maps/org/kenguru/158191390944/?indoorLevel=1&ll=39.717231%2C47.284135&z=17';
const CACHE_TTL = Number(process.env.CACHE_TTL || 30 * 60 * 1000);
const REVIEW_LIMIT = Math.max(1, Number(process.env.MAX_REVIEWS || 200));

let cache = { updatedAt: 0, reviews: [] };
let activeRequest = null;

function clean(text = '') {
  return text.replace(/\s+/g, ' ').trim();
}

async function scrapeReviews() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    locale: 'ru-RU',
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36'
  });

  try {
    const url = new URL(ORGANIZATION_URL);
    url.searchParams.set('tab', 'reviews');
    url.searchParams.set('sort', 'by_time');

    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);

    // Закрываем возможные всплывающие окна.
    for (const selector of [
      'button[aria-label="Закрыть"]',
      '.button._view_clear[aria-label="Закрыть"]',
      '[class*="popup"] button[aria-label="Закрыть"]'
    ]) {
      await page.locator(selector).first().click({ timeout: 800 }).catch(() => {});
    }

    // Подгружаем отзывы до тех пор, пока список действительно растёт.
    // Яндекс использует виртуальную прокрутку, поэтому одного scrollTo недостаточно.
    let previousCount = 0;
    let stableRounds = 0;

    for (let i = 0; i < 60; i += 1) {
      // Нажимаем возможные кнопки «ещё / показать полностью / показать больше».
      for (const selector of [
        'button:has-text("Показать ещё")',
        'button:has-text("Ещё")',
        'button:has-text("Загрузить ещё")',
        '[role="button"]:has-text("Показать ещё")'
      ]) {
        await page.locator(selector).last().click({ timeout: 350 }).catch(() => {});
      }

      const state = await page.evaluate(() => {
        const cardSelectors = [
          '.business-review-view',
          '[class*="business-review-view"]',
          '[class*="review-card"]',
          '[data-testid*="review"]'
        ];

        let count = 0;
        for (const selector of cardSelectors) {
          const found = document.querySelectorAll(selector).length;
          if (found > count) count = found;
        }

        const scrollables = [...document.querySelectorAll('div,main,section')]
          .filter(el => el.scrollHeight > el.clientHeight + 120)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

        const reviewPanel = scrollables.find(el => {
          const cls = String(el.className || '');
          const text = (el.getAttribute('aria-label') || '') + ' ' + cls;
          return /review|отзыв|scroll/i.test(text);
        }) || scrollables[0];

        if (reviewPanel) {
          const step = Math.max(reviewPanel.clientHeight * 0.85, 500);
          reviewPanel.scrollTop = Math.min(reviewPanel.scrollTop + step, reviewPanel.scrollHeight);
          reviewPanel.dispatchEvent(new Event('scroll', { bubbles: true }));
        }

        window.scrollBy(0, Math.max(window.innerHeight * 0.8, 650));
        return { count, atEnd: reviewPanel ? reviewPanel.scrollTop + reviewPanel.clientHeight >= reviewPanel.scrollHeight - 20 : false };
      });

      if (state.count >= REVIEW_LIMIT) break;

      if (state.count === previousCount) stableRounds += 1;
      else stableRounds = 0;

      previousCount = state.count;
      if (stableRounds >= 7 && state.atEnd) break;
      await page.waitForTimeout(700);
    }

    const reviews = await page.evaluate((limit) => {
      const textOf = (root, selectors) => {
        for (const selector of selectors) {
          const node = root.querySelector(selector);
          const value = node?.textContent?.replace(/\s+/g, ' ').trim();
          if (value) return value;
        }
        return '';
      };

      const cardSelectors = [
        '.business-review-view',
        '[class*="business-review-view"]',
        '[class*="review-card"]',
        '[data-testid*="review"]'
      ];

      let cards = [];
      for (const selector of cardSelectors) {
        cards = [...document.querySelectorAll(selector)];
        if (cards.length) break;
      }

      const result = cards.map((card, index) => {
        const name = textOf(card, [
          '.business-review-view__author-name',
          '.business-review-view__author',
          '[class*="author-name"]',
          '[class*="author"]'
        ]);
        const text = textOf(card, [
          '.business-review-view__body-text',
          '.business-review-view__body',
          '[class*="review-text"]',
          '[class*="body-text"]'
        ]);
        const date = textOf(card, [
          '.business-review-view__date',
          '[class*="review-date"]',
          'time'
        ]);
        const avatarNode = card.querySelector('img');
        const avatar = avatarNode?.currentSrc || avatarNode?.src || '';

        let rating = 0;
        const ariaStars = card.querySelector('[aria-label*="из 5"], [aria-label*="5 зв"]');
        const aria = ariaStars?.getAttribute('aria-label') || '';
        const match = aria.match(/([1-5](?:[.,]\d)?)/);
        if (match) rating = Math.round(Number(match[1].replace(',', '.')));

        if (!rating) {
          const activeStars = card.querySelectorAll(
            '.business-rating-badge-view__stars._full, [class*="star"] [class*="full"], [class*="star"] svg'
          ).length;
          rating = Math.min(5, activeStars || 5);
        }

        const id = card.getAttribute('data-review-id') || `${name}-${date}-${index}`;
        return { id, name, text, date, avatar, rating };
      }).filter(item => item.name && item.text);

      const unique = [];
      const seen = new Set();
      for (const review of result) {
        const key = `${review.name}|${review.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(review);
        }
      }
      return unique.slice(0, limit);
    }, REVIEW_LIMIT);

    if (!reviews.length) {
      throw new Error('Не удалось найти карточки отзывов. Возможно, Яндекс изменил HTML-разметку.');
    }

    return reviews.map(review => ({
      ...review,
      name: clean(review.name),
      text: clean(review.text),
      date: clean(review.date),
      rating: Math.max(1, Math.min(5, Number(review.rating) || 5))
    }));
  } finally {
    await browser.close();
  }
}

async function getReviews(force = false) {
  const fresh = Date.now() - cache.updatedAt < CACHE_TTL;
  if (!force && fresh && cache.reviews.length) return cache;
  if (activeRequest) return activeRequest;

  activeRequest = scrapeReviews()
    .then(reviews => {
      cache = { updatedAt: Date.now(), reviews };
      return cache;
    })
    .finally(() => { activeRequest = null; });

  return activeRequest;
}

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/api/reviews', async (req, res) => {
  try {
    const data = await getReviews(req.query.refresh === '1');
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, source: ORGANIZATION_URL, ...data });
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: error.message,
      cached: cache.reviews,
      updatedAt: cache.updatedAt || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`Отзывы: http://localhost:${PORT}`);
});
