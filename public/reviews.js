const track=document.querySelector('#reviews-track');
const viewport=document.querySelector('.reviews__viewport');
const dots=document.querySelector('#reviews-dots');
const statusEl=document.querySelector('#reviews-status');
const prev=document.querySelector('.reviews__arrow--prev');
const next=document.querySelector('.reviews__arrow--next');
const STORAGE_KEY='kenguru-reviews-cache-v6';
const API_BASE=window.KENGURU_REVIEWS_API||((location.hostname==='kenguru-reviews.onrender.com'||location.hostname.endsWith('.onrender.com'))?'':'https://kenguru-reviews.onrender.com');
let reviews=[],index=0,autoplay=null,startX=null,deltaX=0;

const esc=(v='')=>String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const reviewKey=r=>`${String(r?.name||'').trim().toLowerCase()}|${String(r?.text||'').replace(/\s+/g,' ').trim().toLowerCase()}`;
function normalizeReviews(items){const seen=new Set();return (Array.isArray(items)?items:[]).filter(r=>{const key=reviewKey(r);if(!key||seen.has(key)||!r?.text)return false;seen.add(key);return true})}
function readLocalCache(){try{const data=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');return data&&Array.isArray(data.reviews)?data:null}catch{return null}}
function saveLocalCache(data){try{localStorage.setItem(STORAGE_KEY,JSON.stringify({updatedAt:data.updatedAt||Date.now(),reviews:normalizeReviews(data.reviews)}))}catch{}}

function render(){
  track.innerHTML=reviews.map((r,i)=>{const name=esc(r.name||'Гость');const rating=Math.max(1,Math.min(5,Number(r.rating)||5));const avatar=r.avatar?`<img class="review-card__avatar" src="${esc(r.avatar)}" alt="" loading="lazy">`:`<div class="review-card__avatar review-card__avatar--placeholder">${name[0]||'Г'}</div>`;return `<article class="review-card" data-index="${i}" tabindex="0"><div class="review-card__top">${avatar}<div><h3 class="review-card__name">${name}</h3><div class="review-card__stars" aria-label="Оценка ${rating} из 5">${'★'.repeat(rating)}${'☆'.repeat(5-rating)}</div></div></div><p class="review-card__text">${esc(r.text)}</p>${r.date?`<div class="review-card__date">${esc(r.date)}</div>`:''}</article>`}).join('');
  dots.innerHTML=reviews.map((_,i)=>`<button class="reviews__dot" data-index="${i}" aria-label="Отзыв ${i+1}"></button>`).join('');
  track.querySelectorAll('.review-card').forEach(el=>{el.onclick=()=>go(Number(el.dataset.index));el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go(Number(el.dataset.index))}}});
  dots.querySelectorAll('button').forEach(el=>el.onclick=()=>go(Number(el.dataset.index)));
  requestAnimationFrame(update)
}
function update(){const cards=[...track.children];if(!cards.length)return;index=(index+cards.length)%cards.length;const active=cards[index];const target=active.offsetLeft-(viewport.clientWidth-active.offsetWidth)/2;track.style.transform=`translate3d(${-target}px,0,0)`;cards.forEach((c,i)=>{c.classList.toggle('is-active',i===index);c.classList.toggle('is-near',Math.abs(i-index)===1)});dots.querySelectorAll('button').forEach((d,i)=>d.classList.toggle('is-active',i===index))}
function go(i,restart=true){if(!reviews.length)return;index=(i+reviews.length)%reviews.length;update();if(restart)startAuto()}
function startAuto(){clearInterval(autoplay);if(reviews.length>1&&!matchMedia('(prefers-reduced-motion:reduce)').matches)autoplay=setInterval(()=>go(index+1,false),6000)}
prev.onclick=()=>go(index-1);next.onclick=()=>go(index+1);addEventListener('resize',update);
viewport.addEventListener('pointerdown',e=>{startX=e.clientX;deltaX=0;clearInterval(autoplay)});
viewport.addEventListener('pointermove',e=>{if(startX!==null)deltaX=e.clientX-startX});
viewport.addEventListener('pointerup',()=>{Math.abs(deltaX)>45?go(index+(deltaX<0?1:-1)):startAuto();startX=null});

async function requestReviews(force=false){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),30000);
  try{
    const response=await fetch(`${API_BASE}/api/reviews${force?'?refresh=1':''}`,{cache:'no-store',mode:'cors',signal:controller.signal,headers:{Accept:'application/json'}});
    const type=response.headers.get('content-type')||'';
    if(!type.includes('application/json'))throw new Error('Сервер временно отвечает не в формате JSON');
    const data=await response.json();
    if(!response.ok||!data.reviews?.length)throw new Error(data.message||'Отзывы не получены');
    return data;
  }finally{clearTimeout(timer)}
}

async function refreshInBackground(){
  try{
    const data=await requestReviews(true);
    const fresh=normalizeReviews(data.reviews);
    if(!fresh.length)return;
    const before=reviews.map(reviewKey).join('||');
    const after=fresh.map(reviewKey).join('||');
    saveLocalCache(data);
    if(before!==after){reviews=fresh;index=Math.min(index,reviews.length-1);render();startAuto()}
    statusEl.textContent='';
  }catch{
    // Старые отзывы остаются на экране. Техническую ошибку посетителю не показываем.
    statusEl.textContent=reviews.length?'':'Отзывы временно недоступны.';
  }
}

async function boot(){
  const local=readLocalCache();
  if(local?.reviews?.length){reviews=normalizeReviews(local.reviews);render();startAuto();statusEl.textContent=''}
  else statusEl.textContent='Загружаем отзывы…';

  try{
    const data=await requestReviews(false);
    const incoming=normalizeReviews(data.reviews);
    if(incoming.length){reviews=incoming;saveLocalCache(data);render();startAuto();statusEl.textContent=''}
  }catch{
    if(!reviews.length)statusEl.textContent='Отзывы временно недоступны.';
  }

  // Сервер вернёт сохранённые отзывы сразу, а новые подтянет сам в фоне.
  setTimeout(refreshInBackground,2500);
}

boot();
setInterval(refreshInBackground,60*60*1000);
