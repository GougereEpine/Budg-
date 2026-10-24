// Budg' : notifications Web Push vers l'autre membre du couple.
//
// - GET                    -> { publicKey } (clé VAPID publique, générée au premier appel)
// - POST + x-budg-secret   -> appelé par le déclencheur SQL à chaque nouvelle dépense /
//                             nouveau remboursement : notifie les appareils de l'autre
// - POST + Authorization   -> { test: true } : notification de test vers ses propres appareils
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

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
      const sent = await notifyPartner(body.table, body.record || {}, body.actor || null);
      return json({ sent });
    }

    // Notification de test vers ses propres appareils.
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await supabase.auth.getUser(token);
    if (!auth?.user) return json({ error: 'unauthorized' }, 401);
    if (!body.test) return json({ error: 'bad request' }, 400);
    const { data: subs } = await supabase
      .from('budg_push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', auth.user.id);
    const sent = await sendTo(subs || [], {
      title: '🔔 Notifications Budg’ activées',
      body: 'Vous serez prévenu(e) quand votre moitié ajoute une dépense.',
      url: './',
      tag: 'budg-test',
    });
    return json({ sent });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message }, 500);
  }
});
