// Budg' : notifications Web Push vers l'autre membre du couple.
//
// - GET                    -> { publicKey } (clé VAPID publique, générée au premier appel)
// - POST + x-budg-secret   -> appelé par le déclencheur SQL à chaque nouvelle dépense /
//                             nouveau remboursement : notifie les appareils de l'autre
// - POST + x-budg-secret + { type: 'monthly' } -> bilan du mois écoulé (pg_cron, le 1er du mois)
// - POST + x-budg-secret + { type: 'shopping' } -> articles ajoutés à la liste, groupés (pg_cron)
// - POST + x-budg-secret + { type: 'reminder' } -> rappel de règlement au-delà du seuil (pg_cron)
// - POST + Authorization   -> { test: true } : notification de test vers ses propres appareils
//                             { preview: 'monthly' } : son bilan du mois dernier, tout de suite
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
// Même code de calcul que l'appli (copie de /logic.js, vérifiée par les tests).
import './logic.js';

// deno-lint-ignore no-explicit-any
const L = (globalThis as any).BudgLogic;

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function readConfig(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('budg_server_config').select('key, value');
  if (error) throw error;
  return Object.fromEntries(data.map((r) => [r.key, r.value]));
}

// Clés VAPID : créées une seule fois et gardées dans budg_server_config.
async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const config = await readConfig();
  if (config.vapid_public && config.vapid_private) {
    return { publicKey: config.vapid_public, privateKey: config.vapid_private };
  }
  const keys = webpush.generateVAPIDKeys();
  // ignoreDuplicates : si deux appels arrivent en même temps, la première paire gagne.
  await supabase.from('budg_server_config').upsert(
    [
      { key: 'vapid_public', value: keys.publicKey },
      { key: 'vapid_private', value: keys.privateKey },
    ],
    { onConflict: 'key', ignoreDuplicates: true }
  );
  const again = await readConfig();
  return { publicKey: again.vapid_public, privateKey: again.vapid_private };
}

const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const euro = (cents: number) => money.format(cents / 100).replace(/,00(?=\s?€)/, '');

// Part de la personne `p` dans une dépense (même règle que logic.js, sauf l'usage voiture).
function shareFor(e: Record<string, any>, p: 'a' | 'b'): number | null {
  if (e.by_usage) return null;
  let a: number;
  if (e.share_a != null) a = e.share_a;
  else {
    const base = e.amount - (e.extra_a || 0) - (e.extra_b || 0);
    a = Math.round((base * e.split) / 100) + (e.extra_a || 0);
  }
  return p === 'a' ? a : e.amount - a;
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

async function sendTo(subs: Sub[], payload: Record<string, unknown>) {
  const { publicKey, privateKey } = await vapidKeys();
  webpush.setVapidDetails('https://budg-couple.netlify.app', publicKey, privateKey);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 }
      );
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      // Abonnement expiré ou révoqué : on le supprime.
      if (code === 404 || code === 410) await supabase.from('budg_push_subscriptions').delete().eq('id', s.id);
      else console.error('push failed', code, (err as Error).message);
    }
  }
  return sent;
}

