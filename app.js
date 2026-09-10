/* ==================================================================
   Paper Trade Ledger — app.js
   Everything: Supabase IO, JSON ingest + validation, the date-driven
   check-in engine, P&L arithmetic, rendering.

   No market data anywhere. Every price in this app is typed in by hand.
================================================================== */

/* ---------------- tiny DOM helpers ---------------- */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(v){
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ---------------- state ---------------- */
let sb        = null;    // supabase client
let trades    = [];      // every row, newest first
let parsed    = null;    // { data, warnings, perShare }
let chart     = null;
let closingId = null;
let sortBy    = { key:'exit_date', asc:false };

/* ==================================================================
   1. BOOT
================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const cfg = window.SUPA || {};
  const ready = cfg.url && cfg.anon
    && !cfg.url.includes('PASTE_') && !cfg.anon.includes('PASTE_');

  if (!ready){
    $('#setupNotice').hidden = false;
    return;
  }

  $('#app').hidden = false;
  sb = window.supabase.createClient(cfg.url, cfg.anon);

  bindEvents();
  tickClock();
  setInterval(tickClock, 30_000);
  // re-evaluate "is anything due" once a minute so the page can roll
  // over past midnight without a manual refresh
  setInterval(renderAll, 60_000);

  loadTrades();
});

function tickClock(){
  const d = new Date();
  $('#clock').textContent =
    d.toLocaleDateString(undefined,{weekday:'short', day:'2-digit', month:'short'})
    + '  ' + d.toLocaleTimeString(undefined,{hour:'2-digit', minute:'2-digit'});
}

/* ==================================================================
   2. DATES  (all comparisons are local-calendar-date, never UTC)
================================================================== */
function isoLocal(d){
  return d.getFullYear() + '-' +
    String(d.getMonth()+1).padStart(2,'0') + '-' +
    String(d.getDate()).padStart(2,'0');
}
function todayISO(){ return isoLocal(new Date()); }

// build a Date at local noon so DST never shifts the calendar day
function fromISO(s){
  if (!isISO(s)) return null;
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d, 12, 0, 0);
}
function isISO(s){ return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

function daysUntil(iso){
  const a = fromISO(iso), b = fromISO(todayISO());
  if (!a || !b) return null;
  return Math.round((a - b) / 86_400_000);
}
function fmtDay(iso){
  const d = fromISO(iso);
  if (!d) return '—';
  return d.toLocaleDateString(undefined,{weekday:'short', day:'2-digit', month:'short'});
}
function fmtShort(iso){
  const d = fromISO(iso);
  if (!d) return '—';
  return d.toLocaleDateString(undefined,{day:'2-digit', month:'short'});
}

/* ==================================================================
   3. NUMBERS
================================================================== */
function num(v){
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[$,\s]/g,''));
  return Number.isFinite(n) ? n : null;
}
function money(n, {sign=false} = {}){
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});
  const s = n < 0 ? '-' : (sign && n > 0 ? '+' : '');
  return s + '$' + a;
}
function pnlHTML(n){
  if (n === null || n === undefined) return '<span>—</span>';
  const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  return `<span class="${cls}">${esc(money(n,{sign:true}))}</span>`;
}

/* ==================================================================
   4. SUPABASE IO
================================================================== */
async function loadTrades(){
  hideError();
  const { data, error } = await sb.from('trades').select('*').order('created_at',{ascending:false});
  if (error) return showError('Could not load trades from Supabase.', error.message);
  trades = data || [];
  renderAll();
}

async function insertTrade(row){
  const { error } = await sb.from('trades').insert(row);
  if (error){ showError('Save failed — nothing was written.', error.message); return false; }
  return true;
}

async function patchTrade(id, patch){
  const { error } = await sb.from('trades').update(patch).eq('id', id);
  if (error){ showError('Update failed — the change was not saved.', error.message); return false; }
  return true;
}

async function deleteTrade(id){
  const { error } = await sb.from('trades').delete().eq('id', id);
  if (error){ showError('Delete failed.', error.message); return false; }
  return true;
}

function showError(msg, detail){
  const bar = $('#errorBar');
  bar.innerHTML = esc(msg) + (detail ? ' <span>' + esc(detail) + '</span>' : '');
  bar.hidden = false;
}
function hideError(){ $('#errorBar').hidden = true; }

