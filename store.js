// Couche de données de Budg'.
// - mode "local" : tout est gardé dans le navigateur (un seul appareil).
// - mode "cloud" : données partagées dans Supabase, synchronisées en temps réel
//   entre les deux membres du couple.
// L'appli manipule toujours le même objet `Store.state` ; les modifications sont
// appliquées tout de suite en mémoire puis envoyées à Supabase.
(function () {
  'use strict';

  const LOCAL_KEY = 'budg-local-v1';
  const CACHE_KEY = 'budg-cloud-cache-v1';
  const MODE_KEY = 'budg-mode';
  const OUTBOX_KEY = 'budg-outbox-v1';

  // Erreur due à l'absence de réseau (et non à un refus du serveur).
  function isNetworkError(e) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    const msg = (e && (e.message || e.details || e.name)) || String(e);
    return /Failed to fetch|NetworkError|Load failed|fetch failed|AuthRetryableFetchError|Network request failed/i.test(msg);
  }

  const DEFAULT_CATEGORIES = [
    ['Courses', '🛒', 40000],
    ['Restaurants', '🍽️', 10000],
    ['Logement', '🏠', 0],
    ['Assurances', '🛡️', 0],
    ['Abonnements', '📺', 0],
    ['Énergie & internet', '💡', 0],
    ['Transport', '🚗', 0],
    ['Vacances', '✈️', 15000],
    ['Loisirs & sorties', '🎉', 0],
    ['Maison', '🛋️', 0],
    ['Santé', '💊', 0],
    ['Cadeaux', '🎁', 0],
    ['Autre', '📦', 0],
  ];

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function defaultCategories() {
    return DEFAULT_CATEGORIES.map(([name, icon, budget], position) => ({
      id: uuid(),
      name,
      icon,
      budget,
      position,
    }));
  }

  function emptyState(nameA, nameB, defaultSplit) {
    return {
      people: [
        { id: 'a', name: nameA },
        { id: 'b', name: nameB },
      ],
      defaultSplit,
      categories: defaultCategories(),
      expenses: [],
      recurring: [],
      transfers: [],
      recurringTransfers: [],
      carUsage: {},
      shopping: [],
      goals: [],
      goalContributions: [],
      reminderThreshold: null,
    };
  }

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* stockage indisponible : on continue en mémoire */
    }
  }

  // Correspondance objets JS <-> lignes SQL.
  const TABLES = {
    categories: {
      table: 'budg_categories',
      toRow: (c) => ({ id: c.id, name: c.name, icon: c.icon, budget: c.budget, period: c.period || 'month', position: c.position, owner: c.owner || null }),
      fromRow: (r) => ({ id: r.id, name: r.name, icon: r.icon, budget: r.budget, period: r.period, position: r.position, owner: r.owner }),
    },
    expenses: {
      table: 'budg_expenses',
      toRow: (e) => ({
        id: e.id,
        date: e.date,
        label: e.label,
        amount: e.amount,
        payer: e.payer,
        category_id: e.categoryId,
        split: e.split,
        share_a: e.shareA == null ? null : e.shareA,
        by_usage: Boolean(e.byUsage),
        is_income: Boolean(e.isIncome),
        extra_a: e.extraA || 0,
        extra_b: e.extraB || 0,
        owner: e.owner || null,
      }),
      fromRow: (r) => ({
        id: r.id,
        date: r.date,
        label: r.label,
        amount: r.amount,
        payer: r.payer,
        categoryId: r.category_id,
        split: r.split,
        shareA: r.share_a,
        byUsage: r.by_usage,
        isIncome: r.is_income,
        extraA: r.extra_a,
        extraB: r.extra_b,
        owner: r.owner,
        createdBy: r.created_by,
      }),
    },
    recurring: {
      table: 'budg_recurring',
      toRow: (x) => ({
        id: x.id,
        label: x.label,
        amount: x.amount,
        payer: x.payer,
        category_id: x.categoryId,
        split: x.split,
        share_a: x.shareA == null ? null : x.shareA,
        by_usage: Boolean(x.byUsage),
        owner: x.owner || null,
        day: x.day,
        start_month: x.startMonth,
        end_month: x.endMonth || null,
      }),
      fromRow: (r) => ({
        id: r.id,
        label: r.label,
        amount: r.amount,
        payer: r.payer,
        categoryId: r.category_id,
        split: r.split,
        shareA: r.share_a,
        byUsage: r.by_usage,
        owner: r.owner,
        day: r.day,
        startMonth: r.start_month,
        endMonth: r.end_month,
      }),
    },
    transfers: {
      table: 'budg_transfers',
      toRow: (t) => ({
        id: t.id,
        date: t.date,
        from_person: t.from,
        to_person: t.to,
        amount: t.amount,
        note: t.note || '',
      }),
      fromRow: (r) => ({
        id: r.id,
        date: r.date,
        from: r.from_person,
        to: r.to_person,
        amount: r.amount,
        note: r.note,
        createdBy: r.created_by,
      }),
    },
    goals: {
      table: 'budg_goals',
      toRow: (g) => ({ id: g.id, name: g.name, icon: g.icon, target: g.target, deadline: g.deadline || null, position: g.position || 0 }),
      fromRow: (r) => ({ id: r.id, name: r.name, icon: r.icon, target: r.target, deadline: r.deadline, position: r.position }),
    },
    goalContributions: {
      table: 'budg_goal_contributions',
      toRow: (c) => ({ id: c.id, goal_id: c.goalId, person: c.person, amount: c.amount, date: c.date, note: c.note || '' }),
      fromRow: (r) => ({ id: r.id, goalId: r.goal_id, person: r.person, amount: r.amount, date: r.date, note: r.note }),
    },
    shopping: {
      table: 'budg_shopping_items',
      toRow: (x) => ({ id: x.id, label: x.label, done: x.done, position: x.position }),
      fromRow: (r) => ({ id: r.id, label: r.label, done: r.done, position: r.position, createdBy: r.created_by }),
    },
    recurringTransfers: {
      table: 'budg_recurring_transfers',
      toRow: (x) => ({
        id: x.id,
        from_person: x.from,
        to_person: x.to,
        auto: x.auto,
        amount: x.auto ? null : x.amount,
        day: x.day,
        start_month: x.startMonth,
        end_month: x.endMonth || null,
        note: x.note || '',
      }),
      fromRow: (r) => ({
        id: r.id,
        from: r.from_person,
        to: r.to_person,
        auto: r.auto,
        amount: r.amount,
        day: r.day,
        startMonth: r.start_month,
        endMonth: r.end_month,
        note: r.note,
      }),
    },
  };

  const Store = {
    mode: null,
    state: null,
    me: null, // 'a' ou 'b' en mode cloud
    user: null,
    householdId: null,
    inviteCode: null,
    partnerJoined: false,
    client: null,
    channel: null,
    listeners: [],
    partnerListeners: [],
    knownIds: null, // ids déjà vus, pour repérer ce que l'autre vient d'ajouter
    offline: false, // dernière tentative réseau échouée
    outbox: readJSON(OUTBOX_KEY) || [], // modifications faites hors ligne, à envoyer
    flushing: false,

    cloudConfigured() {
      const c = window.BUDG_CONFIG || {};
      return Boolean(c.supabaseUrl && c.supabaseKey && window.supabase);
    },

    onChange(fn) {
      this.listeners.push(fn);
    },

    // Appelé avec (type, élément) quand l'autre ajoute une dépense ou un remboursement.
    onPartnerActivity(fn) {
      this.partnerListeners.push(fn);
    },

    emit() {
      if (this.mode === 'local') writeJSON(LOCAL_KEY, this.state);
      if (this.mode === 'cloud' && this.householdId) {
        writeJSON(CACHE_KEY, {
          householdId: this.householdId,
          me: this.me,
          user: this.user && { id: this.user.id, email: this.user.email },
          inviteCode: this.inviteCode,
          partnerJoined: this.partnerJoined,
          state: this.state,
        });
      }
      this.listeners.forEach((fn) => fn());
    },

    // Renvoie l'étape à afficher : 'welcome' | 'auth' | 'household' | 'ready'.
    async init() {
      const savedMode = localStorage.getItem(MODE_KEY);
      if (savedMode === 'local') {
        this.mode = 'local';
        this.state = readJSON(LOCAL_KEY);
        if (this.state) this.state = { recurringTransfers: [], carUsage: {}, shopping: [], goals: [], goalContributions: [], ...this.state };
        return this.state ? 'ready' : 'welcome';
      }
      if (!this.cloudConfigured()) return 'welcome';

      const { supabaseUrl, supabaseKey } = window.BUDG_CONFIG;
      this.client = window.supabase.createClient(supabaseUrl, supabaseKey);
      this.mode = 'cloud';
      window.addEventListener('online', () => this.sync());
      const { data, error } = await this.client.auth.getSession();
      if (!data.session) {
        // Hors ligne avec une session à rafraîchir : on ouvre les données en cache.
        const cache = readJSON(CACHE_KEY);
        if (error && isNetworkError(error) && cache && cache.user) return this.useCache(cache);
        return 'auth';
      }
      this.user = data.session.user;
      return this.loadHousehold();
    },

    // Ouvre la dernière copie connue des données (hors ligne).
    useCache(cache) {
      this.householdId = cache.householdId;
      this.me = cache.me;
      this.user = this.user || cache.user;
      this.inviteCode = cache.inviteCode;
      this.partnerJoined = cache.partnerJoined;
      this.state = { recurringTransfers: [], carUsage: {}, shopping: [], goals: [], goalContributions: [], ...cache.state };
      this.offline = true;
      this.subscribe();
      return 'ready';
    },

    useLocal(nameA, nameB, defaultSplit) {
      localStorage.setItem(MODE_KEY, 'local');
      this.mode = 'local';
      this.state = emptyState(nameA, nameB, defaultSplit);
      this.emit();
    },

    leaveLocal() {
      localStorage.removeItem(MODE_KEY);
    },

    // ---------- Authentification ----------

    async signIn(email, password) {
      const { data, error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      this.user = data.user;
      return this.loadHousehold();
    },

    async signUp(email, password) {
      const { data, error } = await this.client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: location.href.split('#')[0] },
      });
      if (error) throw error;
      if (!data.session) return 'confirm-email';
      this.user = data.user;
      return this.loadHousehold();
    },

    async signOut() {
      if (this.channel) await this.client.removeChannel(this.channel);
      await this.client.auth.signOut();
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(OUTBOX_KEY);
      location.reload();
    },

    // ---------- Couple ----------

    async loadHousehold() {
      const { data, error } = await this.client
        .from('budg_members')
        .select('household_id, person')
        .eq('user_id', this.user.id)
        .maybeSingle();
      if (error) {
        const cache = readJSON(CACHE_KEY);
        if (isNetworkError(error) && cache && cache.householdId) return this.useCache(cache);
        throw error;
      }
      if (!data) return 'household';
      this.householdId = data.household_id;
      this.me = data.person;

      const cache = readJSON(CACHE_KEY);
      if (cache && cache.householdId === this.householdId) {
        this.state = { recurringTransfers: [], carUsage: {}, shopping: [], goals: [], goalContributions: [], ...cache.state };
      }
      this.subscribe();
      try {
        await this.sync();
      } catch (e) {
        if (!(isNetworkError(e) && this.state)) throw e;
        this.offline = true;
      }
      return 'ready';
    },

    async createHousehold(nameMe, namePartner, defaultSplit) {
      const { data: hid, error } = await this.client.rpc('budg_create_household', {
        p_name_a: nameMe,
        p_name_b: namePartner,
        p_default_split: defaultSplit,
      });
      if (error) throw error;
      const rows = defaultCategories().map((c) => ({ ...TABLES.categories.toRow(c), household_id: hid }));
      const { error: catError } = await this.client.from('budg_categories').insert(rows);
      if (catError) throw catError;
      return this.loadHousehold();
    },

    async joinHousehold(code) {
      const { error } = await this.client.rpc('budg_join_household', { p_code: code });
      if (error) throw error;
      return this.loadHousehold();
    },

    async fetchAll() {
      const hid = this.householdId;
      const q = (table) => this.client.from(table).select('*').eq('household_id', hid);
      const [house, members, cats, exps, recs, trs, rtrs, usage, shop, goals, contribs] = await Promise.all([
        this.client.from('budg_households').select('*').eq('id', hid).single(),
        this.client.from('budg_members').select('person').eq('household_id', hid),
        q('budg_categories').order('position'),
        q('budg_expenses'),
        q('budg_recurring'),
        q('budg_transfers'),
        q('budg_recurring_transfers'),
        q('budg_car_usage'),
        q('budg_shopping_items').order('position'),
        q('budg_goals').order('position'),
        q('budg_goal_contributions'),
      ]);
      for (const res of [house, members, cats, exps, recs, trs, rtrs, usage, shop, goals, contribs]) if (res.error) throw res.error;

      const h = house.data;
      this.inviteCode = h.invite_code;
      this.partnerJoined = members.data.length >= 2;
      this.state = {
        people: [
          { id: 'a', name: h.name_a },
          { id: 'b', name: h.name_b },
        ],
        defaultSplit: h.default_split,
        categories: cats.data.map(TABLES.categories.fromRow),
        expenses: exps.data.map(TABLES.expenses.fromRow),
        recurring: recs.data.map(TABLES.recurring.fromRow),
        transfers: trs.data.map(TABLES.transfers.fromRow),
        recurringTransfers: rtrs.data.map(TABLES.recurringTransfers.fromRow),
        carUsage: Object.fromEntries(usage.data.map((u) => [u.month, u.split])),
        shopping: shop.data.map(TABLES.shopping.fromRow),
        goals: goals.data.map(TABLES.goals.fromRow),
        goalContributions: contribs.data.map(TABLES.goalContributions.fromRow),
        reminderThreshold: h.reminder_threshold,
      };
      // Ce qui n'est pas encore parti reste visible.
      for (const op of this.outbox) this.applyOp(op);
      this.offline = false;
      this.detectPartnerActivity();
      this.emit();
    },

    // ---------- Hors ligne : file d'attente des modifications ----------

    // Envoie ce qui est en attente puis recharge tout.
    async sync() {
      await this.flush();
      try {
        await this.fetchAll();
      } catch (e) {
        if (isNetworkError(e)) {
          this.offline = true;
          this.emit();
        }
        throw e;
      }
    },

    // Exécute une opération sur Supabase ; renvoie l'erreur éventuelle.
    async runOp(op) {
      try {
        const hid = this.householdId;
        let res;
        if (op.type === 'upsert') {
          res = await this.client.from(TABLES[op.kind].table).upsert({ ...TABLES[op.kind].toRow(op.item), household_id: hid });
        } else if (op.type === 'delete') {
          res = await this.client.from(TABLES[op.kind].table).delete().eq('id', op.id);
        } else if (op.type === 'carUsage') {
          const table = this.client.from('budg_car_usage');
          res =
            op.split == null
              ? await table.delete().eq('household_id', hid).eq('month', op.month)
              : await table.upsert({ household_id: hid, month: op.month, split: op.split });
        } else if (op.type === 'reminder') {
          res = await this.client.from('budg_households').update({ reminder_threshold: op.threshold }).eq('id', hid);
        } else if (op.type === 'settings') {
          res = await this.client
            .from('budg_households')
            .update({ name_a: op.nameA, name_b: op.nameB, default_split: op.defaultSplit })
            .eq('id', hid);
        }
        return res && res.error;
      } catch (e) {
        return e;
      }
    },

    // Rejoue une opération sur l'état en mémoire.
    applyOp(op) {
      const st = this.state;
      if (op.type === 'upsert') {
        const list = st[op.kind];
        const i = list.findIndex((x) => x.id === op.item.id);
        if (i >= 0) list[i] = op.item;
        else list.push(op.item);
      } else if (op.type === 'delete') {
        st[op.kind] = st[op.kind].filter((x) => x.id !== op.id);
      } else if (op.type === 'carUsage') {
        if (op.split == null) delete st.carUsage[op.month];
        else st.carUsage[op.month] = op.split;
      } else if (op.type === 'reminder') {
        st.reminderThreshold = op.threshold;
      } else if (op.type === 'settings') {
        st.people[0].name = op.nameA;
        st.people[1].name = op.nameB;
        st.defaultSplit = op.defaultSplit;
      }
    },

    queue(op) {
      this.outbox.push(op);
      writeJSON(OUTBOX_KEY, this.outbox);
      this.emit();
    },

    async flush() {
      if (this.flushing || !this.outbox.length || this.mode !== 'cloud') return;
      this.flushing = true;
      try {
        while (this.outbox.length) {
          const error = await this.runOp(this.outbox[0]);
          if (error && isNetworkError(error)) {
            this.offline = true;
            break;
          }
          // Refus du serveur (règle, contrainte) : on abandonne cette opération.
          if (error) console.error('Modification hors ligne refusée', error, this.outbox[0]);
          this.outbox.shift();
          writeJSON(OUTBOX_KEY, this.outbox);
        }
      } finally {
        this.flushing = false;
        this.emit();
      }
    },

    // Envoie une modification, ou la met en attente si le réseau manque.
    // `rollback` annule le changement local si le serveur la refuse.
    async write(op, rollback) {
      if (this.mode !== 'cloud') return;
      // On garde l'ordre : s'il y a déjà des modifications en attente, on passe après.
      if (this.outbox.length) {
        this.queue(op);
        this.flush();
        return;
      }
      const error = await this.runOp(op);
      if (!error) return;
      if (isNetworkError(error)) {
        this.offline = true;
        this.queue(op);
        return;
      }
      rollback();
      this.emit();
      throw error;
    },

    detectPartnerActivity() {
      const items = [
        // Dépenses perso : pas d'alerte chez l'autre.
        ...this.state.expenses.filter((x) => !x.owner).map((x) => ['expense', x]),
        ...this.state.transfers.map((x) => ['transfer', x]),
      ];
      const first = this.knownIds == null;
      const known = this.knownIds || new Set();
      for (const [type, x] of items) {
        if (known.has(x.id)) continue;
        known.add(x.id);
        if (!first && x.createdBy && this.user && x.createdBy !== this.user.id) {
          this.partnerListeners.forEach((fn) => fn(type, x));
        }
      }
      this.knownIds = known;
    },

    // ---------- Notifications push ----------

    isIOS() {
      return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    },

    isStandalone() {
      return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    },

    // 'unsupported' | 'ios-install' | 'denied' | 'on' | 'off'
    async pushState() {
      if (this.mode !== 'cloud') return 'unsupported';
      if (this.isIOS() && !this.isStandalone()) return 'ios-install';
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      return sub && Notification.permission === 'granted' ? 'on' : 'off';
    },

    async enablePush() {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notifications refusées dans le navigateur');
      const reg = await navigator.serviceWorker.ready;
      const res = await fetch(`${window.BUDG_CONFIG.supabaseUrl}/functions/v1/budg-notify`);
      const { publicKey } = await res.json();
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      const json = sub.toJSON();
      const { error } = await this.client.from('budg_push_subscriptions').upsert(
        {
          household_id: this.householdId,
          user_id: this.user.id,
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
        },
        { onConflict: 'endpoint' }
      );
      if (error) throw error;
    },

    async disablePush() {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (!sub) return;
      await this.client.from('budg_push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    },

    // Bilan du mois dernier envoyé tout de suite sur ses propres appareils.
    async previewMonthly() {
      const { data, error } = await this.client.functions.invoke('budg-notify', { body: { preview: 'monthly' } });
      if (error) throw error;
      if (!data || !data.sent) throw new Error("Aucun appareil abonné n'a pu être joint");
    },

    async testPush() {
      const { data, error } = await this.client.functions.invoke('budg-notify', { body: { test: true } });
      if (error) throw error;
      if (!data || !data.sent) throw new Error("Aucun appareil abonné n'a pu être joint");
    },

    // Toute modification faite par l'autre déclenche un rechargement (léger : un
    // couple a au plus quelques milliers de lignes).
    subscribe() {
      if (this.channel) this.client.removeChannel(this.channel);
      const hid = this.householdId;
      let timer = null;
      const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.sync().catch((e) => console.error(e)), 300);
      };
      let channel = this.client.channel(`budg-${hid}`);
      for (const { table } of Object.values(TABLES)) {
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter: `household_id=eq.${hid}` },
          refresh
        );
      }
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'budg_car_usage', filter: `household_id=eq.${hid}` },
        refresh
      );
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'budg_households', filter: `id=eq.${hid}` },
        refresh
      );
      this.channel = channel.subscribe();
      // Au retour sur l'appli (téléphone mis en veille…), on resynchronise.
      if (!this.visibilityBound) {
        this.visibilityBound = true;
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') refresh();
        });
      }
    },

    // ---------- Écritures ----------

    newId: uuid,

    async save(kind, item) {
      const list = this.state[kind];
      const i = list.findIndex((x) => x.id === item.id);
      const previous = i >= 0 ? list[i] : null;
      if (i >= 0) list[i] = item;
      else list.push(item);
      this.emit();
      await this.write({ type: 'upsert', kind, item }, () => {
        if (previous) list[list.indexOf(item)] = previous;
        else list.splice(list.indexOf(item), 1);
      });
    },

    async remove(kind, id) {
      const list = this.state[kind];
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return;
      const [removed] = list.splice(i, 1);
      if (kind === 'goals') {
        // Comme en base (on delete cascade) : les versements du projet disparaissent aussi.
        this.state.goalContributions = this.state.goalContributions.filter((c) => c.goalId !== id);
      }
      if (kind === 'categories') {
        // Comme en base (on delete set null) : les dépenses restent, sans catégorie.
        for (const e of this.state.expenses) if (e.categoryId === id) e.categoryId = null;
        for (const r of this.state.recurring) if (r.categoryId === id) r.categoryId = null;
      }
      this.emit();
      await this.write({ type: 'delete', kind, id }, () => list.splice(i, 0, removed));
    },

    // Usage de la voiture d'un mois (null = revenir à la valeur héritée).
    async setCarUsage(month, split) {
      const usage = this.state.carUsage;
      const previous = usage[month];
      if (split == null) delete usage[month];
      else usage[month] = split;
      this.emit();
      await this.write({ type: 'carUsage', month, split }, () => {
        if (previous == null) delete usage[month];
        else usage[month] = previous;
      });
    },

    // Seuil du rappel de règlement (centimes), null = pas de rappel.
    async setReminderThreshold(threshold) {
      const previous = this.state.reminderThreshold;
      this.state.reminderThreshold = threshold;
      this.emit();
      await this.write({ type: 'reminder', threshold }, () => (this.state.reminderThreshold = previous));
    },

    async updateSettings({ nameA, nameB, defaultSplit }) {
      this.state.people[0].name = nameA;
      this.state.people[1].name = nameB;
      this.state.defaultSplit = defaultSplit;
      this.emit();
      await this.write({ type: 'settings', nameA, nameB, defaultSplit }, () => this.fetchAll().catch(() => {}));
    },

    // Import d'une sauvegarde JSON (mode local) ou envoi vers le cloud.
    async importState(data) {
      if (!data || !Array.isArray(data.expenses) || !Array.isArray(data.categories)) {
        throw new Error('Fichier de sauvegarde invalide');
      }
      if (this.mode === 'local') {
        this.state = { recurringTransfers: [], carUsage: {}, shopping: [], goals: [], goalContributions: [], ...data };
        this.emit();
        return;
      }
      const hid = this.householdId;
      for (const kind of ['categories', 'expenses', 'recurring', 'transfers', 'recurringTransfers', 'shopping', 'goals', 'goalContributions']) {
        const rows = (data[kind] || []).map((x) => ({ ...TABLES[kind].toRow(x), household_id: hid }));
        if (!rows.length) continue;
        const { error } = await this.client.from(TABLES[kind].table).upsert(rows);
        if (error) throw error;
      }
      const usageRows = Object.entries(data.carUsage || {}).map(([month, split]) => ({ household_id: hid, month, split }));
      if (usageRows.length) {
        const { error } = await this.client.from('budg_car_usage').upsert(usageRows);
        if (error) throw error;
      }
      await this.fetchAll();
    },
  };

  // Clé VAPID (base64 url) -> octets, format attendu par pushManager.subscribe.
  function urlBase64ToUint8Array(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  window.BudgStore = Store;
})();