async function notifyPartner(table: string, record: Record<string, any>, actor: string | null) {
  const hid = record.household_id;
  const author = actor || record.created_by || null;
  const [{ data: house }, { data: members }, { data: subs }] = await Promise.all([
    supabase.from('budg_households').select('name_a, name_b').eq('id', hid).single(),
    supabase.from('budg_members').select('user_id, person').eq('household_id', hid),
    supabase.from('budg_push_subscriptions').select('id, endpoint, p256dh, auth, user_id').eq('household_id', hid),
  ]);
  if (!house || !members || !subs) return 0;
  const names: Record<string, string> = { a: house.name_a, b: house.name_b };
  const authorPerson = members.find((m) => m.user_id === author)?.person;

  let sent = 0;
  for (const m of members) {
    if (m.user_id === author) continue;
    const mySubs = subs.filter((s) => s.user_id === m.user_id);
    if (!mySubs.length) continue;
    const who = names[authorPerson || (m.person === 'a' ? 'b' : 'a')];
    let title: string;
    let body: string;
    if (table === 'budg_expenses') {
      const share = shareFor(record, m.person);
      const part = share == null ? '' : ` (ta part : ${euro(share)})`;
      if (record.is_income) {
        title = `💰 ${who} a reçu ${euro(record.amount)}`;
        body = `${record.label}${part}`;
      } else {
        title = `💸 ${who} a ajouté une dépense`;
        body = `${record.label} — ${euro(record.amount)}${part}`;
      }
    } else {
      title = `🤝 Remboursement de ${euro(record.amount)}`;
      body = `${names[record.from_person]} → ${names[record.to_person]}${record.note ? ` · ${record.note}` : ''}`;
    }
    sent += await sendTo(mySubs, { title, body, url: './', tag: `budg-${record.id}` });
  }
  return sent;
}

// ---------- Bilan mensuel ----------

const pad = (n: number) => String(n).padStart(2, '0');

function parisToday(): string {
  const parts = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // AAAA-MM-JJ
}

// Données d'un couple, au format de l'appli (comme store.js).
async function loadState(hid: string) {
  const q = (table: string) => supabase.from(table).select('*').eq('household_id', hid);
  const [house, cats, exps, recs, trs, rtrs, usage] = await Promise.all([
    supabase.from('budg_households').select('*').eq('id', hid).single(),
    q('budg_categories'),
    q('budg_expenses'),
    q('budg_recurring'),
    q('budg_transfers'),
    q('budg_recurring_transfers'),
    q('budg_car_usage'),
  ]);
  const h = house.data!;
  return {
    people: [
      { id: 'a', name: h.name_a },
      { id: 'b', name: h.name_b },
    ],
    defaultSplit: h.default_split,
    categories: (cats.data || []).map((r) => ({ id: r.id, name: r.name, icon: r.icon, budget: r.budget, period: r.period, position: r.position, owner: r.owner })),
    expenses: (exps.data || []).map((r) => ({
      id: r.id, date: r.date, label: r.label, amount: r.amount, payer: r.payer, categoryId: r.category_id, split: r.split,
      shareA: r.share_a, byUsage: r.by_usage, isIncome: r.is_income, extraA: r.extra_a, extraB: r.extra_b, owner: r.owner,
    })),
    recurring: (recs.data || []).map((r) => ({
      id: r.id, label: r.label, amount: r.amount, payer: r.payer, categoryId: r.category_id, split: r.split, shareA: r.share_a,
      byUsage: r.by_usage, owner: r.owner, day: r.day, startMonth: r.start_month, endMonth: r.end_month,
    })),
    transfers: (trs.data || []).map((r) => ({ id: r.id, date: r.date, from: r.from_person, to: r.to_person, amount: r.amount, note: r.note })),
    recurringTransfers: (rtrs.data || []).map((r) => ({
      id: r.id, from: r.from_person, to: r.to_person, auto: r.auto, amount: r.amount, day: r.day, startMonth: r.start_month, endMonth: r.end_month,
    })),
    carUsage: Object.fromEntries((usage.data || []).map((u) => [u.month, u.split])),
    shopping: [],
  };
}

function monthName(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('fr-FR', { month: 'long', timeZone: 'UTC' });
}

