const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');

function baseState(extra = {}) {
  return {
    people: [
      { id: 'a', name: 'Alex' },
      { id: 'b', name: 'Sam' },
    ],
    defaultSplit: 50,
    categories: [
      { id: 'courses', name: 'Courses', icon: '🛒', budget: 40000, position: 0 },
      { id: 'resto', name: 'Restaurants', icon: '🍽️', budget: 10000, position: 1 },
      { id: 'logement', name: 'Logement', icon: '🏠', budget: 0, position: 2 },
      { id: 'loisirs', name: 'Loisirs', icon: '🎉', budget: 0, position: 3 },
    ],
    expenses: [],
    recurring: [],
    transfers: [],
    ...extra,
  };
}

test('parseAmount accepte les formats français', () => {
  assert.equal(L.parseAmount('12,50'), 1250);
  assert.equal(L.parseAmount('12.5'), 1250);
  assert.equal(L.parseAmount('1 200 €'), 120000);
  assert.equal(L.parseAmount('0,07'), 7);
  assert.ok(Number.isNaN(L.parseAmount('abc')));
  assert.ok(Number.isNaN(L.parseAmount('1,234')));
});

test('shareOf répartit sans perdre de centime', () => {
  assert.deepEqual(L.shareOf(1001, 50), { a: 501, b: 500 });
  assert.deepEqual(L.shareOf(1000, 100), { a: 1000, b: 0 });
  assert.deepEqual(L.shareOf(999, 60), { a: 599, b: 400 });
});

test('addMonths et monthsRange traversent les années', () => {
  assert.equal(L.addMonths('2026-11', 3), '2027-02');
  assert.equal(L.addMonths('2026-01', -1), '2025-12');
  assert.deepEqual(L.monthsRange('2026-11', '2027-01'), ['2026-11', '2026-12', '2027-01']);
});

test('solde : 50/50, une dépense de chaque côté', () => {
  const s = baseState({
    expenses: [
      { id: '1', date: '2026-10-02', label: 'Courses', amount: 10000, payer: 'a', categoryId: 'courses', split: 50 },
      { id: '2', date: '2026-10-05', label: 'Resto', amount: 4000, payer: 'b', categoryId: 'resto', split: 50 },
    ],
  });
  const bal = L.computeBalance(s, '2026-10');
  // Alex a payé 100, sa part est 70 -> Sam doit 30.
  assert.equal(bal.debtor, 'b');
  assert.equal(bal.creditor, 'a');
  assert.equal(bal.amount, 3000);
});

test('solde : dépense payée entièrement pour l\'autre', () => {
  const s = baseState({
    expenses: [{ id: '1', date: '2026-10-02', label: 'Cadeau', amount: 5000, payer: 'a', categoryId: null, split: 0 }],
  });
  const bal = L.computeBalance(s, '2026-10');
  assert.equal(bal.debtor, 'b');
  assert.equal(bal.amount, 5000);
});

test('solde : remboursement remet à zéro', () => {
  const s = baseState({
    expenses: [{ id: '1', date: '2026-10-02', label: 'Courses', amount: 6000, payer: 'a', categoryId: 'courses', split: 50 }],
    transfers: [{ id: 't', date: '2026-10-03', from: 'b', to: 'a', amount: 3000, note: '' }],
  });
  const bal = L.computeBalance(s, '2026-10');
  assert.equal(bal.amount, 0);
  assert.equal(bal.debtor, null);
});

