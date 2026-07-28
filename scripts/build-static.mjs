import fs from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('static/reviews-cache.json');
const api = process.env.REVIEWS_API_URL || 'https://kenguru-reviews.onrender.com/api/reviews';
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90_000);

try {
  const response = await fetch(api, { signal: controller.signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.reviews) || !data.reviews.length) throw new Error('API вернул пустой список');
  await fs.writeFile(out, JSON.stringify({ updatedAt: Number(data.updatedAt || Date.now()), reviews: data.reviews }, null, 2));
  console.log(`Static snapshot: ${data.reviews.length} reviews`);
} catch (error) {
  console.warn(`Static snapshot kept unchanged: ${error.message}`);
} finally {
  clearTimeout(timer);
}
