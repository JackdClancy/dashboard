// Finances with Akahu integration
(function(){
  const sampleTx = [
    {id:1,date: daysAgo(2),amount:120.50,category:'Groceries',type:'debit'},
    {id:2,date: daysAgo(4),amount:45.00,category:'Transport',type:'debit'},
    {id:3,date: daysAgo(10),amount:1500,category:'Salary',type:'credit'},
    {id:4,date: daysAgo(20),amount:950,category:'Rent',type:'debit'}
  ];

  function daysAgo(n){
    const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString();
  }

  function loadAkahuCreds(){
    const raw = localStorage.getItem('akahu_creds');
    return raw ? JSON.parse(raw) : {appId:'',userToken:''};
  }
  function saveAkahuCreds(appId,userToken){
    localStorage.setItem('akahu_creds',JSON.stringify({appId,userToken}));
  }

  const state = loadState();

  function loadState(){
    const raw=localStorage.getItem('finances_v1');
    if(raw) return JSON.parse(raw);
    return {
      transactions: sampleTx,
      categories: ['Rent','Groceries','Transport','Entertainment'],
      savingsGoal:5000,
      savingsCurrent:1200
    };
  }

  function save(){ localStorage.setItem('finances_v1',JSON.stringify(state)); }

  // Auto-categorization: matches a transaction's merchant/description text
  // against keywords for each of the fixed spending categories.
  const CATEGORY_RULES = {
    'Rent':          ['rent', 'flat account', 'flatmates', 'landlord'],
    'Groceries':     ['groceries', 'woolworths', 'new world', 'paknsave', 'pak n save', 'countdown', 'fresh choice', 'four square', 'supermarket', 'foodstuffs'],
    'Transport':     ['transport', 'uber', 'petrol', 'gas station', 'bp', 'z energy', 'mobil', 'caltex', 'gull', 'taxi', 'parking', 'at hop', 'train', 'metro', 'bus'],
    'Entertainment': ['entertainment', 'cinema', 'hoyts', 'reading cinema', 'golf', 'bowling', 'theatre', 'theater', 'movie', 'museum', 'zoo'],
    'Alcohol':       ['alcohol', 'liquor', 'bottle store', 'bws', 'big barrel', 'thirsty liquor', 'bar', 'pub', 'tavern', 'nightclub', 'brewery', 'cellar'],
    'Subscriptions': ['subscriptions', 'apple.com', 'icloud', 'claude', 'anthropic', 'netflix', 'spotify', 'disney', 'prime video', 'youtube premium', 'subscription'],
    'Food':          ['cafe', 'coffee', 'pizza', "domino's", 'dominos', 'pizza hut', 'hell pizza', "mcdonald", 'kfc', 'burger king', 'burger fuel', 'subway', 'starbucks', 'restaurant', 'takeaway', 'take away', 'fish and chips', 'bakery', 'sushi', 'kebab', 'noodle', 'wok', 'thai', 'butchery']
  };

  // categorize() returns the matched bucket, or 'Other' if nothing matches
  // (so every transaction lands somewhere instead of being dropped silently).
  function categorize(text){
    if(!text) return 'Other';
    const t = text.toLowerCase();
    for(const [cat, keywords] of Object.entries(CATEGORY_RULES)){
      if(keywords.some(k => t.includes(k))) return cat;
    }
    return 'Other';
  }

  // Fetch transactions from Akahu via our serverless proxy (/api/akahu).
  // The browser can't call api.akahu.nz directly due to CORS, so the
  // request is forwarded server-side instead.
  async function fetchAkahuTransactions(appId, userToken){
    const status = document.getElementById('akahuStatus');
    try {
      status.textContent = 'Loading from Akahu...';

      const res = await fetch('/api/akahu', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({appId, userToken})
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Request failed: '+res.status);

      if(data.message){
        status.textContent = data.message;
        return;
      }

      const akahuTx = data.transactions || [];

      // Map Akahu transactions
      const mapped = akahuTx.map((t,i)=>({
        id: i,
        date: t.date,
        amount: Math.abs(t.amount),
        category: t.merchant?.name || t.description || 'Uncategorized',
        type: t.amount > 0 ? 'credit' : 'debit'
      }));

      state.transactions = mapped;
      save();
      render();
      saveAkahuCreds(appId, userToken);
      status.textContent = 'Loaded '+akahuTx.length+' transactions from Akahu!';
    } catch(e){
      status.textContent = 'Error: '+e.message;
      console.error(e);
    }
  }

  // Renderers
  function render(){ renderOverview(); renderCategories(); renderSavings(); }

  function renderOverview(){
    const range = document.querySelector('input[name=range]:checked')?.value || 'week';
    const now = new Date();
    let cutoff = new Date();
    if(range==='week') cutoff.setDate(now.getDate()-7); else cutoff.setMonth(now.getMonth()-1);
    const tx = state.transactions.filter(t=> new Date(t.date) > cutoff);
    const spent = tx.filter(t=>t.type==='debit').reduce((s,x)=>s+x.amount,0);
    const income = tx.filter(t=>t.type==='credit').reduce((s,x)=>s+x.amount,0);
    document.getElementById('totalSpent').textContent = '$'+spent.toFixed(2);
    document.getElementById('income').textContent = '$'+income.toFixed(2);
    const list = document.getElementById('txList'); list.innerHTML='';
    tx.slice().sort((a,b)=> new Date(b.date) - new Date(a.date)).forEach(t=>{
      const el = document.createElement('div'); el.className='tx';
      el.textContent = `${new Date(t.date).toLocaleDateString()} • ${t.category} • ${t.type==='debit'?'-':''}$${t.amount.toFixed(2)}`;
      list.appendChild(el);
    });
  }

  function renderCategories(){
    const range = document.querySelector('input[name=range]:checked')?.value || 'week';
    const now = new Date();
    let cutoff = new Date();
    if(range==='week') cutoff.setDate(now.getDate()-7); else cutoff.setMonth(now.getMonth()-1);

    const totals = {};
    state.categories.forEach(c=>totals[c]=0);
    state.transactions.forEach(t=>{
      if(t.type!=='debit') return;
      if(new Date(t.date) <= cutoff) return;
      const bucket = categorize(t.category);
      if(bucket && totals.hasOwnProperty(bucket)) totals[bucket] += t.amount;
    });
    const container = document.getElementById('categoryList'); container.innerHTML='';
    state.categories.forEach(c=>{
      const row = document.createElement('div'); row.className='category';
      const name = document.createElement('div'); name.textContent = c;
      const value = document.createElement('div'); value.textContent = '$'+(totals[c]||0).toFixed(2);
      const barWrap = document.createElement('div'); barWrap.className='bar';
      const bar = document.createElement('i');
      const max = Math.max(...Object.values(totals),1);
      bar.style.width = ((totals[c]||0)/max*100)+'%';
      barWrap.appendChild(bar);
      row.appendChild(name); row.appendChild(barWrap); row.appendChild(value);
      container.appendChild(row);
    });
  }

  function renderSavings(){
    document.getElementById('savingsGoal').value = state.savingsGoal;
    document.getElementById('savingsCurrent').value = state.savingsCurrent;
    const pct = Math.min(100, (state.savingsCurrent/state.savingsGoal)*100);
    document.getElementById('savingsBar').style.width = pct+'%';
    document.getElementById('savingsText').textContent = `${Math.round(pct)}% of $${state.savingsGoal.toFixed(2)} saved`;
  }

  // Events
  function syncRangeToggles(value){
    document.querySelectorAll('input[name=range]').forEach(r => { r.checked = (r.value === value); });
  }

  document.addEventListener('change', e=>{
    if(e.target && e.target.name==='range'){
      syncRangeToggles(e.target.value);
      renderOverview();
      renderCategories();
    }
  });
  syncRangeToggles('week');
  document.getElementById('addCategoryForm').addEventListener('submit', e=>{
    e.preventDefault(); const name = document.getElementById('newCategoryName').value.trim();
    if(!name) return; state.categories.push(name); save(); render(); document.getElementById('newCategoryName').value='';
  });
  document.getElementById('savingsGoal').addEventListener('change', e=>{ state.savingsGoal=Number(e.target.value)||0; save(); renderSavings(); });
  document.getElementById('savingsCurrent').addEventListener('change', e=>{ state.savingsCurrent=Number(e.target.value)||0; save(); renderSavings(); });
  
  // Restore Akahu credentials if previously saved
  const creds = loadAkahuCreds();
  if(creds.appId) document.getElementById('appId').value = creds.appId;
  if(creds.userToken) document.getElementById('userToken').value = creds.userToken;
  
  document.getElementById('loadAkahu').addEventListener('click', ()=>{
    const appId = document.getElementById('appId').value.trim();
    const userToken = document.getElementById('userToken').value.trim();
    if(!appId || !userToken){
      document.getElementById('akahuStatus').textContent = 'Please enter both App ID and User Access Token.';
      return;
    }
    fetchAkahuTransactions(appId, userToken);
  });

  // initial render
  render();
  // expose for console
  window.financesState = state;
  window.financesSave = save;
})();