test('charges fixes : comptées chaque mois jusqu\'au mois en cours', () => {
  const s = baseState({
    defaultSplit: 60,
    recurring: [
      { id: 'loyer', label: 'Loyer', amount: 100000, payer: 'a', categoryId: 'logement', split: 60, day: 5, startMonth: '2026-08', endMonth: null },
      { id: 'netflix', label: 'Netflix', amount: 1399, payer: 'b', categoryId: 'loisirs', split: 50, day: 31, startMonth: '2026-10', endMonth: null },
    ],
  });
  const occ = L.expandRecurring(s.recurring, '2026-10');
  assert.equal(occ.filter((e) => e.recurringId === 'loyer').length, 3);
  assert.equal(occ.find((e) => e.recurringId === 'netflix').date, '2026-10-31');
  // Février : le jour 31 est ramené au dernier jour du mois.
  assert.equal(L.expandRecurring(s.recurring, '2027-02').find((e) => e.id === 'netflix@2027-02').date, '2027-02-28');

  // Loyer : Alex paie 1000, part de Sam 40 % -> Sam doit 400 par mois, 3 mois = 1200.
  // Netflix : Sam paie 13,99, part d'Alex 50 % -> Alex doit 7,00 (arrondi).
  const bal = L.computeBalance(s, '2026-10');
  assert.equal(bal.debtor, 'b');
  assert.equal(bal.amount, 120000 - 700);
});

test('charges fixes terminées ne comptent plus', () => {
  const s = baseState({
    recurring: [
      { id: 'r', label: 'Salle de sport', amount: 3000, payer: 'a', categoryId: 'loisirs', split: 50, day: 1, startMonth: '2026-01', endMonth: '2026-03' },
    ],
  });
  assert.equal(L.expandRecurring(s.recurring, '2026-10').length, 3);
  assert.equal(L.recurringSummary(s, '2026-10').total, 0);
  assert.equal(L.recurringSummary(s, '2026-02').total, 3000);
});

test('analyse : budget dépassé à 140 %', () => {
  const s = baseState({
    expenses: [
      { id: '1', date: '2026-10-02', label: 'Courses', amount: 30000, payer: 'a', categoryId: 'courses', split: 50 },
      { id: '2', date: '2026-10-10', label: 'Courses', amount: 26000, payer: 'b', categoryId: 'courses', split: 50 },
    ],
  });
  const an = L.analyzeMonth(s, '2026-10', '2026-10-24');
  const courses = an.categories.find((c) => c.id === 'courses');
  assert.equal(courses.pct, 140);
  assert.equal(courses.level, 'over');
  assert.equal(an.alerts[0].level, 'over');
  assert.equal(an.alerts[0].excess, 16000);
  assert.equal(an.budgetTotal, 50000);
  assert.equal(an.budgetPct, 112);
});

test('analyse : projection fin de mois au rythme actuel', () => {
  const s = baseState({
    expenses: [{ id: '1', date: '2026-10-05', label: 'Resto', amount: 6000, payer: 'a', categoryId: 'resto', split: 50 }],
    recurring: [
      { id: 'loyer', label: 'Loyer', amount: 90000, payer: 'a', categoryId: 'logement', split: 50, day: 1, startMonth: '2026-10', endMonth: null },
    ],
  });
  // 10 jours sur 31 écoulés : 60 € de resto -> 186 € projetés, soit 186 % du budget.
  const an = L.analyzeMonth(s, '2026-10', '2026-10-10');
  const resto = an.categories.find((c) => c.id === 'resto');
  assert.equal(resto.pct, 60);
  assert.equal(resto.projected, 18600);
  assert.equal(resto.level, 'warn');
  assert.equal(an.alerts[0].projectedPct, 186);
  // Le loyer (charge fixe) n'est pas extrapolé.
  assert.equal(an.projectedTotal, 90000 + 18600);
});

test('analyse : mois passé = pas de projection, comparaison à la moyenne', () => {
  const s = baseState({
    expenses: [
      { id: '1', date: '2026-07-10', label: 'Ciné', amount: 4000, payer: 'a', categoryId: 'loisirs', split: 50 },
      { id: '2', date: '2026-08-10', label: 'Ciné', amount: 4000, payer: 'a', categoryId: 'loisirs', split: 50 },
      { id: '3', date: '2026-09-10', label: 'Concert', amount: 16000, payer: 'b', categoryId: 'loisirs', split: 50 },
    ],
  });
  const an = L.analyzeMonth(s, '2026-09', '2026-10-24');
  assert.equal(an.progress, 1);
  assert.equal(an.projectedTotal, 16000);
  const loisirs = an.categories.find((c) => c.id === 'loisirs');
  assert.equal(loisirs.average, 4000);
  assert.equal(loisirs.vsAverage, 300);
  assert.equal(an.alerts[0].level, 'trend');
  assert.deepEqual(
    an.history.map((h) => h.month),
    ['2026-06', '2026-07', '2026-08', '2026-09']
  );
});

