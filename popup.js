const tabsList = document.getElementById('tabsList');
const searchInput = document.getElementById('search');
const heroDot = document.getElementById('heroDot');
const heroText = document.getElementById('heroText');
const btnClear = document.getElementById('btnClear');
const currentSection = document.getElementById('currentSection');
const otherCount = document.getElementById('otherCount');

let allTabs = [];
let currentTab = null;
let filterText = '';
let configs = {}; // tabId -> {url,title,interval,active,lastRefresh}
let focusedTabId = null; // tabId de la pestaña con foco en la ventana activa

const PRESETS = [
  { val: 30,  label: '30s' },
  { val: 60,  label: '1m' },
  { val: 90,  label: '1m30' },
  { val: 120, label: '2m' },
  { val: 300, label: '5m' },
  { val: 600, label: '10m' },
  { val: 1200, label: '20m' },
];

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function matchFilter(tab) {
  if (!filterText) return true;
  const q = filterText.toLowerCase();
  const title = (tab.title || '').toLowerCase();
  const host = hostname(tab.url || '').toLowerCase();
  return title.includes(q) || host.includes(q);
}

function isUsable(t) {
  return t && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://');
}

/* ── Hero ── */
function setHero() {
  const active = Object.values(configs).filter(c => c.active).length;
  if (active > 0) {
    heroDot.classList.add('on');
    heroText.className = 'hero-text on';
    heroText.textContent = `${active} pestaña${active !== 1 ? 's' : ''} con refresco`;
  } else {
    heroDot.classList.remove('on');
    heroText.className = 'hero-text';
    heroText.textContent = 'Inactivo';
  }
}

/* ── Select de intervalos ── */
function selectOptions(interval) {
  let opts = PRESETS.map(p => `<option value="${p.val}" ${interval === p.val ? 'selected' : ''}>${p.label}</option>`).join('');
  if (!PRESETS.some(p => p.val === interval)) {
    opts += `<option value="${interval}" selected>${interval}s</option>`;
  }
  return opts;
}

/* ── Sección pestaña actual ── */
function renderCurrent() {
  if (!currentTab) {
    currentSection.innerHTML = '';
    return;
  }
  const c = configs[currentTab.id];
  const active = !!(c && c.active);
  const interval = (c && c.interval) || 90;
  const fav = currentTab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="%23555"/></svg>';
  const fresh = active ? freshnessTag(c.lastRefresh, currentTab.id) : null;

  currentSection.innerHTML = `
    <div class="current-label">Pestaña actual</div>
    <div class="current-tab ${active ? 'active-tab' : ''}" id="currentCard">
      <img src="${fav}" alt="">
      <div class="current-info">
        <div class="current-title">${escapeHtml(currentTab.title || '(sin título)')}</div>
        <div class="current-url">${escapeHtml(currentTab.url || '')}</div>
        ${fresh ? `<span class="current-fresh ${fresh.cls}" id="curFresh">${fresh.label}</span>` : ''}
      </div>
      <div class="current-actions">
        <select class="select ${active ? 'refreshing' : ''}" id="curInterval" title="Intervalo de refresco">${selectOptions(interval)}</select>
        <label class="switch">
          <input type="checkbox" id="curToggle" ${active ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
        <button class="refresh-now" id="curRefreshNow" title="Recargar ahora">⟳</button>
      </div>
    </div>
  `;

  document.getElementById('curToggle').addEventListener('change', (e) => {
    setActive(currentTab.id, e.target.checked);
  });
  document.getElementById('curInterval').addEventListener('change', (e) => {
    applyInterval(currentTab.id, parseInt(e.target.value), true);
  });
  document.getElementById('curRefreshNow').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'refresh-now', tabId: currentTab.id });
  });
}

/* ── Frescura de la pestaña actual ──
   El popup siempre se abre sobre la pestaña enfocada, así que el estado
   "en pausa" es lo normal aquí: se muestra junto al tiempo real, nunca
   en sustitución (si no, el contador sería invisible siempre). */
