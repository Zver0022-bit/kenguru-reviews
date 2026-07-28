const track = document.querySelector('#reviews-track');
const viewport = document.querySelector('.reviews__viewport');
const dots = document.querySelector('#reviews-dots');
const statusEl = document.querySelector('#reviews-status');
const prev = document.querySelector('.reviews__arrow--prev');
const next = document.querySelector('.reviews__arrow--next');

const API_BASE = 'https://kenguru-reviews.onrender.com';
const STORAGE_KEY = 'kenguru-reviews-static-cache-v9';
let reviews = [];
let index = 0;
let autoplay = null;
let startX = null;
let deltaX = 0;

const esc = (v = '') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const keyOf = r => `${String(r?.name || '').trim().toLowerCase()}|${String(r?.text || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;

function normalize(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter(r => {
    const key = keyOf(r);
    if (!r?.text || !key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseCache(value) {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    const clean = normalize(data?.reviews);
    return clean.length ? { updatedAt: Number(data.updatedAt || 0), reviews: clean } : null;
  } catch { return null; }
}

function localCache() { return parseCache(localStorage.getItem(STORAGE_KEY)); }
function saveLocal(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({updatedAt: Number(data.updatedAt || Date.now()), reviews: normalize(data.reviews)})); } catch {}
}

function render() {
  track.innerHTML = reviews.map((r, i) => {
    const name = esc(r.name || 'Гость');
    const rating = Math.max(1, Math.min(5, Number(r.rating) || 5));
    const avatar = r.avatar
      ? `<img class="review-card__avatar" src="${esc(r.avatar)}" alt="" loading="lazy">`
      : `<div class="review-card__avatar review-card__avatar--placeholder">${name[0] || 'Г'}</div>`;
    return `<article class="review-card" data-index="${i}" tabindex="0">
      <div class="review-card__top">${avatar}<div><h3 class="review-card__name">${name}</h3><div class="review-card__stars" aria-label="Оценка ${rating} из 5">${'★'.repeat(rating)}${'☆'.repeat(5-rating)}</div></div></div>
      <p class="review-card__text">${esc(r.text)}</p>
      ${r.date ? `<div class="review-card__date">${esc(r.date)}</div>` : ''}
    </article>`;
  }).join('');
  dots.innerHTML = reviews.map((_, i) => `<button class="reviews__dot" data-index="${i}" aria-label="Отзыв ${i+1}"></button>`).join('');
  track.querySelectorAll('.review-card').forEach(el => {
    el.onclick = () => go(Number(el.dataset.index));
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(Number(el.dataset.index)); } };
  });
  dots.querySelectorAll('button').forEach(el => el.onclick = () => go(Number(el.dataset.index)));
  requestAnimationFrame(update);
}

function update() {
  const cards = [...track.children];
  if (!cards.length) return;
  index = (index + cards.length) % cards.length;
  const active = cards[index];
  const target = active.offsetLeft - (viewport.clientWidth - active.offsetWidth) / 2;
  track.style.transform = `translate3d(${-target}px,0,0)`;
  cards.forEach((c, i) => {
    c.classList.toggle('is-active', i === index);
    c.classList.toggle('is-near', Math.abs(i-index) === 1);
  });
  dots.querySelectorAll('button').forEach((d, i) => d.classList.toggle('is-active', i === index));
}
function go(i, restart = true) { if (!reviews.length) return; index = (i + reviews.length) % reviews.length; update(); if (restart) startAuto(); }
function startAuto() { clearInterval(autoplay); if (reviews.length > 1 && !matchMedia('(prefers-reduced-motion:reduce)').matches) autoplay = setInterval(() => go(index + 1, false), 6000); }

prev.onclick = () => go(index - 1);
next.onclick = () => go(index + 1);
addEventListener('resize', update);
viewport.addEventListener('pointerdown', e => { startX = e.clientX; deltaX = 0; clearInterval(autoplay); });
viewport.addEventListener('pointermove', e => { if (startX !== null) deltaX = e.clientX - startX; });
viewport.addEventListener('pointerup', () => { Math.abs(deltaX) > 45 ? go(index + (deltaX < 0 ? 1 : -1)) : startAuto(); startX = null; });

function apply(data) {
  const fresh = normalize(data?.reviews);
  if (!fresh.length) return false;
  const changed = reviews.map(keyOf).join('||') !== fresh.map(keyOf).join('||');
  saveLocal(data);
  if (changed) {
    reviews = fresh;
    index = Math.min(index, reviews.length - 1);
    render();
    startAuto();
  }
  statusEl.textContent = '';
  return true;
}

async function getJson(url, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {cache:'no-store', mode:'cors', signal:controller.signal, headers:{Accept:'application/json'}});
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !type.includes('application/json')) throw new Error('not-json');
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function boot() {
  // 1) Встроенная копия из Static Site: работает даже когда Docker спит.
  let bundled = null;
  try { bundled = parseCache(await getJson('./reviews-cache.json', 5000)); } catch {}
  // 2) Более новая копия конкретного посетителя.
  const local = localCache();
  const initial = local && (!bundled || local.updatedAt >= bundled.updatedAt) ? local : bundled;
  if (initial) { reviews = initial.reviews; render(); startAuto(); }

  // 3) Фоновое обновление. Ошибки никогда не заменяют уже показанные карточки.
  try { apply(await getJson(`${API_BASE}/api/reviews`, 15000)); } catch {}
  setTimeout(async () => { try { apply(await getJson(`${API_BASE}/api/reviews?refresh=1`, 15000)); } catch {} }, 3500);
}

boot();
setInterval(async () => { try { apply(await getJson(`${API_BASE}/api/reviews`, 15000)); } catch {} }, 30 * 60 * 1000);