let toastTimer = null;
function toast(msg){
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ==================================================================
   5. INGEST — parse + validate the Interpreter JSON
================================================================== */
const ACTIONS = ['BUY','SELL'];
const TYPES   = ['CALL','PUT'];

function parseInput(raw){
  const errors = [], warnings = [];
  let txt = (raw || '').trim();

  // tolerate the one thing the interpreter is most likely to get wrong
  if (txt.startsWith('```')){
    txt = txt.replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim();
    warnings.push('Stripped markdown code fences. Tell the interpreter to stop adding them.');
  }
  const first = txt.indexOf('{'), last = txt.lastIndexOf('}');
  if (first > 0 || (last > -1 && last < txt.length - 1)){
    if (first > -1 && last > first){
      txt = txt.slice(first, last + 1);
      warnings.push('Trimmed text from around the JSON object.');
    }
  }

  let o;
  try { o = JSON.parse(txt); }
  catch (e){ return { errors:['Not valid JSON: ' + e.message], warnings, data:null }; }

  if (!o || typeof o !== 'object' || Array.isArray(o))
    return { errors:['Expected a single JSON object.'], warnings, data:null };

  /* --- required --- */
  if (!o.ticker || typeof o.ticker !== 'string') errors.push('ticker is missing.');
  if (!o.strategy || typeof o.strategy !== 'string') errors.push('strategy is missing.');
  if (!isISO(o.expiration_date)) errors.push('expiration_date is missing or not YYYY-MM-DD.');

  /* --- legs --- */
  let legs = [];
  if (!Array.isArray(o.legs) || o.legs.length === 0){
    errors.push('legs must be an array with at least one leg.');
  } else if (o.legs.length > 4){
    errors.push('legs has ' + o.legs.length + ' entries. Max is 4.');
  } else {
    legs = o.legs.map((L, i) => {
      const n = i + 1;
      const action = String(L.action || '').toUpperCase();
      const type   = String(L.type   || '').toUpperCase();
      if (!ACTIONS.includes(action)) errors.push(`Leg ${n}: action must be BUY or SELL.`);
      if (!TYPES.includes(type))     errors.push(`Leg ${n}: type must be CALL or PUT.`);
      const strike = num(L.strike);
      if (strike === null) errors.push(`Leg ${n}: strike is missing.`);
      if (!isISO(L.expiration_date)) warnings.push(`Leg ${n}: no valid expiration_date on the leg.`);
      const prem = num(L.premium_per_share);
      if (prem === null) warnings.push(`Leg ${n}: no premium — entry cost cannot be cross-checked.`);
      return { action, type, strike, expiration_date:L.expiration_date || null, premium_per_share:prem };
    });
  }

  /* --- money --- */
  const net = num(o.net_amount_per_share);
  if (net === null) warnings.push('net_amount_per_share is null. Entry cost and the P&L helper will not work.');
  const dir = String(o.net_direction || '').toLowerCase();
  if (!['debit','credit'].includes(dir)) warnings.push('net_direction is not "debit" or "credit". Defaulting to debit.');

  const maxP = num(o.max_profit_per_contract);
  const maxL = num(o.max_loss_per_contract);
  if (maxL === null) warnings.push('max_loss_per_contract is null — this trade will not count toward capital at risk.');

  /* --- the scaling trap --- */
  const perShare = looksPerShare(net, maxP, maxL);
  if (perShare){
    warnings.push('Max profit / max loss look like per-share dollars, not per-contract. The x100 box below is ticked — untick it if that is wrong.');
  }

  /* --- dates --- */
  if (isISO(o.expiration_date)){
    const dte = daysUntil(o.expiration_date);
    if (dte < 0) warnings.push('Expiration date is ' + Math.abs(dte) + ' day(s) in the past.');
    if (dte > 14) warnings.push('Expiration is ' + dte + ' days out. The bot is meant to return 4–5 DTE.');
  }
  legs.forEach((L,i) => {
    if (isISO(L.expiration_date) && isISO(o.expiration_date) && L.expiration_date > o.expiration_date)
      warnings.push(`Leg ${i+1} expires after the top-level expiration_date. Calendar spread? Check the countdown date is the one you want.`);
  });

  /* --- rules --- */
  const tsr = Array.isArray(o.time_stop_rules) ? o.time_stop_rules.filter(r => r && typeof r === 'object') : [];
  if (!Array.isArray(o.time_stop_rules)) warnings.push('time_stop_rules is not an array. Treating as empty.');
  tsr.forEach((r,i) => { if (!isISO(r.check_by_date)) warnings.push(`Time stop ${i+1} has no valid check_by_date — it will never fire.`); });
  if (tsr.length === 0) warnings.push('No time stops. The only scheduled check will be expiry day.');

  const inval = Array.isArray(o.invalidation_criteria) ? o.invalidation_criteria.map(String) : [];
  const bes   = Array.isArray(o.breakeven_prices) ? o.breakeven_prices.map(num).filter(v => v !== null) : [];

  const data = {
    ticker: String(o.ticker || '').toUpperCase().trim(),
    analysis_date: isISO(o.analysis_date) ? o.analysis_date : null,
    strategy: String(o.strategy || '').trim(),
    legs,
    net_amount_per_share: net,
    net_direction: ['debit','credit'].includes(dir) ? dir : 'debit',
    max_profit_per_contract: maxP,
    max_loss_per_contract: maxL,
    breakeven_prices: bes,
    risk_reward_ratio: o.risk_reward_ratio ? String(o.risk_reward_ratio) : null,
    thesis_summary: o.thesis_summary ? String(o.thesis_summary) : null,
    stop_loss_underlying_price: num(o.stop_loss_underlying_price),
    stop_loss_premium_pct: num(o.stop_loss_premium_pct),
    time_stop_rules: tsr.map(r => ({
      check_by_date: isISO(r.check_by_date) ? r.check_by_date : null,
      check_by_time_et: r.check_by_time_et || null,
      rule: r.rule ? String(r.rule) : ''
    })),
    invalidation_criteria: inval,
    expiration_date: isISO(o.expiration_date) ? o.expiration_date : null
  };

  return { errors, warnings, data, perShare };
}

// A real per-contract max loss on a 4–5 DTE structure is essentially never
// under $25. If both money fields are tiny AND they sit closer to the raw
// per-share net than to net*100, the interpreter forgot the x100.
function looksPerShare(net, maxP, maxL){
  const vals = [maxP, maxL].filter(v => v !== null && v !== 0);
  if (!vals.length) return false;
  const tiny = vals.every(v => Math.abs(v) < 25);
  if (!tiny) return false;
  if (net === null) return true;
  const gapShare    = Math.abs(Math.abs(maxL ?? maxP) - Math.abs(net));
  const gapContract = Math.abs(Math.abs(maxL ?? maxP) - Math.abs(net) * 100);
  return gapShare < gapContract;
}

/* ---------------- preview ---------------- */
function renderPreview(res){
  const box = $('#preview');
  box.hidden = false;

  if (!res.data || res.errors.length){
    box.innerHTML =
      '<div class="pv-title">Cannot save this</div>' +
      res.errors.map(e => `<div class="pv-issue">${esc(e)}</div>`).join('') +
      res.warnings.map(w => `<div class="pv-warn">${esc(w)}</div>`).join('');
    parsed = null;
    return;
  }

  const d = res.data;
  parsed = { data:d, perShare:res.perShare };

  const legRows = d.legs.map(L =>
    `<div class="pv-row"><span>${esc(L.action)} ${esc(L.type)}</span>` +
    `<span>${esc(L.strike)} · ${esc(L.expiration_date || '—')} · ${L.premium_per_share === null ? '—' : '$'+esc(L.premium_per_share)}</span></div>`
  ).join('');

  const row = (k,v) => `<div class="pv-row"><span>${esc(k)}</span><span>${v}</span></div>`;

  box.innerHTML =
    res.warnings.map(w => `<div class="pv-warn">${esc(w)}</div>`).join('') +
    `<div class="pv-title">${esc(d.ticker)} · ${esc(d.strategy)}</div>` +
    `<div class="pv-legs">${legRows}</div>` +
    row('Net, per share', (d.net_amount_per_share === null ? '—' : '$'+d.net_amount_per_share) + ' ' + esc(d.net_direction)) +
    row('Max profit', d.max_profit_per_contract === null ? 'open-ended' : esc(money(d.max_profit_per_contract))) +
    row('Max loss', d.max_loss_per_contract === null ? '—' : esc(money(d.max_loss_per_contract))) +
    row('Breakeven', d.breakeven_prices.length ? esc(d.breakeven_prices.join(', ')) : '—') +
    row('Risk / reward', esc(d.risk_reward_ratio || '—')) +
    row('Stop, underlying', d.stop_loss_underlying_price === null ? '—' : esc(d.stop_loss_underlying_price)) +
    row('Stop, premium lost', d.stop_loss_premium_pct === null ? '—' : esc(d.stop_loss_premium_pct) + '%') +
    row('Expiry', esc(d.expiration_date) + ' · ' + daysUntil(d.expiration_date) + ' DTE') +
    row('Time stops', String(d.time_stop_rules.length)) +
    row('Invalidation notes', String(d.invalidation_criteria.length)) +
    (d.thesis_summary ? `<p class="hint">${esc(d.thesis_summary)}</p>` : '') +
    `<label class="pv-check"><input type="checkbox" id="x100" ${res.perShare ? 'checked' : ''}>
       <span>Max profit / max loss are written per share — multiply by 100 to store dollars per contract.</span></label>` +
    `<div class="qty-row">
       <div><label class="lbl" for="qty">Contracts</label>
         <input id="qty" class="inp mono" type="number" min="1" step="1" value="1"></div>
       <button id="saveBtn" class="btn btn-primary" type="button">Save as open position</button>
     </div>`;

  $('#saveBtn').addEventListener('click', saveParsed);
}

async function saveParsed(){
  if (!parsed) return;
  const d   = parsed.data;
  const qty = Math.max(1, parseInt($('#qty').value, 10) || 1);
  const k   = $('#x100').checked ? 100 : 1;

  const row = {
    ticker: d.ticker,
    analysis_date: d.analysis_date,
    strategy: d.strategy,
    legs: d.legs,
    contracts: qty,
    net_amount_per_share: d.net_amount_per_share,
    net_direction: d.net_direction,
    // stored as DOLLARS PER ONE CONTRACT. Everything downstream multiplies by contracts.
    max_profit_per_contract: d.max_profit_per_contract === null ? null : d.max_profit_per_contract * k,
    max_loss_per_contract:   d.max_loss_per_contract   === null ? null : d.max_loss_per_contract   * k,
    breakeven_prices: d.breakeven_prices,
    risk_reward_ratio: d.risk_reward_ratio,
    thesis_summary: d.thesis_summary,
    stop_loss_underlying_price: d.stop_loss_underlying_price,
    stop_loss_premium_pct: d.stop_loss_premium_pct,
    time_stop_rules: d.time_stop_rules,
    invalidation_criteria: d.invalidation_criteria,
    expiration_date: d.expiration_date,
    status: 'open',
    checkins: []
  };

  $('#saveBtn').disabled = true;
  const ok = await insertTrade(row);
  $('#saveBtn').disabled = false;
  if (!ok) return;

  $('#jsonIn').value = '';
  $('#preview').hidden = true;
  parsed = null;
  toast(d.ticker + ' logged');
  await loadTrades();
}

/* ==================================================================
   6. CHECK-IN ENGINE
   Every date the trade forces you to go and look up a price.
================================================================== */
function checkpoints(t){
  const out = [];
  (t.time_stop_rules || []).forEach((r, i) => {
    if (!r || !isISO(r.check_by_date)) return;
    out.push({
      key:  'ts-' + i,
      date: r.check_by_date,
      label:'Time stop',
      rule: r.rule || 'Time stop check.',
      time: r.check_by_time_et || null
    });
  });
  if (isISO(t.expiration_date)){
    out.push({
      key:'exp', date:t.expiration_date, label:'Expiration',
      rule:'Expiry. The position has to be resolved today — log where it settled, then close it.', time:null
    });
  }
  return out.sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

function checkinFor(t, key){
  return (t.checkins || []).find(c => c && c.key === key) || null;
}
function dueCheckpoints(t){
  const today = todayISO();
  return checkpoints(t).filter(cp => cp.date <= today && !checkinFor(t, cp.key));
}
function lastCheckin(t){
  const cs = (t.checkins || []).filter(c => c && num(c.underlying_price) !== null);
  if (!cs.length) return null;
  return cs.slice().sort((a,b) => String(a.logged_at||a.date) < String(b.logged_at||b.date) ? -1 : 1).pop();
}

/* directional bias, used only to say which side of the stop is "bad" */
function bias(t){
  const s = String(t.strategy || '').toLowerCase();
  const bull = ['long call','call debit','bull call','put credit','bull put','synthetic long'];
  const bear = ['long put','put debit','bear put','call credit','bear call','synthetic short'];
  if (bull.some(k => s.includes(k))) return 'bullish';
  if (bear.some(k => s.includes(k))) return 'bearish';
  return 'neutral';
}

function stopBreached(t){
  const stop = num(t.stop_loss_underlying_price);
  const last = lastCheckin(t);
  if (stop === null || !last) return false;
  const px = num(last.underlying_price);
  const b = bias(t);
  if (b === 'bullish') return px <= stop;
  if (b === 'bearish') return px >= stop;
  return false;
}

/* ==================================================================
   7. DERIVED MONEY
================================================================== */
const qtyOf     = t => Math.max(1, parseInt(t.contracts, 10) || 1);
const maxProfit = t => t.max_profit_per_contract === null ? null : num(t.max_profit_per_contract) * qtyOf(t);
const maxLoss   = t => t.max_loss_per_contract   === null ? null : num(t.max_loss_per_contract)   * qtyOf(t);

function entryCost(t){
  const n = num(t.net_amount_per_share);
  if (n === null) return null;
  return Math.abs(n) * 100 * qtyOf(t);
}
function capitalAtRisk(t){
  const ml = maxLoss(t);
  if (ml !== null) return Math.abs(ml);
  const ec = entryCost(t);
  return ec === null ? 0 : ec;
}
function legLine(t){
  return (t.legs || []).map(L =>
    `${L.action === 'SELL' ? '-' : '+'}${L.strike}${(L.type||'')[0] || ''}`
  ).join('  ') + (t.legs && t.legs.length ? '  ×' + qtyOf(t) : '');
}

/* ==================================================================
   8. RENDER
================================================================== */
function renderAll(){
  renderStats();
  renderChart();
  renderOpen();
  renderClosed();
  renderBanner();
}

function renderStats(){
  const closed = trades.filter(t => t.status === 'closed');
  const wins   = closed.filter(t => t.outcome === 'win').length;
  const losses = closed.filter(t => t.outcome === 'loss').length;
  const decided= wins + losses;
  const pnl    = closed.reduce((s,t) => s + (num(t.realized_pnl) || 0), 0);
  const cap    = trades.reduce((s,t) => s + capitalAtRisk(t), 0);
  const open   = trades.filter(t => t.status !== 'closed').length;

  $('#statTotal').textContent = trades.length;
  $('#statWin').textContent   = decided ? Math.round((wins/decided)*100) + '%' : '—';
  $('#statWinSub').textContent = decided
    ? `Win rate · ${wins}W ${losses}L of ${closed.length} closed`
    : 'Win rate';
  $('#statPnl').innerHTML = pnlHTML(closed.length ? pnl : null);
  $('#statCap').textContent = money(cap);
  $('#statOpen').textContent = open;
}

function renderChart(){
  const closed = trades
    .filter(t => t.status === 'closed' && num(t.realized_pnl) !== null)
    .sort((a,b) => String(a.exit_date || a.created_at) < String(b.exit_date || b.created_at) ? -1 : 1);

  const labels = ['start'];
  const vals   = [0];
  let run = 0;
  closed.forEach(t => {
    run += num(t.realized_pnl);
    labels.push(fmtShort(t.exit_date) + ' ' + t.ticker);
    vals.push(Math.round(run * 100) / 100);
  });

  $('#chartNote').textContent = closed.length ? closed.length + ' closed trades' : 'nothing closed yet';

  const ctx = $('#equity').getContext('2d');
  const grid = '#242c37', tick = '#667284';
  const up = run >= 0;

  if (chart){ chart.data.labels = labels; chart.data.datasets[0].data = vals;
    chart.data.datasets[0].borderColor = up ? '#3fb27f' : '#e2564d';
    chart.update(); return; }

  chart = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{
      data: vals,
      borderColor: up ? '#3fb27f' : '#e2564d',
      borderWidth: 1.6,
      pointRadius: 2,
      pointBackgroundColor: '#0e1116',
      tension: 0,
      fill: false
    }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      animation:false,
      plugins:{ legend:{ display:false },
        tooltip:{ backgroundColor:'#1a2029', borderColor:grid, borderWidth:1,
          titleColor:'#e6eaf0', bodyColor:'#9aa5b4', displayColors:false,
          callbacks:{ label: c => money(c.parsed.y, {sign:true}) } } },
      scales:{
        x:{ grid:{ color:'transparent' }, ticks:{ color:tick, font:{ family:'JetBrains Mono', size:10 }, maxRotation:0, autoSkip:true } },
        y:{ grid:{ color:grid }, border:{ display:false },
            ticks:{ color:tick, font:{ family:'JetBrains Mono', size:10 },
              callback: v => (v < 0 ? '-$' : '$') + Math.abs(v) } }
      }
    }
  });
}

