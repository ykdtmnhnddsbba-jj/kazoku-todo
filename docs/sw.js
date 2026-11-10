// かぞくToDo Service Worker：通知の表示と、通知ボタン（完了・スヌーズ）の処理
const VERSION = 'v3';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 画面ファイルはネット優先（更新がすぐ反映される）、つながらないときだけキャッシュ
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

function idbGet(k) {
  return new Promise((res) => {
    const r = indexedDB.open('kazoku', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => {
      const g = r.result.transaction('kv').objectStore('kv').get(k);
      g.onsuccess = () => res(g.result);
      g.onerror = () => res(undefined);
    };
    r.onerror = () => res(undefined);
  });
}

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { title: 'かぞくToDo', body: e.data?.text() || '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(p.title || 'かぞくToDo', {
      body: p.body || '',
      tag: p.tag,
      renotify: !!p.renotify && !!p.tag,
      requireInteraction: !!p.requireInteraction,
      silent: !!p.silent,
      vibrate: p.silent ? undefined : [200, 100, 200, 100, 400],
      icon: './icons/icon-192.png',
      badge: './icons/badge-96.png',
      data: { ...(p.data || {}), member: p.member },
      actions: p.actions || [],
    });
    const cs = await self.clients.matchAll({ type: 'window' });
    cs.forEach((c) => c.postMessage('refresh'));
  })());
});

async function post(path, body) {
  const cfg = await idbGet('cfg');
  if (!cfg?.api) throw new Error('no config');
  const res = await fetch(cfg.api + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Family-Key': cfg.key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return cfg;
}

async function openApp(hash) {
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of cs) {
    if ('focus' in c) { c.postMessage('refresh'); return c.focus(); }
  }
  return self.clients.openWindow('./' + (hash || '#today'));
}

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const d = n.data || {};
  n.close();
  e.waitUntil((async () => {
    try {
      if (e.action === 'done' && d.task_id) {
        await post('/api/done', { task_id: d.task_id, date: d.date, target: d.target, by: d.member });
        const cs = await self.clients.matchAll({ type: 'window' });
        cs.forEach((c) => c.postMessage('refresh'));
        return;
      }
      if (e.action === 'snooze' && d.task_id) {
        await post('/api/snooze', { task_id: d.task_id, date: d.date, target: d.target });
        return;
      }
    } catch (err) {
      // 通信できなかったらアプリを開いて手で押してもらう
      return openApp('#today');
    }
    return openApp('#today');
  })());
});
