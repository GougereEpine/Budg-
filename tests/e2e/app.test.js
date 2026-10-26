// Tests d'interface : on rejoue dans Chromium les parcours principaux de l'appli.
// Lancement : npm run test:ui
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, launch, openApp, baseState, swipe, text, supabaseBundle } = require('./helpers');

let server;
let url;
let browser;

test.before(async () => {
  ({ server, url } = await startServer());
  browser = await launch();
});

test.after(async () => {
  await browser.close();
  server.close();
});

const e = (id, label, amount, extra = {}) => ({
  id,
  date: '2026-10-10',
  label,
  amount,
  payer: 'a',
  categoryId: 'courses',
  split: 50,
  ...extra,
});

test('création du couple hors ligne puis première dépense : solde et accueil', async () => {
  const { context, page } = await openApp(browser, url);
  await page.fill('[name=nameA]', 'Maxime');
  await page.fill('[name=nameB]', 'Lola');
  await page.click('#setup button.primary');
  await page.click('#tabs .fab');
  await page.fill('#modal [name=amount]', '33,80');
  await page.fill('#modal [name=label]', 'Courses');
  await page.click('#modal button[type=submit]');
  assert.match(await text(page, '.balance'), /Lola doit à Maxime 16,90 €/);
  assert.equal(await page.$$eval('#view .card.list [data-expense]', (x) => x.length), 1);
  // Barre de navigation : 4 onglets, + au centre.
  const [navCenter, fabCenter] = await page.evaluate(() => {
    const n = document.querySelector('#tabs').getBoundingClientRect();
    const f = document.querySelector('#tabs .fab').getBoundingClientRect();
    return [Math.round(n.left + n.width / 2), Math.round(f.left + f.width / 2)];
  });
  assert.ok(Math.abs(navCenter - fabCenter) <= 1);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('favoris, catégorie devinée et partie pour une seule personne', async () => {
  const state = baseState({
    expenses: [
      e('1', 'Lidl', 3000, { date: '2026-10-02' }),
      e('2', 'Lidl', 4500, { date: '2026-10-12' }),
      e('3', 'Total essence', 6000, { categoryId: 'transport', byUsage: true, date: '2026-10-05' }),
      e('4', 'Total essence', 5500, { categoryId: 'transport', byUsage: true, date: '2026-10-20' }),
    ],
  });
  const { context, page } = await openApp(browser, url, { state });
  await page.click('#tabs .fab');
  const favs = await page.$$eval('[data-fav]', (b) => b.map((x) => x.textContent.trim()));
  assert.equal(favs.length, 2);
  await page.click('[data-fav]:has-text("Total")');
  assert.equal(await page.inputValue('#modal [name=amount]'), '55');
  // L'option « usage de la voiture » n'est plus proposée : la répartition passe en personnalisée.
  assert.equal(await page.inputValue('#modal [name=splitMode]'), 'custom');
  await page.click('[data-close]');

  await page.click('#tabs .fab');
  await page.selectOption('#modal [name=categoryId]', 'resto');
  await page.click('[data-close]');
  await page.click('#tabs .fab');
  await page.type('#modal [name=label]', 'lidl');
  assert.equal(await page.inputValue('#modal [name=categoryId]'), 'courses');
  await page.fill('#modal [name=amount]', '33,80');
  await page.click('details.extras summary');
  await page.fill('#modal [name=extraA]', '5');
  assert.match(await text(page, '[data-extras-preview]'), /Maxime 19,40 € · Lola 14,40 €/);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('liste de courses : panier puis passage en caisse', async () => {
  const state = baseState({
    shopping: ['Lait', 'Pain', 'Shampoing'].map((label, i) => ({ id: `s${i}`, label, done: false, position: i })),
  });
  const { context, page } = await openApp(browser, url, { state });
  assert.match(await text(page, '.shop-link'), /3 à acheter : Lait, Pain, Shampoing/);
  await page.click('.shop-link');
  await page.fill('[name=shopLabel]', 'Œufs');
  await page.press('[name=shopLabel]', 'Enter');
  await page.click('[data-shop="s0"]');
  await page.click('[data-shop="s1"]');
  await page.click('[data-shop-checkout]');
  assert.equal(await page.inputValue('#modal [name=label]'), 'Courses');
  await page.fill('#modal [name=amount]', '12,40');
  await page.click('#modal button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.shop-item').length === 2);
  const left = await page.$$eval('.shop-item .title', (t) => t.map((x) => x.textContent));
  assert.deepEqual(left.sort(), ['Shampoing', 'Œufs']);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('recherche sur tout l\'historique, par texte et par montant', async () => {
  const state = baseState({
    expenses: [
      e('1', 'Carrefour', 5200, { date: '2026-08-03' }),
      e('2', 'Carrefour market', 3380, { date: '2026-09-12' }),
      e('3', 'Lidl', 3380, { date: '2026-10-08' }),
    ],
  });
  const { context, page } = await openApp(browser, url, { state });
  await page.click('[data-tab=expenses]');
  await page.type('[name=search]', 'carref');
  await page.waitForSelector('[data-search-clear]');
  assert.match(await text(page, '#view > p'), /2 résultat\(s\)/);
  assert.equal(await page.evaluate(() => document.activeElement.name), 'search');
  await page.fill('[name=search]', '33,80');
  await page.waitForFunction(() => /2 résultat/.test(document.querySelector('#view > p').textContent));
  await page.click('[data-search-clear]');
  assert.ok(await page.$('.month-nav'));
  await context.close();
});

test('glisser pour supprimer, puis annuler', async () => {
  const state = baseState({ expenses: [e('1', 'Resto', 4000, { date: new Date().toISOString().slice(0, 10) })] });
  const { context, page } = await openApp(browser, url, { state });
  await page.click('[data-tab=expenses]');
  await swipe(page, '[data-expense="1"]', -40);
  assert.ok(await page.$('[data-expense="1"]'), 'un petit glissement ne supprime rien');
  await swipe(page, '[data-expense="1"]', -160);
  await page.waitForFunction(() => !document.querySelector('[data-expense="1"]'));
  await page.click('.toast-btn');
  await page.waitForSelector('[data-expense="1"]');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('projet d\'épargne : versements et progression', async () => {
  const { context, page } = await openApp(browser, url, { state: baseState() });
  await page.click('[data-tab=budget]');
  await page.click('.topbar [data-add-goal]');
  await page.fill('#modal [name=name]', 'Japon');
  await page.fill('#modal [name=amount]', '3000');
  await page.click('#modal button[type=submit]');
  await page.click('[data-goal]');
  await page.fill('#modal [name=amount]', '500');
  await page.click('#modal button[type=submit]');
  await page.click('[data-goal]');
  await page.click('#modal .seg label:has(input[value=b]) span');
  await page.fill('#modal [name=amount]', '300');
  await page.click('#modal button[type=submit]');
  assert.match(await text(page, '[data-goal]'), /800 € \/ 3 000 € 27 %.*Maxime 500 € · Lola 300 €/);
  await context.close();
});

test('charges fixes : seulement dans l\'onglet Fixes, mais comptées dans le solde', async () => {
  const state = baseState({
    expenses: [e('1', 'Courses', 3380, { date: new Date().toISOString().slice(0, 10) })],
    recurring: [{ id: 'l', label: 'Loyer', amount: 102400, payer: 'a', categoryId: null, split: 50, day: 1, startMonth: '2026-01', endMonth: null }],
  });
  const { context, page } = await openApp(browser, url, { state });
  assert.match(await text(page, '.stats .stat'), /Dépensé ?33,80 €/);
  assert.match(await text(page, '.balance'), /Lola doit à Maxime/);
  assert.doesNotMatch(await text(page, '.balance'), /16,90 €/); // le loyer compte dans le solde
  await page.click('[data-tab=expenses]');
  assert.doesNotMatch(await text(page, '#view'), /Loyer/);
  await page.click('[data-tab=budget]');
  assert.match(await text(page, '.stats .stat'), /Dépensé ?33,80 €/);
  assert.doesNotMatch(await text(page, '#view'), /Charges fixes/);
  await page.click('[data-tab=fixed]');
  assert.match(await text(page, '#view'), /1 024 €/);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('hors ligne : ajouts mis en attente puis envoyés au retour du réseau', { skip: !supabaseBundle() && 'supabase-js non installé (npm install)' }, async () => {
  const REF = 'sxnndcxqdsaiqucxvijb';
  const HID = '11111111-1111-4111-8111-111111111111';
  const UID = '22222222-2222-4222-8222-222222222222';
  const tables = {
    budg_households: [{ id: HID, name_a: 'Maxime', name_b: 'Lola', default_split: 50, invite_code: 'ABC123' }],
    budg_members: [
      { household_id: HID, user_id: UID, person: 'a' },
      { household_id: HID, user_id: 'x', person: 'b' },
    ],
    budg_categories: [{ id: '33333333-3333-4333-8333-333333333333', household_id: HID, name: 'Courses', icon: '🛒', budget: 0, period: 'month', position: 0 }],
    budg_expenses: [
      { id: '44444444-4444-4444-8444-444444444444', household_id: HID, date: '2026-10-10', label: 'Lidl', amount: 2000, payer: 'a', category_id: '33333333-3333-4333-8333-333333333333', split: 50, created_by: UID },
    ],
  };
  const writes = [];
  let down = false;
  const { context, page } = await openApp(browser, url, { cloud: true });
  await context.route(`https://${REF}.supabase.co/**`, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (down || u.pathname.startsWith('/realtime')) return route.abort('internetdisconnected');
    const table = u.pathname.split('/').pop();
    if (req.method() !== 'GET') {
      writes.push(table);
      return route.fulfill({ status: 201, body: '' });
    }
    let rows = tables[table] || [];
    const uid = u.searchParams.get('user_id');
    if (uid) rows = rows.filter((r) => 'eq.' + r.user_id === uid);
    const single = (req.headers().accept || '').includes('vnd.pgrst.object');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(single ? rows[0] || null : rows) });
  });
  // Session fictive (jeton non expiré : aucun appel réseau pour la lire).
  const exp = Math.floor(Date.now() / 1000) + 86400;
  await page.evaluate(
    ([ref, uid, expAt]) => {
      const b64 = (o) => btoa(JSON.stringify(o)).replace(/=/g, '');
      const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: uid, exp: expAt, role: 'authenticated' })}.sig`;
      localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify({ access_token: jwt, refresh_token: 'r', expires_at: expAt, expires_in: 86400, token_type: 'bearer', user: { id: uid, email: 't@budg.test', aud: 'authenticated' } }));
    },
    [REF, UID, exp]
  );
  await page.reload();
  await page.waitForSelector('.balance');
  assert.match(await text(page, '.balance'), /Lola doit à Maxime 10 €/);

  down = true;
  await context.setOffline(true);
  await page.click('#tabs .fab');
  await page.fill('#modal [name=amount]', '30');
  await page.fill('#modal [name=label]', 'Boulangerie');
  await page.click('#modal button[type=submit]');
  // La bannière « Hors ligne » apparaît dès la coupure : on attend que l'ajout y soit compté.
  await page.waitForFunction(() => /en attente/.test(document.querySelector('.sync-banner')?.textContent || ''));
  assert.match(await text(page, '.sync-banner'), /Hors ligne.*1 modification en attente/);
  assert.match(await text(page, '.balance'), /Lola doit à Maxime 25 €/);
  assert.deepEqual(writes, []);

  down = false;
  await context.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('.sync-banner'), null, { timeout: 10000 });
  assert.deepEqual(writes, ['budg_expenses']);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('espace perso : dépense hors du couple, budget perso et vue totale', async () => {
  const state = baseState({ expenses: [e('1', 'Courses', 10000, { date: new Date().toISOString().slice(0, 10) })] });
  const { context, page } = await openApp(browser, url, { state });
  assert.match(await text(page, '.balance'), /Lola doit à Maxime 50 €/);

  // Dépense perso : la répartition disparaît, le solde du couple ne bouge pas.
  await page.click('#tabs .fab');
  await page.click('#modal .seg label:has(input[value=perso]) span');
  assert.equal(await page.isVisible('#modal [name=splitMode]'), false);
  await page.fill('#modal [name=amount]', '60');
  await page.fill('#modal [name=label]', 'Basic Fit');
  await page.click('#modal button[type=submit]');
  assert.match(await text(page, '.balance'), /Lola doit à Maxime 50 €/);
  // Elle apparaît dans les dernières dépenses de l'accueil, marquée « perso ».
  await page.waitForFunction(() => document.querySelectorAll('#view .card.list [data-expense]').length === 2);
  assert.match(await text(page, '#view .card.list'), /Basic Fit.*👤 perso/);

  // Espace perso : part du couple + perso, budget perso dépassé.
  await page.click('[data-goto=perso]');
  assert.match(await text(page, '.share-cols'), /Part du couple ?50 €.*Perso ?60 €/);
  await page.click('[data-add-perso-cat]');
  await page.fill('#modal [name=name]', 'Sport');
  await page.fill('#modal [name=icon]', '🏋️');
  await page.fill('#modal [name=amount]', '40');
  await page.click('#modal button[type=submit]');
  await page.click('[data-expense]');
  await page.selectOption('#modal [name=categoryId]', { label: '🏋️ Sport' });
  await page.click('#modal button[type=submit]');
  assert.match(await text(page, '.alert.over'), /Sport : 150 % du budget/);
  // Les catégories perso n'apparaissent pas dans les réglages du couple.
  await page.click('[data-goto=home]');
  await page.click('[data-settings]');
  assert.equal(await page.$$eval('[data-cat]', (x) => x.length), 3);
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('analyse : vues couple, perso et totale', async () => {
  const d = new Date().toISOString().slice(0, 10);
  const state = baseState({
    categories: [...baseState().categories, { id: 'sport', name: 'Sport', icon: '🏋️', budget: 3000, period: 'month', position: 9, owner: 'a' }],
    expenses: [
      e('1', 'Courses', 10000, { date: d }),
      e('2', 'Basic Fit', 3500, { date: d, categoryId: 'sport', split: 100, owner: 'a' }),
    ],
  });
  const { context, page } = await openApp(browser, url, { state });
  await page.click('[data-tab=budget]');
  assert.match(await text(page, '.stats .stat'), /Dépensé ?100 €/);
  assert.ok(await page.$('[data-add-goal]'));
  await page.click('.seg label:has(input[value=perso]) span');
  assert.match(await text(page, '.stats .stat'), /Dépensé ?35 €/);
  assert.match(await text(page, '.alert.over'), /Sport : 117 % du budget/);
  assert.match(await text(page, '.donut-legend'), /Sport 35 € 100 %/);
  assert.equal(await page.$('[data-add-goal]'), null);
  await page.click('.seg label:has(input[value=total]) span');
  assert.match(await text(page, '.stats .stat'), /Dépensé ?85 €/);
  assert.match(await text(page, '.donut-legend'), /Courses 50 € 59 %.*Sport 35 € 41 %/);
  assert.equal(await page.inputValue('.seg input[value=couple]'), 'couple');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('ticket de caisse : photo lue, articles attribués, dépense préremplie', async () => {
  const { context, page } = await openApp(browser, url, { state: baseState() });
  // Lecture simulée (Tesseract.js est chargé depuis le CDN dans l'appli).
  await context.route('https://cdn.jsdelivr.net/npm/tesseract.js@*/**', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.Tesseract = { createWorker: async () => ({
        recognize: async () => ({ data: { text: 'LAIT 1,15\\nSHAMPOING 4,29\\nDESSERT 2,35\\nTOTAL 7,79\\nCB 7,79' } }),
        setParameters: async () => {},
        terminate: async () => {},
      }) };`,
    })
  );
  await page.click('#tabs .fab');
  await page.setInputFiles('[data-scan-file=gallery]', { name: 'ticket.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await page.waitForSelector('.receipt-item');
  assert.equal(await page.inputValue('#modal [name=total]'), '7,79');
  await page.click('.receipt-item:nth-child(2) .seg label:has(input[value=a]) span');
  await page.click('.receipt-item:nth-child(3) .seg label:has(input[value=b]) span');
  assert.match(await text(page, '[data-receipt-sum]'), /Maxime 4,87 € · Lola 2,92 €/);
  // Article oublié par la lecture : ajouté, les choix déjà faits restent.
  await page.fill('#modal [name=newLabel]', 'Pain');
  await page.fill('#modal [name=newAmount]', '1,20');
  await page.click('[data-add-item]');
  await page.waitForFunction(() => document.querySelectorAll('.receipt-item').length === 4);
  assert.equal(await page.isChecked('.receipt-item:nth-child(2) input[value=a]'), true);
  assert.equal(await page.inputValue('#modal [name=total]'), '7,79');
  // ✕ : le lait n'est pas compté, il est retiré du total.
  await page.click('.receipt-item:nth-child(1) .seg label:has(input[value=x]) span');
  assert.match(await text(page, '[data-receipt-sum]'), /Retiré 1,15 € · dépense 6,64 €.*Maxime 4,29 € · Lola 2,35 €/);
  await page.click('#modal button[type=submit]');
  assert.equal(await page.inputValue('#modal [name=amount]'), '6,64');
  await page.click('#modal button[type=submit]');
  assert.match(await text(page, '.balance'), /Lola doit à Maxime 2,35 €/);
  assert.deepEqual(page.errors, []);
  await context.close();
});