function fmtAgo(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

function freshnessTag(lastRefresh, tabId) {
  if (!lastRefresh) return null;
  const sec = Math.floor((Date.now() - lastRefresh) / 1000);
  if (tabId === focusedTabId) {
    return { label: `En pausa · recargada hace ${fmtAgo(sec)}`, cls: 'fresh-paused' };
  }
  return {
    label: `Recargada hace ${fmtAgo(sec)}`,
    cls: sec < 60 ? 'fresh-0' : (sec < 300 ? 'fresh-1' : 'fresh-2'),
  };
}

function updateCurrentFreshness() {
  const el = document.getElementById('curFresh');
  const card = document.getElementById('currentCard');
  if (!el || !currentTab) return;
  const c = configs[currentTab.id];
  if (!c || !c.active) {
    el.remove();
    card.classList.remove('active-tab');
    return;
  }
  const fresh = freshnessTag(c.lastRefresh, currentTab.id);
  if (fresh) {
    el.textContent = fresh.label;
    el.className = `current-fresh ${fresh.cls}`;
  }
}

/* ── Estado del switch de dominio ──
   Las pestañas sin config cuentan como apagadas: si no, un grupo con una
   sola pestaña activa mostraría el switch encendido y el clic apagaría
   todo el grupo (comportamiento sorpresa). */
function getDomainSwitchState(domainTabs) {
  const states = domainTabs.map(t => !!(configs[t.id] && configs[t.id].active));
  const allOn = states.every(Boolean);
  const allOff = states.every(v => !v);
  return allOn ? 'allOn' : (allOff ? 'allOff' : 'mixed');
}

/* ── Handler switch de dominio ── */
async function onDomainSwitchClick(domain, domainTabs) {
  const state = getDomainSwitchState(domainTabs);
  const turnOn = state !== 'allOn';
  for (const tab of domainTabs) {
    const prev = configs[tab.id] || {};
    const interval = prev.interval || 90;
    await chrome.runtime.sendMessage({
      action: 'upsert',
      tabId: tab.id,
      config: { url: tab.url, title: tab.title, interval, active: turnOn }
    });
  }
  await reloadState();
}

/* ── Lista del resto de pestañas ── */
function renderTabs() {
  const others = allTabs.filter(t => t.id !== (currentTab && currentTab.id));
  const filtered = others.filter(matchFilter);
  otherCount.textContent = filtered.length;

  if (filtered.length === 0) {
    tabsList.innerHTML = `<div class="empty">No hay pestañas${filterText ? ' que coincidan' : ''}</div>`;
    return;
  }

  const groups = {};
  for (const tab of filtered) {
    const h = hostname(tab.url) || '(sin dominio)';
    if (!groups[h]) groups[h] = [];
    groups[h].push(tab);
  }
  const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  tabsList.innerHTML = '';
  for (const [domain, domainTabs] of sorted) {
    const group = document.createElement('div');
    group.className = 'domain-group';

    const state = getDomainSwitchState(domainTabs);
    const header = document.createElement('div');
    header.className = 'domain-header';
    header.innerHTML = `
      <span class="domain-chevron">▼</span>
      <span class="domain-name">${escapeHtml(domain)}</span>
      <span class="domain-count">${domainTabs.length}</span>
      <label class="switch domain-switch ${state === 'mixed' ? 'mixed' : ''}" title="Activar/desactivar todo el grupo">
        <input type="checkbox" ${state === 'allOn' ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
    `;
    header.addEventListener('click', (e) => {
      if (e.target.closest('.domain-switch')) return;
      group.classList.toggle('collapsed');
    });

    const switchEl = header.querySelector('.domain-switch input');
    switchEl.addEventListener('change', () => onDomainSwitchClick(domain, domainTabs));

    const items = document.createElement('div');
    items.className = 'domain-items';
    for (const tab of domainTabs) items.appendChild(buildTabRow(tab));

    group.appendChild(header);
    group.appendChild(items);
    tabsList.appendChild(group);
  }
}

function buildTabRow(tab) {
  const c = configs[tab.id];
  const active = !!(c && c.active);
  const interval = (c && c.interval) || 90;
  const fav = tab.favIconUrl || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="%23555"/></svg>';

  const row = document.createElement('div');
  row.className = 'tab-item';
  row.innerHTML = `
    <label class="switch">
      <input type="checkbox" ${active ? 'checked' : ''}>
      <span class="slider"></span>
    </label>
    <img src="${fav}" alt="">
    <div class="tab-info">
      <div class="tab-title">${escapeHtml(tab.title || '(sin título)')}</div>
    </div>
    <select class="select ${active ? 'refreshing' : ''}" title="Intervalo de refresco">${selectOptions(interval)}</select>
  `;

  const checkbox = row.querySelector('.switch input');
  const select = row.querySelector('.select');

  checkbox.addEventListener('change', () => setActive(tab.id, checkbox.checked));
  select.addEventListener('change', () => applyInterval(tab.id, parseInt(select.value), true));

  return row;
}

/* ── Acciones ── */
async function setActive(tabId, active) {
  const tab = allTabs.find(t => t.id === tabId) || currentTab;
  if (!tab) return;
  const prev = configs[tabId] || {};
  const cfg = { url: tab.url, title: tab.title, interval: prev.interval || 90, active };
  await chrome.runtime.sendMessage({ action: 'upsert', tabId, config: cfg });
  await reloadState();
}

async function applyInterval(tabId, interval, activate) {
  const tab = allTabs.find(t => t.id === tabId) || currentTab;
  if (!tab) return;
  const prev = configs[tabId] || {};
  const active = activate !== undefined ? activate : !!(prev.active);
  const cfg = { url: tab.url, title: tab.title, interval, active };
  await chrome.runtime.sendMessage({ action: 'upsert', tabId, config: cfg });
  await reloadState();
}

/* ── State ── */
function renderAll() {
  renderCurrent();
  renderTabs();
  setHero();
}

async function reloadState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'get' }, (resp) => {
      configs = (resp && resp.configs) || {};
      renderAll();
      resolve();
    });
  });
}