test('splitFromIncomes : au prorata des revenus', () => {
  assert.equal(L.splitFromIncomes(300000, 200000), 60);
  assert.equal(L.splitFromIncomes(0, 0), 50);
});

test('remboursement automatique : sa part des charges fixes, chaque mois', () => {
  const s = baseState({
    recurring: [
      { id: 'loyer', label: 'Loyer', amount: 100000, payer: 'a', categoryId: 'logement', split: 50, day: 1, startMonth: '2026-08', endMonth: null },
      { id: 'netflix', label: 'Netflix', amount: 2000, payer: 'b', categoryId: 'loisirs', split: 50, day: 1, startMonth: '2026-10', endMonth: null },
    ],
    recurringTransfers: [
      { id: 'rt', from: 'b', to: 'a', auto: true, amount: null, day: 1, startMonth: '2026-08', endMonth: null, note: '' },
    ],
  });
  // Août/sept : Sam doit 500 ; octobre : 500 - 10 (Netflix payé par Sam) = 490.
  assert.equal(L.fixedChargesDebt(s, '2026-09', 'b'), 50000);
  assert.equal(L.fixedChargesDebt(s, '2026-10', 'b'), 49000);
  assert.equal(L.fixedChargesDebt(s, '2026-10', 'a'), 0);
  const occ = L.expandRecurringTransfers(s, '2026-10');
  assert.deepEqual(occ.map((t) => [t.date, t.amount]), [
    ['2026-08-01', 50000],
    ['2026-09-01', 50000],
    ['2026-10-01', 49000],
  ]);
  // Les charges fixes sont exactement remboursées : solde nul.
  assert.equal(L.computeBalance(s, '2026-10').amount, 0);
});

test('remboursement automatique à montant fixe, avec fin', () => {
  const s = baseState({
    expenses: [{ id: '1', date: '2026-09-02', label: 'Courses', amount: 60000, payer: 'a', categoryId: 'courses', split: 50 }],
    recurringTransfers: [
      { id: 'rt', from: 'b', to: 'a', auto: false, amount: 10000, day: 5, startMonth: '2026-09', endMonth: '2026-10', note: '' },
    ],
  });
  assert.equal(L.expandRecurringTransfers(s, '2026-12').length, 2);
  // Sam doit 300, a remboursé 2 × 100.
  const bal = L.computeBalance(s, '2026-12');
  assert.equal(bal.debtor, 'b');
  assert.equal(bal.amount, 10000);
  assert.equal(L.allTransfers(s, '2026-09').length, 1);
});

test('essence : répartition selon l\'usage de la voiture du mois', () => {
  const s = baseState({
    defaultSplit: 50,
    expenses: [
      { id: 'e1', date: '2026-09-05', label: 'Essence', amount: 10000, payer: 'a', categoryId: null, split: 50, byUsage: true },
      { id: 'e2', date: '2026-10-05', label: 'Essence', amount: 8000, payer: 'a', categoryId: null, split: 50, byUsage: true },
      { id: 'e3', date: '2026-10-06', label: 'Péage', amount: 2000, payer: 'b', categoryId: null, split: 50, byUsage: true },
    ],
    recurring: [
      { id: 'assu', label: 'Assurance auto', amount: 6000, payer: 'a', categoryId: null, split: 50, day: 1, startMonth: '2026-10', endMonth: null, byUsage: true },
    ],
    carUsage: { '2026-09': 80 },
  });
  // Octobre pas encore renseigné : on reprend septembre (80 %).
  assert.deepEqual(L.carUsageFor(s, '2026-10'), { split: 80, isSet: false, from: '2026-09' });
  assert.equal(L.carUsageFor(s, '2026-08').split, 50);

  s.carUsage['2026-10'] = 70;
  const car = L.carSummary(s, '2026-10');
  assert.equal(car.usage.isSet, true);
  assert.equal(car.total, 16000); // essence + péage + assurance
  assert.deepEqual(car.share, { a: 11200, b: 4800 });

  // Septembre : Max paie 100, part de Lola 20. Octobre : Max paie 80 + 60, Lola 20 ;
  // part de Lola 30 % de 160 = 48 -> Lola doit 48 - 20 = 28. Total : 20 + 28 = 48.
  const bal = L.computeBalance(s, '2026-10');
  assert.equal(bal.debtor, 'b');
  assert.equal(bal.amount, 4800);
  // La charge fixe suit aussi l'usage dans les remboursements automatiques.
  assert.equal(L.fixedChargesDebt(s, '2026-10', 'b'), 1800);
});

