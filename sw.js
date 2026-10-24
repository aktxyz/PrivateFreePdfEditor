// Service worker: keeps a copy of this app's own files so it works with the network off
// ("super private mode"). It only ever caches files served by this site; documents you open
// are read from your disk by the page and never pass through here.
//
// Strategy: network first (so updates arrive as soon as you're online), cached copy when offline.

const CACHE = 'privatefreepdfeditor-v1';
const READY_KEY = '__offline-ready__';
const scope = self.registration.scope;

async function precache() {
    const cache = await caches.open(CACHE);

    // The page itself (every route serves the same HTML), plus the exact script and style
    // URLs it references, which carry content hashes.
    const page = await fetch(scope, { cache: 'no-cache' });
    const html = await page.clone().text();
    await cache.put(scope, page);
    const urls = new Set();
    for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        const u = new URL(m[1], scope).href;
        if (u.startsWith(scope)) urls.add(u);
    }

    // Everything PDF.js may load later on demand: its worker, fonts, CMaps and decoders.
    const list = await (await fetch(new URL('precache.json', scope), { cache: 'no-cache' })).json();
    for (const path of list) urls.add(new URL(path, scope).href);

    const results = await Promise.allSettled([...urls].map(async (u) => {
        const res = await fetch(u, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${res.status} ${u}`);
        await cache.put(u, res);
    }));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) console.warn('Offline copy incomplete:', failed.map(f => f.reason?.message));
    else await cache.put(READY_KEY, new Response('1'));

    // during install the page isn't controlled yet, so include uncontrolled windows
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'offline-ready', ok: !failed.length });
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(precache().catch(err => console.warn('Offline copy failed:', err)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
        await self.clients.claim();   // take over the open page right away
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin || url.pathname.endsWith('/precache.json')) return;

    // All routes (/, /about, /edit …) are the same page.
    const key = req.mode === 'navigate' ? scope : req;
    event.respondWith((async () => {
        try {
            const res = await fetch(req);
            if (res.ok && res.type === 'basic') {
                const copy = res.clone();
                event.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)));
            }
            return res;
        } catch (err) {
            const hit = await caches.match(key, { ignoreSearch: true });
            if (hit) return hit;
            throw err;
        }
    })());
});