function renderBanner(){
  const need = trades.filter(t => t.status !== 'closed' && dueCheckpoints(t).length > 0);
  const bar = $('#alertBar');
  if (!need.length){ bar.hidden = true; return; }
  const list = need.map(t => t.ticker).join(', ');
  bar.innerHTML = `<strong>${need.length} ${need.length === 1 ? 'trade needs' : 'trades need'} a price update</strong>`
    + `<span>${esc(list)}</span>`
    + `<a href="#open">Go to them</a>`;
  bar.hidden = false;
}

function renderOpen(){
  const open = trades.filter(t => t.status !== 'closed')
    .sort((a,b) => String(a.expiration_date) < String(b.expiration_date) ? -1 : 1);
  $('#openCount').textContent = open.length ? open.length + ' live' : '';
  const host = $('#openList');

  if (!open.length){
    host.innerHTML = `<div class="empty">Nothing open. Paste an interpreter JSON on the right to log a trade.</div>`;
    return;
  }
  host.innerHTML = open.map(cardHTML).join('');
}

function cardHTML(t){
  const dte  = daysUntil(t.expiration_date);
  const due  = dueCheckpoints(t);
  const all  = checkpoints(t);
  const last = lastCheckin(t);
  const breach = stopBreached(t);

  const dteTxt = dte === null ? '—' : dte < 0 ? Math.abs(dte) + 'd past' : dte === 0 ? 'today' : dte + 'd';

  /* attention block */
  let attention = '';
  if (due.length){
    attention = `<div class="attention"><div class="attention-h">Check the price and log it</div>` +
      due.map(cp => `
        <div class="cp">
          <div class="cp-rule">${esc(cp.rule)}</div>
          <div class="cp-date">${esc(cp.label)} · due ${esc(fmtDay(cp.date))}${cp.time ? ' · ' + esc(cp.time) : ''}</div>
          <div class="cp-form" style="margin-top:7px">
            <input class="inp mono px" type="number" step="0.01" placeholder="${esc(t.ticker)} price"
                   data-px="${t.id}|${esc(cp.key)}">
            <input class="inp" type="text" placeholder="note, optional" data-note="${t.id}|${esc(cp.key)}">
            <button class="btn btn-primary btn-sm" data-log="${t.id}|${esc(cp.key)}|${esc(cp.date)}|${esc(cp.label)}">Log</button>
          </div>
        </div>`).join('') + `</div>`;
  }

  /* schedule */
  const today = todayISO();
  const sched = all.map(cp => {
    const done = checkinFor(t, cp.key);
    const state = done
      ? `<span class="sch-done">${esc(done.underlying_price)}</span>`
      : cp.date <= today ? `<span class="sch-wait" style="color:var(--accent)">due</span>`
      : `<span class="sch-wait">in ${daysUntil(cp.date)}d</span>`;
    return `<div class="sch-row"><span class="sch-date">${esc(fmtShort(cp.date))}</span>` +
           `<span class="sch-txt">${esc(cp.rule)}</span>${state}</div>`;
  }).join('');

  /* thesis + rules */
  const inval = (t.invalidation_criteria || []).map(x => `<li>${esc(x)}</li>`).join('');
  const thesis = `
    <details class="thesis">
      <summary>Thesis, stops and invalidation</summary>
      <div class="thesis-body">
        ${t.thesis_summary ? `<p style="margin:0 0 8px">${esc(t.thesis_summary)}</p>` : '<p style="margin:0 0 8px">No thesis summary was extracted.</p>'}
        <div class="sch-row"><span class="sch-date">Stop px</span><span class="sch-txt">${
          t.stop_loss_underlying_price === null ? 'none given'
          : esc(t.stop_loss_underlying_price) + ' on the underlying (' + bias(t) + ' bias)'}</span></div>
        <div class="sch-row"><span class="sch-date">Stop %</span><span class="sch-txt">${
          t.stop_loss_premium_pct === null ? 'none given' : 'exit at ' + esc(t.stop_loss_premium_pct) + '% of premium lost'}</span></div>
        <div class="sch-row"><span class="sch-date">Breakeven</span><span class="sch-txt">${
          (t.breakeven_prices || []).length ? esc(t.breakeven_prices.join(', ')) : '—'}</span></div>
        <div class="sch-row"><span class="sch-date">R:R</span><span class="sch-txt">${esc(t.risk_reward_ratio || '—')}</span></div>
        ${inval ? `<div style="margin-top:8px;color:var(--ink-3);font-size:12.5px">Invalidation</div><ul>${inval}</ul>` : ''}
        <div class="schedule" style="margin-top:10px">${sched}</div>
      </div>
    </details>`;

  const lastLine = last
    ? `<div class="sch-row"><span class="sch-date">${esc(fmtShort(last.date))}</span>
        <span class="sch-txt">last logged price ${esc(last.underlying_price)}${last.note ? ' — ' + esc(last.note) : ''}</span></div>`
    : '';

  const breachLine = breach
    ? `<div class="pv-issue" style="margin:0 0 10px">Last logged price is through the stop level. Rules say get out.</div>` : '';

  return `
  <article class="card ${due.length ? 'due' : ''}" data-id="${t.id}">
    <div class="card-top">
      <div class="card-id">
        <div><span class="tick">${esc(t.ticker)}</span><span class="strat">${esc(t.strategy)}</span></div>
        <div class="legline">${esc(legLine(t))} · entered ${esc(fmtShort(t.analysis_date || t.created_at))} · expires ${esc(fmtDay(t.expiration_date))}</div>
      </div>
      <div class="card-clock">
        <div class="dte ${dte !== null && dte <= 1 ? 'urgent' : ''}">${esc(dteTxt)}</div>
        <div class="dte-key">to expiry</div>
      </div>
    </div>

    <div class="metrics">
      <div class="metric"><div class="metric-v">${esc(money(entryCost(t)))}</div><div class="metric-k">${t.net_direction === 'credit' ? 'Credit taken' : 'Entry cost'}</div></div>
      <div class="metric"><div class="metric-v pos">${maxProfit(t) === null ? 'open' : esc(money(maxProfit(t)))}</div><div class="metric-k">Max profit</div></div>
      <div class="metric"><div class="metric-v neg">${maxLoss(t) === null ? '—' : esc(money(maxLoss(t)))}</div><div class="metric-k">Max loss</div></div>
      <div class="metric"><div class="metric-v">${t.stop_loss_underlying_price === null ? '—' : esc(t.stop_loss_underlying_price)}</div><div class="metric-k">Stop, underlying</div></div>
      <div class="metric"><div class="metric-v">${esc(qtyOf(t))}</div><div class="metric-k">Contracts</div></div>
    </div>

    <div class="card-body">
      ${breachLine}
      ${attention}
      ${lastLine}
      ${thesis}
    </div>

    <div class="card-foot">
      <button class="btn btn-sm" data-adhoc="${t.id}">Log a price now</button>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" data-close="${t.id}">Close position</button>
      <button class="btn btn-sm btn-danger" data-del="${t.id}">Delete</button>
    </div>
  </article>`;
}