// Texte du bilan du mois précédent pour un couple.
async function monthlyMessage(hid: string) {
  const state = await loadState(hid);
  const today = parisToday();
  const cur = today.slice(0, 7);
  const prev = L.addMonths(cur, -1);
  const lastDay = `${prev}-${pad(L.daysInMonth(prev))}`;
  const an = L.analyzeMonth(state, prev, lastDay);
  const bal = L.computeBalance(state, cur);
  const names: Record<string, string> = { a: state.people[0].name, b: state.people[1].name };

  const parts: string[] = [];
  parts.push(
    `${euro(an.total)} dépensés` + (an.vsAverage == null ? '' : ` (${an.vsAverage > 0 ? '+' : ''}${an.vsAverage} % vs moyenne)`)
  );
  const over = an.categories
    .filter((c: { level: string; annual?: boolean }) => c.level === 'over' && !c.annual)
    .sort((x: { pct: number }, y: { pct: number }) => y.pct - x.pct)
    .slice(0, 2)
    .map((c: { icon: string; name: string; pct: number }) => `${c.icon} ${c.name} ${c.pct} %`);
  if (over.length) parts.push(`🚨 ${over.join(', ')}`);
  else if (an.budgetTotal) parts.push('✅ budgets tenus');
  parts.push(bal.amount ? `${names[bal.debtor]} doit ${euro(bal.amount)} à ${names[bal.creditor]}` : 'comptes à l’équilibre');

  return { title: `📊 Bilan de ${monthName(prev)}`, body: parts.join(' · '), url: './', tag: `budg-bilan-${prev}` };
}

async function sendMonthly(onlyUser?: string) {
  let query = supabase.from('budg_push_subscriptions').select('id, endpoint, p256dh, auth, user_id, household_id');
  if (onlyUser) query = query.eq('user_id', onlyUser);
  const { data: subs } = await query;
  const byHousehold = new Map<string, Sub[]>();
  for (const s of subs || []) {
    if (!byHousehold.has(s.household_id)) byHousehold.set(s.household_id, []);
    byHousehold.get(s.household_id)!.push(s);
  }
  let sent = 0;
  for (const [hid, list] of byHousehold) {
    try {
      sent += await sendTo(list, await monthlyMessage(hid));
    } catch (err) {
      console.error('bilan', hid, (err as Error).message);
    }
  }
  return sent;
}

// ---------- Liste de courses : une notification par série d'ajouts ----------

const QUIET_MS = 3 * 60 * 1000; // la série est finie après 3 min sans nouvel ajout
const STALE_MS = 24 * 60 * 60 * 1000; // au-delà, on ne prévient plus

async function sendShoppingDigest() {
  const { data: items } = await supabase
    .from('budg_shopping_items')
    .select('id, household_id, label, created_by, created_at')
    .eq('notified', false)
    .order('created_at');
  const groups = new Map<string, { hid: string; author: string | null; items: { id: string; label: string; created_at: string }[] }>();
  for (const it of items || []) {
    const key = `${it.household_id}|${it.created_by}`;
    if (!groups.has(key)) groups.set(key, { hid: it.household_id, author: it.created_by, items: [] });
    groups.get(key)!.items.push(it);
  }
  const now = Date.now();
  let sent = 0;
  for (const g of groups.values()) {
    const last = Math.max(...g.items.map((i) => Date.parse(i.created_at)));
    if (now - last < QUIET_MS) continue; // la personne est encore en train d'ajouter
    const fresh = g.items.filter((i) => now - Date.parse(i.created_at) < STALE_MS);
    if (fresh.length) {
      const [{ data: house }, { data: members }, { data: subs }] = await Promise.all([
        supabase.from('budg_households').select('name_a, name_b').eq('id', g.hid).single(),
        supabase.from('budg_members').select('user_id, person').eq('household_id', g.hid),
        supabase.from('budg_push_subscriptions').select('id, endpoint, p256dh, auth, user_id').eq('household_id', g.hid),
      ]);
      if (house && members && subs) {
        const authorPerson = members.find((m) => m.user_id === g.author)?.person;
        const who = authorPerson ? (authorPerson === 'a' ? house.name_a : house.name_b) : 'Quelqu’un';
        const labels = fresh.map((i) => i.label);
        const body =
          labels.length === 1
            ? labels[0]
            : `${labels.length} articles : ${labels.slice(0, 4).join(', ')}${labels.length > 4 ? '…' : ''}`;
        for (const m of members) {
          if (m.user_id === g.author) continue;
          const mySubs = subs.filter((s) => s.user_id === m.user_id);
          if (mySubs.length) {
            sent += await sendTo(mySubs, { title: `🛒 ${who} a complété la liste de courses`, body, url: './', tag: `budg-liste-${g.hid}` });
          }
        }
      }
    }
    await supabase.from('budg_shopping_items').update({ notified: true }).in('id', g.items.map((i) => i.id));
  }
  return sent;
}

