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
    search: '',
    openFixedGroups: new Set(), // catégories dépliées dans l'onglet Fixes
    hideFixed: readPref('budg-hide-fixed') === '1',
    // Accueil : charges fixes masquées par défaut (réglage séparé).
    hideFixedHome: readPref('budg-hide-fixed-home') !== '0',
    persoOf: null, // espace perso affiché ('a' ou 'b'), par défaut le sien
    scope: 'couple', // Analyse : 'couple', 'perso' ou 'total' (sa part du couple + son perso)
  };

  // Préférences propres à cet appareil (le stockage peut être indisponible).
  function readPref(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* tant pis : le réglage ne sera pas retenu */
    }
  }

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

  // Catégories du couple (`owner` null) ou catégories perso d'une personne.
  function sortedCategories(owner = null) {
    return S.state.categories.filter((c) => (c.owner || null) === owner).sort((x, y) => x.position - y.position);
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

  // Message avec un bouton (ex. « Annuler »), visible 5 secondes.
  function toastAction(msg, label, action) {
    toastEl.innerHTML = `<span>${esc(msg)}</span><button type="button" class="toast-btn">${esc(label)}</button>`;
    toastEl.hidden = false;
    toastEl.querySelector('button').onclick = () => {
      toastEl.hidden = true;
      action();
    };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 5000);
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
    modalDirty = false;
    modalForm.oninput = modalForm.onchange = () => (modalDirty = true);
    modalForm.querySelector('[data-close]').onclick = () => closeModalSafely();
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

  // Une saisie en cours n'est jamais perdue par un clic à côté ou la touche Échap :
  // on ferme directement si rien n'a été modifié, sinon on demande confirmation.
  let modalDirty = false;

  function closeModalSafely() {
    if (modalDirty && !confirm('Fermer sans enregistrer ? Votre saisie sera perdue.')) return;
    modal.close();
  }

  // Le clic doit commencer ET finir sur le fond (sinon, sélectionner du texte dans
  // un champ et relâcher la souris à côté fermait la fenêtre).
  let pressedOnBackdrop = false;
  modal.addEventListener('mousedown', (ev) => (pressedOnBackdrop = ev.target === modal));
  modal.addEventListener('click', (ev) => {
    if (ev.target === modal && pressedOnBackdrop) closeModalSafely();
    pressedOnBackdrop = false;
  });
  modal.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    closeModalSafely();
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

  // Options du choix de catégorie : celles du couple, ou (perso) ses catégories
  // perso puis celles du couple.
  function categoryOptions(selected, owner = null) {
    const opts = (list) =>
      list.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('');
    if (!owner) return opts(sortedCategories());
    const mine = sortedCategories(owner);
    return mine.length
      ? `<optgroup label="Mes catégories">${opts(mine)}</optgroup><optgroup label="Catégories du couple">${opts(sortedCategories())}</optgroup>`
      : opts(sortedCategories());
  }

  function categoryField(selected, owner = null) {
    return `
      <label class="field"><span>Catégorie</span>
        <select name="categoryId">${categoryOptions(selected, owner)}</select>
      </label>`;
  }

  // Choix « pour le couple » ou « perso » en tête des formulaires.
  function scopeField(owner) {
    return `
      <div class="seg" style="margin-bottom:14px">
        <label><input type="radio" name="scope" value="couple" ${owner ? '' : 'checked'}><span>👥 Couple</span></label>
        <label><input type="radio" name="scope" value="perso" ${owner ? 'checked' : ''}><span>👤 Perso</span></label>
      </div>
      <p class="hint" data-perso-hint ${owner ? '' : 'hidden'}>Rien que pour vous : hors du solde et des budgets du couple, sans notification. Visible dans l'onglet Perso.</p>`;
  }

  // Bascule couple / perso : masque la répartition et change les catégories proposées.
  function bindScopeField(form, onChange) {
    const sync = () => {
      const perso = form.scope.value === 'perso';
      form.querySelector('[data-perso-hint]').hidden = !perso;
      form.querySelectorAll('[data-couple-only]').forEach((el) => (el.hidden = perso));
      const current = form.categoryId.value;
      form.categoryId.innerHTML = categoryOptions(current, perso ? form.payer.value : null);
      if (!form.categoryId.value) form.categoryId.selectedIndex = 0;
      if (onChange) onChange(perso);
    };
    form.querySelectorAll('[name=scope]').forEach((i) => (i.onchange = sync));
    form.querySelectorAll('[name=payer]').forEach((i) => i.addEventListener('change', () => form.scope.value === 'perso' && sync()));
    sync();
  }

  // Une dépense ou un abonnement perso est entièrement à la charge de son propriétaire.
  function personalFields(owner) {
    return { owner, split: owner === 'a' ? 100 : 0, shareA: null, byUsage: false, extraA: 0, extraB: 0 };
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
      // Articles pour une seule personne (formulaire de dépense uniquement).
      const extras = form.querySelector('details.extras');
      if (extras) {
        extras.hidden = sel.value === 'custom' && eur;
        const ex = readExtras(form);
        const out = form.querySelector('[data-extras-preview]');
        if (!ex) out.innerHTML = '⚠️ Montant invalide';
        else if (!(amount > 0) || !(ex.extraA || ex.extraB)) out.innerHTML = 'Le reste est partagé selon la répartition ci-dessus.';
        else if (ex.extraA + ex.extraB > amount) out.innerHTML = `⚠️ Plus que le montant total (${euro(amount)})`;
        else {
          const sh = L.sharesOf({ amount, split: readSplit(form, getMonth()), ...ex });
          out.innerHTML = `${euro(amount - ex.extraA - ex.extraB)} partagés, au total : ${esc(name('a'))} <b>${euro(sh.a)}</b> · ${esc(name('b'))} <b>${euro(sh.b)}</b>`;
        }
      }
    };
    sel.onchange = sync;
    form.querySelectorAll('[name=customUnit],[name=splitCustom],[name=shareCustom],[name=amount],[name=extraA],[name=extraB]').forEach((i) => {
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

  // Articles « rien que pour » (centimes) ; null si un montant est invalide.
  function readExtras(form) {
    if (!form.extraA) return { extraA: 0, extraB: 0 };
    const read = (input) => {
      const v = input.value.trim();
      return v === '' ? 0 : L.parseAmount(v);
    };
    const extraA = read(form.extraA);
    const extraB = read(form.extraB);
    return Number.isFinite(extraA) && Number.isFinite(extraB) ? { extraA, extraB } : null;
  }

  // Lit la répartition du formulaire ; renvoie null (et affiche l'erreur) si invalide.
  function readSplitting(form, amount, month) {
    const byUsage = readByUsage(form);
    const shareA = readShareA(form);
    if (form.splitMode.value === 'custom' && form.customUnit.value === 'eur') {
      if (shareA == null) return fail(form, `Montant pour ${name('a')} invalide`) && null;
      if (shareA > amount) return fail(form, `Le montant pour ${name('a')} dépasse le total`) && null;
      return { split: Math.round((shareA / amount) * 100), shareA, byUsage: false, extraA: 0, extraB: 0 };
    }
    const extras = readExtras(form);
    if (!extras) return fail(form, 'Montant « rien que pour » invalide') && null;
    if (extras.extraA + extras.extraB > amount) return fail(form, 'Les montants « rien que pour » dépassent le total') && null;
    return { split: readSplit(form, month), shareA: null, byUsage, ...extras };
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
      label: preset.label || '',
      amount: 0,
      payer: preset.owner || me(),
      owner: preset.owner || null,
      categoryId: preset.categoryId || (sortedCategories(preset.owner || null)[0] || sortedCategories()[0] || {}).id || null,
      split: S.state.defaultSplit,
    };
    const titles = existing
      ? ['Modifier la dépense', "Modifier l'entrée d'argent"]
      : ['Nouvelle dépense', "Nouvelle entrée d'argent"];
    const favs = existing || preset.label ? [] : L.favorites(S.state, today());
    openModal(
      titles[e.isIncome ? 1 : 0],
      `
      ${
        favs.length
          ? `<div class="chips fav-chips">${favs
              .map((f, i) => `<button type="button" class="chip" data-fav="${i}">${esc(category(f.categoryId).icon)} ${esc(f.label)} · ${euro(f.amount)}</button>`)
              .join('')}</div>`
          : ''
      }
      ${scopeField(e.owner)}
      <div class="seg" style="margin-bottom:14px">
        <label><input type="radio" name="kind" value="expense" ${e.isIncome ? '' : 'checked'}><span>💳 Dépense</span></label>
        <label><input type="radio" name="kind" value="income" ${e.isIncome ? 'checked' : ''}><span>💰 Entrée d'argent</span></label>
      </div>
      <p class="hint" data-income-hint ${e.isIncome ? '' : 'hidden'}>Remboursement EDF, d'assurance, de mutuelle… : partagé selon la répartition et déduit des dépenses de la catégorie.</p>
      <label class="field"><span data-amount-label>${e.isIncome ? 'Montant reçu' : 'Montant'}</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(e.amount)}" required autocomplete="off">
      </label>
      <label class="field"><span>Quoi ?</span>
        <input name="label" placeholder="${e.isIncome ? 'Remboursement EDF…' : 'Courses Carrefour, resto…'}" value="${esc(e.label)}" maxlength="80" required>
      </label>
      ${payerField(e.payer)}
      <div class="row">
        <label class="field"><span>Date</span><input type="date" name="date" value="${e.date}" required></label>
        ${categoryField(e.categoryId, e.owner)}
      </div>
      <div data-couple-only>
      ${splitField(e, L.monthKey(e.date))}
      <details class="extras" ${e.extraA || e.extraB ? 'open' : ''}>
        <summary>🧴 Une partie pour une seule personne <span class="muted">(shampoing, dessert…)</span></summary>
        <div class="row" style="margin-top:10px">
          <label class="field"><span>Rien que pour ${esc(name('a'))}</span>
            <input name="extraA" inputmode="decimal" placeholder="0 €" value="${amountValue(e.extraA)}" autocomplete="off"></label>
          <label class="field"><span>Rien que pour ${esc(name('b'))}</span>
            <input name="extraB" inputmode="decimal" placeholder="0 €" value="${amountValue(e.extraB)}" autocomplete="off"></label>
        </div>
        <p class="hint" data-extras-preview>Le reste est partagé selon la répartition ci-dessus.</p>
      </details>
      </div>`,
      {
        onOpen: (form) => {
          const month = () => L.monthKey(form.date.value || today());
          const sync = bindSplitField(form, month);
          form.date.onchange = sync;
          // Dépense ou entrée d'argent : seuls les libellés changent.
          const payerLabel = form.querySelector('[name=payer]').closest('label.field').querySelector('span');
          const isPerso = () => form.scope.value === 'perso';
          const syncKind = () => {
            const income = form.kind.value === 'income';
            form.querySelector('.modal-head h2').textContent = titles[income ? 1 : 0];
            form.querySelector('[data-income-hint]').hidden = !income || isPerso();
            form.querySelector('[data-amount-label]').textContent = income ? 'Montant reçu' : 'Montant';
            payerLabel.textContent = isPerso() ? (income ? 'Pour' : 'Dépense de') : income ? 'Reçu par' : 'Payé par';
            form.label.placeholder = income ? 'Remboursement EDF…' : 'Courses Carrefour, resto…';
          };
          form.querySelectorAll('[name=kind]').forEach((i) => (i.onchange = syncKind));
          // Les favoris sont ceux du couple : masqués en perso.
          bindScopeField(form, (perso) => {
            const favEl = form.querySelector('.fav-chips');
            if (favEl) favEl.hidden = perso;
            syncKind();
          });
          // Nouvelle dépense : on reprend la répartition de la dernière dépense de la catégorie
          // (ex. « Transport » toujours selon l'usage de la voiture).
          if (!existing) {
            // Remplit la répartition à partir d'une dépense modèle.
            const applySplit = (model) => {
              const d = S.state.defaultSplit;
              if (model.shareA != null && !model.byUsage) {
                form.splitMode.value = 'custom';
                form.customUnit.value = 'eur';
                form.shareCustom.value = amountValue(model.shareA);
              } else {
                form.splitMode.value = model.byUsage
                  ? 'car'
                  : model.split === d ? 'default' : model.split === 50 ? '50' : model.split === 100 ? 'a' : model.split === 0 ? 'b' : 'custom';
                if (!form.splitMode.value) form.splitMode.value = 'custom';
                form.splitCustom.value = model.split;
                form.customUnit.value = 'pct';
              }
              sync();
            };
            const categoryChanged = () => {
              if (isPerso()) return;
              const last = L.shared(S.state.expenses)
                .filter((x) => x.categoryId === form.categoryId.value && !x.isIncome)
                .sort((x, y) => (x.date < y.date ? 1 : -1))[0];
              if (last) applySplit(last);
            };
            // Catégorie choisie à la main : on ne la devine plus.
            let categoryTouched = Boolean(preset.categoryId);
            form.categoryId.onchange = () => {
              categoryTouched = true;
              categoryChanged();
            };
            // Catégorie devinée d'après le libellé (« Lidl » → Courses).
            form.label.addEventListener('input', () => {
              if (categoryTouched) return;
              const guess = L.guessCategory(isPerso() ? L.personalState(S.state, form.payer.value) : S.state, form.label.value);
              if (guess && guess !== form.categoryId.value) {
                form.categoryId.value = guess;
                form.categoryId.classList.add('guessed');
                categoryChanged();
              }
            });
            // Favoris : un toucher remplit tout, il reste à vérifier le montant.
            form.querySelectorAll('[data-fav]').forEach((b) => {
              b.onclick = () => {
                const f = favs[Number(b.dataset.fav)];
                form.label.value = f.label;
                form.amount.value = amountValue(f.amount);
                if (f.categoryId) form.categoryId.value = f.categoryId;
                categoryTouched = true;
                const payerInput = form.querySelector(`[name=payer][value=${f.payer}]`);
                if (payerInput) payerInput.checked = true;
                applySplit(f);
                form.querySelectorAll('[data-fav]').forEach((x) => x.classList.toggle('active', x === b));
                form.amount.focus();
                form.amount.select();
              };
            });
            form.amount.focus();
          }
        },
        onSubmit: async (form) => {
          const amount = readAmount(form);
          if (!amount) return fail(form, 'Montant invalide');
          const perso = form.scope.value === 'perso';
          const splitting = perso ? personalFields(form.payer.value) : readSplitting(form, amount, L.monthKey(form.date.value));
          if (!splitting) return false;
          await S.save('expenses', {
            ...e,
            ...splitting,
            owner: perso ? form.payer.value : null,
            isIncome: form.kind.value === 'income',
            amount,
            label: form.label.value.trim(),
            payer: form.payer.value,
            date: form.date.value,
            categoryId: form.categoryId.value || null,
          });
          toast(form.kind.value === 'income' ? 'Entrée d\'argent enregistrée' : existing ? 'Dépense modifiée' : 'Dépense ajoutée');
          if (preset.onSaved) await preset.onSaved();
        },
        onDelete: existing ? () => S.remove('expenses', e.id) : null,
      }
    );
  }

  function recurringForm(existing, preset = {}) {
    const logement = sortedCategories().find((c) => c.name === 'Logement');
    const r = existing || {
      id: S.newId(),
      label: '',
      amount: 0,
      payer: preset.owner || me(),
      owner: preset.owner || null,
      categoryId: ((preset.owner && sortedCategories(preset.owner)[0]) || logement || sortedCategories()[0] || {}).id || null,
      split: S.state.defaultSplit,
      day: 1,
      startMonth: currentMonth(),
      endMonth: null,
    };
    openModal(
      existing ? 'Modifier la charge fixe' : 'Nouvelle charge fixe',
      `
      ${scopeField(r.owner)}
      <p class="hint" style="margin-top:0">Loyer, assurance, Netflix, électricité… : c'est compté automatiquement chaque mois.</p>
      <label class="field"><span>Montant mensuel</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(r.amount)}" required autocomplete="off">
      </label>
      <label class="field"><span>Nom</span>
        <input name="label" placeholder="Loyer, Netflix, assurance habitation…" value="${esc(r.label)}" maxlength="80" required>
      </label>
      ${payerField(r.payer, 'payer', 'Prélevé sur le compte de')}
      ${categoryField(r.categoryId, r.owner)}
      <div data-couple-only>${splitField(r, currentMonth())}</div>
      <div class="row">
        <label class="field"><span>Jour du prélèvement</span>
          <input type="number" name="day" min="1" max="31" value="${r.day}" required></label>
        <label class="field"><span>À partir de</span>
          <input type="month" name="startMonth" value="${r.startMonth}" required></label>
      </div>
      <label class="field"><span>Jusqu'à (vide = toujours en cours)</span>
        <input type="month" name="endMonth" value="${r.endMonth || ''}"></label>`,
      {
        onOpen: (form) => {
          bindSplitField(form, currentMonth);
          bindScopeField(form);
        },
        onSubmit: async (form) => {
          const amount = readAmount(form);
          if (!amount) return fail(form, 'Montant invalide');
          const perso = form.scope.value === 'perso';
          const startMonth = form.startMonth.value;
          const endMonth = form.endMonth.value || null;
          if (!/^\d{4}-\d{2}$/.test(startMonth)) return fail(form, 'Mois de début invalide');
          if (endMonth && endMonth < startMonth) return fail(form, 'La fin doit être après le début');
          const splitting = perso ? personalFields(form.payer.value) : readSplitting(form, amount, currentMonth());
          if (!splitting) return false;
          await S.save('recurring', {
            ...r,
            ...splitting,
            owner: perso ? form.payer.value : null,
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
      <div class="seg" style="margin-bottom:12px">
        <label><input type="radio" name="period" value="month" ${cat.period === 'year' ? '' : 'checked'}><span>Par mois</span></label>
        <label><input type="radio" name="period" value="year" ${cat.period === 'year' ? 'checked' : ''}><span>Par an</span></label>
      </div>
      <label class="field"><span>Budget (0 = pas de budget)</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(cat.budget)}" autocomplete="off">
      </label>
      <p class="hint">« Par an » pour les dépenses irrégulières (vacances, cadeaux…) : 1/12e s'ajoute à une cagnotte chaque mois, et l'alerte ne se déclenche que si le budget de l'année est dépassé.</p>`,
      {
        onSubmit: async (form) => {
          const v = form.amount.value.trim();
          const budget = v === '' ? 0 : L.parseAmount(v);
          if (!Number.isFinite(budget)) return fail(form, 'Montant invalide');
          await S.save('categories', { ...cat, budget, period: form.period.value });
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
    view.innerHTML = '<div class="welcome loading"><img class="logo" src="icons/icon-192.png" alt=""><p class="tagline">Chargement…</p></div>';
  }

  function renderLocalSetup() {
    view.innerHTML = `
      <div class="welcome">
        <img class="logo" src="icons/icon-192.png" alt="">
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
        <img class="logo" src="icons/icon-192.png" alt="">
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
        <img class="logo" src="icons/icon-192.png" alt="">
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
    if (a.annual) {
      return a.level === 'over'
        ? `<div class="alert over"><span class="ico">🚨</span><div>
            <strong>${label} : ${a.pct} % du budget annuel</strong>
            Hors budget de <b>${euro(a.excess)}</b> (budget ${euro(c.budget)} par an)</div></div>`
        : `<div class="alert warn"><span class="ico">⚠️</span><div>
            <strong>${label} : ${a.pct} % du budget annuel utilisé</strong>
            Il reste ${euro(Math.max(0, c.budget - Math.round((a.pct * c.budget) / 100)))} pour le reste de l'année</div></div>`;
    }
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

  function extrasText(e) {
    const parts = [];
    if (e.extraA) parts.push(`${esc(name('a'))} +${euro(Math.abs(e.extraA))}`);
    if (e.extraB) parts.push(`${esc(name('b'))} +${euro(Math.abs(e.extraB))}`);
    return parts.length ? ` · 🧴 ${parts.join(', ')}` : '';
  }

  // `readOnly` : ligne non cliquable (dépenses perso de l'autre).
  function expenseItem(e, readOnly = false) {
    const c = category(e.categoryId);
    const how = e.personal ? '👤 perso' : `${splitText(e.split, e.byUsage, e.shareA == null ? e.shareA : Math.abs(e.shareA), Math.abs(e.amount))}${extrasText(e)}`;
    const tag = e.recurringId ? '🔁 ' : e.isIncome ? '💰 ' : '';
    // Les entrées d'argent arrivent en négatif depuis les calculs : on affiche des valeurs positives.
    const amount = Math.abs(e.amount);
    return `
      <div class="item" ${readOnly ? '' : `data-expense="${e.id}"`}>
        <div class="emoji">${esc(c.icon)}</div>
        <div class="body">
          <div class="title">${tag}${esc(e.label)}</div>
          <div class="sub">${esc(c.name)} · ${how}</div>
        </div>
        <div class="right">
          <div class="amt num ${e.isIncome ? 'income' : ''}">${e.isIncome ? '+' : ''}${euro(amount)}</div>
          <span class="pill ${e.payer}">${e.isIncome ? 'reçu · ' : ''}${esc(name(e.payer))}</span>
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

  // « Qui a payé » d'un mois, virements compris, comparé à la part de chacun.
  function whoPaidHtml(month, hide = ui.hideFixed) {
    const c = L.monthContributions(S.state, month, { variableOnly: hide });
    if (!c.paid.a && !c.paid.b && !c.given.a && !c.given.b) return '<div class="empty">Rien ce mois-ci.</div>';
    const pos = { a: Math.max(0, c.funded.a), b: Math.max(0, c.funded.b) };
    const transfers = ['a', 'b']
      .filter((p) => c.given[p])
      .map((p) => `+ ${euro(c.given[p])} virés par ${esc(name(p))} à ${esc(name(other(p)))}`)
      .join(' · ');
    const conclusion =
      c.diffA === 0
        ? '✅ Chacun a financé exactement sa part ce mois-ci.'
        : `${esc(name(c.diffA > 0 ? 'a' : 'b'))} a financé <b>${euro(Math.abs(c.diffA))}</b> de plus que sa part ce mois-ci.`;
    // Une seule barre : qui a payé (couleurs) et un repère à l'endroit où la
    // barre devrait s'arrêter si chacun avait payé exactement sa part.
    const paidTotal = pos.a + pos.b;
    const shareTotal = c.share.a + c.share.b;
    const pa = paidTotal ? (pos.a / paidTotal) * 100 : 50;
    const mark = shareTotal ? Math.min(100, Math.max(0, (c.share.a / shareTotal) * 100)) : 50;
    return `
      <div class="small muted">Qui a payé${hide ? ' — hors charges fixes' : ''}${transfers ? ' (virements compris)' : ''}</div>
      <div class="split-wrap">
        <div class="split-bar"><div class="pa" style="width:${pa}%"></div><div class="pb" style="width:${100 - pa}%"></div></div>
        <div class="share-mark" style="left:${mark}%" title="Part de chacun"></div>
      </div>
      <div class="legend">
        <div><div><i class="dot a"></i>${esc(name('a'))} <b class="num">${euro(c.funded.a)}</b></div><div class="muted">part ${euro(c.share.a)}</div></div>
        <div style="text-align:right"><div><b class="num">${euro(c.funded.b)}</b> ${esc(name('b'))}<i class="dot b" style="margin-left:4px"></i></div><div class="muted">part ${euro(c.share.b)}</div></div>
      </div>
      ${transfers ? `<p class="small muted" style="margin:6px 0 0">Dont ${transfers.replace(/^\+ /, '').replace(/ · \+ /g, ' · ')}</p>` : ''}
      <p class="small" style="margin:10px 0 0">${conclusion}</p>
      <p class="small muted" style="margin:4px 0 0">┃ = où la barre s'arrêterait si chacun payait exactement sa part.</p>`;
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

  // ---------- Projets d'épargne ----------

  function goalsSection() {
    const goals = [...(S.state.goals || [])].sort((x, y) => x.position - y.position);
    const row = (g) => {
      const p = L.goalProgress(S.state, g, today());
      const plan =
        p.done
          ? '🎉 Objectif atteint !'
          : g.deadline
            ? p.monthsLeft > 0
              ? `${esc(monthLabel(g.deadline))} · <b>${euro(p.perMonth)}/mois</b> à mettre de côté`
              : `Échéance dépassée · il manque ${euro(p.remaining)}`
            : `il reste ${euro(p.remaining)}`;
      return `
        <div class="budget-row ${p.done ? 'level-ok' : ''}" data-goal="${g.id}">
          <div class="budget-head">
            <span class="name">${esc(g.icon)} ${esc(g.name)}</span>
            <span class="num">${euro(p.saved)} <span class="muted small">/ ${euro(g.target)}</span> <span class="pill ${p.done ? 'ok' : 'a'}">${p.pct} %</span></span>
          </div>
          <div class="bar"><div class="fill" style="width:${p.pct}%;background:var(--a)"></div></div>
          <div class="small muted">${esc(name('a'))} ${euro(p.byPerson.a)} · ${esc(name('b'))} ${euro(p.byPerson.b)}</div>
          <div class="small muted">${plan}</div>
        </div>`;
    };
    return `
      <div class="topbar"><h2>🎯 Projets d'épargne</h2>
        <button class="icon-btn" data-add-goal aria-label="Nouveau projet">＋</button></div>
      <div class="card" style="padding-top:4px;padding-bottom:4px">
        ${goals.length ? goals.map(row).join('') : `<div class="empty">Vacances, voiture, apport… : mettez de côté à deux et suivez la progression.<br><br><button class="btn" data-add-goal>＋ Créer un projet</button></div>`}
      </div>`;
  }

  function goalForm(existing) {
    const g = existing || { id: S.newId(), name: '', icon: '🎯', target: 0, deadline: null, position: Date.now() };
    openModal(
      existing ? 'Modifier le projet' : "Nouveau projet d'épargne",
      `
      <div class="row">
        <label class="field" style="flex:0 0 72px"><span>Icône</span><input name="icon" value="${esc(g.icon)}" maxlength="8" style="text-align:center"></label>
        <label class="field"><span>Nom</span><input name="name" value="${esc(g.name)}" maxlength="60" placeholder="Japon 2027, voiture…" required></label>
      </div>
      <label class="field"><span>Objectif</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(g.target)}" required autocomplete="off"></label>
      <label class="field"><span>Pour quand ? (facultatif)</span>
        <input type="month" name="deadline" value="${g.deadline || ''}"></label>
      <p class="hint">Avec une date, l'appli calcule combien mettre de côté chaque mois.</p>`,
      {
        onSubmit: async (form) => {
          const target = readAmount(form);
          if (!target) return fail(form, 'Objectif invalide');
          await S.save('goals', {
            ...g,
            name: form.name.value.trim(),
            icon: form.icon.value.trim() || '🎯',
            target,
            deadline: form.deadline.value || null,
          });
          toast(existing ? 'Projet modifié' : 'Projet créé');
        },
        onDelete: existing ? () => S.remove('goals', g.id) : null,
      }
    );
  }

  // Fiche d'un projet : versements et ajout d'un versement (ou retrait).
  function goalDetail(goal) {
    const p = L.goalProgress(S.state, goal, today());
    const contribs = (S.state.goalContributions || [])
      .filter((c) => c.goalId === goal.id)
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    openModal(
      `${goal.icon} ${goal.name}`,
      `
      <p style="margin-top:0"><b class="num">${euro(p.saved)}</b> <span class="muted">sur ${euro(goal.target)} · ${p.pct} %</span></p>
      <div class="seg" style="margin-bottom:12px">
        <label><input type="radio" name="dir" value="in" checked><span>➕ Versement</span></label>
        <label><input type="radio" name="dir" value="out"><span>➖ Retrait</span></label>
      </div>
      <label class="field"><span>Montant</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" required autocomplete="off"></label>
      ${payerField(me(), 'person', 'Qui ?')}
      <label class="field"><span>Date</span><input type="date" name="date" value="${today()}" required></label>
      ${
        contribs.length
          ? `<div class="small muted" style="margin:4px 0 6px">Historique</div>
             <div class="card list" style="padding:0 12px">${contribs
               .map(
                 (c) => `<div class="item" style="padding:8px 0;cursor:default">
                   <div class="body"><div class="title" style="font-weight:500">${c.amount > 0 ? '➕' : '➖'} ${euro(Math.abs(c.amount))} · ${esc(name(c.person))}</div>
                   <div class="sub">${esc(dayLabel(c.date))}</div></div>
                   <button type="button" class="icon-btn small-btn" data-del-contrib="${c.id}" aria-label="Supprimer ce versement">✕</button>
                 </div>`
               )
               .join('')}</div>`
          : ''
      }
      <button type="button" class="btn link" data-edit-goal>✏️ Modifier ou supprimer le projet</button>`,
      {
        submitLabel: 'Ajouter',
        onOpen: (form) => {
          form.querySelector('[data-edit-goal]').onclick = () => {
            modal.close();
            goalForm(goal);
          };
          form.querySelectorAll('[data-del-contrib]').forEach((b) => {
            b.onclick = async () => {
              if (!confirm('Supprimer ce versement ?')) return;
              modal.close();
              await run(S.remove('goalContributions', b.dataset.delContrib), 'Versement supprimé');
            };
          });
        },
        onSubmit: async (form) => {
          const amount = readAmount(form);
          if (!amount) return fail(form, 'Montant invalide');
          const sign = form.dir.value === 'out' ? -1 : 1;
          await S.save('goalContributions', {
            id: S.newId(),
            goalId: goal.id,
            person: form.person.value,
            amount: sign * amount,
            date: form.date.value,
            note: '',
          });
          toast(sign > 0 ? `${euro(amount)} mis de côté 🎉` : `${euro(amount)} retirés`);
        },
      }
    );
  }

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

    let alertsHtml = an.alerts.slice(0, 3).map(alertHtml).join('');
    if (an.alerts.length > 3) {
      alertsHtml += `<button class="btn link" data-goto="budget">+ ${an.alerts.length - 3} autre(s) alerte(s) →</button>`;
    }

    // « Masquer les fixes » : on ne compte que les dépenses ponctuelles.
    const spentKey = ui.hideFixedHome ? 'variable' : 'total';
    const prev = an.history.slice(0, -1).filter((h) => h[spentKey] > 0);
    const spentNow = an.history[an.history.length - 1][spentKey];
    const avg = prev.length ? prev.reduce((sum, h) => sum + h[spentKey], 0) / prev.length : null;
    const vsAvg = avg ? Math.round(((spentNow - avg) / avg) * 100) : null;
    const delta =
      vsAvg == null
        ? '<span class="muted">Premier mois</span>'
        : `<span class="${vsAvg > 0 ? 'up' : 'down'}">${vsAvg > 0 ? '+' : ''}${vsAvg} % vs moyenne</span>`;

    const shared = L.shared(state.expenses);
    const recent = [...shared]
      .sort((x, y) => (x.date === y.date ? 0 : x.date < y.date ? 1 : -1))
      .slice(0, 3);

    view.innerHTML = `
      <div class="topbar">
        <h1>Salut ${esc(name(me()))} 👋</h1>
        <button class="icon-btn" data-settings aria-label="Réglages">⚙️</button>
      </div>
      ${invite}
      ${balanceHtml}
      ${shoppingCard()}
      ${persoCard(cur)}
      ${carReminder(cur)}
      ${alertsHtml ? `<h2>Alertes de ${monthLabel(cur, true)}</h2>${alertsHtml}` : ''}
      ${notifSuggestion()}
      <div class="topbar"><h2>Ce mois-ci</h2>
        <button class="chip ${ui.hideFixedHome ? 'active' : ''}" data-hide-fixed-home aria-pressed="${ui.hideFixedHome}">🔁 ${ui.hideFixedHome ? 'Fixes masquées' : 'Masquer les fixes'}</button></div>
      <div class="stats">
        <div class="stat"><div class="label">${ui.hideFixedHome ? 'Dépensé (hors fixes)' : 'Dépensé'}</div><div class="value num">${euro(spentNow)}</div><div class="delta">${delta}</div></div>
        <div class="stat"><div class="label">Budgets</div>
          <div class="value num">${an.budgetPct == null ? '—' : an.budgetPct + ' %'}</div>
          <div class="delta muted">${an.budgetTotal ? `${euro(an.budgetSpent)} / ${euro(an.budgetTotal)}` : 'aucun budget défini'}</div></div>
      </div>
      <div class="card">
        ${whoPaidHtml(cur, ui.hideFixedHome)}
      </div>
      <div class="topbar"><h2>Dernières dépenses</h2>
        ${shared.length > 3 ? '<button class="btn link" data-goto="expenses">Tout voir ›</button>' : ''}</div>
      <div class="card list">
        ${recent.length ? recent.map(expenseItem).join('') : '<div class="empty">Aucune dépense pour l\'instant.<br>Appuyez sur ＋ pour commencer.</div>'}
      </div>`;

    const settle = view.querySelector('[data-settle]');
    if (settle) {
      settle.onclick = () => transferForm(null, { from: bal.debtor, to: bal.creditor, amount: bal.amount });
    }
  }

  // ---------- Recherche (tout l'historique) ----------

  function searchBox() {
    return `
      <div class="search">
        <input name="search" type="search" placeholder="🔍 Rechercher : Carrefour, EDF, 33,80…" value="${esc(ui.search)}" autocomplete="off" enterkeyhint="search">
      </div>`;
  }

  let searchTimer = null;
  function bindSearchBox() {
    const input = view.querySelector('input[name=search]');
    input.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        ui.search = input.value;
        render();
      }, 150);
    };
  }

  function normalize(text) {
    return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function renderSearch() {
    const state = S.state;
    const q = normalize(ui.search.trim());
    const cents = L.parseAmount(ui.search.trim());
    const matches = (fields, amount) =>
      fields.some((f) => f && normalize(f).includes(q)) || (Number.isFinite(cents) && cents > 0 && Math.abs(amount) === cents);

    const upTo = currentMonth() > ui.month ? currentMonth() : ui.month;
    let items = L.allExpenses(state, upTo)
      .filter((e) => matches([e.label, category(e.categoryId).name, name(e.payer)], e.amount))
      .map((e) => ({ kind: 'e', date: e.date, data: e }));
    items = items.concat(
      L.allTransfers(state, upTo)
        .filter((t) => matches(['remboursement', t.note, name(t.from), name(t.to)], t.amount))
        .map((t) => ({ kind: 't', date: t.date, data: t }))
    );
    items.sort((x, y) => (x.date === y.date ? 0 : x.date < y.date ? 1 : -1));
    const shown = items.slice(0, 300);
    const total = items.filter((it) => it.kind === 'e').reduce((sum, it) => sum + it.data.amount, 0);

    let html = '';
    let lastMonth = null;
    for (const it of shown) {
      const m = L.monthKey(it.date);
      if (m !== lastMonth) {
        if (lastMonth) html += '</div>';
        const monthTotal = shown.filter((x) => x.kind === 'e' && L.monthKey(x.date) === m).reduce((sum, x) => sum + x.data.amount, 0);
        html += `<div class="day-head">${esc(monthLabel(m))} · ${euro(monthTotal)}</div><div class="card list">`;
        lastMonth = m;
      }
      html += it.kind === 'e' ? expenseItem(it.data) : transferItem(it.data);
    }
    if (lastMonth) html += '</div>';

    view.innerHTML = `
      <div class="topbar"><h1>Dépenses</h1>
        <button class="icon-btn" data-search-clear aria-label="Fermer la recherche">✕</button></div>
      ${searchBox()}
      <p class="muted small" style="margin:4px 4px 0">${items.length} résultat(s) sur tout l'historique · total <b class="num">${euro(total)}</b>${items.length > shown.length ? ' · 300 premiers affichés' : ''}</p>
      ${html || '<div class="card empty">Aucun résultat.</div>'}`;
    bindSearchBox();
    view.querySelector('[data-search-clear]').onclick = () => {
      ui.search = '';
      render();
    };
  }

  function renderExpenses() {
    if (ui.search.trim()) return renderSearch();
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
    // « Masquer les fixes » : on ne garde que les opérations saisies à la main.
    if (ui.hideFixed && f !== 'fixed') {
      items = items.filter((it) => !it.data.recurringId && !it.data.recurringTransferId);
    }
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
      ${searchBox()}
      ${monthNav()}
      <div class="chips">
        ${chips.map(([v, l]) => `<button class="chip ${f === v ? 'active' : ''}" data-filter="${esc(v)}">${esc(l)}</button>`).join('')}
      </div>
      <div class="list-head">
        <p class="muted small">${items.length} opération(s) · total dépenses <b class="num">${euro(total)}</b></p>
        <button class="chip ${ui.hideFixed ? 'active' : ''}" data-hide-fixed aria-pressed="${ui.hideFixed}">🔁 ${ui.hideFixed ? 'Fixes masquées' : 'Masquer les fixes'}</button>
      </div>
      ${html || '<div class="card empty">Rien ce mois-ci.</div>'}`;

    bindSearchBox();
    view.querySelector('[data-add-transfer]').onclick = () => transferForm(null);
    view.querySelector('[data-hide-fixed]').onclick = () => {
      ui.hideFixed = !ui.hideFixed;
      writePref('budg-hide-fixed', ui.hideFixed ? '1' : '0');
      render();
    };
  }

  // Charges fixes regroupées par catégorie : une ligne résumé (total, part de
  // chacun) qui se déplie sur le détail. Les groupes ouverts restent ouverts
  // quand la page se redessine (synchro avec l'autre téléphone…).
  function fixedGroupsHtml(list, item, sharesFor) {
    const groups = new Map();
    for (const r of list) {
      const key = r.categoryId || 'none';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups.entries()]
      .map(([key, rs]) => {
        const total = rs.reduce((sum, r) => sum + r.amount, 0);
        const shares = rs.reduce(
          (acc, r) => {
            const sh = sharesFor(r);
            return { a: acc.a + sh.a, b: acc.b + sh.b };
          },
          { a: 0, b: 0 }
        );
        return { key, rs, total, shares, cat: category(key === 'none' ? null : key) };
      })
      .sort((x, y) => y.total - x.total)
      .map(
        (g) => `
        <details class="group" data-group="${g.key}" ${ui.openFixedGroups.has(g.key) ? 'open' : ''}>
          <summary class="item">
            <div class="emoji">${esc(g.cat.icon)}</div>
            <div class="body">
              <div class="title">${esc(g.cat.name)} <span class="muted small">· ${g.rs.length}</span></div>
              ${sharesLine(g.shares)}
            </div>
            <div class="right">
              <div class="amt num">${euro(g.total)}<span class="small muted">/mois</span></div>
              <span class="chev" aria-hidden="true">›</span>
            </div>
          </summary>
          <div class="group-body">${g.rs.map(item).join('')}</div>
        </details>`
      )
      .join('');
  }

  function renderFixed() {
    const state = S.state;
    const cur = currentMonth();
    const rs = L.recurringSummary(state, cur);
    const activeIds = new Set(rs.active.map((r) => r.id));
    const list = L.shared(state.recurring).sort((x, y) => y.amount - x.amount);
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
    // Ce que la personne qui doit rembourse déjà chaque mois via les remboursements auto.
    const debt = L.fixedChargesDebt(state, cur, debtor);
    const reimbursed = rtList
      .filter((r) => isActive(r) && r.from === debtor)
      .reduce((sum, r) => sum + (r.auto ? debt : r.amount), 0);
    const gap = reimbursed - debt;
    let balanceText = '';
    if (rs.total && diffA === 0) balanceText = 'Les charges fixes sont parfaitement équilibrées entre vous.';
    else if (rs.total && reimbursed && gap === 0) {
      balanceText = `✅ ${esc(name(debtor))} rembourse chaque mois exactement sa part : <b>${euro(debt)}</b>.`;
    } else if (rs.total && reimbursed && gap > 0) {
      balanceText = `ℹ️ ${esc(name(debtor))} rembourse <b>${euro(reimbursed)}</b> par mois pour une part de <b>${euro(debt)}</b> : <b>${euro(gap)} de plus</b> chaque mois, compté dans le solde en sa faveur. Pour qu'il suive les charges, passez le remboursement en « Sa part des charges fixes ».`;
    } else if (rs.total && reimbursed && gap < 0) {
      balanceText = `⚠️ ${esc(name(debtor))} rembourse <b>${euro(reimbursed)}</b> par mois pour une part de <b>${euro(debt)}</b> : il manque <b>${euro(-gap)}</b> chaque mois (compté dans le solde). Pour qu'il suive les charges, passez le remboursement en « Sa part des charges fixes ».`;
    } else if (rs.total) {
      balanceText = `Chaque mois, ${esc(name(other(debtor)))} avance <b>${euro(Math.abs(diffA))}</b> de plus que sa part : c'est compté dans le solde. Ajoutez un remboursement automatique si ${esc(name(debtor))} fait un virement permanent.`;
    }

    // Montant fixe : on rappelle la part réelle et l'écart (sur sa propre ligne).
    const rtShareLine = (r) => {
      const due = L.fixedChargesDebt(state, cur, r.from);
      const gap = r.amount - due;
      const gapText =
        gap === 0
          ? '<span class="down">✓ exact</span>'
          : gap > 0
            ? `<span class="warn-text">${euro(gap)} de trop</span>`
            : `<span class="up">${euro(-gap)} de moins</span>`;
      return `<div class="small muted">Sa part : <b class="num">${euro(due)}</b> · ${gapText}</div>`;
    };

    const rtItem = (r) => {
      const amount = r.auto ? L.fixedChargesDebt(state, cur, r.from) : r.amount;
      const when = r.startMonth > cur ? `à partir de ${monthLabel(r.startMonth)}` : r.endMonth && r.endMonth < cur ? `terminé en ${monthLabel(r.endMonth)}` : `le ${r.day} du mois`;
      return `
        <div class="item item-wrap" data-recurring-transfer="${r.id}" style="${isActive(r) ? '' : 'opacity:.6'}">
          <div class="emoji">💸</div>
          <div class="body">
            <div class="title">${esc(name(r.from))} → ${esc(name(r.to))}</div>
            <div class="sub">${r.auto ? 'Sa part des charges fixes' : 'Montant fixe'} · ${esc(when)}${r.note ? ' · ' + esc(r.note) : ''}</div>
            ${r.auto ? '' : rtShareLine(r)}
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
        ${active.length ? fixedGroupsHtml(active, item, (r) => L.sharesOf(r.byUsage ? { ...r, split: L.carUsageFor(state, cur).split } : r)) : `<div class="empty">Ajoutez le loyer, les assurances, les abonnements…<br><br><button class="btn primary" data-add-recurring>＋ Ajouter une charge fixe</button></div>`}
      </div>
      ${inactive.length ? `<h2>À venir ou terminées</h2><div class="card list">${inactive.map(item).join('')}</div>` : ''}
      <div class="topbar"><h2>🔁 Remboursements automatiques</h2>
        <button class="icon-btn" data-add-rt aria-label="Ajouter un remboursement automatique">＋</button></div>
      <div class="card list">
        ${rtList.length ? rtList.map(rtItem).join('') : `<div class="empty">Ex. : ${esc(name(debtor))} rembourse sa part des charges fixes chaque début de mois.<br><br><button class="btn" data-add-rt>＋ Ajouter un remboursement auto</button></div>`}
      </div>`;

    view.querySelectorAll('details[data-group]').forEach((d) => {
      d.ontoggle = () => {
        if (d.open) ui.openFixedGroups.add(d.dataset.group);
        else ui.openFixedGroups.delete(d.dataset.group);
      };
    });
    view.querySelectorAll('[data-add-recurring]').forEach((b) => (b.onclick = () => recurringForm(null)));
    view.querySelectorAll('[data-add-rt]').forEach((b) => (b.onclick = () => recurringTransferForm(null)));
  }

  function renderBudget() {
    const p = persoOf();
    const scope = ui.scope;
    const couple = scope === 'couple';
    const state = couple ? S.state : scope === 'perso' ? L.personalState(S.state, p) : L.totalState(S.state, p, ui.month);
    const an = L.analyzeMonth(state, ui.month, today());
    // Seules les catégories du couple (vue Couple) et les catégories perso (autres vues) ont un budget modifiable ici.
    const catAttr = (c) => (couple ? `data-category="${c.id}"` : c.personal && (S.mode !== 'cloud' || p === me()) ? `data-perso-cat="${c.id}"` : '');
    const who = S.mode === 'cloud' && p === me() ? 'moi' : name(p);
    const scopeChips = `
      <div class="seg" style="margin-bottom:12px">
        ${[['couple', '👥 Couple'], ['perso', `👤 Perso`], ['total', '∑ Total']]
          .map(([v, l]) => `<label><input type="radio" name="scope" value="${v}" ${scope === v ? 'checked' : ''}><span>${l}</span></label>`)
          .join('')}
      </div>
      ${couple ? '' : `<p class="hint" style="margin:-4px 4px 10px">${scope === 'perso' ? `Dépenses perso de ${esc(who)}.` : `Part du couple + perso de ${esc(who)} : ce que ${S.mode === 'cloud' && p === me() ? 'tu dépenses' : `${esc(name(p))} dépense`} vraiment.`}${S.mode !== 'cloud' ? ` <button class="btn link" data-scope-person>Voir ${esc(name(other(p)))}</button>` : ''}</p>`}`;
    const isCurrent = ui.month === currentMonth();
    const isPast = ui.month < currentMonth();

    const budgeted = an.categories.filter((c) => c.budget > 0 && !c.annual).sort((x, y) => y.pct - x.pct);
    const annual = an.categories.filter((c) => c.annual);
    const unbudgeted = an.categories.filter((c) => c.budget === 0 && c.spent > 0).sort((x, y) => y.spent - x.spent);

    // Comparaison avec le mois précédent et la moyenne mensuelle.
    const compare = (c) => {
      const parts = [];
      if (c.lastMonth || c.spent) {
        const d = c.spent - c.lastMonth;
        const arrow = d > 0 ? '<span class="up">▲</span>' : d < 0 ? '<span class="down">▼</span>' : '';
        parts.push(`mois dernier ${euro(c.lastMonth)} ${arrow}`);
      }
      if (c.average) {
        const vs = c.spent && c.vsAverage != null ? ` (<span class="${c.vsAverage > 0 ? 'up' : 'down'}">${c.vsAverage > 0 ? '+' : ''}${c.vsAverage} %</span>)` : '';
        parts.push(`moyenne ${euro(c.average)}/mois${vs}`);
      }
      return parts.length ? `<div class="small muted">${parts.join(' · ')}</div>` : '';
    };

    // Budget annuel (vacances…) : suivi depuis janvier et cagnotte disponible.
    const annualRow = (c) => {
      const pct = Math.min(100, (c.ytd / c.budget) * 100);
      const mark = Math.min(100, (c.allowance / c.budget) * 100);
      const cagnotte =
        c.available >= 0
          ? `cagnotte disponible <b>${euro(c.available)}</b>`
          : `<b style="color:var(--warn)">${euro(-c.available)} d'avance sur la cagnotte</b>`;
      return `
        <div class="budget-row level-${c.level}" ${catAttr(c)}>
          <div class="budget-head">
            <span class="name">${esc(c.icon)} ${esc(c.name)}</span>
            <span class="num">${euro(c.ytd)} <span class="muted small">/ ${euro(c.budget)}/an</span> <span class="pill ${pctClass(c.level)}">${c.pct} %</span></span>
          </div>
          <div class="bar"><div class="fill" style="width:${pct}%"></div><div class="mark" style="left:${mark}%" title="Cagnotte accumulée"></div></div>
          <div class="small muted">Depuis janvier · ce mois ${euro(c.spent)} · ${cagnotte}</div>
          <div class="small muted">${c.ytd > c.budget ? `<b style="color:var(--over)">${euro(c.ytd - c.budget)} hors budget annuel</b>` : `reste ${euro(c.budget - c.ytd)} pour l'année`}</div>
        </div>`;
    };

    const row = (c) => {
      if (c.annual) return annualRow(c);
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
      return `
        <div class="budget-row level-${c.level}" ${catAttr(c)}>
          <div class="budget-head">
            <span class="name">${esc(c.icon)} ${esc(c.name)}</span>
            <span class="num">${euro(c.spent)}${c.budget ? ` <span class="muted small">/ ${euro(c.budget)}</span>` : ''} ${pill}</span>
          </div>
          ${c.budget ? `<div class="bar">${proj > pct ? `<div class="proj" style="width:${proj}%"></div>` : ''}<div class="fill" style="width:${pct}%"></div></div>` : ''}
          <div class="small muted">${detail}</div>
          ${compare(c)}
        </div>`;
    };

    // Barres empilées : charges fixes en bas, dépenses ponctuelles au-dessus.
    // « Masquer les fixes » (même réglage que l'onglet Dépenses) ne garde que les ponctuelles.
    const shown = (h) => (ui.hideFixed ? h.variable : h.total);
    const max = Math.max(1, ...an.history.map(shown));
    const historyHtml = an.history
      .map((h) => {
        const fixedPart = ui.hideFixed ? 0 : h.fixed;
        const title = `${monthLabel(h.month)} : ${euro(h.variable)} ponctuelles${ui.hideFixed ? '' : ` + ${euro(h.fixed)} fixes`}`;
        return `
        <div class="col ${h.month === ui.month ? 'current' : ''}" title="${esc(title)}">
          <span class="val num">${shown(h) ? euro(Math.round(shown(h) / 100) * 100) : ''}</span>
          <div class="stack" style="height:${(shown(h) / max) * 100}%">
            ${h.variable ? `<div class="seg-var" style="flex:${h.variable}"></div>` : ''}
            ${fixedPart ? `<div class="seg-fixed" style="flex:${fixedPart}"></div>` : ''}
          </div>
          <span class="m">${monthLabel(h.month, true)}</span>
        </div>`;
      })
      .join('');

    const delta =
      an.vsAverage == null
        ? '<span class="muted">pas d\'historique</span>'
        : `<span class="${an.vsAverage > 0 ? 'up' : 'down'}">${an.vsAverage > 0 ? '+' : ''}${an.vsAverage} % vs moy. (${euro(an.prevAverage)})</span>`;

    view.innerHTML = `
      <div class="topbar"><h1>Analyse</h1>
        <button class="icon-btn" data-edit-budgets aria-label="Modifier les budgets">✏️</button></div>
      ${scopeChips}
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
          <div class="value num">${euro(an.fixedTotal)}</div>
          <div class="delta muted">incluses dans le total</div></div>
      </div>

      ${an.alerts.length ? `<h2>Alertes</h2>${an.alerts.map(alertHtml).join('')}` : ''}
      ${couple ? carCard(ui.month) : ''}
      <h2>Évolution</h2>
      <div class="card">
        <div class="list-head" style="margin:0 0 8px">
          <div class="legend" style="justify-content:flex-start;gap:14px">
            <span><i class="dot" style="background:var(--accent)"></i>Ponctuelles</span>
            ${ui.hideFixed ? '' : '<span><i class="dot" style="background:var(--fixed)"></i>Charges fixes</span>'}
          </div>
          <button class="chip ${ui.hideFixed ? 'active' : ''}" data-hide-fixed aria-pressed="${ui.hideFixed}">🔁 ${ui.hideFixed ? 'Fixes masquées' : 'Masquer les fixes'}</button>
        </div>
        <div class="history">${historyHtml}</div>
      </div>

      ${couple ? goalsSection() : ''}

      <h2>${couple ? 'Budgets par catégorie' : 'Budgets perso'}</h2>
      <div class="card" style="padding-top:4px;padding-bottom:4px">
        ${budgeted.length ? budgeted.map(row).join('') : couple ? '<div class="empty">Aucun budget défini.<br>Touchez ✏️ pour en créer (ex. Courses 400 €).</div>' : '<div class="empty">Aucun budget perso.<br>Créez-en un depuis l\'écran Perso (Accueil → Mon perso).</div>'}
      </div>
      ${annual.length ? `<h2>Budgets annuels</h2><div class="card" style="padding-top:4px;padding-bottom:4px">${annual.map(row).join('')}</div>` : ''}
      ${unbudgeted.length ? `<h2>${couple ? 'Dépenses sans budget' : 'Par catégorie'}</h2><div class="card" style="padding-top:4px;padding-bottom:4px">${unbudgeted.map(row).join('')}</div>` : ''}

      ${couple ? `<h2>Qui paie quoi</h2><div class="card">${whoPaidHtml(ui.month)}</div>` : ''}`;

    view.querySelectorAll('[name=scope]').forEach((i) => {
      i.onchange = () => {
        ui.scope = i.value;
        render();
      };
    });
    const switchPerson = view.querySelector('[data-scope-person]');
    if (switchPerson) {
      switchPerson.onclick = () => {
        ui.persoOf = other(p);
        render();
      };
    }
    view.querySelectorAll('[data-perso-cat]').forEach((el) => {
      el.onclick = () => {
        const c = S.state.categories.find((x) => x.id === el.dataset.persoCat);
        if (c) persoCategoryForm(c, p);
      };
    });
    if (couple) bindCarCard(ui.month);
    view.querySelectorAll('[data-add-goal]').forEach((b) => (b.onclick = () => goalForm(null)));
    view.querySelector('[data-hide-fixed]').onclick = () => {
      ui.hideFixed = !ui.hideFixed;
      writePref('budg-hide-fixed', ui.hideFixed ? '1' : '0');
      render();
    };

    view.querySelector('[data-edit-budgets]').onclick = () => {
      if (!couple) {
        ui.tab = 'perso';
        window.scrollTo(0, 0);
        return render();
      }
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
        <h2 style="margin-top:0">👫 Le couple</h2>
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
        <h2 style="margin-top:0">🗂️ Catégories & budgets</h2>
        <p class="hint" style="margin-top:0">Laissez le budget vide pour une catégorie sans enveloppe. « /an » pour les vacances, les cadeaux… : suivi sur l'année avec une cagnotte.</p>
        ${cats
          .map(
            (c) => `
          <div class="cat-edit" data-cat="${c.id}">
            <button type="button" class="icon-pick" data-pick-icon aria-label="Changer l'icône">${esc(c.icon)}</button>
            <input name="name" value="${esc(c.name)}" maxlength="30" aria-label="Nom">
            <input name="budget" inputmode="decimal" value="${amountValue(c.budget)}" placeholder="— €" aria-label="Budget">
            <select name="period" aria-label="Période du budget">
              <option value="month" ${c.period === 'year' ? '' : 'selected'}>/mois</option>
              <option value="year" ${c.period === 'year' ? 'selected' : ''}>/an</option>
            </select>
            <button type="button" data-del-cat aria-label="Supprimer">🗑️</button>
          </div>`
          )
          .join('')}
        <button type="button" class="btn block" data-add-cat style="margin-top:8px">＋ Ajouter une catégorie</button>
      </div>

      ${cloud ? `<div class="card" id="notif-card">
        <h2 style="margin-top:0">🔔 Notifications</h2>
        <p class="small muted" data-notif-status style="margin:0 0 10px">…</p>
        <div class="row" data-notif-actions style="flex-wrap:wrap"></div>
      </div>
      <form class="card" id="reminder">
        <h2 style="margin-top:0">⏰ Rappel de règlement</h2>
        <label class="field"><span>Prévenir quand le solde dépasse</span>
          <input name="threshold" inputmode="decimal" placeholder="Pas de rappel" value="${amountValue(state.reminderThreshold)}" autocomplete="off"></label>
        <p class="hint" style="margin-bottom:0">La personne qui doit de l'argent reçoit une notification (au plus une par semaine) tant que le solde reste au-dessus. Laissez vide pour ne pas être rappelé.</p>
      </form>` : ''}

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
      <p class="small muted" style="text-align:center">Budg'</p>`;

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

    const reminder = view.querySelector('#reminder');
    if (reminder) {
      const saveThreshold = () => {
        const v = reminder.threshold.value.trim();
        const cents = v === '' ? null : L.parseAmount(v);
        if (cents !== null && !(cents > 0)) return toast('⚠️ Montant invalide');
        if (cents === state.reminderThreshold) return;
        run(S.setReminderThreshold(cents), cents ? `Rappel au-delà de ${euro(cents)}` : 'Rappel désactivé');
      };
      reminder.threshold.onchange = saveThreshold;
      reminder.onsubmit = (ev) => {
        ev.preventDefault();
        reminder.threshold.blur();
      };
    }

    view.querySelectorAll('[data-cat]').forEach((rowEl) => {
      const id = rowEl.dataset.cat;
      rowEl.querySelector('[name=period]').onchange = (ev) => {
        const c = state.categories.find((x) => x.id === id);
        if (c) run(S.save('categories', { ...c, period: ev.target.value }), 'Enregistré');
      };
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

  // ---------- Liste de courses ----------

  // ---------- Espace perso ----------

  function persoOf() {
    return ui.persoOf || me();
  }

  // Carte d'accès à l'espace perso, sur l'accueil.
  function persoCard(month) {
    const t = L.personalTotal(S.state, me(), month);
    const sub = t.perso
      ? `${euro(t.perso)} ce mois-ci · ${euro(t.total)} avec le couple`
      : 'Tes dépenses à toi, hors du couple';
    return `
      <div class="card item shop-link" data-goto="perso" role="button">
        <div class="emoji">👤</div>
        <div class="body"><div class="title">Mon perso</div><div class="sub">${sub}</div></div>
        <span class="chev" aria-hidden="true">›</span>
      </div>`;
  }

  function persoCategoryForm(existing, owner) {
    const c = existing || { id: S.newId(), name: '', icon: '🏷️', budget: 0, period: 'month', owner };
    openModal(
      existing ? `${c.icon} ${c.name}` : 'Nouveau budget perso',
      `
      <div class="row">
        <label class="field" style="flex:0 0 70px"><span>Icône</span><input name="icon" value="${esc(c.icon)}" maxlength="8" required></label>
        <label class="field"><span>Nom</span><input name="name" value="${esc(c.name)}" placeholder="Sport, vêtements, sorties…" maxlength="30" required></label>
      </div>
      <div class="seg" style="margin-bottom:12px">
        <label><input type="radio" name="period" value="month" ${c.period === 'year' ? '' : 'checked'}><span>Par mois</span></label>
        <label><input type="radio" name="period" value="year" ${c.period === 'year' ? 'checked' : ''}><span>Par an</span></label>
      </div>
      <label class="field"><span>Budget (0 = pas de budget)</span>
        <input class="big" name="amount" inputmode="decimal" placeholder="0 €" value="${amountValue(c.budget)}" autocomplete="off">
      </label>`,
      {
        onSubmit: async (form) => {
          const v = form.amount.value.trim();
          const budget = v === '' ? 0 : L.parseAmount(v);
          if (!Number.isFinite(budget)) return fail(form, 'Montant invalide');
          const position = existing ? c.position : Math.max(-1, ...S.state.categories.map((x) => x.position)) + 1;
          await S.save('categories', { ...c, name: form.name.value.trim(), icon: form.icon.value.trim(), budget, period: form.period.value, position });
          toast(existing ? 'Budget perso modifié' : 'Budget perso ajouté');
        },
        onDelete: existing ? () => S.remove('categories', c.id) : null,
      }
    );
  }

  function renderPerso() {
    const p = persoOf();
    // Hors ligne, un seul appareil pour deux : chacun peut modifier son perso.
    const mine = S.mode !== 'cloud' || p === me();
    const ps = L.personalState(S.state, p);
    const an = L.analyzeMonth(ps, ui.month, today());
    const t = L.personalTotal(S.state, p, ui.month);
    const cur = currentMonth();
    const subs = ps.recurring.filter((r) => r.startMonth <= cur && (!r.endMonth || r.endMonth >= cur)).sort((x, y) => y.amount - x.amount);
    const budgets = an.categories.filter((c) => c.personal);
    // Les abonnements ont leur propre liste : on ne les répète pas dans les dépenses du mois.
    const oneOff = an.expenses.filter((e) => !e.recurringId);
    const oneOffTotal = oneOff.reduce((sum, e) => sum + e.amount, 0);

    const budgetRow = (c) => {
      const spent = c.annual ? c.ytd : c.spent;
      const pct = c.budget ? Math.min(100, (spent / c.budget) * 100) : 0;
      const detail = !c.budget
        ? 'pas de budget'
        : spent > c.budget
          ? `<b style="color:var(--over)">${euro(spent - c.budget)} hors budget</b>`
          : `reste ${euro(c.budget - spent)}${c.annual ? " pour l'année" : ''}`;
      return `
        <div class="budget-row level-${c.level}" ${mine ? `data-perso-cat="${c.id}"` : ''}>
          <div class="budget-head">
            <span class="name">${esc(c.icon)} ${esc(c.name)}</span>
            <span class="num">${euro(spent)}${c.budget ? ` <span class="muted small">/ ${euro(c.budget)}${c.annual ? '/an' : ''}</span> <span class="pill ${pctClass(c.level)}">${c.pct} %</span>` : ''}</span>
          </div>
          ${c.budget ? `<div class="bar"><div class="fill" style="width:${pct}%"></div></div>` : ''}
          <div class="small muted">${detail}</div>
        </div>`;
    };

    const subItem = (r) => `
      <div class="item" ${mine ? `data-recurring="${r.id}"` : ''}>
        <div class="emoji">${esc(category(r.categoryId).icon)}</div>
        <div class="body"><div class="title">${esc(r.label)}</div><div class="sub">${esc(category(r.categoryId).name)} · le ${r.day} du mois</div></div>
        <div class="right"><div class="amt num">${euro(r.amount)}<span class="small muted">/mois</span></div></div>
      </div>`;

    const add = (attr, label) => (mine ? `<button class="icon-btn" ${attr} aria-label="${label}">＋</button>` : '');
    view.innerHTML = `
      <div class="topbar">
        <button class="icon-btn" data-goto="home" aria-label="Retour à l'accueil">‹</button>
        <h1 style="flex:1">Perso</h1>
      </div>
      <div class="chips">
        ${['a', 'b'].map((x) => `<button class="chip ${x === p ? 'active' : ''}" data-perso-of="${x}">${S.mode === 'cloud' && x === me() ? '👤 Moi' : esc(name(x))}</button>`).join('')}
      </div>
      ${monthNav()}
      <div class="card">
        <div class="small muted">Ce que ${p === me() && S.mode === 'cloud' ? 'tu dépenses' : `${esc(name(p))} dépense`} vraiment en ${esc(monthLabel(ui.month))}</div>
        <div style="font-size:1.8rem;font-weight:700" class="num">${euro(t.total)}</div>
        <div class="share-cols">
          <div><span class="small muted">👥 Part du couple</span><b class="num">${euro(t.couple)}</b></div>
          <div><span class="small muted">👤 Perso</span><b class="num">${euro(t.perso)}</b></div>
        </div>
      </div>
      ${an.alerts.map(alertHtml).join('')}
      <div class="topbar"><h2>Budgets perso</h2>${add('data-add-perso-cat', 'Ajouter un budget perso')}</div>
      <div class="card">
        ${budgets.length ? budgets.map(budgetRow).join('') : `<div class="empty">${mine ? 'Sport, vêtements, sorties… : fixez-vous un budget, une alerte prévient en cas de dépassement.' : 'Aucun budget perso.'}</div>`}
      </div>
      <div class="topbar"><h2>Abonnements perso</h2>${add('data-add-perso-sub', 'Ajouter un abonnement perso')}</div>
      <div class="card list">
        ${subs.length ? subs.map(subItem).join('') : `<div class="empty">${mine ? 'Téléphone, salle de sport, streaming…' : 'Aucun abonnement perso.'}</div>`}
      </div>
      <div class="topbar"><h2>Dépenses du mois · ${euro(oneOffTotal)}</h2>${add('data-add-perso-exp', 'Ajouter une dépense perso')}</div>
      <div class="card list">
        ${oneOff.length ? oneOff.map((e) => expenseItem(e, !mine)).join('') : '<div class="empty">Rien ce mois-ci.</div>'}
      </div>
      <p class="hint" style="text-align:center">${mine ? `Hors du solde et des budgets du couple, sans notification. ${esc(name(other(p)))} peut les consulter ici.` : 'Consultation seule.'}</p>`;

    view.querySelectorAll('[data-perso-of]').forEach((b) => {
      b.onclick = () => {
        ui.persoOf = b.dataset.persoOf;
        render();
      };
    });
    if (!mine) return;
    view.querySelector('[data-add-perso-cat]').onclick = () => persoCategoryForm(null, p);
    view.querySelector('[data-add-perso-sub]').onclick = () => recurringForm(null, { owner: p });
    view.querySelector('[data-add-perso-exp]').onclick = () => expenseForm(null, { owner: p });
    view.querySelectorAll('[data-perso-cat]').forEach((el) => {
      el.onclick = () => {
        const c = S.state.categories.find((x) => x.id === el.dataset.persoCat);
        if (c) persoCategoryForm(c, p);
      };
    });
  }

  // Carte d'accès à la liste de courses, sur l'accueil.
  function shoppingCard() {
    const todo = S.state.shopping.filter((i) => !i.done).sort((x, y) => x.position - y.position);
    const inCart = S.state.shopping.length - todo.length;
    const preview = todo.length
      ? `${todo.length} à acheter : ${esc(todo.slice(0, 3).map((i) => i.label).join(', '))}${todo.length > 3 ? '…' : ''}`
      : inCart
        ? `${inCart} dans le panier`
        : 'Vide · touchez pour ajouter des articles';
    return `
      <div class="card item shop-link" data-goto="shopping" role="button">
        <div class="emoji">🛒</div>
        <div class="body"><div class="title">Liste de courses</div><div class="sub">${preview}</div></div>
        <span class="chev" aria-hidden="true">›</span>
      </div>`;
  }

  function renderShopping() {
    const items = [...S.state.shopping].sort((x, y) => x.done - y.done || x.position - y.position);
    const todo = items.filter((i) => !i.done);
    const done = items.filter((i) => i.done);
    const row = (i) => `
      <div class="item shop-item ${i.done ? 'done' : ''}" data-shop="${i.id}">
        <span class="check" aria-hidden="true">${i.done ? '✓' : ''}</span>
        <div class="body"><div class="title">${esc(i.label)}</div></div>
        <button class="icon-btn small-btn" data-shop-del="${i.id}" aria-label="Retirer ${esc(i.label)}">✕</button>
      </div>`;
    view.innerHTML = `
      <div class="topbar">
        <button class="icon-btn" data-goto="home" aria-label="Retour à l'accueil">‹</button>
        <h1 style="flex:1">Liste de courses</h1>
      </div>
      <form class="shop-add" id="shop-add">
        <input name="shopLabel" placeholder="Ajouter : lait, pain, shampoing…" maxlength="80" autocomplete="off" enterkeyhint="done">
        <button class="btn primary" aria-label="Ajouter">＋</button>
      </form>
      <div class="card list">
        ${todo.length ? todo.map(row).join('') : '<div class="empty">Rien à acheter 🎉<br>Ajoutez des articles, ils apparaissent aussi chez l\'autre.</div>'}
      </div>
      ${
        done.length
          ? `<div class="topbar"><h2>Dans le panier · ${done.length}</h2>
               <button class="btn link" data-shop-clear>Vider</button></div>
             <div class="card list">${done.map(row).join('')}</div>
             <button class="btn primary block" data-shop-checkout>🧾 Passer en caisse</button>
             <p class="hint" style="text-align:center;margin-top:8px">Crée la dépense « Courses » et retire les articles cochés.</p>`
          : ''
      }`;

    const form = view.querySelector('#shop-add');
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const label = form.shopLabel.value.trim();
      if (!label) return;
      form.shopLabel.value = '';
      const position = Math.max(0, ...S.state.shopping.map((i) => i.position)) + 1;
      run(S.save('shopping', { id: S.newId(), label, done: false, position }));
      form.shopLabel.focus();
    };
    view.querySelectorAll('[data-shop]').forEach((el) => {
      el.onclick = (ev) => {
        if (ev.target.closest('[data-shop-del]')) return;
        const it = S.state.shopping.find((x) => x.id === el.dataset.shop);
        if (it) run(S.save('shopping', { ...it, done: !it.done }));
      };
    });
    view.querySelectorAll('[data-shop-del]').forEach((b) => {
      b.onclick = () => run(S.remove('shopping', b.dataset.shopDel));
    });
    const clearDone = async () => {
      for (const it of S.state.shopping.filter((x) => x.done)) await S.remove('shopping', it.id);
    };
    const clear = view.querySelector('[data-shop-clear]');
    if (clear) clear.onclick = () => run(clearDone(), 'Articles retirés');
    const checkout = view.querySelector('[data-shop-checkout]');
    if (checkout) {
      checkout.onclick = () => {
        const courses = sortedCategories().find((c) => c.name === 'Courses');
        expenseForm(null, { label: 'Courses', categoryId: courses && courses.id, onSaved: () => run(clearDone()) });
      };
    }
  }

  // ---------- Routage ----------

  const TABS = {
    home: renderHome,
    expenses: renderExpenses,
    shopping: renderShopping,
    perso: renderPerso,
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
    // La liste et les réglages s'ouvrent depuis l'accueil : c'est lui qui reste surligné.
    const navTab = ['shopping', 'settings', 'perso'].includes(ui.tab) ? 'home' : ui.tab;
    tabs.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === navTab));
    // Une synchro ne doit pas faire perdre ce qu'on est en train de taper.
    const keep = focused && view.contains(focused) && focused.name && focused.matches('input:not([type=radio]):not([type=checkbox])')
      ? { name: focused.name, value: focused.value, start: focused.selectionStart, end: focused.selectionEnd }
      : null;
    const scroll = window.scrollY;
    TABS[ui.tab]();
    window.scrollTo(0, scroll);
    if (keep) {
      const el = view.querySelector(`input[name="${keep.name}"]`);
      if (el) {
        el.value = keep.value;
        el.focus();
        try {
          el.setSelectionRange(keep.start, keep.end);
        } catch (e) {
          /* champ sans sélection (nombre…) */
        }
      }
    }
    showSyncBanner();
    fillNotifCard();
    showNotifSuggestion();
  }

  // Bandeau « hors ligne » / « envoi en cours » en haut de la page.
  function showSyncBanner() {
    if (S.mode !== 'cloud') return;
    const pending = S.outbox.length;
    const offline = S.offline || navigator.onLine === false;
    if (!offline && !pending) return;
    const waiting = pending ? `${pending} modification${pending > 1 ? 's' : ''} en attente d'envoi.` : '';
    const text = offline
      ? `<strong>📴 Hors ligne</strong> Données de la dernière synchro. ${waiting || 'Vos ajouts seront envoyés au retour du réseau.'}`
      : `<strong>⏳ Envoi en cours…</strong> ${waiting}`;
    view.insertAdjacentHTML('afterbegin', `<div class="sync-banner ${offline ? 'off' : ''}">${text}</div>`);
  }

  window.addEventListener('offline', () => {
    S.offline = true;
    render();
  });

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
      // Depuis son espace perso, le ＋ ajoute une dépense perso.
      expenseForm(null, ui.tab === 'perso' && (S.mode !== 'cloud' || persoOf() === me()) ? { owner: persoOf() } : {});
      return;
    }
    ui.tab = b.dataset.tab;
    window.scrollTo(0, 0);
    render();
  });

  // ---------- Glisser vers la gauche pour supprimer ----------

  // Élément supprimable sous le doigt : dépense ou remboursement saisi à la main
  // (pas les occurrences de charges fixes), ou article de la liste de courses.
  function swipeTarget(el) {
    const item = el.closest('.item');
    if (!item || !view.contains(item)) return null;
    const d = item.dataset;
    if (d.expense && !d.expense.includes('@')) return { item, kind: 'expenses', id: d.expense };
    if (d.transfer && !d.transfer.includes('@')) return { item, kind: 'transfers', id: d.transfer };
    if (d.shop) return { item, kind: 'shopping', id: d.shop };
    return null;
  }

  let swipe = null;
  let swallowClick = false;
  view.addEventListener(
    'touchstart',
    (ev) => {
      const t = swipeTarget(ev.target);
      swipe = t && { ...t, x: ev.touches[0].clientX, y: ev.touches[0].clientY, dx: 0, horizontal: null };
    },
    { passive: true }
  );
  view.addEventListener(
    'touchmove',
    (ev) => {
      if (!swipe) return;
      const dx = ev.touches[0].clientX - swipe.x;
      const dy = ev.touches[0].clientY - swipe.y;
      if (swipe.horizontal == null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) swipe.horizontal = Math.abs(dx) > Math.abs(dy);
      if (!swipe.horizontal) return;
      swipe.dx = Math.min(0, dx);
      swipe.item.classList.add('swiping');
      swipe.item.style.transform = `translateX(${swipe.dx}px)`;
    },
    { passive: true }
  );
  view.addEventListener('touchend', () => {
    if (!swipe) return;
    const { item, kind, id, dx, horizontal } = swipe;
    swipe = null;
    if (!horizontal) return;
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 300);
    if (dx > -90) {
      item.style.transform = '';
      item.classList.remove('swiping');
      return;
    }
    item.style.transform = 'translateX(-110%)';
    const previous = S.state[kind].find((x) => x.id === id);
    if (!previous) return;
    const label = kind === 'shopping' ? previous.label : kind === 'transfers' ? 'Remboursement' : previous.label;
    setTimeout(() => {
      run(S.remove(kind, id));
      toastAction(`« ${label} » supprimé`, 'Annuler', () => run(S.save(kind, { ...previous }), 'Restauré'));
    }, 150);
  });
  // Un glissement ne doit pas aussi ouvrir la fiche.
  view.addEventListener(
    'click',
    (ev) => {
      if (swallowClick) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    },
    true
  );

  // Délégation des clics dans la vue.
  view.addEventListener('click', (ev) => {
    const t = ev.target.closest(
      '[data-goal],[data-expense],[data-transfer],[data-recurring-transfer],[data-recurring],[data-category],[data-month],[data-filter],[data-goto],[data-settings]'
    );
    if (!t) return;
    const d = t.dataset;
    if (d.goal) {
      const g = (S.state.goals || []).find((x) => x.id === d.goal);
      if (g) goalDetail(g);
      return;
    }
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

  // L'autre vient d'ajouter quelque chose pendant que l'appli est ouverte.
  S.onPartnerActivity((type, x) => {
    if (type === 'expense') {
      toast(`${x.isIncome ? '💰' : '💸'} ${name(other(me()))} ${x.isIncome ? 'a reçu' : 'a ajouté'} ${x.label} — ${euro(x.amount)}`);
    } else {
      toast(`🤝 Remboursement de ${euro(x.amount)} : ${name(x.from)} → ${name(x.to)}`);
    }
  });

  // ---------- Notifications push ----------

  // Textes liés aux notifications, avec le prénom de l'autre.
  const NOTIF_TEXT = {
    get on() {
      return `✅ Activées sur cet appareil : une notif dès que ${name(other(me()))} ajoute une dépense ou un remboursement.`;
    },
    get off() {
      return `Une notif dès que ${name(other(me()))} ajoute une dépense, un remboursement ou des articles à la liste, même appli fermée. Et un bilan le 1er du mois.`;
    },
    denied: "Les notifications sont bloquées pour ce site : autorisez-les dans les réglages du navigateur, puis revenez ici.",
    'ios-install': "Sur iPhone, ajoutez d'abord Budg' à l'écran d'accueil (Partager → Sur l'écran d'accueil), puis ouvrez-le depuis l'icône pour activer les notifications.",
    unsupported: "Ce navigateur ne gère pas les notifications push.",
  };

  async function fillNotifCard() {
    const card = document.getElementById('notif-card');
    if (!card) return;
    const state = await S.pushState().catch(() => 'unsupported');
    card.querySelector('[data-notif-status]').textContent = NOTIF_TEXT[state];
    const actions = card.querySelector('[data-notif-actions]');
    actions.innerHTML =
      state === 'off'
        ? '<button class="btn primary" data-notif="on">🔔 Activer sur cet appareil</button>'
        : state === 'on'
          ? '<button class="btn" data-notif="monthly">📊 Bilan du mois dernier</button><button class="btn danger" data-notif="off">Désactiver</button>'
          : '';
  }

  function notifSuggestion() {
    if (S.mode !== 'cloud' || readPref('budg-notif-hint') === 'hidden') return '';
    return `<div class="alert trend" id="notif-hint" hidden><span class="ico">🔔</span><div>
      <strong>Les dépenses de ${esc(name(other(me())))} en direct</strong>
      <span data-hint-text>Une notif dès que ${esc(name(other(me())))} ajoute une dépense, même appli fermée.</span>
      <div style="margin-top:8px;display:flex;gap:8px"><button class="btn primary" data-notif="on">Activer</button><button class="btn" data-notif="dismiss">Plus tard</button></div>
    </div></div>`;
  }

  async function showNotifSuggestion() {
    const hint = document.getElementById('notif-hint');
    if (!hint) return;
    const state = await S.pushState().catch(() => 'unsupported');
    if (state === 'off') hint.hidden = false;
    else if (state === 'ios-install') {
      hint.querySelector('[data-hint-text]').textContent = NOTIF_TEXT['ios-install'];
      hint.querySelector('[data-notif="on"]').remove();
      hint.hidden = false;
    }
  }

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-notif],[data-hide-fixed],[data-hide-fixed-home]');
    if (!b || !view.contains(b)) return;
    if (b.dataset.hideFixedHome !== undefined) {
      ui.hideFixedHome = !ui.hideFixedHome;
      writePref('budg-hide-fixed-home', ui.hideFixedHome ? '1' : '0');
      render();
      return;
    }
    if (b.dataset.hideFixed !== undefined && !b.onclick) {
      ui.hideFixed = !ui.hideFixed;
      writePref('budg-hide-fixed', ui.hideFixed ? '1' : '0');
      render();
      return;
    }
    const action = b.dataset.notif;
    if (!action) return;
    if (action === 'dismiss') {
      writePref('budg-notif-hint', 'hidden');
      render();
      return;
    }
    b.disabled = true;
    try {
      if (action === 'on') {
        await S.enablePush();
        toast('🔔 Notifications activées');
        await S.testPush().catch(() => {});
      } else if (action === 'off') {
        await S.disablePush();
        toast('Notifications désactivées sur cet appareil');
      } else if (action === 'test') {
        await S.testPush();
        toast('Notification de test envoyée');
      } else if (action === 'monthly') {
        await S.previewMonthly();
        toast('Bilan envoyé sur vos appareils');
      }
    } catch (e) {
      console.error(e);
      toast('⚠️ ' + errorMessage(e));
    } finally {
      b.disabled = false;
      render();
    }
  });

  // Safari iOS ignore « user-scalable=no » : on bloque aussi le pincement ici.
  ['gesturestart', 'gesturechange'].forEach((type) =>
    document.addEventListener(type, (ev) => ev.preventDefault(), { passive: false })
  );

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
  }

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
