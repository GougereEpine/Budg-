// Interface de Budg'. Rendu en HTML simple, régénéré à chaque changement d'état.
(function () {
  'use strict';

  const L = window.BudgLogic;
  const S = window.BudgStore;

  const view = document.getElementById('view');
  const tabs = document.getElementById('tabs');
  const modal = document.getElementById('modal');
  const modalForm = document.getElementById('modal-form');
  const toastEl = document.getElementById('toast');

  const ui = {
    step: 'loading',
    tab: 'home',
    month: L.monthKey(L.todayISO()),
    filter: 'all',
  };

  // ---------- Utilitaires ----------

  const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

  function euro(cents) {
    return money.format(cents / 100).replace(/,00(?=\s?€)/, '');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  function today() {
    return L.todayISO();
  }

  function currentMonth() {
    return L.monthKey(today());
  }

  function monthLabel(month, short) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', {
      month: short ? 'short' : 'long',
      year: short ? undefined : 'numeric',
    });
  }

  function dayLabel(date) {
    const [y, m, d] = date.split('-').map(Number);
    if (date === today()) return "Aujourd'hui";
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }

  function name(pid) {
    const p = S.state.people.find((x) => x.id === pid);
    return p ? p.name : pid;
  }

  function other(pid) {
    return pid === 'a' ? 'b' : 'a';
  }

  function me() {
    return S.me || 'a';
  }

  function category(id) {
    return S.state.categories.find((c) => c.id === id) || { id: null, name: 'Sans catégorie', icon: '❔', budget: 0 };
  }

  function sortedCategories() {
    return [...S.state.categories].sort((x, y) => x.position - y.position);
  }

  function splitText(split, byUsage, shareA, amount) {
    if (byUsage) return `🚗 ${split}/${100 - split}`;
    if (shareA != null) return `${esc(name('a'))} ${euro(shareA)} · ${esc(name('b'))} ${euro(amount - shareA)}`;
    if (split === 100) return `pour ${name('a')}`;
    if (split === 0) return `pour ${name('b')}`;
    return `${split}/${100 - split}`;
  }

  function pctClass(level) {
    return level === 'over' ? 'over' : level === 'warn' ? 'warn' : 'ok';
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
  }

  function errorMessage(e) {
    const msg = (e && e.message) || String(e);
    if (/Invalid login credentials/i.test(msg)) return 'E-mail ou mot de passe incorrect';
    if (/Email not confirmed/i.test(msg)) return "Confirmez d'abord votre e-mail (lien reçu par mail)";
    if (/User already registered/i.test(msg)) return 'Un compte existe déjà avec cet e-mail';
    if (/Password should be/i.test(msg)) return 'Mot de passe trop court (6 caractères minimum)';
    if (/Failed to fetch|NetworkError/i.test(msg)) return 'Pas de connexion internet';
    return msg;
  }

  async function run(promise, okMsg) {
    try {
      await promise;
      if (okMsg) toast(okMsg);
    } catch (e) {
      console.error(e);
      toast('⚠️ ' + errorMessage(e));
    }
  }

  // ---------- Fenêtre modale ----------

  function openModal(title, bodyHtml, { onSubmit, onDelete, submitLabel = 'Enregistrer', onOpen } = {}) {
    modalForm.innerHTML = `
      <div class="modal-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Fermer">✕</button>
      </div>
      ${bodyHtml}
      <p class="error" data-error></p>
      <div class="modal-actions">
        ${onDelete ? '<button type="button" class="btn danger" data-delete>Supprimer</button>' : ''}
        ${onSubmit ? `<button type="submit" class="btn primary">${esc(submitLabel)}</button>` : ''}
      </div>`;
    modalForm.onsubmit = async (ev) => {
      ev.preventDefault();
      const errEl = modalForm.querySelector('[data-error]');
      try {
        const res = await onSubmit(modalForm);
        if (res === false) return;
        modal.close();
      } catch (e) {
        console.error(e);
        errEl.textContent = errorMessage(e);
      }
    };
    modalForm.querySelector('[data-close]').onclick = () => modal.close();
    const del = modalForm.querySelector('[data-delete]');
    if (del) {
      del.onclick = async () => {
        if (!confirm('Supprimer définitivement ?')) return;
        modal.close();
        await run(onDelete(), 'Supprimé');
      };
    }
    modal.showModal();
    if (onOpen) onOpen(modalForm);
  }

  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) modal.close();
  });

  function fail(form, msg) {
    form.querySelector('[data-error]').textContent = msg;
    return false;
  }

  // Champs communs des formulaires.

  function payerField(selected, fieldName = 'payer', label = 'Payé par') {
    return `
      <label class="field"><span>${label}</span>
        <div class="seg">
          ${['a', 'b']
            .map(
              (p) => `<label><input type="radio" name="${fieldName}" value="${p}" ${p === selected ? 'checked' : ''}>
                <span><i class="dot ${p}"></i>${esc(name(p))}</span></label>`
            )
            .join('')}
        </div>
      </label>`;
  }

  function categoryField(selected) {
    return `
      <label class="field"><span>Catégorie</span>
        <select name="categoryId">
          ${sortedCategories()
            .map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`)
            .join('')}
        </select>
      </label>`;
  }

  function usageHint(month) {
    const u = L.carUsageFor(S.state, month);
    const txt = `${name('a')} ${u.split} % · ${name('b')} ${100 - u.split} %`;
    return u.isSet
      ? `Usage de la voiture ce mois-ci : <b>${esc(txt)}</b> (modifiable dans Analyse).`
      : `Usage de ${esc(monthLabel(month))} pas encore indiqué : <b>${esc(txt)}</b> en attendant. Réglez-le dans Analyse, même en fin de mois.`;
  }

  // `item` : { split, byUsage, shareA } de la dépense ou charge fixe.
  function splitField(item, month) {
    const { split, byUsage, shareA } = item;
    const d = S.state.defaultSplit;
    const inEuros = shareA != null && !byUsage;
    let mode = 'custom';
    if (byUsage) mode = 'car';
    else if (inEuros) mode = 'custom';
    else if (split === d) mode = 'default';
    else if (split === 50) mode = '50';
    else if (split === 100) mode = 'a';
    else if (split === 0) mode = 'b';
    const opt = (v, label) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${esc(label)}</option>`;
    return `
      <label class="field"><span>Répartition</span>
        <select name="splitMode">
          ${opt('default', `Comme d'habitude (${d}/${100 - d})`)}
          ${d !== 50 ? opt('50', 'Moitié-moitié (50/50)') : ''}
          ${opt('a', `Tout pour ${name('a')}`)}
          ${opt('b', `Tout pour ${name('b')}`)}
          ${opt('custom', 'Personnalisée…')}
          ${opt('car', "🚗 Selon l'usage de la voiture (essence…)")}
        </select>
      </label>
      <p class="hint" data-usage-hint ${mode === 'car' ? '' : 'hidden'}>${usageHint(month)}</p>
      <div data-custom ${mode === 'custom' ? '' : 'hidden'}>
        <div class="seg" style="margin-bottom:10px">
          <label><input type="radio" name="customUnit" value="pct" ${inEuros ? '' : 'checked'}><span>En %</span></label>
          <label><input type="radio" name="customUnit" value="eur" ${inEuros ? 'checked' : ''}><span>En €</span></label>
        </div>
        <label class="field" data-unit-pct ${inEuros ? 'hidden' : ''}>
          <span>Part de ${esc(name('a'))} (%) — ${esc(name('b'))} paie le reste</span>
          <input name="splitCustom" type="number" min="0" max="100" step="1" value="${split}">
        </label>
        <label class="field" data-unit-eur ${inEuros ? '' : 'hidden'}>
          <span>Montant pour ${esc(name('a'))} (€) — ${esc(name('b'))} paie le reste</span>
          <input name="shareCustom" inputmode="decimal" placeholder="0 €" value="${inEuros ? amountValue(shareA) : ''}" autocomplete="off">
        </label>
        <p class="hint" data-split-preview></p>
      </div>`;
  }

  // `getMonth` donne le mois concerné (pour afficher l'usage de la voiture).
  function bindSplitField(form, getMonth) {
    const sel = form.querySelector('[name=splitMode]');
    const custom = form.querySelector('[data-custom]');
    const hint = form.querySelector('[data-usage-hint]');
    const preview = form.querySelector('[data-split-preview]');
    const sync = () => {
      custom.hidden = sel.value !== 'custom';
      hint.hidden = sel.value !== 'car';
      hint.innerHTML = usageHint(getMonth());
      const eur = form.customUnit.value === 'eur';
      form.querySelector('[data-unit-pct]').hidden = eur;
      form.querySelector('[data-unit-eur]').hidden = !eur;
      // Aperçu en euros de la part de chacun.
      const amount = L.parseAmount(form.amount.value);
      let text = '';
      if (amount > 0) {
        const shareA = readShareA(form);
        if (shareA != null && shareA > amount) text = `⚠️ Plus que le montant total (${euro(amount)})`;
        else {
          const s = shareA != null ? { a: shareA, b: amount - shareA } : L.shareOf(amount, readSplit(form, getMonth()));
          text = `${esc(name('a'))} <b>${euro(s.a)}</b> · ${esc(name('b'))} <b>${euro(s.b)}</b>`;
        }
      }
      preview.innerHTML = text;
    };
    sel.onchange = sync;
    form.querySelectorAll('[name=customUnit],[name=splitCustom],[name=shareCustom],[name=amount]').forEach((i) => {
      i.addEventListener('input', sync);
      i.addEventListener('change', sync);
    });
    sync();
    return sync;
  }

  function readByUsage(form) {
    return form.splitMode.value === 'car';
  }

  // Montant précis pour a (centimes) en mode personnalisé « en € », sinon null.
  function readShareA(form) {
    if (form.splitMode.value !== 'custom' || form.customUnit.value !== 'eur') return null;
    const v = form.shareCustom.value.trim();
    if (v === '') return null;
    const cents = L.parseAmount(v);
    return Number.isFinite(cents) ? cents : null;
  }

  // Lit la répartition du formulaire ; renvoie null (et affiche l'erreur) si invalide.
  function readSplitting(form, amount, month) {
    const byUsage = readByUsage(form);
    const shareA = readShareA(form);
    if (form.splitMode.value === 'custom' && form.customUnit.value === 'eur') {
      if (shareA == null) return fail(form, `Montant pour ${name('a')} invalide`) && null;
      if (shareA > amount) return fail(form, `Le montant pour ${name('a')} dépasse le total`) && null;
      return { split: Math.round((shareA / amount) * 100), shareA, byUsage: false };
    }
    return { split: readSplit(form, month), shareA: null, byUsage };
  }

  function readSplit(form, month) {
    const mode = form.splitMode.value;
    if (mode === 'car') return L.carUsageFor(S.state, month).split;
    if (mode === 'default') return S.state.defaultSplit;
    if (mode === '50') return 50;
    if (mode === 'a') return 100;
    if (mode === 'b') return 0;
    const v = Math.round(Number(form.splitCustom.value));
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : S.state.defaultSplit;
  }

  function readAmount(form, field = 'amount') {
    const cents = L.parseAmount(form[field].value);
    return Number.isFinite(cents) && cents > 0 ? cents : null;
  }

  function amountValue(cents) {
    return cents ? (cents / 100).toFixed(2).replace('.', ',').replace(/,00$/, '') : '';
  }

  // ---------- Formulaires ----------

  function expenseForm(existing, preset = {}) {
    const e = existing || {
      id: S.newId(),
      date: today(),
      label: '',
      amount: 0,
      payer: me(),
      categoryId: preset.categoryId || (sortedCategories()[0] || {}).id || null,
      split: S.state.defaultSplit,
    };
    openModal(
      existing ? 'Modifier la dépense' : 'Nouvelle dépense',
      `
      <label class="field"><span>Montant</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(e.amount)}" required autocomplete="off">
      </label>
      <label class="field"><span>Quoi ?</span>
        <input name="label" placeholder="Courses Carrefour, resto…" value="${esc(e.label)}" maxlength="80" required>
      </label>
      ${payerField(e.payer)}
      <div class="row">
        <label class="field"><span>Date</span><input type="date" name="date" value="${e.date}" required></label>
        ${categoryField(e.categoryId)}
      </div>
      ${splitField(e, L.monthKey(e.date))}`,
      {
        onOpen: (form) => {
          const month = () => L.monthKey(form.date.value || today());
          const sync = bindSplitField(form, month);
          form.date.onchange = sync;
          // Nouvelle dépense : on reprend la répartition de la dernière dépense de la catégorie
          // (ex. « Transport » toujours selon l'usage de la voiture).
          if (!existing) {
            form.categoryId.onchange = () => {
              const last = [...S.state.expenses]
                .filter((x) => x.categoryId === form.categoryId.value)
                .sort((x, y) => (x.date < y.date ? 1 : -1))[0];
              if (!last) return;
              const d = S.state.defaultSplit;
              form.splitMode.value = last.byUsage
                ? 'car'
                : last.split === d ? 'default' : last.split === 50 ? '50' : last.split === 100 ? 'a' : last.split === 0 ? 'b' : 'custom';
              if (!form.splitMode.value) form.splitMode.value = 'custom';
              form.splitCustom.value = last.split;
              form.customUnit.value = 'pct';
              sync();
            };
            form.amount.focus();
          }
        },
        onSubmit: async (form) => {
          const amount = readAmount(form);
          if (!amount) return fail(form, 'Montant invalide');
          const splitting = readSplitting(form, amount, L.monthKey(form.date.value));
          if (!splitting) return false;
          await S.save('expenses', {
            ...e,
            ...splitting,
            amount,
            label: form.label.value.trim(),
            payer: form.payer.value,
            date: form.date.value,
            categoryId: form.categoryId.value || null,
          });
          toast(existing ? 'Dépense modifiée' : 'Dépense ajoutée');
        },
        onDelete: existing ? () => S.remove('expenses', e.id) : null,
      }
    );
  }

  function recurringForm(existing) {
    const logement = S.state.categories.find((c) => c.name === 'Logement');
    const r = existing || {
      id: S.newId(),
      label: '',
      amount: 0,
      payer: me(),
      categoryId: (logement || sortedCategories()[0] || {}).id || null,
      split: S.state.defaultSplit,
      day: 1,
      startMonth: currentMonth(),
      endMonth: null,
    };
    openModal(
      existing ? 'Modifier la charge fixe' : 'Nouvelle charge fixe',
      `
      <p class="hint" style="margin-top:0">Loyer, assurance, Netflix, électricité… : c'est compté automatiquement chaque mois.</p>
      <label class="field"><span>Montant mensuel</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(r.amount)}" required autocomplete="off">
      </label>
      <label class="field"><span>Nom</span>
        <input name="label" placeholder="Loyer, Netflix, assurance habitation…" value="${esc(r.label)}" maxlength="80" required>
      </label>
      ${payerField(r.payer, 'payer', 'Prélevé sur le compte de')}
      ${categoryField(r.categoryId)}
      ${splitField(r, currentMonth())}
      <div class="row">
        <label class="field"><span>Jour du prélèvement</span>
          <input type="number" name="day" min="1" max="31" value="${r.day}" required></label>
        <label class="field"><span>À partir de</span>
          <input type="month" name="startMonth" value="${r.startMonth}" required></label>
      </div>
      <label class="field"><span>Jusqu'à (vide = toujours en cours)</span>
        <input type="month" name="endMonth" value="${r.endMonth || ''}"></label>`,
      {
        onOpen: (form) => bindSplitField(form, currentMonth),
        onSubmit: async (form) => {
          const amount = readAmount(form);
          if (!amount) return fail(form, 'Montant invalide');
          const startMonth = form.startMonth.value;
          const endMonth = form.endMonth.value || null;
          if (!/^\d{4}-\d{2}$/.test(startMonth)) return fail(form, 'Mois de début invalide');
          if (endMonth && endMonth < startMonth) return fail(form, 'La fin doit être après le début');
          const splitting = readSplitting(form, amount, currentMonth());
          if (!splitting) return false;
          await S.save('recurring', {
            ...r,
            ...splitting,
            amount,
            label: form.label.value.trim(),
            payer: form.payer.value,
            categoryId: form.categoryId.value || null,
            day: Math.min(31, Math.max(1, Math.round(Number(form.day.value)) || 1)),
            startMonth,
            endMonth,
          });
          toast(existing ? 'Charge fixe modifiée' : 'Charge fixe ajoutée');
        },
        onDelete: existing ? () => S.remove('recurring', r.id) : null,
      }
    );
  }

  function transferForm(existing, preset = {}) {
    const t = existing || {
      id: S.newId(),
      date: today(),
      from: preset.from || me(),
      to: preset.to || other(preset.from || me()),
      amount: preset.amount || 0,
      note: '',
    };
    openModal(
      existing ? 'Modifier le remboursement' : 'Remboursement',
      `
      <p class="hint" style="margin-top:0">Un virement ou du liquide donné à l'autre pour équilibrer les comptes.</p>
      <label class="field"><span>Montant</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(t.amount)}" required autocomplete="off">
      </label>
      ${payerField(t.from, 'from', 'De la part de')}
      <div class="row">
        <label class="field"><span>Date</span><input type="date" name="date" value="${t.date}" required></label>
        <label class="field"><span>Note</span><input name="note" value="${esc(t.note)}" maxlength="80" placeholder="Virement…"></label>
      </div>`,
      {
        onSubmit: async (form) => {
          const amount = readAmount(form);
          if (!amount) return fail(form, 'Montant invalide');
          const from = form.from.value;
          await S.save('transfers', {
            ...t,
            amount,
            from,
            to: other(from),
            date: form.date.value,
            note: form.note.value.trim(),
          });
          toast('Remboursement enregistré');
        },
        onDelete: existing ? () => S.remove('transfers', t.id) : null,
      }
    );
  }

  function recurringTransferForm(existing) {
    // Par défaut : la personne qui avance le moins de charges fixes rembourse l'autre.
    const rs = L.recurringSummary(S.state, currentMonth());
    const defaultFrom = rs.share.a - rs.paid.a > rs.share.b - rs.paid.b ? 'a' : 'b';
    const t = existing || {
      id: S.newId(),
      from: defaultFrom,
      to: other(defaultFrom),
      auto: true,
      amount: null,
      day: 1,
      startMonth: currentMonth(),
      endMonth: null,
      note: '',
    };
    const preview = (from) => euro(L.fixedChargesDebt(S.state, currentMonth(), from));
    openModal(
      existing ? 'Modifier le remboursement auto' : 'Remboursement automatique',
      `
      <p class="hint" style="margin-top:0">Un virement qui revient chaque mois (virement permanent…) : plus besoin de le saisir.</p>
      ${payerField(t.from, 'from', 'Qui rembourse ?')}
      <label class="field"><span>Montant</span>
        <div class="seg">
          <label><input type="radio" name="mode" value="auto" ${t.auto ? 'checked' : ''}><span>Sa part des charges fixes</span></label>
          <label><input type="radio" name="mode" value="fixed" ${t.auto ? '' : 'checked'}><span>Montant fixe</span></label>
        </div>
      </label>
      <p class="hint" data-auto-hint ${t.auto ? '' : 'hidden'}>Recalculé chaque mois d'après les charges fixes. Ce mois-ci : <b data-preview>${preview(t.from)}</b>.</p>
      <label class="field" data-fixed ${t.auto ? 'hidden' : ''}><span>Montant mensuel</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(t.amount)}" autocomplete="off">
      </label>
      <div class="row">
        <label class="field"><span>Jour du virement</span>
          <input type="number" name="day" min="1" max="31" value="${t.day}" required></label>
        <label class="field"><span>À partir de</span>
          <input type="month" name="startMonth" value="${t.startMonth}" required></label>
      </div>
      <label class="field"><span>Jusqu'à (vide = toujours en cours)</span>
        <input type="month" name="endMonth" value="${t.endMonth || ''}"></label>
      <label class="field"><span>Note</span>
        <input name="note" value="${esc(t.note)}" maxlength="80" placeholder="Virement permanent…"></label>`,
      {
        onOpen: (form) => {
          const sync = () => {
            const auto = form.mode.value === 'auto';
            form.querySelector('[data-auto-hint]').hidden = !auto;
            form.querySelector('[data-fixed]').hidden = auto;
            form.querySelector('[data-preview]').textContent = preview(form.from.value);
          };
          form.querySelectorAll('[name=mode],[name=from]').forEach((i) => (i.onchange = sync));
        },
        onSubmit: async (form) => {
          const auto = form.mode.value === 'auto';
          const amount = auto ? null : readAmount(form);
          if (!auto && !amount) return fail(form, 'Montant invalide');
          const startMonth = form.startMonth.value;
          const endMonth = form.endMonth.value || null;
          if (!/^\d{4}-\d{2}$/.test(startMonth)) return fail(form, 'Mois de début invalide');
          if (endMonth && endMonth < startMonth) return fail(form, 'La fin doit être après le début');
          const from = form.from.value;
          await S.save('recurringTransfers', {
            ...t,
            from,
            to: other(from),
            auto,
            amount,
            day: Math.min(31, Math.max(1, Math.round(Number(form.day.value)) || 1)),
            startMonth,
            endMonth,
            note: form.note.value.trim(),
          });
          toast(existing ? 'Remboursement auto modifié' : 'Remboursement auto ajouté');
        },
        onDelete: existing ? () => S.remove('recurringTransfers', t.id) : null,
      }
    );
  }

  function budgetForm(cat) {
    openModal(
      `${cat.icon} ${cat.name}`,
      `
      <label class="field"><span>Budget mensuel (0 = pas de budget)</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(cat.budget)}" autocomplete="off">
      </label>`,
      {
        onSubmit: async (form) => {
          const v = form.amount.value.trim();
          const budget = v === '' ? 0 : L.parseAmount(v);
          if (!Number.isFinite(budget)) return fail(form, 'Montant invalide');
          await S.save('categories', { ...cat, budget });
          toast('Budget mis à jour');
        },
      }
    );
  }

  const ICONS = [
    '🛒', '🥖', '🥦', '🍷', '🍽️', '🍕', '🍔', '☕', '🍻', '🏠',
    '🔑', '🛋️', '🧹', '🔧', '💡', '🔥', '💧', '📶', '📱', '💻',
    '📺', '🎬', '🎵', '🎮', '📚', '🛡️', '🏦', '💳', '🧾', '💶',
    '🚗', '⛽', '🚆', '🚲', '🅿️', '✈️', '🏖️', '🏔️', '🧳', '🏨',
    '🎉', '🎟️', '🏋️', '⚽', '🎨', '💊', '🩺', '🦷', '👓', '💇',
    '👕', '👟', '💄', '🎁', '💐', '👶', '🐶', '🐱', '🌱', '🎓',
    '💼', '🏛️', '❤️', '💍', '🐷', '📦', '🏷️', '⭐',
  ];

  function iconPicker(categoryId) {
    const cat = S.state.categories.find((c) => c.id === categoryId);
    if (!cat) return;
    const choose = (icon) => {
      modal.close();
      run(S.save('categories', { ...cat, icon }), 'Icône changée');
    };
    openModal(
      `Icône de « ${cat.name} »`,
      `
      <div class="emoji-grid">
        ${ICONS.map((i) => `<button type="button" data-emoji="${i}" class="${i === cat.icon ? 'current' : ''}">${i}</button>`).join('')}
      </div>
      <label class="field"><span>Ou tapez n'importe quel emoji</span>
        <input name="icon" maxlength="8" placeholder="${esc(cat.icon)}" autocomplete="off"></label>`,
      {
        submitLabel: 'Utiliser',
        onOpen: (form) => {
          form.querySelectorAll('[data-emoji]').forEach((b) => (b.onclick = () => choose(b.dataset.emoji)));
        },
        onSubmit: async (form) => {
          const icon = form.icon.value.trim();
          if (!icon) return fail(form, 'Choisissez un emoji');
          await S.save('categories', { ...cat, icon });
          toast('Icône changée');
        },
      }
    );
  }

  // Curseur de répartition + aide « au prorata des revenus ».
  function splitSetupHtml(split, nameA, nameB) {
    return `
      <label class="field"><span>Répartition des dépenses communes</span>
        <input type="range" name="split" min="0" max="100" step="1" value="${split}">
      </label>
      <div class="legend" style="margin-top:-6px;margin-bottom:10px">
        <span><i class="dot a"></i><b data-na>${esc(nameA)}</b> <span data-sa>${split}</span> %</span>
        <span><b data-nb>${esc(nameB)}</b> <span data-sb>${100 - split}</span> %<i class="dot b" style="margin-left:4px"></i></span>
      </div>
      <details class="small" style="margin-bottom:12px">
        <summary class="muted">Calculer au prorata des revenus</summary>
        <div class="row" style="margin-top:8px">
          <input name="incomeA" inputmode="decimal" placeholder="Revenu de ${esc(nameA)}">
          <input name="incomeB" inputmode="decimal" placeholder="Revenu de ${esc(nameB)}">
        </div>
      </details>`;
  }

  function bindSplitSetup(root, getNames) {
    const range = root.querySelector('[name=split]');
    const update = () => {
      root.querySelector('[data-sa]').textContent = range.value;
      root.querySelector('[data-sb]').textContent = 100 - range.value;
      if (getNames) {
        const [a, b] = getNames();
        root.querySelector('[data-na]').textContent = a;
        root.querySelector('[data-nb]').textContent = b;
      }
    };
    range.oninput = update;
    const incomes = () => {
      const a = L.parseAmount(root.querySelector('[name=incomeA]').value);
      const b = L.parseAmount(root.querySelector('[name=incomeB]').value);
      if (a > 0 && b > 0) {
        range.value = L.splitFromIncomes(a, b);
        update();
      }
    };
    root.querySelector('[name=incomeA]').oninput = incomes;
    root.querySelector('[name=incomeB]').oninput = incomes;
    return update;
  }

  // ---------- Écrans d'accueil ----------

  function renderLoading() {
    view.innerHTML = '<div class="welcome"><div class="logo">💞</div><p class="tagline">Chargement…</p></div>';
  }

  function renderLocalSetup() {
    view.innerHTML = `
      <div class="welcome">
        <div class="logo">💞</div>
        <h1>Budg'</h1>
        <p class="tagline">Le budget à deux, sans prise de tête.</p>
        <form class="card" id="setup">
          <div class="row">
            <label class="field"><span>Votre prénom</span><input name="nameA" required maxlength="30" placeholder="Alex"></label>
            <label class="field"><span>Prénom de votre moitié</span><input name="nameB" required maxlength="30" placeholder="Sam"></label>
          </div>
          ${splitSetupHtml(50, 'Vous', 'Votre moitié')}
          <button class="btn primary block">C'est parti</button>
          ${
            S.cloudConfigured()
              ? '<button type="button" class="btn link block" data-cloud>← Revenir à la connexion</button>'
              : '<p class="hint" style="margin:12px 0 0">Mode hors ligne : les données restent sur cet appareil. Pour partager en temps réel avec votre moitié, configurez Supabase (voir README).</p>'
          }
        </form>
      </div>`;
    const form = view.querySelector('#setup');
    bindSplitSetup(form, () => [form.nameA.value || 'Vous', form.nameB.value || 'Votre moitié']);
    form.nameA.oninput = form.nameB.oninput = () => form.split.oninput();
    form.onsubmit = (ev) => {
      ev.preventDefault();
      S.useLocal(form.nameA.value.trim(), form.nameB.value.trim(), Number(form.split.value));
      go('ready');
    };
    const back = view.querySelector('[data-cloud]');
    if (back) back.onclick = () => go('auth');
  }

  function renderAuth() {
    let signup = false;
    view.innerHTML = `
      <div class="welcome">
        <div class="logo">💞</div>
        <h1>Budg'</h1>
        <p class="tagline">Le budget à deux, synchronisé entre vos deux téléphones.</p>
        <form class="card" id="auth">
          <label class="field"><span>E-mail</span><input type="email" name="email" required autocomplete="email"></label>
          <label class="field"><span>Mot de passe</span><input type="password" name="password" required minlength="6" autocomplete="current-password"></label>
          <p class="error" data-error></p>
          <button class="btn primary block" data-submit>Se connecter</button>
          <button type="button" class="btn link block" data-toggle>Pas encore de compte ? Créer un compte</button>
        </form>
        <button type="button" class="btn link block" data-local>Utiliser sans compte, sur cet appareil</button>
      </div>`;
    const form = view.querySelector('#auth');
    const err = form.querySelector('[data-error]');
    form.querySelector('[data-toggle]').onclick = () => {
      signup = !signup;
      form.querySelector('[data-submit]').textContent = signup ? 'Créer mon compte' : 'Se connecter';
      form.querySelector('[data-toggle]').textContent = signup
        ? "J'ai déjà un compte : me connecter"
        : 'Pas encore de compte ? Créer un compte';
      form.password.autocomplete = signup ? 'new-password' : 'current-password';
      err.textContent = '';
    };
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      const btn = form.querySelector('[data-submit]');
      btn.disabled = true;
      try {
        const email = form.email.value.trim();
        const step = signup
          ? await S.signUp(email, form.password.value)
          : await S.signIn(email, form.password.value);
        if (step === 'confirm-email') {
          err.style.color = 'var(--ok)';
          err.textContent = `📬 Un e-mail de confirmation a été envoyé à ${email}. Cliquez sur le lien puis connectez-vous.`;
          return;
        }
        go(step);
      } catch (e) {
        err.style.color = '';
        err.textContent = errorMessage(e);
      } finally {
        btn.disabled = false;
      }
    };
    view.querySelector('[data-local]').onclick = () => go('welcome');
  }

  function renderHousehold() {
    view.innerHTML = `
      <div class="welcome">
        <div class="logo">💞</div>
        <h1>Votre couple</h1>
        <p class="tagline">Créez votre budget commun, ou rejoignez celui de votre moitié.</p>
        <form class="card" id="create">
          <h2 style="margin-top:0">✨ Créer notre budget</h2>
          <div class="row">
            <label class="field"><span>Votre prénom</span><input name="nameA" required maxlength="30"></label>
            <label class="field"><span>Prénom de votre moitié</span><input name="nameB" required maxlength="30"></label>
          </div>
          ${splitSetupHtml(50, 'Vous', 'Votre moitié')}
          <p class="error" data-error></p>
          <button class="btn primary block">Créer</button>
        </form>
        <form class="card" id="join">
          <h2 style="margin-top:0">🔗 Rejoindre avec un code</h2>
          <p class="hint" style="margin-top:0">Votre moitié trouve le code dans Réglages.</p>
          <label class="field"><span>Code d'invitation</span>
            <input name="code" required maxlength="6" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.2em"></label>
          <p class="error" data-error></p>
          <button class="btn block">Rejoindre</button>
        </form>
        <button type="button" class="btn link block" data-logout>Se déconnecter</button>
      </div>`;
    const create = view.querySelector('#create');
    bindSplitSetup(create, () => [create.nameA.value || 'Vous', create.nameB.value || 'Votre moitié']);
    create.nameA.oninput = create.nameB.oninput = () => create.split.oninput();
    create.onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        go(await S.createHousehold(create.nameA.value.trim(), create.nameB.value.trim(), Number(create.split.value)));
      } catch (e) {
        create.querySelector('[data-error]').textContent = errorMessage(e);
      }
    };
    const join = view.querySelector('#join');
    join.onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        go(await S.joinHousehold(join.code.value));
      } catch (e) {
        join.querySelector('[data-error]').textContent = errorMessage(e);
      }
    };
    view.querySelector('[data-logout]').onclick = () => S.signOut();
  }

  // ---------- Morceaux réutilisés ----------

  function monthNav() {
    return `
      <div class="month-nav">
        <button data-month="-1" aria-label="Mois précédent">‹</button>
        <span class="label">${monthLabel(ui.month)}</span>
        <button data-month="1" aria-label="Mois suivant">›</button>
      </div>`;
  }

  function alertHtml(a) {
    const c = category(a.categoryId);
    const label = `${esc(c.icon)} ${esc(c.name)}`;
    if (a.level === 'over') {
      return `<div class="alert over"><span class="ico">🚨</span><div>
        <strong>${label} : ${a.pct} % du budget</strong>
        Hors budget de <b>${euro(a.excess)}</b> (budget ${euro(c.budget)})</div></div>`;
    }
    if (a.level === 'warn') {
      if (a.pct >= 90) {
        return `<div class="alert warn"><span class="ico">⚠️</span><div>
          <strong>${label} : ${a.pct} % du budget déjà utilisé</strong>
          Il reste ${euro(Math.max(0, c.budget - Math.round((a.pct * c.budget) / 100)))} pour finir le mois</div></div>`;
      }
      return `<div class="alert warn"><span class="ico">⚠️</span><div>
        <strong>${label} : à ce rythme, ${a.projectedPct} % du budget</strong>
        Projection fin de mois : ${euro(a.projected)} pour ${euro(c.budget)} prévus</div></div>`;
    }
    return `<div class="alert trend"><span class="ico">📈</span><div>
      <strong>${label} : +${a.vsAverage} % par rapport à d'habitude</strong>
      Moyenne des derniers mois : ${euro(a.average)}</div></div>`;
  }

  function expenseItem(e) {
    const c = category(e.categoryId);
    const tag = e.recurringId ? '🔁 ' : '';
    return `
      <div class="item" data-expense="${e.id}">
        <div class="emoji">${esc(c.icon)}</div>
        <div class="body">
          <div class="title">${tag}${esc(e.label)}</div>
          <div class="sub">${esc(c.name)} · ${splitText(e.split, e.byUsage, e.shareA, e.amount)}</div>
        </div>
        <div class="right">
          <div class="amt num">${euro(e.amount)}</div>
          <span class="pill ${e.payer}">${esc(name(e.payer))}</span>
        </div>
      </div>`;
  }

  function transferItem(t) {
    return `
      <div class="item" data-transfer="${t.id}">
        <div class="emoji">💸</div>
        <div class="body">
          <div class="title">${t.recurringTransferId ? '🔁 ' : ''}Remboursement</div>
          <div class="sub">${esc(name(t.from))} → ${esc(name(t.to))}${t.note ? ' · ' + esc(t.note) : ''}</div>
        </div>
        <div class="right"><div class="amt num">${euro(t.amount)}</div></div>
      </div>`;
  }

  // « Maxime 512 € · Lola 512 € » : la part en euros de chacun pour un montant.
  function sharesLine(s) {
    return `<div class="shares">
      <span><i class="dot a"></i>${esc(name('a'))} <b class="num">${euro(s.a)}</b></span>
      <span><i class="dot b"></i>${esc(name('b'))} <b class="num">${euro(s.b)}</b></span>
    </div>`;
  }

  function splitBar(values, labelA, labelB) {
    const total = values.a + values.b;
    const pa = total ? (values.a / total) * 100 : 50;
    return `
      <div class="split-bar"><div class="pa" style="width:${pa}%"></div><div class="pb" style="width:${100 - pa}%"></div></div>
      <div class="legend">
        <span><i class="dot a"></i>${esc(name('a'))} ${labelA}</span>
        <span>${labelB} ${esc(name('b'))}<i class="dot b" style="margin-left:4px"></i></span>
      </div>`;
  }

  // ---------- Onglets ----------

  // ---------- Usage de la voiture ----------

  function usesCar() {
    const st = S.state;
    return st.expenses.some((e) => e.byUsage) || st.recurring.some((r) => r.byUsage) || Object.keys(st.carUsage).length > 0;
  }

  function carReminder(month) {
    const car = L.carSummary(S.state, month);
    if (!car.expenses.length || car.usage.isSet) return '';
    return `<div class="alert trend" data-goto="budget" style="cursor:pointer"><span class="ico">🚗</span><div>
      <strong>Usage de la voiture de ${esc(monthLabel(month))} à indiquer</strong>
      ${euro(car.total)} de dépenses voiture réparties en attendant à ${car.usage.split}/${100 - car.usage.split}. Touchez pour régler →</div></div>`;
  }

  function carCard(month) {
    if (!usesCar()) return '';
    const car = L.carSummary(S.state, month);
    const u = car.usage;
    const status = u.isSet
      ? ''
      : `<p class="hint" style="margin:0 0 10px">Pas encore indiqué pour ce mois : ${
          u.from ? `on reprend ${esc(monthLabel(u.from))}` : 'on utilise la répartition par défaut'
        } (${u.split}/${100 - u.split}).</p>`;
    return `
      <h2>🚗 Voiture</h2>
      <form class="card" id="car-usage">
        <div class="small muted" style="margin-bottom:6px">Qui a utilisé la voiture en ${esc(monthLabel(month))} ?</div>
        ${status}
        <input type="range" name="usage" min="0" max="100" step="5" value="${u.split}" aria-label="Part d'usage de ${esc(name('a'))}">
        <div class="legend" style="margin:4px 0 10px">
          <span><i class="dot a"></i>${esc(name('a'))} <b data-ua>${u.split}</b> %</span>
          <span>${esc(name('b'))} <b data-ub>${100 - u.split}</b> %<i class="dot b" style="margin-left:4px"></i></span>
        </div>
        <details class="small" style="margin-bottom:12px">
          <summary class="muted">Calculer avec les kilomètres</summary>
          <div class="row" style="margin-top:8px">
            <input name="kmA" inputmode="numeric" placeholder="km ${esc(name('a'))}">
            <input name="kmB" inputmode="numeric" placeholder="km ${esc(name('b'))}">
          </div>
        </details>
        <div class="small muted">Dépenses voiture du mois (essence, péage…) : <b class="num" data-car-total>${euro(car.total)}</b></div>
        <div data-car-shares>${car.total ? sharesLine(L.shareOf(car.total, u.split)) : ''}</div>
        <button class="btn primary block" style="margin-top:12px">Enregistrer l'usage de ${esc(monthLabel(month, true))}</button>
      </form>`;
  }

  function bindCarCard(month) {
    const form = view.querySelector('#car-usage');
    if (!form) return;
    const car = L.carSummary(S.state, month);
    const update = () => {
      const v = Number(form.usage.value);
      form.querySelector('[data-ua]').textContent = v;
      form.querySelector('[data-ub]').textContent = 100 - v;
      // Aperçu : total des dépenses voiture réparti avec le % affiché.
      form.querySelector('[data-car-shares]').innerHTML = car.total ? sharesLine(L.shareOf(car.total, v)) : '';
    };
    form.usage.oninput = update;
    const km = () => {
      const a = Number(form.kmA.value.replace(/\s/g, ''));
      const b = Number(form.kmB.value.replace(/\s/g, ''));
      if (a >= 0 && b >= 0 && a + b > 0) {
        form.usage.value = Math.round((a / (a + b)) * 100);
        // Le curseur avance de 5 en 5 : on affiche la valeur exacte calculée.
        form.usage.dataset.exact = Math.round((a / (a + b)) * 100);
        update();
        form.querySelector('[data-ua]').textContent = form.usage.dataset.exact;
        form.querySelector('[data-ub]').textContent = 100 - form.usage.dataset.exact;
        form.querySelector('[data-car-shares]').innerHTML = car.total ? sharesLine(L.shareOf(car.total, Number(form.usage.dataset.exact))) : '';
      }
    };
    form.kmA.oninput = form.kmB.oninput = km;
    form.usage.addEventListener('input', () => delete form.usage.dataset.exact);
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const v = form.usage.dataset.exact != null ? Number(form.usage.dataset.exact) : Number(form.usage.value);
      run(S.setCarUsage(month, v), `Usage enregistré : ${name('a')} ${v} % · ${name('b')} ${100 - v} %`);
    };
  }

  function renderHome() {
    const state = S.state;
    const cur = currentMonth();
    const bal = L.computeBalance(state, cur);
    const an = L.analyzeMonth(state, cur, today());

    const balanceHtml =
      bal.amount === 0
        ? `<div class="card balance"><div class="muted">Solde du couple</div>
             <div class="amount">0 €</div><div class="who">Vous êtes à l'équilibre 🎉</div></div>`
        : `<div class="card balance"><div class="muted">${esc(name(bal.debtor))} doit à ${esc(name(bal.creditor))}</div>
             <div class="amount num">${euro(bal.amount)}</div>
             <button class="btn primary" data-settle>💸 Régler</button></div>`;

    const invite =
      S.mode === 'cloud' && !S.partnerJoined
        ? `<div class="card"><strong>Invitez ${esc(name(other(me())))} 💌</strong>
             <p class="small muted" style="margin:4px 0 8px">Créez-lui un compte sur Budg', puis entrez ce code :</p>
             <div class="code">${esc(S.inviteCode)}</div></div>`
        : '';

    const budgets = an.categories.filter((c) => c.budget > 0);
    let alertsHtml = an.alerts.slice(0, 3).map(alertHtml).join('');
    if (an.alerts.length > 3) {
      alertsHtml += `<button class="btn link" data-goto="budget">+ ${an.alerts.length - 3} autre(s) alerte(s) →</button>`;
    }
    if (!an.alerts.length && budgets.length && an.total > 0) {
      alertsHtml = `<div class="alert good"><span class="ico">✅</span><div><strong>Tout est dans les clous</strong>
        Aucun budget dépassé ce mois-ci.</div></div>`;
    }

    const delta =
      an.vsAverage == null
        ? '<span class="muted">Premier mois</span>'
        : `<span class="${an.vsAverage > 0 ? 'up' : 'down'}">${an.vsAverage > 0 ? '+' : ''}${an.vsAverage} % vs moyenne</span>`;

    const recent = [...state.expenses]
      .sort((x, y) => (x.date === y.date ? 0 : x.date < y.date ? 1 : -1))
      .slice(0, 5);

    view.innerHTML = `
      <div class="topbar">
        <h1>Salut ${esc(name(me()))} 👋</h1>
        <button class="icon-btn" data-settings aria-label="Réglages">⚙️</button>
      </div>
      ${invite}
      ${balanceHtml}
      ${carReminder(cur)}
      ${alertsHtml ? `<h2>Alertes de ${monthLabel(cur, true)}</h2>${alertsHtml}` : ''}
      <h2>Ce mois-ci</h2>
      <div class="stats">
        <div class="stat"><div class="label">Dépensé</div><div class="value num">${euro(an.total)}</div><div class="delta">${delta}</div></div>
        <div class="stat"><div class="label">Budgets</div>
          <div class="value num">${an.budgetPct == null ? '—' : an.budgetPct + ' %'}</div>
          <div class="delta muted">${an.budgetTotal ? `${euro(an.budgetSpent)} / ${euro(an.budgetTotal)}` : 'aucun budget défini'}</div></div>
      </div>
      <div class="card">
        <div class="small muted">Qui a payé ce mois-ci</div>
        ${splitBar(an.paid, euro(an.paid.a), euro(an.paid.b))}
      </div>
      <h2>Dernières dépenses</h2>
      <div class="card list">
        ${recent.length ? recent.map(expenseItem).join('') : '<div class="empty">Aucune dépense pour l\'instant.<br>Appuyez sur ＋ pour commencer.</div>'}
      </div>`;

    const settle = view.querySelector('[data-settle]');
    if (settle) {
      settle.onclick = () => transferForm(null, { from: bal.debtor, to: bal.creditor, amount: bal.amount });
    }
  }

  function renderExpenses() {
    const state = S.state;
    const expenses = L.monthExpenses(state, ui.month);
    const transfers = L.allTransfers(state, ui.month).filter((t) => L.monthKey(t.date) === ui.month);

    let items = expenses.map((e) => ({ kind: 'e', date: e.date, data: e }));
    items = items.concat(transfers.map((t) => ({ kind: 't', date: t.date, data: t })));
    const f = ui.filter;
    items = items.filter((it) => {
      if (f === 'all') return true;
      if (f === 'transfers') return it.kind === 't';
      if (it.kind === 't') return false;
      if (f === 'fixed') return Boolean(it.data.recurringId);
      if (f === 'a' || f === 'b') return it.data.payer === f;
      return it.data.categoryId === f;
    });
    items.sort((x, y) => (x.date === y.date ? 0 : x.date < y.date ? 1 : -1));

    const total = items.filter((it) => it.kind === 'e').reduce((s, it) => s + it.data.amount, 0);

    const usedCats = new Set(expenses.map((e) => e.categoryId));
    const chips = [
      ['all', 'Tout'],
      ['a', name('a')],
      ['b', name('b')],
      ['fixed', '🔁 Fixes'],
      ['transfers', '💸 Remboursements'],
      ...sortedCategories()
        .filter((c) => usedCats.has(c.id))
        .map((c) => [c.id, `${c.icon} ${c.name}`]),
    ];

    let html = '';
    let lastDate = null;
    for (const it of items) {
      if (it.date !== lastDate) {
        if (lastDate) html += '</div>';
        html += `<div class="day-head">${esc(dayLabel(it.date))}</div><div class="card list">`;
        lastDate = it.date;
      }
      html += it.kind === 'e' ? expenseItem(it.data) : transferItem(it.data);
    }
    if (lastDate) html += '</div>';

    view.innerHTML = `
      <div class="topbar"><h1>Dépenses</h1>
        <button class="icon-btn" data-add-transfer aria-label="Ajouter un remboursement">💸</button></div>
      ${monthNav()}
      <div class="chips">
        ${chips.map(([v, l]) => `<button class="chip ${f === v ? 'active' : ''}" data-filter="${esc(v)}">${esc(l)}</button>`).join('')}
      </div>
      <p class="muted small" style="margin:4px 4px 0">${items.length} opération(s) · total dépenses <b class="num">${euro(total)}</b></p>
      ${html || '<div class="card empty">Rien ce mois-ci.</div>'}`;

    view.querySelector('[data-add-transfer]').onclick = () => transferForm(null);
  }

  function renderFixed() {
    const state = S.state;
    const cur = currentMonth();
    const rs = L.recurringSummary(state, cur);
    const activeIds = new Set(rs.active.map((r) => r.id));
    const list = [...state.recurring].sort((x, y) => y.amount - x.amount);
    const active = list.filter((r) => activeIds.has(r.id));
    const inactive = list.filter((r) => !activeIds.has(r.id));

    const item = (r) => {
      const c = category(r.categoryId);
      const when = r.startMonth > cur ? `à partir de ${monthLabel(r.startMonth)}` : r.endMonth && r.endMonth < cur ? `terminé en ${monthLabel(r.endMonth)}` : `le ${r.day} du mois`;
      return `
        <div class="item" data-recurring="${r.id}">
          <div class="emoji">${esc(c.icon)}</div>
          <div class="body">
            <div class="title">${esc(r.label)}</div>
            <div class="sub">${esc(c.name)} · ${esc(when)}${r.byUsage ? ' · 🚗 usage voiture' : ''}</div>
            ${sharesLine(L.sharesOf(r.byUsage ? { ...r, split: L.carUsageFor(state, cur).split } : r))}
          </div>
          <div class="right">
            <div class="amt num">${euro(r.amount)}<span class="small muted">/mois</span></div>
            <span class="pill ${r.payer}">${esc(name(r.payer))}</span>
          </div>
        </div>`;
    };

    const isActive = (r) => r.startMonth <= cur && (!r.endMonth || r.endMonth >= cur);
    const rtList = [...state.recurringTransfers].sort((x, y) => (x.startMonth < y.startMonth ? -1 : 1));
    const diffA = rs.paid.a - rs.share.a;
    const debtor = diffA > 0 ? 'b' : 'a';
    const covering = rtList.find((r) => isActive(r) && r.auto && r.from === debtor);
    let balanceText = '';
    if (rs.total && diffA === 0) balanceText = 'Les charges fixes sont parfaitement équilibrées entre vous.';
    else if (rs.total && covering) {
      balanceText = `${esc(name(debtor))} rembourse automatiquement sa part (<b>${euro(Math.abs(diffA))}</b>) le ${covering.day} du mois. ✅`;
    } else if (rs.total) {
      balanceText = `Chaque mois, ${esc(name(other(debtor)))} avance <b>${euro(Math.abs(diffA))}</b> de plus que sa part : c'est compté dans le solde. Ajoutez un remboursement automatique si ${esc(name(debtor))} fait un virement permanent.`;
    }

    const rtItem = (r) => {
      const amount = r.auto ? L.fixedChargesDebt(state, cur, r.from) : r.amount;
      const when = r.startMonth > cur ? `à partir de ${monthLabel(r.startMonth)}` : r.endMonth && r.endMonth < cur ? `terminé en ${monthLabel(r.endMonth)}` : `le ${r.day} du mois`;
      return `
        <div class="item" data-recurring-transfer="${r.id}" style="${isActive(r) ? '' : 'opacity:.6'}">
          <div class="emoji">💸</div>
          <div class="body">
            <div class="title">${esc(name(r.from))} → ${esc(name(r.to))}</div>
            <div class="sub">${r.auto ? 'Sa part des charges fixes' : 'Montant fixe'} · ${esc(when)}${r.note ? ' · ' + esc(r.note) : ''}</div>
          </div>
          <div class="right"><div class="amt num">${euro(amount)}<span class="small muted">/mois</span></div></div>
        </div>`;
    };

    view.innerHTML = `
      <div class="topbar"><h1>Charges fixes</h1>
        <button class="icon-btn" data-add-recurring aria-label="Ajouter une charge fixe">＋</button></div>
      <div class="card">
        <div class="small muted">Total par mois</div>
        <div style="font-size:1.8rem;font-weight:700" class="num">${euro(rs.total)}</div>
        ${rs.total ? splitBar(rs.paid, `paie ${euro(rs.paid.a)}`, `paie ${euro(rs.paid.b)}`) : ''}
        ${
          rs.total
            ? `<div class="share-cols">
                 <div><span class="small muted"><i class="dot a"></i>Part de ${esc(name('a'))}</span><b class="num">${euro(rs.share.a)}</b></div>
                 <div><span class="small muted"><i class="dot b"></i>Part de ${esc(name('b'))}</span><b class="num">${euro(rs.share.b)}</b></div>
               </div>
               <p class="small muted" style="margin:8px 0 0">${balanceText}</p>`
            : ''
        }
      </div>
      <div class="card list">
        ${active.length ? active.map(item).join('') : `<div class="empty">Ajoutez le loyer, les assurances, les abonnements…<br><br><button class="btn primary" data-add-recurring>＋ Ajouter une charge fixe</button></div>`}
      </div>
      ${inactive.length ? `<h2>À venir ou terminées</h2><div class="card list">${inactive.map(item).join('')}</div>` : ''}
      <div class="topbar"><h2>🔁 Remboursements automatiques</h2>
        <button class="icon-btn" data-add-rt aria-label="Ajouter un remboursement automatique">＋</button></div>
      <div class="card list">
        ${rtList.length ? rtList.map(rtItem).join('') : `<div class="empty">Ex. : ${esc(name(debtor))} rembourse sa part des charges fixes chaque début de mois.<br><br><button class="btn" data-add-rt>＋ Ajouter un remboursement auto</button></div>`}
      </div>`;

    view.querySelectorAll('[data-add-recurring]').forEach((b) => (b.onclick = () => recurringForm(null)));
    view.querySelectorAll('[data-add-rt]').forEach((b) => (b.onclick = () => recurringTransferForm(null)));
  }

  function renderBudget() {
    const state = S.state;
    const an = L.analyzeMonth(state, ui.month, today());
    const isCurrent = ui.month === currentMonth();
    const isPast = ui.month < currentMonth();

    const budgeted = an.categories.filter((c) => c.budget > 0).sort((x, y) => y.pct - x.pct);
    const unbudgeted = an.categories.filter((c) => c.budget === 0 && c.spent > 0).sort((x, y) => y.spent - x.spent);

    const row = (c) => {
      const pct = c.budget ? Math.min(100, (c.spent / c.budget) * 100) : 0;
      const proj = c.budget && isCurrent ? Math.min(100, (c.projected / c.budget) * 100) : 0;
      const pill = c.budget
        ? `<span class="pill ${pctClass(c.level)}">${c.pct} %</span>`
        : '';
      let detail;
      if (!c.budget) {
        detail = c.average ? `moyenne ${euro(c.average)}` : 'pas de budget';
      } else if (c.spent > c.budget) {
        detail = `<b style="color:var(--over)">${euro(c.spent - c.budget)} hors budget</b>`;
      } else {
        detail = `reste ${euro(c.budget - c.spent)}`;
        if (isCurrent && c.projected > c.budget) detail += ` · projection ${euro(c.projected)}`;
      }
      const vs =
        c.vsAverage != null && c.spent > 0
          ? ` · <span class="${c.vsAverage > 0 ? 'up' : 'down'}">${c.vsAverage > 0 ? '+' : ''}${c.vsAverage} % vs moy.</span>`
          : '';
      return `
        <div class="budget-row level-${c.level}" data-category="${c.id}">
          <div class="budget-head">
            <span class="name">${esc(c.icon)} ${esc(c.name)}</span>
            <span class="num">${euro(c.spent)}${c.budget ? ` <span class="muted small">/ ${euro(c.budget)}</span>` : ''} ${pill}</span>
          </div>
          ${c.budget ? `<div class="bar">${proj > pct ? `<div class="proj" style="width:${proj}%"></div>` : ''}<div class="fill" style="width:${pct}%"></div></div>` : ''}
          <div class="small muted">${detail}${vs}</div>
        </div>`;
    };

    const max = Math.max(1, an.budgetTotal, ...an.history.map((h) => h.total));
    const historyHtml = an.history
      .map(
        (h) => `
        <div class="col ${h.month === ui.month ? 'current' : ''}">
          <span class="val num">${h.total ? euro(Math.round(h.total / 100) * 100) : ''}</span>
          <div class="stick" style="height:${(h.total / max) * 100}%"></div>
          <span class="m">${monthLabel(h.month, true)}</span>
        </div>`
      )
      .join('');

    const delta =
      an.vsAverage == null
        ? '<span class="muted">pas d\'historique</span>'
        : `<span class="${an.vsAverage > 0 ? 'up' : 'down'}">${an.vsAverage > 0 ? '+' : ''}${an.vsAverage} % vs moy. (${euro(an.prevAverage)})</span>`;

    const fairA = an.paid.a - an.share.a;
    const fairText =
      an.total === 0
        ? ''
        : fairA === 0
          ? 'Ce mois-ci, chacun a payé exactement sa part.'
          : `Ce mois-ci, ${esc(name(fairA > 0 ? 'a' : 'b'))} a avancé <b>${euro(Math.abs(fairA))}</b> de plus que sa part.`;

    view.innerHTML = `
      <div class="topbar"><h1>Analyse</h1>
        <button class="icon-btn" data-edit-budgets aria-label="Modifier les budgets">✏️</button></div>
      ${monthNav()}
      <div class="stats">
        <div class="stat"><div class="label">Dépensé</div><div class="value num">${euro(an.total)}</div><div class="delta">${delta}</div></div>
        <div class="stat"><div class="label">${isPast ? 'Budgets utilisés' : 'Budgets utilisés'}</div>
          <div class="value num ${an.budgetPct > 100 ? 'up' : ''}">${an.budgetPct == null ? '—' : an.budgetPct + ' %'}</div>
          <div class="delta muted">${an.budgetTotal ? `${euro(an.budgetSpent)} / ${euro(an.budgetTotal)}` : 'aucun budget'}</div></div>
        ${
          isCurrent
            ? `<div class="stat"><div class="label">Projection fin de mois</div><div class="value num">${euro(an.projectedTotal)}</div>
                 <div class="delta muted">au rythme actuel (${Math.round(an.progress * 100)} % du mois écoulé)</div></div>`
            : ''
        }
        <div class="stat"><div class="label">Charges fixes</div>
          <div class="value num">${euro(an.categories.reduce((s, c) => s + c.fixed, 0))}</div>
          <div class="delta muted">incluses dans le total</div></div>
      </div>

      ${an.alerts.length ? `<h2>Alertes</h2>${an.alerts.map(alertHtml).join('')}` : ''}
      ${carCard(ui.month)}

      <h2>Budgets par catégorie</h2>
      <div class="card" style="padding-top:4px;padding-bottom:4px">
        ${budgeted.length ? budgeted.map(row).join('') : '<div class="empty">Aucun budget défini.<br>Touchez ✏️ pour en créer (ex. Courses 400 €).</div>'}
      </div>
      ${unbudgeted.length ? `<h2>Dépenses sans budget</h2><div class="card" style="padding-top:4px;padding-bottom:4px">${unbudgeted.map(row).join('')}</div>` : ''}

      <h2>Évolution</h2>
      <div class="card"><div class="history">${historyHtml}</div></div>

      <h2>Qui paie quoi</h2>
      <div class="card">
        <div class="small muted">Payé</div>
        ${splitBar(an.paid, euro(an.paid.a), euro(an.paid.b))}
        <div class="small muted" style="margin-top:12px">Part de chacun</div>
        ${splitBar(an.share, euro(an.share.a), euro(an.share.b))}
        ${fairText ? `<p class="small" style="margin:12px 0 0">${fairText}</p>` : ''}
      </div>`;

    bindCarCard(ui.month);

    view.querySelector('[data-edit-budgets]').onclick = () => {
      ui.tab = 'settings';
      render();
      setTimeout(() => document.getElementById('categories')?.scrollIntoView({ behavior: 'smooth' }), 50);
    };
  }

  function renderSettings() {
    const state = S.state;
    const cats = sortedCategories();
    const cloud = S.mode === 'cloud';

    view.innerHTML = `
      <div class="topbar"><h1>Réglages</h1>
        <button class="icon-btn" data-goto="home" aria-label="Retour">✕</button></div>

      <form class="card" id="couple">
        <h2 style="margin-top:0">💞 Le couple</h2>
        <div class="row">
          <label class="field"><span><i class="dot a"></i>Personne 1</span><input name="nameA" value="${esc(name('a'))}" required maxlength="30"></label>
          <label class="field"><span><i class="dot b"></i>Personne 2</span><input name="nameB" value="${esc(name('b'))}" required maxlength="30"></label>
        </div>
        ${splitSetupHtml(state.defaultSplit, name('a'), name('b'))}
        <p class="hint">Utilisée par défaut pour chaque nouvelle dépense. Les dépenses déjà saisies ne changent pas.</p>
        <button class="btn primary block">Enregistrer</button>
      </form>

      ${
        cloud
          ? `<div class="card">
               <h2 style="margin-top:0">🔗 Code d'invitation</h2>
               <div class="code">${esc(S.inviteCode)}</div>
               <p class="hint" style="margin:8px 0 0">${S.partnerJoined ? '✅ Vous êtes connectés tous les deux.' : `${esc(name(other(me())))} crée un compte puis entre ce code.`}</p>
             </div>`
          : ''
      }

      <div class="card" id="categories">
        <h2 style="margin-top:0">🗂️ Catégories & budgets mensuels</h2>
        <p class="hint" style="margin-top:0">Laissez le budget vide pour une catégorie sans enveloppe.</p>
        ${cats
          .map(
            (c) => `
          <div class="cat-edit" data-cat="${c.id}">
            <button type="button" class="icon-pick" data-pick-icon aria-label="Changer l'icône">${esc(c.icon)}</button>
            <input name="name" value="${esc(c.name)}" maxlength="30" aria-label="Nom">
            <input name="budget" inputmode="decimal" value="${amountValue(c.budget)}" placeholder="— €" aria-label="Budget mensuel">
            <button type="button" data-del-cat aria-label="Supprimer">🗑️</button>
          </div>`
          )
          .join('')}
        <button type="button" class="btn block" data-add-cat style="margin-top:8px">＋ Ajouter une catégorie</button>
      </div>

      <div class="card">
        <h2 style="margin-top:0">💾 Données</h2>
        <div class="row">
          <button type="button" class="btn" data-export>Exporter</button>
          <label class="btn" style="cursor:pointer">Importer<input type="file" accept="application/json" data-import hidden></label>
        </div>
        ${
          cloud
            ? `<p class="hint" style="margin:12px 0 8px">Connecté : ${esc(S.user && S.user.email)}</p>
               <button type="button" class="btn danger block" data-logout>Se déconnecter</button>`
            : `<p class="hint" style="margin:12px 0 8px">Mode hors ligne : les données sont uniquement sur cet appareil.
                 ${S.cloudConfigured() ? "Pour les partager, exportez-les, passez en ligne puis importez-les." : ''}</p>
               ${S.cloudConfigured() ? '<button type="button" class="btn primary block" data-go-cloud style="margin-bottom:8px">Passer en ligne</button>' : ''}
               <button type="button" class="btn danger block" data-reset>Tout effacer</button>`
        }
      </div>
      <p class="small muted" style="text-align:center">Budg' · fait avec 💞</p>`;

    const couple = view.querySelector('#couple');
    bindSplitSetup(couple, () => [couple.nameA.value, couple.nameB.value]);
    couple.nameA.oninput = couple.nameB.oninput = () => couple.split.oninput();
    couple.onsubmit = (ev) => {
      ev.preventDefault();
      run(
        S.updateSettings({
          nameA: couple.nameA.value.trim(),
          nameB: couple.nameB.value.trim(),
          defaultSplit: Number(couple.split.value),
        }),
        'Enregistré'
      );
    };

    view.querySelectorAll('[data-cat]').forEach((rowEl) => {
      const id = rowEl.dataset.cat;
      rowEl.querySelectorAll('input').forEach((input) => {
        input.onchange = () => {
          const c = state.categories.find((x) => x.id === id);
          if (!c) return;
          const updated = { ...c };
          if (input.name === 'budget') {
            const v = input.value.trim();
            const cents = v === '' ? 0 : L.parseAmount(v);
            if (!Number.isFinite(cents)) {
              toast('⚠️ Budget invalide');
              input.value = amountValue(c.budget);
              return;
            }
            updated.budget = cents;
          } else if (input.value.trim()) {
            updated[input.name] = input.value.trim();
          } else {
            input.value = c[input.name];
            return;
          }
          run(S.save('categories', updated), 'Enregistré');
        };
      });
      rowEl.querySelector('[data-pick-icon]').onclick = () => iconPicker(id);
      rowEl.querySelector('[data-del-cat]').onclick = () => {
        const c = category(id);
        if (!confirm(`Supprimer la catégorie « ${c.name} » ? Ses dépenses passeront « Sans catégorie ».`)) return;
        run(S.remove('categories', id), 'Catégorie supprimée');
      };
    });

    view.querySelector('[data-add-cat]').onclick = () => {
      const position = Math.max(-1, ...state.categories.map((c) => c.position)) + 1;
      run(S.save('categories', { id: S.newId(), name: 'Nouvelle catégorie', icon: '🏷️', budget: 0, position }));
    };

    view.querySelector('[data-export]').onclick = () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `budg-${today()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };

    view.querySelector('[data-import]').onchange = async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      if (!confirm('Importer ce fichier ? Les éléments du fichier seront ajoutés ou remplaceront ceux qui existent.')) return;
      try {
        await S.importState(JSON.parse(await file.text()));
        toast('Import terminé');
      } catch (e) {
        toast('⚠️ ' + errorMessage(e));
      }
    };

    const logout = view.querySelector('[data-logout]');
    if (logout) logout.onclick = () => S.signOut();
    const reset = view.querySelector('[data-reset]');
    if (reset) {
      reset.onclick = () => {
        if (!confirm('Effacer toutes les données de cet appareil ?')) return;
        localStorage.removeItem('budg-local-v1');
        S.leaveLocal();
        location.reload();
      };
    }
    const goCloud = view.querySelector('[data-go-cloud]');
    if (goCloud) {
      goCloud.onclick = () => {
        S.leaveLocal();
        location.reload();
      };
    }
  }

  // ---------- Routage ----------

  const TABS = {
    home: renderHome,
    expenses: renderExpenses,
    fixed: renderFixed,
    budget: renderBudget,
    settings: renderSettings,
  };

  function render() {
    if (ui.step !== 'ready') return;
    // Ne pas casser la saisie en cours dans les réglages lors d'une synchro.
    const focused = document.activeElement;
    if (ui.tab === 'settings' && focused && view.contains(focused) && focused.matches('input')) return;
    tabs.hidden = false;
    tabs.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
    const scroll = window.scrollY;
    TABS[ui.tab]();
    window.scrollTo(0, scroll);
  }

  function go(step) {
    ui.step = step;
    tabs.hidden = step !== 'ready';
    if (step === 'welcome') renderLocalSetup();
    else if (step === 'auth') renderAuth();
    else if (step === 'household') renderHousehold();
    else if (step === 'ready') render();
    else renderLoading();
  }

  tabs.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (!b) return;
    if (b.dataset.tab === 'add') {
      expenseForm(null);
      return;
    }
    ui.tab = b.dataset.tab;
    window.scrollTo(0, 0);
    render();
  });

  // Délégation des clics dans la vue.
  view.addEventListener('click', (ev) => {
    const t = ev.target.closest(
      '[data-expense],[data-transfer],[data-recurring-transfer],[data-recurring],[data-category],[data-month],[data-filter],[data-goto],[data-settings]'
    );
    if (!t) return;
    const d = t.dataset;
    if (d.expense) {
      const real = S.state.expenses.find((e) => e.id === d.expense);
      if (real) return expenseForm(real);
      const recId = d.expense.split('@')[0];
      const rec = S.state.recurring.find((r) => r.id === recId);
      if (rec) recurringForm(rec);
    } else if (d.transfer) {
      const tr = S.state.transfers.find((x) => x.id === d.transfer);
      if (tr) return transferForm(tr);
      const rt = S.state.recurringTransfers.find((x) => x.id === d.transfer.split('@')[0]);
      if (rt) recurringTransferForm(rt);
    } else if (d.recurringTransfer) {
      const rt = S.state.recurringTransfers.find((x) => x.id === d.recurringTransfer);
      if (rt) recurringTransferForm(rt);
    } else if (d.recurring) {
      const rec = S.state.recurring.find((r) => r.id === d.recurring);
      if (rec) recurringForm(rec);
    } else if (d.category) {
      const c = S.state.categories.find((x) => x.id === d.category);
      if (c) budgetForm(c);
    } else if (d.month) {
      ui.month = L.addMonths(ui.month, Number(d.month));
      render();
    } else if (d.filter) {
      ui.filter = d.filter;
      render();
    } else if (d.goto || d.settings !== undefined) {
      ui.tab = d.goto || 'settings';
      window.scrollTo(0, 0);
      render();
    }
  });

  S.onChange(() => render());

  async function boot() {
    go('loading');
    try {
      go(await S.init());
    } catch (e) {
      console.error(e);
      toast('⚠️ ' + errorMessage(e));
      // Hors connexion : on affiche les dernières données connues si on en a.
      if (S.state) go('ready');
      else go(S.mode === 'cloud' ? 'auth' : 'welcome');
    }
  }

  boot();
})();