test('répartition par montant précis plutôt qu\'en %', () => {
  const s = baseState({
    expenses: [{ id: '1', date: '2026-10-02', label: 'Ilevia', amount: 4699, payer: 'a', categoryId: null, split: 21, shareA: 1000 }],
    recurring: [{ id: 'r', label: 'Internet', amount: 4699, payer: 'a', categoryId: null, split: 83, shareA: 3900, day: 1, startMonth: '2026-10', endMonth: null }],
  });
  assert.deepEqual(L.sharesOf(s.expenses[0]), { a: 1000, b: 3699 });
  // Lola doit 36,99 (dépense) + 7,99 (charge fixe) — sans arrondi en %.
  assert.equal(L.computeBalance(s, '2026-10').amount, 3699 + 799);
  assert.deepEqual(L.recurringSummary(s, '2026-10').share, { a: 3900, b: 799 });
});

test('qui a financé le mois : les virements comptent', () => {
  const s = baseState({
    expenses: [{ id: '1', date: '2026-10-03', label: 'Spotify', amount: 999, payer: 'b', categoryId: null, split: 50 }],
    recurring: [{ id: 'loyer', label: 'Loyer', amount: 102400, payer: 'a', categoryId: null, split: 50, day: 1, startMonth: '2026-10', endMonth: null }],
    recurringTransfers: [{ id: 'rt', from: 'b', to: 'a', auto: false, amount: 63638, day: 1, startMonth: '2026-10', endMonth: null, note: '' }],
    transfers: [{ id: 't', date: '2026-09-30', from: 'a', to: 'b', amount: 5000, note: '' }],
  });
  const c = L.monthContributions(s, '2026-10');
  assert.deepEqual(c.paid, { a: 102400, b: 999 });
  assert.deepEqual(c.given, { a: 0, b: 63638 }); // le virement de septembre ne compte pas
  assert.deepEqual(c.funded, { a: 102400 - 63638, b: 999 + 63638 });
  // Part de Max : 512 + 5 (Spotify, arrondi) ; il a financé 387,62 -> Lola a financé 124,38 de plus.
  assert.equal(c.share.a, 51200 + 500);
  assert.equal(c.diffA, 102400 - 63638 - 51700);
});

test('entrée d\'argent : remboursement EDF reçu par l\'un, partagé et déduit', () => {
  const s = baseState({
    categories: [{ id: 'nrj', name: 'Énergie', icon: '💡', budget: 15000, position: 0 }],
    recurring: [{ id: 'edf', label: 'EDF', amount: 10600, payer: 'a', categoryId: 'nrj', split: 50, day: 1, startMonth: '2026-10', endMonth: null }],
    expenses: [{ id: 'r', date: '2026-10-20', label: 'Remboursement EDF', amount: 4000, payer: 'a', categoryId: 'nrj', split: 50, isIncome: true }],
  });
  const sum = L.monthSummary(s, '2026-10');
  assert.equal(sum.total, 6600); // 106 - 40
  assert.equal(sum.categories[0].spent, 6600);
  // EDF : Lola doit 53 ; Maxime a reçu 40 dont 20 pour Lola -> Lola doit 33.
  const bal = L.computeBalance(s, '2026-10');
  assert.equal(bal.debtor, 'b');
  assert.equal(bal.amount, 3300);
  // Montant précis : 30 € pour Maxime, 10 € pour Lola.
  s.expenses[0].shareA = 3000;
  assert.equal(L.computeBalance(s, '2026-10').amount, 5300 - 1000);
});

