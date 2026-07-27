const track = document.querySelector('#reviews-track');
const viewport = document.querySelector('.reviews__viewport');
const slider = document.querySelector('#reviews-slider');
const dots = document.querySelector('#reviews-dots');
const statusEl = document.querySelector('#reviews-status');
const prev = document.querySelector('.reviews__arrow--prev');
const next = document.querySelector('.reviews__arrow--next');

let reviews = [];
let index = 0;
let autoplayId = null;
let startX = null;
let deltaX = 0;

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

const demoReviews = [
  { name: 'Мария', rating: 5, text: 'Тренеры внимательные, всегда подберут программу под цели и уровень. Очень приятная атмосфера и отличный клуб.', date: '18 мая 2025' },
  { name: 'Алексей', rating: 5, text: 'Отличный клуб! Здесь тебя действительно понимают и создают классную атмосферу.', date: '15 мая 2025' },
  { name: 'Дмитрий', rating: 5, text: 'Удобная запись, напоминания, приятные бонусы. Всё на высшем уровне.', date: '14 мая 2025' },
  { name: 'Екатерина', rating: 5, text: 'Очень тёплое отношение к игрокам. Хочется приходить снова и снова!', date: '12 мая 2025' }
];

function render() {
  track.innerHTML = reviews.map((review, cardIndex) => {
    const name = escapeHtml(review.name || 'Гость');
    const text = escapeHtml(review.text || '');
    const date = escapeHtml(review.date || '');
    const rating = Math.max(1, Math.min(5, Number(review.rating) || 5));
    const avatar = review.avatar
      ? `<img class="review-card__avatar" src="${escapeHtml(review.avatar)}" alt="${name}" loading="lazy">`
      : `<div class="review-card__avatar review-card__avatar--placeholder" aria-hidden="true">${name[0] || 'Г'}</div>`;

    return `<article class="review-card" data-index="${cardIndex}" tabindex="0" aria-label="Отзыв ${cardIndex + 1} из ${reviews.length}">
      ${avatar}
      <div class="review-card__head">
        <h3 class="review-card__name">${name}</h3>
        <div class="review-card__stars" aria-label="Оценка ${rating} из 5">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</div>
      </div>
      <p class="review-card__text">${text}</p>
      ${date ? `<div class="review-card__date">${date}</div>` : ''}
    </article>`;
  }).join('');

  dots.innerHTML = reviews.map((_, dotIndex) =>
    `<button class="reviews__dot" type="button" data-index="${dotIndex}" aria-label="Показать отзыв ${dotIndex + 1}"></button>`
  ).join('');

  track.querySelectorAll('.review-card').forEach(card => {
    card.addEventListener('click', () => goTo(Number(card.dataset.index)));
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        goTo(Number(card.dataset.index));
      }
    });
  });

  dots.querySelectorAll('.reviews__dot').forEach(dot => {
    dot.addEventListener('click', () => goTo(Number(dot.dataset.index)));
  });

  requestAnimationFrame(update);
}

function update() {
  const cards = [...track.querySelectorAll('.review-card')];
  if (!cards.length) return;

  index = (index + cards.length) % cards.length;
  const active = cards[index];
  const viewportWidth = viewport.getBoundingClientRect().width;
  const activeWidth = active.getBoundingClientRect().width;
  const activeOffset = active.offsetLeft;
  const target = activeOffset - (viewportWidth - activeWidth) / 2;
  track.style.transform = `translate3d(${-target}px, 0, 0)`;

  cards.forEach((card, cardIndex) => {
    const distance = Math.abs(cardIndex - index);
    card.classList.toggle('is-active', distance === 0);
    card.classList.toggle('is-near', distance === 1);
    card.setAttribute('aria-current', distance === 0 ? 'true' : 'false');
  });

  dots.querySelectorAll('.reviews__dot').forEach((dot, dotIndex) => {
    dot.classList.toggle('is-active', dotIndex === index);
    dot.setAttribute('aria-current', dotIndex === index ? 'true' : 'false');
  });
}

function goTo(newIndex, restart = true) {
  if (!reviews.length) return;
  index = (newIndex + reviews.length) % reviews.length;
  update();
  if (restart) restartAutoplay();
}

function restartAutoplay() {
  clearInterval(autoplayId);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || reviews.length < 2) return;
  autoplayId = setInterval(() => goTo(index + 1, false), 5500);
}

prev.addEventListener('click', () => goTo(index - 1));
next.addEventListener('click', () => goTo(index + 1));
addEventListener('resize', update);

slider.addEventListener('mouseenter', () => clearInterval(autoplayId));
slider.addEventListener('mouseleave', restartAutoplay);
slider.addEventListener('focusin', () => clearInterval(autoplayId));
slider.addEventListener('focusout', restartAutoplay);

viewport.addEventListener('pointerdown', event => {
  startX = event.clientX;
  deltaX = 0;
  viewport.setPointerCapture?.(event.pointerId);
  clearInterval(autoplayId);
});
viewport.addEventListener('pointermove', event => {
  if (startX === null) return;
  deltaX = event.clientX - startX;
});
viewport.addEventListener('pointerup', () => {
  if (Math.abs(deltaX) > 48) goTo(index + (deltaX < 0 ? 1 : -1));
  else restartAutoplay();
  startX = null;
  deltaX = 0;
});
viewport.addEventListener('pointercancel', restartAutoplay);

document.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft') goTo(index - 1);
  if (event.key === 'ArrowRight') goTo(index + 1);
});

async function loadReviews() {
  // Сразу показываем карусель, чтобы блок никогда не зависал на «Загружаем отзывы…».
  if (!reviews.length) {
    reviews = demoReviews;
    render();
    restartAutoplay();
    statusEl.textContent = '';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch('/api/reviews', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store'
    });
    const data = await response.json();
    const received = data.reviews?.length ? data.reviews : data.cached || [];
    if (!received.length) return;

    reviews = received;
    index = Math.min(index, reviews.length - 1);
    render();
    restartAutoplay();
    statusEl.textContent = '';
  } catch (error) {
    // Оставляем уже показанную карусель. Следующая попытка произойдёт автоматически.
    console.warn('Отзывы Яндекс временно недоступны:', error?.message || error);
  } finally {
    clearTimeout(timeoutId);
  }
}

loadReviews();
setInterval(loadReviews, 30 * 60 * 1000);
