// Outils des tests d'interface : petit serveur statique, navigateur et données de départ.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.min.js';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// Sert le dossier de l'appli sur un port libre.
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, url === '/' ? 'index.html' : url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

// Copie locale de supabase-js (devDependency), pour ne pas dépendre du réseau.
function supabaseBundle() {
  try {
    // Le paquet n'expose pas ce fichier : on part de son point d'entrée.
    const main = require.resolve('@supabase/supabase-js');
    const root = main.slice(0, main.lastIndexOf('supabase-js') + 'supabase-js'.length);
    // Le CDN sert une version minifiée ; le paquet npm contient la version complète.
    const file = ['supabase.min.js', 'supabase.js'].map((f) => path.join(root, 'dist', 'umd', f)).find((f) => fs.existsSync(f));
    return file || null;
  } catch (e) {
    return null;
  }
}

async function launch() {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  return chromium.launch({ proxy });
}

// Nouvelle page en mode hors ligne (« local »), avec des données de départ.
// `cloud: true` charge supabase-js (pour les tests qui simulent Supabase).
async function openApp(browser, baseUrl, { state, cloud = false, ...options } = {}) {
  // Service worker bloqué par défaut (le test hors ligne l'active explicitement).
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block', ...options });
  const bundle = supabaseBundle();
  await context.route(SUPABASE_CDN, (route) =>
    cloud && bundle ? route.fulfill({ path: bundle, contentType: 'text/javascript' }) : route.abort()
  );
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  if (state) {
    await page.addInitScript((st) => {
      if (localStorage.getItem('budg-test-seeded')) return;
      localStorage.setItem('budg-test-seeded', '1');
      localStorage.setItem('budg-mode', 'local');
      localStorage.setItem('budg-local-v1', JSON.stringify(st));
    }, state);
  }
  await page.goto(baseUrl);
  return { context, page };
}

// Données de départ : Maxime (a) et Lola (b), quelques catégories.
function baseState(extra = {}) {
  return {
    people: [
      { id: 'a', name: 'Maxime' },
      { id: 'b', name: 'Lola' },
    ],
    defaultSplit: 50,
    categories: [
      { id: 'courses', name: 'Courses', icon: '🛒', budget: 40000, period: 'month', position: 0 },
      { id: 'resto', name: 'Restaurants', icon: '🍽️', budget: 10000, period: 'month', position: 1 },
      { id: 'transport', name: 'Transport', icon: '🚗', budget: 0, period: 'month', position: 2 },
    ],
    expenses: [],
    recurring: [],
    transfers: [],
    recurringTransfers: [],
    carUsage: {},
    shopping: [],
    goals: [],
    goalContributions: [],
    ...extra,
  };
}

// Simule un glissement horizontal du doigt sur un élément.
async function swipe(page, selector, dx) {
  await page.evaluate(
    ([sel, delta]) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const touch = (cx) => new Touch({ identifier: 1, target: el, clientX: cx, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x)] }));
      for (let i = 1; i <= 6; i++) {
        el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(x + (delta * i) / 6)] }));
      }
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
    },
    [selector, dx]
  );
}

const text = async (page, selector) => (await page.textContent(selector)).replace(/\s+/g, ' ').trim();

module.exports = { startServer, launch, openApp, baseState, swipe, text, supabaseBundle };