test('articles pour une seule personne (shampoing, dessert)', () => {
  const s = baseState({
    expenses: [
      // Courses 33,80 dont shampoing 5 € pour Maxime : reste 28,80 partagé 50/50.
      { id: '1', date: '2026-10-24', label: 'Courses', amount: 3380, payer: 'a', categoryId: null, split: 50, extraA: 500, extraB: 0 },
      // Resto 60 € payé par Lola, dessert 7 € pour Lola seulement.
      { id: '2', date: '2026-10-24', label: 'Resto', amount: 6000, payer: 'b', categoryId: null, split: 50, extraA: 0, extraB: 700 },
    ],
  });
  assert.deepEqual(L.sharesOf(s.expenses[0]), { a: 1440 + 500, b: 1440 });
  assert.deepEqual(L.sharesOf(s.expenses[1]), { a: 2650, b: 2650 + 700 });
  // Lola doit 14,40 ; Maxime doit 26,50 -> Maxime doit 12,10.
  const bal = L.computeBalance(s, '2026-10');
  assert.equal(bal.debtor, 'a');
  assert.equal(bal.amount, 1210);
});

test('budget annuel (vacances) : cagnotte et pas d\'alerte le mois du départ', () => {
  const s = baseState({
    categories: [
      { id: 'vac', name: 'Vacances', icon: '✈️', budget: 180000, period: 'year', position: 0 },
      { id: 'courses', name: 'Courses', icon: '🛒', budget: 40000, position: 1 },
    ],
    expenses: [
      { id: '1', date: '2026-03-10', label: 'Week-end', amount: 30000, payer: 'a', categoryId: 'vac', split: 50 },
      { id: '2', date: '2026-08-02', label: 'Grèce', amount: 120000, payer: 'b', categoryId: 'vac', split: 50 },
      { id: '3', date: '2026-07-05', label: 'Courses', amount: 32000, payer: 'a', categoryId: 'courses', split: 50 },
      { id: '4', date: '2026-08-05', label: 'Courses', amount: 38000, payer: 'a', categoryId: 'courses', split: 50 },
    ],
  });
  const an = L.analyzeMonth(s, '2026-08', '2026-08-20');
  const vac = an.categories.find((c) => c.id === 'vac');
  assert.equal(vac.annual, true);
  assert.equal(vac.spent, 120000); // ce mois-ci
  assert.equal(vac.ytd, 150000); // depuis janvier
  assert.equal(vac.allowance, 120000); // 8/12 de 1 800 €
  assert.equal(vac.available, -30000); // cagnotte dépassée de 300 €
  assert.equal(vac.pct, 83);
  assert.equal(vac.level, 'ok'); // 1 500 / 1 800 : pas d'alerte malgré 1 200 € en août
  // Le récapitulatif mensuel des budgets ignore le budget annuel.
  assert.equal(an.budgetTotal, 40000);
  // Comparaison : mois dernier.
  assert.equal(an.categories.find((c) => c.id === 'courses').lastMonth, 32000);

  s.expenses.push({ id: '5', date: '2026-08-15', label: 'Location', amount: 40000, payer: 'a', categoryId: 'vac', split: 50 });
  const an2 = L.analyzeMonth(s, '2026-08', '2026-08-20');
  assert.equal(an2.categories.find((c) => c.id === 'vac').level, 'over');
  assert.deepEqual(an2.alerts[0], { level: 'over', annual: true, categoryId: 'vac', pct: 106, excess: 10000 });
});
