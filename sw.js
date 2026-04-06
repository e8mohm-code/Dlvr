const CACHE = 'dlvr-v1';
const ASSETS = [
  '/Dlvr/DLVR_Camera-new.html',
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first للـ API calls، Cache first للباقي
  if(e.request.url.includes('script.google.com') ||
     e.request.url.includes('imgbb.com') ||
     e.request.url.includes('workers.dev')){
    return; // network only
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