function renderClosed(){
  const q  = $('#filterText').value.trim().toLowerCase();
  const oc = $('#filterOutcome').value;

  let rows = trades.filter(t => t.status === 'closed');
  if (q)  rows = rows.filter(t => (t.ticker + ' ' + t.strategy).toLowerCase().includes(q));
  if (oc) rows = rows.filter(t => t.outcome === oc);

  rows.sort((a,b) => {
    const k = sortBy.key;
    let A = a[k], B = b[k];
    if (k === 'realized_pnl' || k === 'contracts'){ A = num(A) ?? -Infinity; B = num(B) ?? -Infinity; }
    else { A = String(A ?? ''); B = String(B ?? ''); }
    if (A < B) return sortBy.asc ? -1 : 1;
    if (A > B) return sortBy.asc ? 1 : -1;
    return 0;
  });

  $$('#closedTbl th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === sortBy.key);
    th.classList.toggle('asc', th.dataset.sort === sortBy.key && sortBy.asc);
  });

  const body = $('#closedBody');
  if (!rows.length){
    body.innerHTML = `<tr><td colspan="9" style="color:var(--ink-3);padding:26px 14px">No closed trades match.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(t => `
    <tr>
      <td class="t-tick">${esc(t.ticker)}</td>
      <td>${esc(t.strategy)}</td>
      <td class="num t-num">${esc(qtyOf(t))}</td>
      <td class="t-num">${esc(fmtShort(t.analysis_date || t.created_at))}</td>
      <td class="t-num">${esc(fmtShort(t.exit_date))}</td>
      <td class="t-num">${esc(fmtShort(t.expiration_date))}</td>
      <td class="num t-num">${pnlHTML(num(t.realized_pnl))}</td>
      <td><span class="pill ${esc(t.outcome || '')}">${esc(t.outcome || '—')}</span></td>
      <td class="num"><button class="btn btn-sm btn-danger" data-del="${t.id}">Delete</button></td>
    </tr>`).join('');
}

/* ==================================================================
   9. ACTIONS
================================================================== */
async function logCheckin(id, key, date, label, price, note){
  const t = trades.find(x => String(x.id) === String(id));
  if (!t) return;
  const px = num(price);
  if (px === null){ toast('Type a price first'); return; }

  const list = Array.isArray(t.checkins) ? t.checkins.slice() : [];
  list.push({
    key, date, label,
    underlying_price: px,
    note: note || '',
    logged_at: new Date().toISOString()
  });

  const ok = await patchTrade(id, { checkins: list });
  if (!ok) return;
  toast('Logged ' + t.ticker + ' at ' + px);
  await loadTrades();
}

function openCloseDialog(id){
  const t = trades.find(x => String(x.id) === String(id));
  if (!t) return;
  closingId = id;

  $('#closeTitle').textContent = `Close ${t.ticker} · ${t.strategy} · ${qtyOf(t)} contract${qtyOf(t) > 1 ? 's' : ''}`;
  $('#exitDate').value = todayISO();
  $('#exitValue').value = '';
  $('#realized').value = '';
  $('#exitNote').value = '';
  $('#sanity').textContent = '';

  const n = num(t.net_amount_per_share);
  $('#calcHint').textContent = n === null
    ? 'No net premium stored, so the helper below cannot work. Type the P&L in yourself.'
    : `Entered at $${Math.abs(n)} ${t.net_direction} per share, ${qtyOf(t)} contract${qtyOf(t)>1?'s':''}. Enter what the whole structure is worth per share now — 0 if it expired worthless.`;

  $('#closeDlg').showModal();
}

function calcPnl(){
  const t = trades.find(x => String(x.id) === String(closingId));
  if (!t) return;
  const entry = num(t.net_amount_per_share);
  const exit  = num($('#exitValue').value);
  if (entry === null || exit === null){ toast('Need an exit value'); return; }
  const q = qtyOf(t);
  const pnl = (t.net_direction === 'credit')
    ? (Math.abs(entry) - Math.abs(exit)) * 100 * q
    : (Math.abs(exit)  - Math.abs(entry)) * 100 * q;
  $('#realized').value = Math.round(pnl * 100) / 100;
  sanityCheck();
}

function sanityCheck(){
  const t = trades.find(x => String(x.id) === String(closingId));
  const v = num($('#realized').value);
  const el = $('#sanity');
  if (!t || v === null){ el.textContent = ''; el.classList.remove('bad'); return; }
  const mp = maxProfit(t), ml = maxLoss(t);
  let msg = '';
  if (mp !== null && v > Math.abs(mp) + 0.005) msg = `That is more than max profit (${money(Math.abs(mp))}). Check the number.`;
  if (ml !== null && v < -Math.abs(ml) - 0.005) msg = `That is worse than max loss (${money(-Math.abs(ml))}). Check the number.`;
  el.textContent = msg;
  el.classList.toggle('bad', !!msg);
}

async function confirmClose(){
  const t = trades.find(x => String(x.id) === String(closingId));
  if (!t) return;
  const pnl = num($('#realized').value);
  if (pnl === null){ toast('Realised P&L is required'); return; }

  const patch = {
    status: 'closed',
    exit_date: $('#exitDate').value || todayISO(),
    exit_note: $('#exitNote').value || null,
    realized_pnl: pnl,
    outcome: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven'
  };
  const ok = await patchTrade(closingId, patch);
  if (!ok) return;
  toast(t.ticker + ' closed · ' + money(pnl, {sign:true}));
  closingId = null;
  await loadTrades();
}

/* ==================================================================
   10. EVENTS
================================================================== */
function bindEvents(){
  $('#parseBtn').addEventListener('click', () => renderPreview(parseInput($('#jsonIn').value)));
  $('#clearBtn').addEventListener('click', () => {
    $('#jsonIn').value = ''; $('#preview').hidden = true; parsed = null;
  });
  $('#refreshBtn').addEventListener('click', loadTrades);

  $('#filterText').addEventListener('input', renderClosed);
  $('#filterOutcome').addEventListener('change', renderClosed);
  $$('#closedTbl th').forEach(th => {
    if (!th.dataset.sort) return;
    th.addEventListener('click', () => {
      if (sortBy.key === th.dataset.sort) sortBy.asc = !sortBy.asc;
      else sortBy = { key: th.dataset.sort, asc: false };
      renderClosed();
    });
  });

  /* delegated card actions */
  $('#openList').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;

    if (b.dataset.log){
      const [id, key, date, label] = b.dataset.log.split('|');
      const px   = $(`[data-px="${id}|${key}"]`);
      const note = $(`[data-note="${id}|${key}"]`);
      await logCheckin(id, key, date, label, px ? px.value : null, note ? note.value : '');
      return;
    }
    if (b.dataset.adhoc){
      const id = b.dataset.adhoc;
      const t  = trades.find(x => String(x.id) === String(id));
      const px = prompt(`Current ${t.ticker} price?`);
      if (px === null) return;
      const note = prompt('Note, optional:') || '';
      await logCheckin(id, 'adhoc-' + Date.now(), todayISO(), 'Manual check', px, note);
      return;
    }
    if (b.dataset.close){ openCloseDialog(b.dataset.close); return; }
    if (b.dataset.del){ await confirmDelete(b.dataset.del); return; }
  });

  $('#closedBody').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.del) await confirmDelete(b.dataset.del);
  });

  /* enter key inside a check-in input submits that check-in */
  $('#openList').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const inp = e.target.closest('[data-px],[data-note]');
    if (!inp) return;
    e.preventDefault();
    const btn = inp.parentElement.querySelector('[data-log]');
    if (btn) btn.click();
  });

  $('#calcBtn').addEventListener('click', calcPnl);
  $('#realized').addEventListener('input', sanityCheck);
  $('#closeDlg').addEventListener('close', async () => {
    if ($('#closeDlg').returnValue === 'confirm') await confirmClose();
    else closingId = null;
  });
}

async function confirmDelete(id){
  const t = trades.find(x => String(x.id) === String(id));
  if (!t) return;
  if (!confirm(`Delete the ${t.ticker} ${t.strategy} trade permanently? This cannot be undone.`)) return;
  const ok = await deleteTrade(id);
  if (!ok) return;
  toast('Deleted');
  await loadTrades();
}