// ---------- Rappel de règlement ----------

const WEEK_MS = 6.5 * 24 * 60 * 60 * 1000; // au plus un rappel par semaine

async function sendReminders() {
  const { data: houses } = await supabase
    .from('budg_households')
    .select('id, reminder_threshold, last_reminder_at')
    .not('reminder_threshold', 'is', null);
  let sent = 0;
  for (const h of houses || []) {
    if (h.last_reminder_at && Date.now() - Date.parse(h.last_reminder_at) < WEEK_MS) continue;
    const state = await loadState(h.id);
    const bal = L.computeBalance(state, parisToday().slice(0, 7));
    if (!bal.debtor || bal.amount < h.reminder_threshold) continue;
    const [{ data: members }, { data: subs }] = await Promise.all([
      supabase.from('budg_members').select('user_id, person').eq('household_id', h.id),
      supabase.from('budg_push_subscriptions').select('id, endpoint, p256dh, auth, user_id').eq('household_id', h.id),
    ]);
    const debtor = (members || []).find((m) => m.person === bal.debtor);
    const mySubs = (subs || []).filter((s) => debtor && s.user_id === debtor.user_id);
    if (!mySubs.length) continue;
    const creditor = state.people.find((p: { id: string }) => p.id === bal.creditor).name;
    const n = await sendTo(mySubs, {
      title: `💸 Petit rappel : ${euro(bal.amount)} à régler`,
      body: `Tu dois ${euro(bal.amount)} à ${creditor}. Touche « Régler » dans Budg’ une fois le virement fait.`,
      url: './',
      tag: `budg-rappel-${h.id}`,
    });
    if (n) await supabase.from('budg_households').update({ last_reminder_at: new Date().toISOString() }).eq('id', h.id);
    sent += n;
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method === 'GET') {
      const { publicKey } = await vapidKeys();
      return json({ publicKey });
    }
    if (req.method !== 'POST') return json({ error: 'method' }, 405);

    const body = await req.json().catch(() => ({}));

    // Appel du déclencheur SQL.
    const secret = req.headers.get('x-budg-secret');
    if (secret) {
      const config = await readConfig();
      if (secret !== config.webhook_secret) return json({ error: 'forbidden' }, 403);
      if (body.type === 'monthly') return json({ sent: await sendMonthly() });
      if (body.type === 'shopping') return json({ sent: await sendShoppingDigest() });
      if (body.type === 'reminder') return json({ sent: await sendReminders() });
      const sent = await notifyPartner(body.table, body.record || {}, body.actor || null);
      return json({ sent });
    }

    // Notification de test vers ses propres appareils.
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await supabase.auth.getUser(token);
    if (!auth?.user) return json({ error: 'unauthorized' }, 401);
    if (body.preview === 'monthly') return json({ sent: await sendMonthly(auth.user.id) });
    if (!body.test) return json({ error: 'bad request' }, 400);
    const { data: subs } = await supabase
      .from('budg_push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', auth.user.id);
    // Prénom de l'autre membre du couple, pour le message.
    const { data: member } = await supabase
      .from('budg_members')
      .select('person, budg_households(name_a, name_b)')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    const house = (member?.budg_households || {}) as { name_a?: string; name_b?: string };
    const partner = (member?.person === 'a' ? house.name_b : house.name_a) || 'l’autre';
    const sent = await sendTo(subs || [], {
      title: '🔔 Notifications Budg’ activées',
      body: `Une notif arrivera dès que ${partner} ajoute une dépense.`,
      url: './',
      tag: 'budg-test',
    });
    return json({ sent });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message }, 500);
  }
});
