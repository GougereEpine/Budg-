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
    const s = String(input).replace(/[\s €]/g, '').replace(',', '.');
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  }

  function shareOf(amount, split) {
    const a = Math.round((amount * split) / 100);
    return { a, b: amount - a };
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
        });
      }
    }
    return out;
  }

  // Dépenses ponctuelles + occurrences des charges fixes, jusqu'au mois `upTo`.
  function allExpenses(state, upTo) {
    const real = state.expenses.filter((e) => monthKey(e.date) <= upTo);
    return real.concat(expandRecurring(state.recurring, upTo));
  }

  // Solde du couple : net.a > 0 signifie que b doit net.a à a.
  // Toutes les dépenses saisies comptent (même datées plus tard) ; les charges
  // fixes ne comptent que jusqu'au mois `upTo` (en général le mois en cours).
  function computeBalance(state, upTo) {
    const net = { a: 0, b: 0 };
    for (const e of state.expenses.concat(expandRecurring(state.recurring, upTo))) {
      const s = shareOf(e.amount, e.split);
      net[e.payer] += e.amount;
      net.a -= s.a;
      net.b -= s.b;
    }
    for (const t of state.transfers) {
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
      const s = shareOf(e.amount, e.split);
      share.a += s.a;
      share.b += s.b;
      byCategory[e.categoryId] = (byCategory[e.categoryId] || 0) + e.amount;
    }
    const categories = state.categories.map((c) => ({
      ...c,
      spent: byCategory[c.id] || 0,
      remaining: c.budget - (byCategory[c.id] || 0),
    }));
    const budgetTotal = state.categories.reduce((sum, c) => sum + (c.budget || 0), 0);
    return { month, expenses, total, paid, share, categories, budgetTotal };
  }

  // Coût mensuel des charges fixes actives sur un mois donné.
  function recurringSummary(state, month) {
    const active = state.recurring.filter(
      (r) => r.startMonth <= month && (!r.endMonth || r.endMonth >= month)
    );
    const paid = { a: 0, b: 0 };
    const share = { a: 0, b: 0 };
    let total = 0;
    for (const r of active) {
      total += r.amount;
      paid[r.payer] += r.amount;
      const s = shareOf(r.amount, r.split);
      share.a += s.a;
      share.b += s.b;
    }
    return { active, total, paid, share };
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

    const categories = summary.categories.map((c) => {
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
        vsAverage: average ? Math.round(((c.spent - average) / average) * 100) : null,
        level,
      };
    });

    const alerts = [];
    for (const c of categories) {
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

    const budgeted = categories.filter((c) => c.budget > 0);
    const budgetSpent = budgeted.reduce((s, c) => s + c.spent, 0);
    const fixedTotal = categories.reduce((s, c) => s + c.fixed, 0);
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
      budgetPct: summary.budgetTotal > 0 ? Math.round((budgetSpent / summary.budgetTotal) * 100) : null,
      projectedTotal,
      prevAverage,
      vsAverage: prevAverage ? Math.round(((summary.total - prevAverage) / prevAverage) * 100) : null,
      history: [...prevSummaries].reverse().concat([summary]).map((s) => ({ month: s.month, total: s.total })),
    };
  }

  const api = {
    analyzeMonth,
    pad,
    monthKey,
    todayISO,
    addMonths,
    monthsRange,
    daysInMonth,
    parseAmount,
    shareOf,
    expandRecurring,
    allExpenses,
    computeBalance,
    monthExpenses,
    monthSummary,
    recurringSummary,
    splitFromIncomes,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgLogic = api;
})(typeof self !== 'undefined' ? self : this);
