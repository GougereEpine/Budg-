// Cœur de calcul de Budg' : fonctions pures, sans accès au DOM.
// Tous les montants sont en centimes (entiers) pour éviter les erreurs d'arrondi.
// Le partage d'une dépense est exprimé par `split` = pourcentage à la charge de la personne "a".
(function (root) {
  'use strict';

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function monthKey(date) {
    return date.slice(0, 7);
  }

  function todayISO(now) {
    const d = now || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function addMonths(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const idx = y * 12 + (m - 1) + delta;
    return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
  }

  function monthsRange(start, end) {
    const out = [];
    for (let m = start; m <= end; m = addMonths(m, 1)) out.push(m);
    return out;
  }

  function daysInMonth(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }

  // "12,50" / "12.5" / "1 200" -> centimes. Renvoie NaN si invalide.
  function parseAmount(input) {
    const s = String(input).replace(/[\s\u00a0€]/g, '').replace(',', '.');
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  }

  function shareOf(amount, split) {
    const a = Math.round((amount * split) / 100);
    return { a, b: amount - a };
  }

  // Parts d'une dépense : montant précis pour a (`shareA`, en centimes) s'il est
  // renseigné, sinon le pourcentage `split`. `extraA` / `extraB` : articles pour
  // une seule personne (shampoing, dessert…) retirés avant le partage.
  function sharesOf(e) {
    if (e.shareA != null && !e.byUsage) return { a: e.shareA, b: e.amount - e.shareA };
    const extraA = e.extraA || 0;
    const extraB = e.extraB || 0;
    const s = shareOf(e.amount - extraA - extraB, e.split);
    return { a: s.a + extraA, b: s.b + extraB };
  }

  // Usage de la voiture : % d'utilisation par a pour un mois. Si le mois n'est pas
  // renseigné, on reprend le dernier mois renseigné avant, sinon la répartition
  // par défaut du couple. `isSet` indique si le mois lui-même a été renseigné.
  function carUsageFor(state, month) {
    const usage = state.carUsage || {};
    if (usage[month] != null) return { split: usage[month], isSet: true, from: month };
    const before = Object.keys(usage).filter((m) => m < month).sort();
    if (before.length) {
      const m = before[before.length - 1];
      return { split: usage[m], isSet: false, from: m };
    }
    return { split: state.defaultSplit, isSet: false, from: null };
  }

  // Une dépense « selon l'usage de la voiture » prend le % du mois où elle a lieu.
  function withUsage(state, e) {
    return e.byUsage ? { ...e, split: carUsageFor(state, monthKey(e.date)).split } : e;
  }

  // Une entrée d'argent (remboursement EDF, d'assurance…) est une dépense en
  // négatif : elle réduit la catégorie, et la personne qui l'a reçue doit sa
  // part à l'autre.
  function signed(e) {
    if (!e.isIncome) return e;
    return {
      ...e,
      amount: -e.amount,
      shareA: e.shareA == null ? e.shareA : -e.shareA,
      extraA: -(e.extraA || 0),
      extraB: -(e.extraB || 0),
    };
  }

  // Espace perso : une dépense, un abonnement ou une catégorie avec `owner`
  // ('a' ou 'b') n'appartient qu'à cette personne et reste hors des comptes du couple.
  function shared(list) {
    return (list || []).filter((x) => !x.owner);
  }

  // Sans les charges fixes ni les remboursements automatiques : ce qu'on affiche
  // et analyse partout sauf dans l'onglet Fixes. Le solde du couple, lui, les
  // compte toujours (computeBalance sur l'état complet).
  function withoutFixed(state) {
    return { ...state, recurring: [], recurringTransfers: [] };
  }

  // Vue « perso » de `p`, au même format que l'état du couple : ses dépenses et
  // abonnements perso (entièrement à sa charge), ses catégories perso et celles
  // du couple (sans budget). Les calculs habituels s'y appliquent tels quels.
  // Une catégorie perso du même nom qu'une catégorie du couple (« Restaurants »)
  // la remplace : ses dépenses perso comptent dans le budget perso.
  function personalState(state, p) {
    const remap = personalCategoryMap(state, p);
    const mine = (list) =>
      (list || [])
        .filter((x) => x.owner === p)
        .map((x) => ({
          ...x,
          categoryId: remap[x.categoryId] || x.categoryId,
          owner: null,
          personal: p,
          payer: p,
          split: p === 'a' ? 100 : 0,
          shareA: null,
          byUsage: false,
          extraA: 0,
          extraB: 0,
        }));
    const cats = (state.categories || [])
      .filter((c) => c.owner === p)
      .map((c) => ({ ...c, owner: null, personal: p }))
      .concat(shared(state.categories).filter((c) => !remap[c.id]).map((c) => ({ ...c, budget: 0, period: 'month' })));
    return { ...state, expenses: mine(state.expenses), recurring: mine(state.recurring), categories: cats, transfers: [], recurringTransfers: [] };
  }

  // Catégories du couple qui ont une catégorie perso du même nom chez `p` : id du couple -> id perso.
  function personalCategoryMap(state, p) {
    const own = {};
    for (const c of state.categories || []) if (c.owner === p) own[normalizeLabel(c.name)] = c.id;
    const map = {};
    for (const c of shared(state.categories)) {
      const id = own[normalizeLabel(c.name)];
      if (id) map[c.id] = id;
    }
    return map;
  }

  // Vue « totale » de `p` jusqu'au mois `upTo` : sa part de chaque dépense du
  // couple (charges fixes comprises, catégorie du couple sans budget) plus son
  // perso. Même format que l'état du couple, pour réutiliser l'analyse.
  function totalState(state, p, upTo) {
    const ps = personalState(state, p);
    const remap = personalCategoryMap(state, p);
    const couple = allExpenses(state, upTo)
      .map((e) => ({
        id: `${e.id}#${p}`,
        recurringId: e.recurringId,
        date: e.date,
        label: e.label,
        categoryId: remap[e.categoryId] || e.categoryId,
        amount: sharesOf(e)[p],
        payer: p,
        split: p === 'a' ? 100 : 0,
      }))
      .filter((e) => e.amount !== 0);
    return { ...ps, expenses: couple.concat(ps.expenses) };
  }

  // Ce que `p` dépense vraiment sur un mois : sa part des dépenses du couple
  // plus ses dépenses perso.
  function personalTotal(state, p, month) {
    const couple = monthSummary(state, month).share[p];
    const perso = monthSummary(personalState(state, p), month).total;
    return { couple, perso, total: couple + perso };
  }

  // Génère les occurrences mensuelles des charges fixes jusqu'au mois `upTo` inclus.
  function expandRecurring(recurring, upTo) {
    const out = [];
    for (const r of recurring) {
      const last = r.endMonth && r.endMonth < upTo ? r.endMonth : upTo;
      if (r.startMonth > last) continue;
      for (const month of monthsRange(r.startMonth, last)) {
        const day = Math.min(r.day || 1, daysInMonth(month));
        out.push({
          id: `${r.id}@${month}`,
          recurringId: r.id,
          date: `${month}-${pad(day)}`,
          label: r.label,
          amount: r.amount,
          payer: r.payer,
          categoryId: r.categoryId,
          split: r.split,
          shareA: r.shareA,
          byUsage: Boolean(r.byUsage),
          ...(r.personal ? { personal: r.personal } : {}),
        });
      }
    }
    return out;
  }

  // Ce que `from` doit à l'autre au titre des charges fixes d'un mois donné
  // (sa part moins ce qu'il/elle a déjà payé soi-même), jamais négatif.
  function fixedChargesDebt(state, month, from) {
    const rs = recurringSummary(state, month);
    return Math.max(0, rs.share[from] - rs.paid[from]);
  }

  // Occurrences mensuelles des remboursements automatiques jusqu'au mois `upTo`.
  // `auto` = le montant est recalculé chaque mois à partir des charges fixes.
  function expandRecurringTransfers(state, upTo) {
    const out = [];
    for (const r of state.recurringTransfers || []) {
      const last = r.endMonth && r.endMonth < upTo ? r.endMonth : upTo;
      if (r.startMonth > last) continue;
      for (const month of monthsRange(r.startMonth, last)) {
        const amount = r.auto ? fixedChargesDebt(state, month, r.from) : r.amount;
        if (!(amount > 0)) continue;
        const day = Math.min(r.day || 1, daysInMonth(month));
        out.push({
          id: `${r.id}@${month}`,
          recurringTransferId: r.id,
          date: `${month}-${pad(day)}`,
          from: r.from,
          to: r.to,
          amount,
          note: r.note || '',
        });
      }
    }
    return out;
  }

  function allTransfers(state, upTo) {
    return state.transfers
      .filter((t) => monthKey(t.date) <= upTo)
      .concat(expandRecurringTransfers(state, upTo));
  }

  // Dépenses ponctuelles + occurrences des charges fixes, jusqu'au mois `upTo`.
  function allExpenses(state, upTo) {
    const real = shared(state.expenses).filter((e) => monthKey(e.date) <= upTo);
    return real.concat(expandRecurring(shared(state.recurring), upTo)).map((e) => signed(withUsage(state, e)));
  }

  // Solde du couple : net.a > 0 signifie que b doit net.a à a.
  // Toutes les dépenses saisies comptent (même datées plus tard) ; les charges
  // fixes et remboursements automatiques ne comptent que jusqu'au mois `upTo`
  // (en général le mois en cours).
  function computeBalance(state, upTo) {
    const net = { a: 0, b: 0 };
    for (const raw of shared(state.expenses).concat(expandRecurring(shared(state.recurring), upTo))) {
      const e = signed(withUsage(state, raw));
      const s = sharesOf(e);
      net[e.payer] += e.amount;
      net.a -= s.a;
      net.b -= s.b;
    }
    for (const t of state.transfers.concat(expandRecurringTransfers(state, upTo))) {
      net[t.from] += t.amount;
      net[t.to] -= t.amount;
    }
    if (net.a === 0) return { net, debtor: null, creditor: null, amount: 0 };
    return net.a > 0
      ? { net, debtor: 'b', creditor: 'a', amount: net.a }
      : { net, debtor: 'a', creditor: 'b', amount: net.b };
  }

  function monthExpenses(state, month) {
    return allExpenses(state, month)
      .filter((e) => monthKey(e.date) === month)
      .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  }

  function monthSummary(state, month) {
    const expenses = monthExpenses(state, month);
    const byCategory = {};
    const paid = { a: 0, b: 0 };
    const share = { a: 0, b: 0 };
    let total = 0;
    for (const e of expenses) {
      total += e.amount;
      paid[e.payer] += e.amount;
      const s = sharesOf(e);
      share.a += s.a;
      share.b += s.b;
      byCategory[e.categoryId] = (byCategory[e.categoryId] || 0) + e.amount;
    }
    const categories = shared(state.categories).map((c) => ({
      ...c,
      spent: byCategory[c.id] || 0,
      remaining: c.budget - (byCategory[c.id] || 0),
    }));
    const budgetTotal = shared(state.categories).reduce((sum, c) => sum + (c.budget || 0), 0);
    return { month, expenses, total, paid, share, categories, budgetTotal };
  }

  // Coût mensuel des charges fixes actives sur un mois donné.
  function recurringSummary(state, month) {
    const active = shared(state.recurring).filter(
      (r) => r.startMonth <= month && (!r.endMonth || r.endMonth >= month)
    );
    const paid = { a: 0, b: 0 };
    const share = { a: 0, b: 0 };
    let total = 0;
    for (const r of active) {
      total += r.amount;
      paid[r.payer] += r.amount;
      const s = sharesOf(r.byUsage ? { ...r, split: carUsageFor(state, month).split } : r);
      share.a += s.a;
      share.b += s.b;
    }
    return { active, total, paid, share };
  }

  // Qui a réellement financé le mois : dépenses payées directement, plus les
  // virements donnés, moins les virements reçus (remboursements auto compris).
  // `variableOnly` : sans les charges fixes ni les remboursements automatiques
  // (qui servent à les couvrir) ; les remboursements saisis à la main restent.
  function monthContributions(state, month, { variableOnly = false } = {}) {
    const paid = { a: 0, b: 0 };
    const share = { a: 0, b: 0 };
    for (const e of monthExpenses(state, month)) {
      if (variableOnly && e.recurringId) continue;
      paid[e.payer] += e.amount;
      const sh = sharesOf(e);
      share.a += sh.a;
      share.b += sh.b;
    }
    const given = { a: 0, b: 0 };
    for (const t of allTransfers(state, month)) {
      if (monthKey(t.date) !== month || (variableOnly && t.recurringTransferId)) continue;
      given[t.from] += t.amount;
    }
    const funded = {
      a: paid.a + given.a - given.b,
      b: paid.b + given.b - given.a,
    };
    return { paid, given, funded, share, diffA: funded.a - share.a };
  }

  // Dépenses du mois réparties selon l'usage de la voiture (essence, péage…).
  function carSummary(state, month) {
    const usage = carUsageFor(state, month);
    const expenses = monthExpenses(state, month).filter((e) => e.byUsage);
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    const paid = { a: 0, b: 0 };
    const share = { a: 0, b: 0 };
    for (const e of expenses) {
      paid[e.payer] += e.amount;
      const s = sharesOf(e);
      share.a += s.a;
      share.b += s.b;
    }
    return { usage, expenses, total, paid, share };
  }

  // Libellé simplifié pour comparer : minuscules, sans accents, chiffres ni ponctuation.
  function normalizeLabel(label) {
    return String(label || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Catégorie la plus probable pour un libellé, d'après les dépenses passées :
  // même libellé (poids 3) ou même premier mot (poids 1). null si rien de sûr.
  function guessCategory(state, label) {
    const key = normalizeLabel(label);
    if (key.length < 2) return null;
    const first = key.split(' ')[0];
    const scores = {};
    for (const e of shared(state.expenses)) {
      if (e.isIncome || !e.categoryId) continue;
      const k = normalizeLabel(e.label);
      const w = k === key ? 3 : first.length >= 3 && k.split(' ')[0] === first ? 1 : 0;
      if (w) scores[e.categoryId] = (scores[e.categoryId] || 0) + w;
    }
    let best = null;
    for (const [id, score] of Object.entries(scores)) if (!best || score > best.score) best = { id, score };
    return best ? best.id : null;
  }

  // Dépenses fréquentes (au moins 2 fois en 4 mois) à proposer en raccourci,
  // avec les réglages de la dernière occurrence.
  function favorites(state, today, n = 5) {
    const since = addMonths(monthKey(today), -4);
    const groups = {};
    for (const e of shared(state.expenses)) {
      if (e.isIncome || monthKey(e.date) < since) continue;
      const k = normalizeLabel(e.label);
      if (!k) continue;
      const g = groups[k] || (groups[k] = { count: 0, last: e });
      g.count++;
      if (e.date >= g.last.date) g.last = e;
    }
    return Object.values(groups)
      .filter((g) => g.count >= 2)
      .sort((x, y) => y.count - x.count || (x.last.date < y.last.date ? 1 : -1))
      .slice(0, n)
      .map(({ count, last }) => ({
        count,
        label: last.label,
        amount: last.amount,
        payer: last.payer,
        categoryId: last.categoryId,
        split: last.split,
        shareA: last.shareA,
        byUsage: last.byUsage,
      }));
  }

  // Projet d'épargne : déjà mis de côté (total et par personne), % de l'objectif,
  // et ce qu'il faut mettre chaque mois pour tenir l'échéance (mois inclus).
  function goalProgress(state, goal, today) {
    const contribs = (state.goalContributions || []).filter((c) => c.goalId === goal.id);
    const byPerson = { a: 0, b: 0 };
    for (const c of contribs) byPerson[c.person] += c.amount;
    const saved = byPerson.a + byPerson.b;
    const remaining = Math.max(0, goal.target - saved);
    let monthsLeft = null;
    let perMonth = null;
    if (goal.deadline) {
      const cur = monthKey(today);
      monthsLeft = goal.deadline < cur ? 0 : monthsRange(cur, goal.deadline).length;
      perMonth = monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining;
    }
    return {
      saved,
      byPerson,
      remaining,
      pct: Math.min(100, Math.round((saved / goal.target) * 100)),
      done: saved >= goal.target,
      monthsLeft,
      perMonth,
    };
  }

  // Lecture d'un ticket de caisse (texte reconnu sur la photo) : les lignes
  // « article ... 1,99 », et le total (ligne TOTAL / SOLDE / À PAYER, sinon le
  // plus grand montant). Les lignes de paiement, TVA, rendu… ne sont pas des articles.
  const RECEIPT_TOTAL = /\b(total|solde|reste|a payer|net a payer|montant du|montant ttc|ttc|amount due|balance due|grand total)\b/;
  const RECEIPT_SUBTOTAL = /\b(sous ?total|sub ?total)\b/;
  const RECEIPT_SKIP = /\b(sous ?total|sub ?total|total|solde|a payer|cb|carte|visa|mastercard|especes|rendu|monnaie|tva|htva|ht|ttc|taux|montant|paiement|paye|regle|credit|debit|avoir|fidelite|cagnotte|ticket|merci|siret|tel|date|heure|caisse|transaction|aut|contactless|sans contact|pieces|articles|table|serv|vat|sales|rate|amt|change|cash|card|guests|chk|tbl|excl|balance)\b/;
  // Montant en fin de ligne (1,99 / 12.50 / -0,60), suivi éventuellement de la
  // devise (€, EUR, souvent mal lue : « ER », « EIR », « e », « £ ») puis de petits
  // restes de lecture (code TVA « A », « À », points, virgules…).
  // Les chiffres mal lus en lettres (B pour 8, O pour 0…) sont corrigés.
  const RECEIPT_AMOUNT = /(?:^|\s)[€£$Ç]?(-?\s?[\dBOoSIl]{1,4}[,.]\s?\d{2})[.,]?(?:\s*(?:€|eur|euros?|eir|fur|er|ur|e|£|c)\b)?(?:\s*[^\s\d]{1,3})*\s*$/i;
  const OCR_DIGITS = { B: '8', O: '0', o: '0', S: '5', I: '1', l: '1' };
  const toCents = (s) => Math.round(parseFloat(s.replace(/\s/g, '').replace(/[BOoSIl]/g, (c) => OCR_DIGITS[c]).replace(',', '.')) * 100);

  function parseReceiptText(text) {
    const items = [];
    const totals = [];
    const amounts = [];
    let afterTotal = false;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, ' ').trim();
      const m = line.match(RECEIPT_AMOUNT);
      if (!m) continue;
      const amount = toCents(m[1]);
      if (!Number.isFinite(amount) || amount === 0) continue;
      let before = line.slice(0, m.index).replace(/\b\d+\s*[x*]\s*\d+[,.]\d{2}\b/gi, ' '); // « 2 x 1,50 »
      // Un seul autre montant sur la ligne : le prix unitaire (« 3 X EPINARDS 3.15 EUR 9.45 EUR ») ;
      // plusieurs : ligne de tableau (TVA…).
      const others = before.match(/\d[,.]\d{2}/g) || [];
      const table = others.length >= 2;
      if (others.length === 1) before = before.replace(/[\dBO]{1,4}[,.]\d{2}\s*(?:€|eur|euros?|eir|er|e)?/i, ' ');
      const key = normalizeLabel(before);
      if (RECEIPT_TOTAL.test(key) && !RECEIPT_SUBTOTAL.test(key)) {
        if (amount > 0) totals.push(amount);
        afterTotal = true;
        continue;
      }
      if (amount > 0 && !table) amounts.push(amount);
      if (afterTotal || table || RECEIPT_SKIP.test(key) || !/[a-z]{3}/.test(key)) continue;
      // Début de ligne : bruit de lecture (« a. », « m5 », colonne « T »…) puis quantité éventuelle.
      const words = before.replace(/[€*|]+/g, ' ').trim().split(/\s+/);
      const first = words.findIndex((w) => /[a-z]{3}/i.test(normalizeLabel(w)));
      // Quantité seulement si elle est écrite « 2 X » : un chiffre seul en début de
      // ligne est souvent une colonne mal lue (« T » lu « 7 »).
      const q = before.match(/(?:^|[\sA-Za-z])(\d{1,2})[\s.]?[x×*](?:\s|$)/i);
      const qty = q && Number(q[1]) <= 12 ? Number(q[1]) : 1;
      const label = words.slice(Math.max(0, first)).join(' ');
      items.push({ label: qty > 1 ? `${qty} × ${label}` : label, amount });
    }
    return { totals, amounts, items };
  }

  // Sans ligne TOTAL lisible : le total revient d'habitude plusieurs fois sur le
  // ticket (total, reste à payer, paiement carte). On prend le plus grand montant
  // vu au moins deux fois dans une même lecture s'il couvre les articles lus
  // (deux articles au même prix ne font pas un total), et jamais moins que la
  // somme des articles lus.
  function guessTotal(reads) {
    let best = 0;
    for (const r of reads) {
      const seen = {};
      for (const a of r.amounts) seen[a] = (seen[a] || 0) + 1;
      const sum = r.items.reduce((s, it) => s + it.amount, 0);
      const repeated = Object.keys(seen).map(Number).filter((a) => seen[a] >= 2 && a >= sum);
      best = Math.max(best, sum, repeated.length ? Math.max(...repeated) : Math.max(0, ...r.amounts));
    }
    return best;
  }

  // `text` : le texte lu, ou plusieurs lectures de la même photo (réglages
  // différents). Le total vient d'une ligne TOTAL / SOLDE / À PAYER si une
  // lecture en trouve une (sinon le plus grand montant) ; les articles, de la
  // lecture dont la somme tombe le plus près de ce total.
  function parseReceipt(text) {
    const reads = (Array.isArray(text) ? text : [text]).map(parseReceiptText);
    const totals = reads.flatMap((r) => r.totals);
    const total = totals.length ? Math.max(...totals) : guessTotal(reads);
    let best = null;
    for (const r of reads) {
      // Un « article » qui vaut tout le ticket est une ligne de total mal lue.
      const items = r.items.filter((it) => it.amount < total || (it.amount === total && r.items.length === 1));
      const gap = Math.abs(total - items.reduce((sum, it) => sum + it.amount, 0));
      if (!best || gap < best.gap || (gap === best.gap && items.length > best.items.length)) best = { gap, items };
    }
    return { total, items: best ? best.items : [] };
  }

  // Répartition d'un ticket : chaque article est pour les deux ('ab'), pour 'a',
  // pour 'b', ou retiré ('x', ex. le pourboire). Renvoie les montants « rien que
  // pour » de la dépense et le montant retiré du total ; le reste (articles
  // partagés, remises, lignes non lues) est partagé.
  function receiptExtras(items, assign) {
    const extra = { a: 0, b: 0, x: 0 };
    items.forEach((it, i) => {
      const who = assign[i];
      if (who === 'a' || who === 'b' || who === 'x') extra[who] += it.amount;
    });
    return { extraA: Math.max(0, extra.a), extraB: Math.max(0, extra.b), removed: Math.max(0, extra.x) };
  }

  // Répartition proportionnelle aux revenus (en % pour a), arrondie à l'unité.
  function splitFromIncomes(incomeA, incomeB) {
    const sum = incomeA + incomeB;
    if (!(sum > 0)) return 50;
    return Math.round((incomeA / sum) * 100);
  }

  // Analyse d'un mois : % du budget consommé, projection de fin de mois au rythme
  // actuel, comparaison avec la moyenne des 3 mois précédents, et alertes.
  // `today` (YYYY-MM-DD) sert à savoir quelle part du mois est écoulée.
  function analyzeMonth(state, month, today) {
    const summary = monthSummary(state, month);
    const curMonth = monthKey(today);
    const dim = daysInMonth(month);
    const elapsed = month < curMonth ? dim : month > curMonth ? 0 : Number(today.slice(8, 10));
    const progress = elapsed / dim; // part du mois écoulée (0..1)

    const prevMonths = [1, 2, 3].map((i) => addMonths(month, -i));
    const prevSummaries = prevMonths.map((m) => monthSummary(state, m));
    // On ne compte que les mois où il y a eu au moins une dépense.
    const withData = prevSummaries.filter((s) => s.total > 0);

    // Les charges fixes tombent en début de mois : on ne les projette pas, seules
    // les dépenses variables suivent le rythme de dépense.
    const project = (fixed, variable) => {
      if (progress <= 0) return fixed + variable;
      if (progress >= 1) return fixed + variable;
      return fixed + Math.round(variable / progress);
    };

    // Budgets annuels (vacances…) : on suit l'année civile du mois affiché.
    const yearMonths = monthsRange(`${month.slice(0, 4)}-01`, month);
    const yearSummaries = yearMonths.map((m) => (m === month ? summary : monthSummary(state, m)));
    const monthIndex = yearMonths.length; // 1 = janvier

    const categories = summary.categories.map((c) => {
      const lastMonth = prevSummaries[0].categories.find((x) => x.id === c.id)?.spent || 0;
      if (c.period === 'year' && c.budget > 0) {
        const ytd = yearSummaries.reduce((sum, ys) => sum + (ys.categories.find((x) => x.id === c.id)?.spent || 0), 0);
        // Cagnotte : 1/12e du budget s'ajoute chaque mois, les dépenses s'en déduisent.
        const allowance = Math.round((c.budget * monthIndex) / 12);
        const pct = Math.round((ytd / c.budget) * 100);
        const avgs = withData.map((ps) => ps.categories.find((x) => x.id === c.id)?.spent || 0);
        const average = avgs.length ? Math.round(avgs.reduce((x, y) => x + y, 0) / avgs.length) : null;
        return {
          ...c,
          annual: true,
          fixed: 0,
          variable: c.spent,
          ytd,
          allowance,
          available: allowance - ytd,
          pct,
          projected: c.spent,
          projectedPct: null,
          average,
          lastMonth,
          vsAverage: average ? Math.round(((c.spent - average) / average) * 100) : null,
          level: ytd > c.budget ? 'over' : pct >= 90 ? 'warn' : 'ok',
        };
      }
      let fixed = 0;
      for (const e of summary.expenses) {
        if (e.categoryId === c.id && e.recurringId) fixed += e.amount;
      }
      const variable = c.spent - fixed;
      const projected = project(fixed, variable);
      const avgs = withData.map((s) => s.categories.find((x) => x.id === c.id)?.spent || 0);
      const average = avgs.length ? Math.round(avgs.reduce((x, y) => x + y, 0) / avgs.length) : null;
      const pct = c.budget > 0 ? Math.round((c.spent / c.budget) * 100) : null;
      const projectedPct = c.budget > 0 ? Math.round((projected / c.budget) * 100) : null;

      let level = 'ok';
      if (c.budget > 0) {
        if (c.spent > c.budget) level = 'over';
        else if (pct >= 90 || (progress < 1 && projectedPct > 100)) level = 'warn';
      }
      return {
        ...c,
        fixed,
        variable,
        pct,
        projected,
        projectedPct,
        average,
        lastMonth,
        vsAverage: average ? Math.round(((c.spent - average) / average) * 100) : null,
        level,
      };
    });

    const alerts = [];
    for (const c of categories) {
      if (c.annual) {
        if (c.level === 'over') alerts.push({ level: 'over', annual: true, categoryId: c.id, pct: c.pct, excess: c.ytd - c.budget });
        else if (c.level === 'warn') alerts.push({ level: 'warn', annual: true, categoryId: c.id, pct: c.pct });
        continue;
      }
      if (c.level === 'over') {
        alerts.push({
          level: 'over',
          categoryId: c.id,
          pct: c.pct,
          excess: c.spent - c.budget,
        });
      } else if (c.level === 'warn') {
        alerts.push({
          level: 'warn',
          categoryId: c.id,
          pct: c.pct,
          projected: c.projected,
          projectedPct: c.projectedPct,
        });
      }
      // Dépense hors budget (pas d'enveloppe) nettement au-dessus de l'habitude.
      if (c.budget === 0 && c.average && c.spent > c.average * 1.5 && c.spent - c.average >= 3000) {
        alerts.push({ level: 'trend', categoryId: c.id, vsAverage: c.vsAverage, average: c.average });
      }
    }
    const order = { over: 0, warn: 1, trend: 2 };
    alerts.sort((x, y) => order[x.level] - order[y.level] || (y.pct || 0) - (x.pct || 0));

    // Le récapitulatif « Budgets » du mois ne compte que les budgets mensuels.
    const budgeted = categories.filter((c) => c.budget > 0 && !c.annual);
    const budgetSpent = budgeted.reduce((s, c) => s + c.spent, 0);
    const budgetTotal = budgeted.reduce((s, c) => s + c.budget, 0);
    // Compté sur les dépenses elles-mêmes : une charge fixe sans catégorie reste une charge fixe.
    const fixedTotal = summary.expenses.filter((e) => e.recurringId).reduce((s, e) => s + e.amount, 0);
    const projectedTotal = project(fixedTotal, summary.total - fixedTotal);
    const prevAverage = withData.length
      ? Math.round(withData.reduce((s, x) => s + x.total, 0) / withData.length)
      : null;

    return {
      ...summary,
      progress,
      categories,
      alerts,
      budgetSpent,
      budgetTotal,
      budgetPct: budgetTotal > 0 ? Math.round((budgetSpent / budgetTotal) * 100) : null,
      projectedTotal,
      fixedTotal,
      prevAverage,
      vsAverage: prevAverage ? Math.round(((summary.total - prevAverage) / prevAverage) * 100) : null,
      history: [...prevSummaries]
        .reverse()
        .concat([summary])
        .map((s) => {
          const fixedSum = s.expenses.filter((e) => e.recurringId).reduce((sum, e) => sum + e.amount, 0);
          return { month: s.month, total: s.total, fixed: fixedSum, variable: s.total - fixedSum };
        }),
    };
  }

  const api = {
    analyzeMonth,
    shared,
    withoutFixed,
    personalState,
    personalCategoryMap,
    personalTotal,
    totalState,
    goalProgress,
    normalizeLabel,
    guessCategory,
    favorites,
    monthContributions,
    carUsageFor,
    carSummary,
    fixedChargesDebt,
    expandRecurringTransfers,
    allTransfers,
    pad,
    monthKey,
    todayISO,
    addMonths,
    monthsRange,
    daysInMonth,
    parseAmount,
    shareOf,
    sharesOf,
    expandRecurring,
    allExpenses,
    computeBalance,
    monthExpenses,
    monthSummary,
    recurringSummary,
    splitFromIncomes,
    parseReceipt,
    receiptExtras,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgLogic = api;
})(typeof self !== 'undefined' ? self : this);