/* Refresco reactivo: si el background cambia el estado (p.ej. un reload que
   acaba de ocurrir) mientras el popup está abierto, se refleja sin reabrirlo. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.configs) return;
  configs = changes.configs.newValue || {};
  renderAll();
});

async function loadTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = isUsable(active) ? active : null;
  focusedTabId = currentTab?.id || null;
  allTabs = tabs.filter(isUsable);
  await reloadState();
}

/* ── Events ── */
/* "Limpiar todo" borra todas las configuraciones activas de golpe: exige un
   segundo clic en 3s para confirmar, en vez de confirm() nativo (los diálogos
   nativos pueden cerrar el popup de forma inconsistente). */
let clearArmed = false;
let clearTimer = null;
btnClear.addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    btnClear.classList.add('armed');
    btnClear.textContent = '¿Seguro?';
    clearTimer = setTimeout(() => {
      clearArmed = false;
      btnClear.classList.remove('armed');
      btnClear.textContent = 'Limpiar todo';
    }, 3000);
    return;
  }
  clearTimeout(clearTimer);
  clearArmed = false;
  btnClear.classList.remove('armed');
  btnClear.textContent = 'Limpiar todo';
  await chrome.runtime.sendMessage({ action: 'clear-all' });
  await reloadState();
});

searchInput.addEventListener('input', () => {
  filterText = searchInput.value.trim();
  renderTabs();
});

/* Actualizar "recargada hace Xs" en tiempo real */
setInterval(updateCurrentFreshness, 1000);

loadTabs();