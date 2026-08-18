// Finances with Akahu integration.
//
// Categorisation (reworked 2026-08-18): this page no longer keyword-matches
// merchant names. It looks each merchant up in the `merchant_rules` table,
// which scripts/sync-finances.mjs fills in from Akahu's own establishment
// classification plus an AI identification pass. See CLAUDE.md.
//
// Resolution order per transaction:
//   1. merchant rule      — manual override > house rule > AI identification
//   2. akahu_category rule — Akahu's NZFCC classification for that merchant
//   3. unresolved          — surfaces in "Unreviewed", NOT silently in Other
//
// The distinction in 3 is the point: "Other" means no bucket fits, whereas
// "Unreviewed" means we don't know yet and Jack can fix it in one tap. A tap
// writes a manual rule, so the same merchant is never asked about again.
(function () {
  const CATEGORIES = ['Rent', 'Groceries', 'Transport', 'Entertainment',
    'Alcohol', 'Subscriptions', 'Food', 'Other'];
  const UNREVIEWED = 'Unreviewed';

  // ── Helpers ─────────────────────────────────────────────────────
  function daysAgo(n) {
    const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString();
  }

  // Display format for all dates: DD-MM-YY (stored data stays ISO for sorting/sync)
  function fmtDMY(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)}`;
  }

  const money = n => '$' + n.toFixed(2);

  // Must stay identical to normaliseKey() in scripts/finance-taxonomy.mjs —
  // the browser looks rules up by the same key the bridge writes them under.
  function normaliseKey(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/\b\d{5,}\b/g, ' ')
      .replace(/\b(eftpos|visa purchase|card|ref|xx+\d*)\b/g, ' ')
      .replace(/[^a-z0-9&' ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── State ───────────────────────────────────────────────────────
  const sampleTx = [
    { id: 1, date: daysAgo(2), amount: 120.50, merchant: 'New World', description: 'New World', akahuCategory: 'Supermarkets and grocery stores', type: 'debit' },
    { id: 2, date: daysAgo(4), amount: 45.00, merchant: 'Uber', description: 'Uber', akahuCategory: 'Taxi, rideshare, and on-demand transport services', type: 'debit' },
    { id: 3, date: daysAgo(10), amount: 1500, merchant: 'Employer', description: 'Salary', akahuCategory: null, type: 'credit' },
    { id: 4, date: daysAgo(20), amount: 950, merchant: 'Flat Account', description: 'Flat Account', akahuCategory: null, type: 'debit' },
  ];

  const state = loadState();

  function loadState() {
    const raw = localStorage.getItem('finances_v2');
    if (raw) return JSON.parse(raw);

    // Migrate v1, which overloaded `category` to hold the merchant name.
    const legacy = localStorage.getItem('finances_v1');
    if (legacy) {
      const old = JSON.parse(legacy);
      return {
        transactions: (old.transactions || []).map(t => ({
          id: t.id, date: t.date, amount: t.amount, type: t.type,
          merchant: t.category || '', description: t.category || '', akahuCategory: null,
        })),
        savingsGoal: old.savingsGoal ?? 5000,
        savingsCurrent: old.savingsCurrent ?? 1200,
      };
    }
    return { transactions: sampleTx, savingsGoal: 5000, savingsCurrent: 1200 };
  }

  function save() { localStorage.setItem('finances_v2', JSON.stringify(state)); }

  // merchant key -> {category, source, evidence}; akahu category name -> same
  const rules = { merchant: new Map(), akahuCategory: new Map() };
  // Weekly budget per category, from the vault via sync-budget.mjs. A category
  // with no target stays null — the bar renders without one rather than
  // inventing a number.
  let budgets = {};
  let supabaseClient = null;
  let expanded = null;   // which category row is open

  // ── Categorisation ──────────────────────────────────────────────
  function resolve(tx) {
    const key = normaliseKey(tx.merchant || tx.description);
    const m = rules.merchant.get(key);
    if (m) return { category: m.category, source: m.source, why: m.evidence };

    if (tx.akahuCategory) {
      const a = rules.akahuCategory.get(tx.akahuCategory);
      if (a) return { category: a.category, source: 'akahu', why: tx.akahuCategory };
    }
    return { category: UNREVIEWED, source: null, why: tx.akahuCategory || null };
  }

  async function loadRules(attempt = 0) {
    const status = document.getElementById('rulesStatus');
    try {
      if (!supabaseClient) {
        const cfg = await (await fetch('/api/config')).json();
        if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error('Supabase is not configured');
        supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
        supabaseClient
          .channel('finances_changes')
          // Wrapped, not passed directly: the payload arg would land in loadRules'
          // `attempt` parameter and disable its retry path.
          .on('postgres_changes', { event: '*', schema: 'public', table: 'merchant_rules' }, () => loadRules())
          // Budget edits made in Obsidian land here via sync-budget.mjs, so an
          // open dashboard re-reads them without a reload. Filtered to the
          // budget key on purpose — app_state also carries mail, calendar, news
          // and consumed, which change constantly and would refetch for nothing.
          .on('postgres_changes',
            { event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.budget' },
            () => loadRules())
          .subscribe();
      }

      const [{ data, error }, budgetRow] = await Promise.all([
        supabaseClient.from('merchant_rules').select('key,kind,category,source,evidence'),
        supabaseClient.from('app_state').select('data').eq('key', 'budget').maybeSingle(),
      ]);
      if (error) throw error;

      rules.merchant.clear(); rules.akahuCategory.clear();
      for (const r of data || []) {
        const target = r.kind === 'akahu_category' ? rules.akahuCategory : rules.merchant;
        target.set(r.key, { category: r.category, source: r.source, evidence: r.evidence });
      }
      budgets = budgetRow?.data?.data?.budgets || {};
      lastRefresh = Date.now();

      const budgeted = Object.values(budgets).filter(v => v != null).length;
      status.textContent = `${rules.merchant.size} merchant rules, ${rules.akahuCategory.size} establishment types known.`
        + (budgeted ? ` Budgets for ${budgeted} categories from the vault.` : ' No budget synced yet.');
      status.classList.remove('warn');
    } catch (e) {
      // A transient failure here looks exactly like the bug this whole rework
      // was meant to fix — every transaction shows as Unreviewed — so retry a
      // couple of times before giving up and saying so.
      console.error(e);
      if (attempt < 2) {
        status.textContent = 'Loading categorisation rules…';
        setTimeout(() => loadRules(attempt + 1), 1000 * (attempt + 1));
        return;
      }
      status.textContent = 'Could not load categorisation rules: ' + e.message
        + ' — everything will show as Unreviewed. Reload to retry.';
      status.classList.add('warn');
    }
    render();
  }

  // A tap in the review queue becomes a permanent manual rule, which the
  // bridge script will never overwrite.
  async function setManualRule(merchantLabel, category) {
    if (!supabaseClient) return;
    const key = normaliseKey(merchantLabel);
    if (!key) return;

    // Optimistic — realtime will confirm.
    rules.merchant.set(key, { category, source: 'manual', evidence: 'Set by you' });
    render();

    const { error } = await supabaseClient.from('merchant_rules').upsert({
      key, kind: 'merchant', category, source: 'manual',
      evidence: 'Set by you', sample: merchantLabel,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'kind,key' });

    if (error) {
      document.getElementById('rulesStatus').textContent = 'Could not save rule: ' + error.message;
      console.error(error);
    }
  }

  // ── Akahu fetch ─────────────────────────────────────────────────
  function loadAkahuCreds() {
    const raw = localStorage.getItem('akahu_creds');
    return raw ? JSON.parse(raw) : { appId: '', userToken: '' };
  }
  function saveAkahuCreds(appId, userToken) {
    localStorage.setItem('akahu_creds', JSON.stringify({ appId, userToken }));
  }

  // The browser can't call api.akahu.nz directly due to CORS, so the request
  // is forwarded through our serverless proxy (/api/akahu) instead.
  async function fetchAkahuTransactions(appId, userToken) {
    const status = document.getElementById('akahuStatus');
    try {
      status.textContent = 'Loading from Akahu...';

      const res = await fetch('/api/akahu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, userToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed: ' + res.status);

      if (data.message) { status.textContent = data.message; return; }

      const akahuTx = data.transactions || [];

      // Keep the fields categorisation needs. Note `merchant` and
      // `akahuCategory` are kept separate — the old code collapsed the
      // merchant name into a field called `category`, which is what made the
      // establishment data invisible to the categoriser.
      state.transactions = akahuTx.map((t, i) => ({
        id: t._id || i,
        date: t.date,
        amount: Math.abs(t.amount),
        type: t.amount > 0 ? 'credit' : 'debit',
        merchant: t.merchant?.name || '',
        description: t.description || '',
        akahuCategory: t.category?.name || null,
      }));

      save();
      render();
      saveAkahuCreds(appId, userToken);
      status.textContent = 'Loaded ' + akahuTx.length + ' transactions from Akahu.';
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
      console.error(e);
    }
  }

  // ── Renderers ───────────────────────────────────────────────────
  function cutoff() {
    const range = document.querySelector('input[name=range]:checked')?.value || 'week';
    const now = new Date(), c = new Date();
    if (range === 'week') c.setDate(now.getDate() - 7); else c.setMonth(now.getMonth() - 1);
    return c;
  }

  function inRange() {
    const c = cutoff();
    return state.transactions.filter(t => new Date(t.date) > c);
  }

  function render() { renderOverview(); renderCategories(); renderSavings(); }

  function renderOverview() {
    const tx = inRange();
    const spent = tx.filter(t => t.type === 'debit').reduce((s, x) => s + x.amount, 0);
    const income = tx.filter(t => t.type === 'credit').reduce((s, x) => s + x.amount, 0);
    document.getElementById('totalSpent').textContent = money(spent);
    document.getElementById('income').textContent = money(income);

    const list = document.getElementById('txList');
    list.innerHTML = '';
    tx.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).forEach(t => {
      const label = t.merchant || t.description || 'Unknown';
      const cat = t.type === 'debit' ? resolve(t).category : 'Income';
      const el = document.createElement('div');
      el.className = 'tx';
      el.innerHTML = `<span class="tx-date">${fmtDMY(new Date(t.date))}</span>`
        + `<span class="tx-name">${esc(label)}</span>`
        + `<span class="tx-cat${cat === UNREVIEWED ? ' unreviewed' : ''}">${esc(cat)}</span>`
        + `<span class="tx-amt">${t.type === 'debit' ? '-' : '+'}${money(t.amount)}</span>`;
      list.appendChild(el);
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Groups this period's debits by category, and within a category by
  // merchant — so an expanded row shows exactly what's driving the number,
  // and every line can be reassigned.
  function groupSpending() {
    const totals = {};
    [...CATEGORIES, UNREVIEWED].forEach(c => (totals[c] = { total: 0, merchants: new Map() }));

    for (const t of inRange()) {
      if (t.type !== 'debit') continue;
      const { category, source, why } = resolve(t);
      const bucket = totals[category] || totals[UNREVIEWED];
      const label = t.merchant || t.description || 'Unknown';

      bucket.total += t.amount;
      if (!bucket.merchants.has(label)) {
        bucket.merchants.set(label, { label, total: 0, count: 0, source, why });
      }
      const m = bucket.merchants.get(label);
      m.total += t.amount; m.count++;
    }
    return totals;
  }

  function renderCategories() {
    const totals = groupSpending();
    const container = document.getElementById('categoryList');
    container.innerHTML = '';

    // Budgets from the vault are weekly, so scale them to whatever range is
    // selected rather than comparing a month's spend against a week's target.
    const days = Math.max(1, Math.round((Date.now() - cutoff().getTime()) / 86400000));
    const budgetFor = c => (budgets[c] == null ? null : budgets[c] * days / 7);

    // Only used for categories with no budget set, so they still show
    // something proportional instead of an empty track.
    const max = Math.max(...Object.values(totals).map(v => v.total), 1);
    const rows = [...CATEGORIES];
    if (totals[UNREVIEWED].total > 0) rows.push(UNREVIEWED);

    for (const c of rows) {
      const { total, merchants } = totals[c];
      const isUnreviewed = c === UNREVIEWED;
      const budget = budgetFor(c);
      const over = budget != null && total >= budget;

      // With a budget, the end of the bar IS the budget — so a full bar means
      // the budget is spent, and it goes red at that point.
      const width = budget != null
        ? Math.min(total / budget, 1) * 100
        : total / max * 100;

      const row = document.createElement('div');
      row.className = 'category' + (isUnreviewed ? ' is-unreviewed' : '')
        + (over ? ' over-budget' : '') + (budget == null ? ' no-budget' : '')
        + (merchants.size ? ' clickable' : '');
      row.innerHTML = `<div class="cat-name">${esc(c)}`
        + (merchants.size ? ` <span class="cat-count">${merchants.size}</span>` : '')
        + `</div><div class="bar"><i style="width:${width}%"></i></div>`
        + `<div class="cat-amt">${money(total)}`
        + `<span class="cat-budget">${budget == null ? 'no budget'
          : over ? `${money(total - budget)} over` : `of ${money(budget)}`}</span></div>`;

      if (merchants.size) {
        row.addEventListener('click', () => {
          expanded = expanded === c ? null : c;
          renderCategories();
        });
      }
      container.appendChild(row);

      if (expanded === c && merchants.size) {
        const detail = document.createElement('div');
        detail.className = 'cat-detail';
        [...merchants.values()].sort((a, b) => b.total - a.total).forEach(m => {
          const line = document.createElement('div');
          line.className = 'merchant';

          const why = m.source === 'manual' ? 'set by you'
            : m.source === 'ai' ? m.why
              : m.source === 'akahu' ? m.why
                : m.source === 'rule' ? 'house rule'
                  : 'not identified yet';

          line.innerHTML = `<div class="merchant-name">${esc(m.label)}`
            + `<span class="merchant-why">${esc(why || '')}</span></div>`
            + `<div class="merchant-amt">${money(m.total)}`
            + (m.count > 1 ? ` <span class="merchant-count">×${m.count}</span>` : '') + '</div>';

          const select = document.createElement('select');
          select.className = 'merchant-pick';
          select.innerHTML = '<option value="">Move to…</option>'
            + CATEGORIES.map(o => `<option value="${o}"${o === c ? ' selected' : ''}>${o}</option>`).join('');
          select.addEventListener('click', e => e.stopPropagation());
          select.addEventListener('change', e => {
            if (e.target.value) setManualRule(m.label, e.target.value);
          });
          line.appendChild(select);
          detail.appendChild(line);
        });
        container.appendChild(detail);
      }
    }

    // Headline: how much of this period's spend is still unidentified.
    const spend = Object.values(totals).reduce((s, v) => s + v.total, 0);
    const un = totals[UNREVIEWED].total;
    const note = document.getElementById('categoryNote');
    if (!spend) {
      note.textContent = 'No spending in this period.';
    } else if (un > 0) {
      note.innerHTML = `<strong>${(un / spend * 100).toFixed(0)}%</strong> of this period's spend `
        + `(${money(un)}) isn't identified yet — open <em>Unreviewed</em> below and assign it once.`;
    } else {
      note.textContent = 'Everything in this period is categorised.';
    }
  }

  function renderSavings() {
    document.getElementById('savingsGoal').value = state.savingsGoal;
    document.getElementById('savingsCurrent').value = state.savingsCurrent;
    const pct = Math.min(100, (state.savingsCurrent / state.savingsGoal) * 100);
    document.getElementById('savingsBar').style.width = pct + '%';
    document.getElementById('savingsText').textContent =
      `${Math.round(pct)}% of ${money(state.savingsGoal)} saved`;
  }

  // ── Events ──────────────────────────────────────────────────────
  function syncRangeToggles(value) {
    document.querySelectorAll('input[name=range]').forEach(r => { r.checked = (r.value === value); });
  }

  document.addEventListener('change', e => {
    if (e.target && e.target.name === 'range') {
      syncRangeToggles(e.target.value);
      renderOverview();
      renderCategories();
    }
  });
  syncRangeToggles('week');

  document.getElementById('savingsGoal').addEventListener('change', e => {
    state.savingsGoal = Number(e.target.value) || 0; save(); renderSavings();
  });
  document.getElementById('savingsCurrent').addEventListener('change', e => {
    state.savingsCurrent = Number(e.target.value) || 0; save(); renderSavings();
  });

  const creds = loadAkahuCreds();
  if (creds.appId) document.getElementById('appId').value = creds.appId;
  if (creds.userToken) document.getElementById('userToken').value = creds.userToken;

  document.getElementById('loadAkahu').addEventListener('click', () => {
    const appId = document.getElementById('appId').value.trim();
    const userToken = document.getElementById('userToken').value.trim();
    if (!appId || !userToken) {
      document.getElementById('akahuStatus').textContent = 'Please enter both App ID and User Access Token.';
      return;
    }
    fetchAkahuTransactions(appId, userToken);
  });

  // ── Keeping up with vault edits ─────────────────────────────────
  // Realtime alone isn't enough here: `merchant_rules` isn't in this project's
  // supabase_realtime publication, and `app_state` only publishes INSERTs (its
  // replica identity can't carry UPDATEs), so a budget edit — which rewrites an
  // existing row — never reaches an open page as a push. Both are one-line DDL
  // fixes, noted in CLAUDE.md, but the page shouldn't depend on them: re-reading
  // when the tab regains focus also covers a phone waking up or a dropped
  // socket, which push updates wouldn't survive anyway.
  const REFRESH_MS = 30000;
  let lastRefresh = Date.now();

  function refreshIfStale(force) {
    if (document.hidden) return;
    if (!force && Date.now() - lastRefresh < REFRESH_MS) return;
    lastRefresh = Date.now();
    loadRules();
  }

  document.addEventListener('visibilitychange', () => refreshIfStale(true));
  window.addEventListener('focus', () => refreshIfStale(true));
  setInterval(() => refreshIfStale(false), 10000);

  // ── Boot ────────────────────────────────────────────────────────
  render();
  loadRules();

  // expose for console
  window.financesState = state;
  window.financesRules = rules;
  window.financesSave = save;
})();
