// ==UserScript==
// @name         银河奶牛 · 攒钱计划
// @namespace    mwi.savings
// @version      0.7.5
// @author       im630
// @license      MIT
// @description  通过添加心愿装备/资源，自动评估购买心愿物品的攒钱进展。同时支持添加置换物品，能够更方便生活佬攒钱转战斗或者战斗佬攒钱更新装备。
// @homepage     https://github.com/im630/mwi-savings
// @downloadURL  https://raw.githubusercontent.com/im630/mwi-savings/main/mwi-savings.user.js
// @updateURL    https://raw.githubusercontent.com/im630/mwi-savings/main/mwi-savings.user.js
// @match        https://www.milkywayidle.com/*
// @match        https://test.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://test.milkywayidlecn.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const pageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  function getPageLS() {
    try { return pageWin.localStorage; } catch (e) {
      try { return window.localStorage; } catch (e2) { return null; }
    }
  }

  function readStore(key, def) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key, undefined);
        if (v !== undefined && v !== null) {
          if (typeof v === 'string') {
            try { return JSON.parse(v); } catch (e) { return v; }
          }
          return v;
        }
      }
    } catch (e) { /* fall through */ }
    try {
      const ls = getPageLS();
      if (!ls) return def;
      const raw = ls.getItem(key);
      return raw ? JSON.parse(raw) : def;
    } catch (e) { return def; }
  }

  function writeStore(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      const ls = getPageLS();
      if (ls) ls.setItem(key, JSON.stringify(value));
    } catch (e) { /* ignore */ }
  }

  function pageFetch(url, opts) {
    const f = pageWin.fetch ? pageWin.fetch.bind(pageWin) : (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('无 fetch');
    return f(url, opts);
  }

  function gmJson(url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          timeout: 15000,
          onload: function (res) {
            try {
              if (res.status >= 200 && res.status < 300) resolve(JSON.parse(res.responseText));
              else reject(new Error('HTTP ' + res.status));
            } catch (e) { reject(e); }
          },
          onerror: function () { reject(new Error('网络错误')); },
          ontimeout: function () { reject(new Error('超时')); }
        });
        return;
      }
      pageFetch(url, { cache: 'force-cache' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(resolve, reject);
    });
  }

  /* ------------------------------------------------------------------
   * LZ-String 1.4.4 的 decompressFromUTF16 可读实现（MIT）
   * 仅保留解压 localStorage.initClientData 所需的部分
   * ------------------------------------------------------------------ */
  function decompressFromUTF16(compressed) {
    if (compressed == null) return '';
    if (compressed === '') return null;

    var dictionary = [];
    var enlargeIn = 4;
    var dictSize = 4;
    var numBits = 3;
    var entry = '';
    var result = [];
    var i;
    var w;
    var c;
    var data = { val: compressed.charCodeAt(0) - 32, position: 16384, index: 1 };

    function readBits(count) {
      var bits = 0;
      var maxpower = Math.pow(2, count);
      var power = 1;
      while (power !== maxpower) {
        var resb = data.val & data.position;
        data.position >>= 1;
        if (data.position === 0) {
          data.position = 16384;
          data.val = compressed.charCodeAt(data.index++) - 32;
        }
        bits |= (resb > 0 ? 1 : 0) * power;
        power <<= 1;
      }
      return bits;
    }

    for (i = 0; i < 3; i += 1) dictionary[i] = i;

    switch (readBits(2)) {
      case 0:
        c = String.fromCharCode(readBits(8));
        break;
      case 1:
        c = String.fromCharCode(readBits(16));
        break;
      case 2:
        return '';
    }

    dictionary[3] = c;
    w = c;
    result.push(c);

    while (true) {
      if (data.index > compressed.length) return '';

      switch (c = readBits(numBits)) {
        case 0:
          dictionary[dictSize++] = String.fromCharCode(readBits(8));
          c = dictSize - 1;
          enlargeIn--;
          break;
        case 1:
          dictionary[dictSize++] = String.fromCharCode(readBits(16));
          c = dictSize - 1;
          enlargeIn--;
          break;
        case 2:
          return result.join('');
      }

      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }

      if (dictionary[c]) {
        entry = dictionary[c];
      } else if (c === dictSize) {
        entry = w + w.charAt(0);
      } else {
        return null;
      }

      result.push(entry);
      dictionary[dictSize++] = w + entry.charAt(0);
      enlargeIn--;
      w = entry;

      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  const KEY = 'mwi.savings.v1';
  const MARKET_KEY = 'mwi.savings.market.v1';
  const CATALOG_KEY = 'mwi.savings.catalog.v3';
  const MARKET_URL = '/game_data/marketplace.json';
  const MARKET_TTL = 10 * 60 * 1000;
  const SWAP_TAX = 0.04;
  const NAMES_KEY = 'mwi.savings.names.v1';
  const NAMES_URLS = [
    'https://cdn.jsdelivr.net/npm/@c3d.gg/mwi-types@1.5.1/dist/domains/items/items.json',
    'https://unpkg.com/@c3d.gg/mwi-types@1.5.1/dist/domains/items/items.json'
  ];
  const NAMES_TTL = 30 * 24 * 60 * 60 * 1000;
  const INV_LOC = '/item_locations/inventory';
  const EQUIP_LOC = '/item_locations/equipment';
  const MARKET_LOC = '/item_locations/market';
  const LOCATIONS = ['库存', '技能', '装备', '房屋', 'Inventory', 'Skills', 'Equipment', 'House'];

  const NAME_OVERRIDES = {
    '/items/pathbreaker_boots': '开路者靴',
    '/items/pathfinder_boots': '探路者靴',
    '/items/pathseeker_boots': '寻路者靴',
    '/items/pathbreaker_lodestone': '开路者磁石',
    '/items/pathfinder_lodestone': '探路者磁石',
    '/items/pathseeker_lodestone': '寻路者磁石',
    '/items/artificer_cape': '工匠披风',
    '/items/chance_cape': '机遇披风',
    '/items/culinary_cape': '烹饪披风',
    '/items/gatherer_cape': '采集披风',
    '/items/seal_of_action_speed': '行动速度封印',
    '/items/seal_of_attack_speed': '攻击速度封印',
    '/items/seal_of_cast_speed': '施法速度封印',
    '/items/seal_of_combat_drop': '战斗掉落封印',
    '/items/seal_of_critical_rate': '暴击率封印',
    '/items/seal_of_damage': '伤害封印',
    '/items/seal_of_efficiency': '效率封印',
    '/items/seal_of_gathering': '采集封印',
    '/items/seal_of_gourmet': '美食封印',
    '/items/seal_of_processing': '加工封印',
    '/items/seal_of_rare_find': '稀有发现封印',
    '/items/seal_of_wisdom': '智慧封印',
    '/items/labyrinth_essence': '迷宫精华',
    '/items/labyrinth_token': '迷宫代币',
    '/items/labyrinth_refinement_shard': '迷宫精炼碎片',
    '/items/labyrinth_refinement_chest': '迷宫精炼宝箱',
    '/items/purdoras_box_combat': '紫多拉之盒（战斗）',
    '/items/purdoras_box_skilling': '紫多拉之盒（生活）',
    '/items/basic_torch': '基础火把',
    '/items/advanced_torch': '高级火把',
    '/items/expert_torch': '专家火把',
    '/items/basic_shroud': '基础斗篷',
    '/items/advanced_shroud': '高级斗篷',
    '/items/expert_shroud': '专家斗篷',
    '/items/basic_beacon': '基础信标',
    '/items/advanced_beacon': '高级信标',
    '/items/expert_beacon': '专家信标',
    '/items/basic_food_crate': '基础食物箱',
    '/items/advanced_food_crate': '高级食物箱',
    '/items/expert_food_crate': '专家食物箱',
    '/items/basic_tea_crate': '基础茶箱',
    '/items/advanced_tea_crate': '高级茶箱',
    '/items/expert_tea_crate': '专家茶箱',
    '/items/basic_coffee_crate': '基础咖啡箱',
    '/items/advanced_coffee_crate': '高级咖啡箱',
    '/items/expert_coffee_crate': '专家咖啡箱'
  };

  const DEFAULT_STATE = function () {
    return {
      version: 1,
      wishes: [],
      swaps: [],
      settings: { wishBasis: 'a', swapBasis: 'b', dailyProfitM: 0 },
      ui: { sheet: 'wish' }
    };
  };

  let state = loadState();
  let saveTimer = null;
  let renderTimer = null;
  let spriteBaseCache = null;
  let styleInjected = false;

  const rt = {
    startedAt: Date.now(),
    catalog: null,
    catalogSource: '',
    names: null,
    namesLoading: false,
    namesError: '',
    inventory: [],
    inventoryRaw: null,
    inventoryLoading: false,
    notice: '',
    gold: 0,
    inventoryAt: 0,
    market: null,
    marketAt: 0,
    loadingMarket: false,
    lastError: '',
    modal: null,
    tab: null,
    tablist: null,
    panelId: null,
    tabStyle: null,
    characterID: null,
    host: null,
    overlay: null,
    fab: null,
    fixed: false,
    boundLists: new WeakSet(),
    draft: {
      wish: { q: '', hrid: null, enh: 0, qty: 1 },
      swap: { q: '', hrid: null, enh: 0, qty: 1, all: false, loc: INV_LOC }
    }
  };

  /* ---------------------------- 工具 ---------------------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function uid() {
    const c = pageWin.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    if (c && c.randomUUID) return c.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function clampInt(v, min, max) {
    v = Math.floor(Number(v) || 0);
    if (v < min) v = min;
    if (v > max) v = max;
    return v;
  }

  function fmt(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    n = Number(n);
    const abs = Math.abs(n);
    if (abs >= 1e12) return trim((n / 1e12).toFixed(2)) + 'T';
    if (abs >= 1e9) return trim((n / 1e9).toFixed(2)) + 'B';
    if (abs >= 1e6) return trim((n / 1e6).toFixed(2)) + 'M';
    if (abs >= 1e3) return trim((n / 1e3).toFixed(1)) + 'K';
    return String(Math.round(n));
  }

  function trim(s) {
    return String(s).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  }

  function fmtQty(n) {
    n = Number(n) || 0;
    const abs = Math.abs(n);
    if (abs >= 1e12) return trim((n / 1e12).toFixed(2)) + 'T';
    if (abs >= 1e9) return trim((n / 1e9).toFixed(2)) + 'B';
    if (abs >= 1e6) return trim((n / 1e6).toFixed(2)) + 'M';
    if (abs >= 1e3) return trim((n / 1e3).toFixed(2)) + 'K';
    return String(Math.round(n));
  }

  function pct(x) {
    x = Math.max(0, Math.min(1, Number(x) || 0));
    return (x * 100).toFixed(1) + '%';
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function nameOverride(hrid) {
    if (NAME_OVERRIDES[hrid]) return NAME_OVERRIDES[hrid];
    if (hrid.length > 8 && hrid.slice(-8) === '_refined') {
      const base = NAME_OVERRIDES[hrid.slice(0, -8)];
      if (base) return base + ' ★';
    }
    return '';
  }

  function zhName(hrid) {
    const ov = nameOverride(hrid);
    if (ov) return ov;
    const it = rt.catalog && rt.catalog[hrid];
    return (rt.names && rt.names[hrid]) || (it && it.nameZh) || '';
  }

  function displayName(hrid, enh) {
    const it = rt.catalog && rt.catalog[hrid];
    const zh = zhName(hrid);
    const base = zh || (it && it.name) || hrid.replace('/items/', '');
    return enh > 0 ? base + '+' + enh : base;
  }

  function spriteBase() {
    if (spriteBaseCache) return spriteBaseCache;
    const nodes = document.querySelectorAll('use');
    for (let i = 0; i < nodes.length; i++) {
      const href = nodes[i].getAttribute('href') || nodes[i].getAttribute('xlink:href') || '';
      if (href.indexOf('items_sprite') !== -1) {
        spriteBaseCache = href.split('#')[0];
        return spriteBaseCache;
      }
    }
    return null;
  }

  function icon(hrid) {
    const base = spriteBase();
    if (!base) return '<span class="mwi-icon-ph">?</span>';
    return '<svg class="mwi-icon" aria-hidden="true"><use href="' + esc(base) + '#' + esc(hrid.replace('/items/', '')) + '"></use></svg>';
  }

  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 50);
  }

  /* ---------------------------- 状态 ---------------------------- */

  function loadState() {
    try {
      const s = readStore(KEY, null);
      if (!s) return DEFAULT_STATE();
      const d = DEFAULT_STATE();
      const settings = Object.assign({}, d.settings, s.settings || {});
      if (settings.wishBasis !== 'a' && settings.wishBasis !== 'b') settings.wishBasis = 'a';
      if (settings.swapBasis !== 'a' && settings.swapBasis !== 'b') settings.swapBasis = 'b';
      function norm(arr, opts) {
        if (!Array.isArray(arr)) return [];
        const keepAll = !!(opts && opts.keepAll);
        return arr.filter(function (x) { return x && x.hrid; }).map(function (x) {
          const all = keepAll ? !!x.all : false;
          const loc = keepAll ? (isSwapLoc(x.loc) ? x.loc : INV_LOC) : undefined;
          let qty = Math.floor(Number(x.qty));
          if (!isFinite(qty)) qty = all ? 0 : 1;
          if (qty < 0) qty = 0;
          if (!all && qty < 1) qty = 1;
          return {
            id: x.id || uid(),
            hrid: x.hrid,
            enh: Number(x.enh) || 0,
            qty: qty,
            all: keepAll ? all : undefined,
            loc: loc
          };
        });
      }
      return {
        version: 1,
        wishes: norm(s.wishes),
        swaps: norm(s.swaps, { keepAll: true }),
        settings: settings,
        ui: Object.assign({}, d.ui, s.ui || {})
      };
    } catch (e) {
      return DEFAULT_STATE();
    }
  }

  function saveState() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        writeStore(KEY, state);
      } catch (e) {
        console.warn('[攒钱] 保存失败', e);
      }
    }, 300);
  }

  /* ---------------------------- 物品目录 ---------------------------- */

  function readCatalogCache() {
    try {
      const c = readStore(CATALOG_KEY, null);
      return c && c.data ? c.data : null;
    } catch (e) { return null; }
  }

  function buildCatalog(itemDetailMap) {
    const out = {};
    for (const hrid in itemDetailMap) {
      if (hrid.indexOf('/items/') !== 0) continue;
      const it = itemDetailMap[hrid];
      if (!it) continue;
      const maxEnh = it.equipmentDetail ? 20 : 0;
      out[hrid] = {
        name: it.name || hrid,
        nameZh: it.nameZh || '',
        tradable: !!it.isTradable,
        maxEnh: maxEnh,
        category: it.categoryHrid || '',
        icon: hrid.replace('/items/', '')
      };
    }
    try {
      writeStore(CATALOG_KEY, { ts: Date.now(), data: out });
    } catch (e) { /* 容量不足就算了 */ }
    return out;
  }

  function readClientData() {
    const ls = getPageLS();
    if (!ls) return null;
    const raw = ls.getItem('initClientData');
    if (!raw) return null;
    let obj = null;
    try {
      const json = decompressFromUTF16(raw);
      if (json) obj = JSON.parse(json);
    } catch (e) { /* 可能不是压缩数据，走下面的明文兜底 */ }
    if (!obj) {
      try { obj = JSON.parse(raw); } catch (e) { /* ignore */ }
    }
    if (obj && obj.itemDetailMap) return obj.itemDetailMap;
    console.warn('[攒钱] initClientData 无法解析');
    return null;
  }

  function initCatalog() {
    const cached = readCatalogCache();
    if (cached) { rt.catalog = cached; rt.catalogSource = 'cache'; }
    const map = readClientData();
    if (map) {
      rt.catalog = buildCatalog(map);
      rt.catalogSource = 'localStorage';
    } else if (!rt.catalog) {
      rt.catalogSource = 'none';
    }
    if (needsNames()) loadNames(false);
    scheduleRender();
  }

  function readNamesCache() {
    try {
      const c = readStore(NAMES_KEY, null);
      return c && c.data ? c : null;
    } catch (e) { return null; }
  }

  function needsNames() {
    if (!rt.catalog) return false;
    const keys = Object.keys(rt.catalog);
    for (let i = 0; i < keys.length; i++) {
      const it = rt.catalog[keys[i]];
      if (it && it.tradable && !it.nameZh) return true;
    }
    return false;
  }

  async function loadNames(force) {
    if (rt.namesLoading) return;
    const cached = readNamesCache();
    if (cached && cached.data) {
      rt.names = cached.data;
      scheduleRender();
      if (!force && Date.now() - cached.ts < NAMES_TTL) return;
    } else if (rt.names && !force) {
      return;
    }

    rt.namesLoading = true;
    rt.namesError = '';
    scheduleRender();
    let lastErr = null;
    for (let u = 0; u < NAMES_URLS.length; u++) {
      try {
        const arr = await gmJson(NAMES_URLS[u]);
        const map = {};
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          if (it && it.hrid && it.nameZh) map[it.hrid] = it.nameZh;
        }
        if (Object.keys(map).length) {
          rt.names = map;
          try { writeStore(NAMES_KEY, { ts: Date.now(), data: map }); } catch (e) { /* 容量 */ }
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      rt.namesError = lastErr && lastErr.message ? lastErr.message : String(lastErr);
      console.warn('[攒钱] 中文名加载失败', lastErr);
    }
    rt.namesLoading = false;
    scheduleRender();
  }

  function isLabyrinth(hrid, category) {
    if (category === '/item_categories/labyrinth') return true;
    return /^\/items\/(labyrinth_|seal_of_|purdoras_box_|(artificer|chance|culinary|gatherer)_cape|path(breaker|finder|seeker)_(boots|lodestone)|(basic|advanced|expert)_(torch|shroud|beacon|food_crate|tea_crate|coffee_crate))/.test(hrid);
  }

  function searchCatalog(q, limit) {
    limit = limit || 40;
    if (!rt.catalog) return [];
    const s = String(q || '').trim().toLowerCase();
    const rows = [];
    for (const hrid in rt.catalog) {
      const it = rt.catalog[hrid];
      if (hrid === '/items/coin') continue;
      const lab = isLabyrinth(hrid, it.category);
      const zh = zhName(hrid);
      const en = it.name || '';
      const extra = [];
      if (/_cape(_refined)?$/.test(hrid)) extra.push('披风', '斗篷');
      if (/lodestone$/.test(hrid)) extra.push('磁石', '路标');
      const hay = (zh + ' ' + en + ' ' + hrid + (lab ? ' 迷宫 迷宮 labyrinth' : '') + ' ' + extra.join(' ')).toLowerCase();
      if (s && hay.indexOf(s) === -1) continue;
      if (!it.tradable && !(lab && s)) continue;
      rows.push({
        hrid: hrid,
        name: en,
        nameZh: zh,
        maxEnh: it.maxEnh,
        tradable: it.tradable,
        lab: lab
      });
    }
    rows.sort(function (a, b) {
      return (a.nameZh || a.name).localeCompare(b.nameZh || b.name, 'zh');
    });
    return rows.slice(0, limit);
  }

  /* ---------------------------- 库存 ---------------------------- */

  function asArray(raw) {
    if (!raw) return null;
    if (Array.isArray(raw)) return raw;
    if (typeof raw.values === 'function') return Array.from(raw.values());
    if (typeof raw === 'object') return Object.values(raw);
    return null;
  }

  function asLiveNumber(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (isFinite(n)) return n;
    }
    if (v && typeof v === 'object') {
      const n = v.amount != null ? v.amount : v.value;
      if (typeof n === 'number' && isFinite(n)) return n;
    }
    return null;
  }

  function isItemStack(it) {
    if (!it || typeof it !== 'object') return false;
    const hrid = it.itemHrid || it.hrid;
    if (!hrid || hrid.indexOf('/items/') !== 0) return false;
    const q = Number(it.count != null ? it.count : it.quantity);
    return isFinite(q) && q > 0;
  }

  function stackLoc(it, key) {
    const raw = it.itemLocationHrid || it.locationHrid || it.itemLocation || it.location;
    if (raw) return raw;
    if (/listing|market/i.test(key) && !/order/i.test(key)) return MARKET_LOC;
    if (/equipment|equip|tool|head|body|legs|feet|hands|neck|ring|earrings|back|trinket|pouch|charm/i.test(key)) return EQUIP_LOC;
    if (/characterItems|inventory/i.test(key)) return INV_LOC;
    return null;
  }

  function pushStateItem(out, seen, it, key) {
    if (!isItemStack(it)) return;
    const loc = stackLoc(it, key);
    if (!loc) return;
    const hrid = it.itemHrid || it.hrid;
    const uid = it.id || it.hash;
    const dedupe = uid || (hrid + '|' + (it.enhancementLevel || 0) + '|' + loc + '|' +
      (it.count != null ? it.count : it.quantity));
    if (seen[dedupe]) return;
    seen[dedupe] = true;
    if (it.itemLocationHrid || it.locationHrid || it.itemLocation || it.location) {
      out.push(it);
    } else {
      const copy = Object.assign({}, it);
      copy.itemLocationHrid = loc;
      out.push(copy);
    }
  }

  function readMyMarketListings(st) {
    const raw = st.myMarketListingMap;
    if (!raw) return [];
    const out = [];
    const seen = {};

    function firstNumber() {
      for (let i = 0; i < arguments.length; i++) {
        const n = Number(arguments[i]);
        if (isFinite(n)) return n;
      }
      return null;
    }

    function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth < 0) return;
      if (Array.isArray(obj) || typeof obj.values === 'function') {
        const vals = asArray(obj) || [];
        for (let i = 0; i < vals.length; i++) walk(vals[i], depth - 1);
        return;
      }
      const hrid = obj.itemHrid || (obj.item && (obj.item.itemHrid || obj.item.hrid)) || obj.hrid;
      if (hrid && hrid.indexOf('/items/') === 0) {
        if (obj.isBuy === true) return;
        let qty = firstNumber(obj.quantity, obj.count, obj.amount, obj.remainingQuantity, obj.remaining, obj.qty);
        const filled = firstNumber(obj.filledQuantity, obj.quantityFilled, obj.filled);
        if (qty == null) qty = 1;
        if (filled != null && filled > 0 && qty > filled) qty -= filled;
        if (!(qty > 0)) return;
        const enh = Number(obj.enhancementLevel || obj.enhancement || 0) || 0;
        const id = obj.id || obj.hash || (hrid + '|' + enh + '|' + qty + '|' + (obj.price || ''));
        if (seen[id]) return;
        seen[id] = true;
        out.push({
          id: id,
          itemHrid: hrid,
          count: qty,
          enhancementLevel: enh,
          itemLocationHrid: MARKET_LOC
        });
        return;
      }
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        if (/order/i.test(keys[i])) continue;
        walk(obj[keys[i]], depth - 1);
      }
    }

    walk(raw, 3);
    return out;
  }

  function readStateItems(st) {
    const out = [];
    const seen = {};
    const seenObjs = new WeakSet();
    const skipKey = /Detail|Dict|Table|Translations|Requirement|Experience|Category|Type|Config|gameConn|disconnect|captcha|reconnect|isLoading|versionTimestamp/i;
    const keys = Object.keys(st);

    function collectNested(obj, key, depth) {
      if (!obj || typeof obj !== 'object' || depth < 0 || seenObjs.has(obj)) return;
      seenObjs.add(obj);
      if (isItemStack(obj)) {
        pushStateItem(out, seen, obj, key);
        return;
      }
      if (Array.isArray(obj) || typeof obj.values === 'function') {
        const vals = asArray(obj) || [];
        for (let i = 0; i < vals.length; i++) collectNested(vals[i], key, depth - 1);
        return;
      }
      const subKeys = Object.keys(obj);
      for (let i = 0; i < subKeys.length; i++) {
        const sub = subKeys[i];
        if (skipKey.test(sub)) continue;
        if (/order/i.test(key + '.' + sub)) continue;
        collectNested(obj[sub], key + '.' + sub, depth - 1);
      }
    }

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (skipKey.test(key)) continue;
      const raw = st[key];
      if (!raw || typeof raw !== 'object') continue;
      let arr = null;
      if (Array.isArray(raw) || typeof raw.values === 'function') arr = asArray(raw);
      else arr = Object.values(raw);
      if (arr) {
        for (let j = 0; j < arr.length; j++) pushStateItem(out, seen, arr[j], key);
      }
    }
    collectNested(st, '', 3);
    const listings = readMyMarketListings(st);
    for (let i = 0; i < listings.length; i++) {
      pushStateItem(out, seen, listings[i], 'myMarketListingMap');
    }
    return out;
  }

  function readLiveItems() {
    const states = [
      pageWin.mwi && pageWin.mwi.game && pageWin.mwi.game.state,
      pageWin.game && pageWin.game.state,
      pageWin.__game && pageWin.__game.state
    ];
    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      if (!st) continue;
      const items = readStateItems(st);
      if (items.length) return items;
    }
    return null;
  }

  function findGoldDeep(root) {
    const seen = new WeakSet();
    function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth < 0 || seen.has(obj)) return null;
      seen.add(obj);
      if (typeof obj.values === 'function') {
        const vals = Array.from(obj.values());
        for (let i = 0; i < vals.length; i++) {
          const v = vals[i];
          if (v && typeof v === 'object') {
            const n = walk(v, depth - 1);
            if (n != null) return n;
          }
        }
        return null;
      }
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        if (/^(coins?|characterCoins|money|currency|gold)$/i.test(keys[i])) {
          const n = asLiveNumber(obj[keys[i]]);
          if (n != null) return n;
        }
      }
      for (let i = 0; i < keys.length; i++) {
        const v = obj[keys[i]];
        if (v && typeof v === 'object') {
          const n = walk(v, depth - 1);
          if (n != null) return n;
        }
      }
      return null;
    }
    return walk(root, 3);
  }

  function collectCharacterObjects(st) {
    const out = [];
    function addRaw(raw, mapLike) {
      if (!raw || typeof raw !== 'object') return;
      if (typeof raw.values === 'function') {
        const vals = Array.from(raw.values());
        for (let i = 0; i < vals.length; i++) {
          if (vals[i] && typeof vals[i] === 'object') out.push(vals[i]);
        }
        return;
      }
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] && typeof raw[i] === 'object') out.push(raw[i]);
        }
        return;
      }
      if (mapLike) {
        const vals = Object.values(raw);
        for (let i = 0; i < vals.length; i++) {
          if (vals[i] && typeof vals[i] === 'object') out.push(vals[i]);
        }
        return;
      }
      out.push(raw);
    }
    addRaw(st.character, false);
    addRaw(st.characterData, false);
    addRaw(st.characterInfo, false);
    addRaw(st.characters, true);
    addRaw(st.characterMap, true);
    addRaw(st.characterById, true);
    return out;
  }

  function itemLoc(it) {
    return it.itemLocationHrid || it.locationHrid || it.itemLocation || it.location || INV_LOC;
  }

  function isEquipLoc(loc) {
    if (!loc) return false;
    if (loc === INV_LOC) return false;
    if (loc.indexOf('/item_locations/market') === 0) return false;
    if (loc.indexOf('/item_locations/house') === 0) return false;
    if (loc.indexOf('/item_locations/skills') === 0) return false;
    return loc.indexOf('/item_locations/') === 0;
  }

  function isSwapLoc(loc) {
    if (!loc) return false;
    return loc === INV_LOC || loc.indexOf('/item_locations/market') === 0 || isEquipLoc(loc);
  }

  function locLabel(loc) {
    if (!loc || loc === INV_LOC) return '库存';
    if (loc.indexOf('/item_locations/market') === 0) return '市场';
    if (isEquipLoc(loc)) return '装备';
    return '其他';
  }

  function locRank(loc) {
    if (!loc || loc === INV_LOC) return 0;
    if (isEquipLoc(loc)) return 1;
    if (loc.indexOf('/item_locations/market') === 0) return 2;
    return 3;
  }

  function addGoldCandidate(list, value, source, priority) {
    const n = asLiveNumber(value);
    if (n == null) return;
    for (let i = 0; i < list.length; i++) {
      if (list[i].source === source && list[i].value === n) return;
    }
    list.push({ value: n, source: source, priority: priority });
  }

  function readLiveGoldCandidates() {
    const list = [];
    const states = [
      pageWin.mwi && pageWin.mwi.game && pageWin.mwi.game.state,
      pageWin.game && pageWin.game.state,
      pageWin.__game && pageWin.__game.state
    ];
    const fields = ['characterItems', 'characterItemMap', 'characterItemsMap', 'items', 'inventory'];
    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      if (!st) continue;

      for (let j = 0; j < fields.length; j++) {
        const arr = asArray(st[fields[j]]);
        if (!arr) continue;
        let sum = 0;
        let found = false;
        for (let k = 0; k < arr.length; k++) {
          const it = arr[k];
          if (!it) continue;
          const hrid = it.itemHrid || it.hrid;
          if (hrid !== '/items/coin') continue;
          if (itemLoc(it) !== INV_LOC) continue;
          const q = Number(it.count != null ? it.count : it.quantity);
          if (!isFinite(q)) continue;
          sum += q;
          found = true;
        }
        if (found) addGoldCandidate(list, sum, '库存金币', 2);
      }

      const chars = collectCharacterObjects(st);
      for (let j = 0; j < chars.length; j++) {
        const c = chars[j];
        addGoldCandidate(list, c.coins, '角色 coins', 0);
        addGoldCandidate(list, c.characterCoins, '角色 characterCoins', 0);
        const directCoins = asLiveNumber(c.coins) != null || asLiveNumber(c.characterCoins) != null;
        if (!directCoins) {
          const deep = findGoldDeep(c);
          if (deep != null) addGoldCandidate(list, deep, '角色嵌套金币', 4);
        }
      }

      for (let j = 0; j < chars.length; j++) {
        const c = chars[j];
        addGoldCandidate(list, c.gold, '角色 gold', 3);
        addGoldCandidate(list, c.money, '角色 money', 3);
        addGoldCandidate(list, c.coin, '角色 coin', 3);
      }

      addGoldCandidate(list, st.coins, '顶层 coins', 5);
      addGoldCandidate(list, st.characterCoins, '顶层 characterCoins', 5);
      addGoldCandidate(list, st.money, '顶层 money', 5);
      addGoldCandidate(list, st.currency, '顶层 currency', 5);
      addGoldCandidate(list, st.gold, '顶层 gold', 5);

      const deepState = findGoldDeep(st);
      if (deepState != null) addGoldCandidate(list, deepState, '状态嵌套金币', 6);
    }
    return list;
  }

  function chooseLiveGold(candidates, oldGold) {
    if (!candidates.length) return null;
    const byValue = {};
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!byValue[c.value] || c.priority < byValue[c.value].priority) {
        byValue[c.value] = c;
      }
    }
    const unique = Object.keys(byValue).map(function (k) { return byValue[k]; });
    unique.sort(function (a, b) { return a.priority - b.priority; });
    const topPriority = unique[0].priority;
    const top = unique.filter(function (c) { return c.priority === topPriority; });
    if (top.length === 1) return top[0];
    const changed = top.filter(function (c) { return c.value !== oldGold; });
    return changed.length ? changed[0] : top[0];
  }

  function readLiveGold() {
    const picked = chooseLiveGold(readLiveGoldCandidates(), rt.gold || 0);
    return picked ? picked.value : null;
  }

  function sumCoin(items) {
    let sum = 0;
    let found = false;
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i];
      if (!it) continue;
      const hrid = it.itemHrid || it.hrid;
      if (hrid !== '/items/coin') continue;
      if (itemLoc(it) !== INV_LOC) continue;
      const q = Number(it.count != null ? it.count : it.quantity);
      if (!isFinite(q)) continue;
      sum += q;
      found = true;
    }
    return found ? sum : null;
  }

  let noticeTimer = null;
  function showNotice(msg) {
    rt.notice = msg;
    scheduleRender();
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      rt.notice = '';
      scheduleRender();
    }, 3000);
  }

  function refreshInventory() {
    if (rt.inventoryLoading) return;
    rt.inventoryLoading = true;
    scheduleRender();
    setTimeout(function () {
      try {
        const live = readLiveItems();
        const items = live || rt.inventoryRaw;
        const candidates = readLiveGoldCandidates();
        const itemCoin = sumCoin(items);
        if (itemCoin != null) addGoldCandidate(candidates, itemCoin, '当前库存快照', 1);
        const oldGold = rt.gold || 0;
        const picked = chooseLiveGold(candidates, oldGold);
        const goldChanged = !!(picked && picked.value !== oldGold);
        const hasCoin = itemCoin != null;
        if (items && items.length) {
          setInventory(items);
          if (picked) {
            rt.gold = picked.value;
          } else if (!hasCoin) {
            rt.gold = oldGold;
          }
          const goldNote = picked ? (goldChanged ? '，金币已更新' : '') : (!hasCoin ? '，金币未读取到，保留原值' : '');
          showNotice((live ? '库存已刷新（实时）' : '库存已刷新（最近一次同步；若未变化请刷新页面）') + goldNote);
        } else if (picked) {
          rt.gold = picked.value;
          showNotice('金币已刷新（实时），但未读取到库存');
        } else {
          showNotice('未读取到库存，请刷新页面后重试');
        }
      } catch (e) {
        showNotice('刷新库存失败：' + (e && e.message ? e.message : e));
      } finally {
        rt.inventoryLoading = false;
        scheduleRender();
      }
    }, 0);
  }

  function onCharacterSwitch() {
    hideOwnTab();
    if (rt.tab && rt.tab.parentElement) rt.tab.parentElement.removeChild(rt.tab);
    rt.tab = null;
    rt.tablist = null;
    rt.panelId = null;
    rt.tabStyle = null;
    setTimeout(ensureUI, 100);
  }

  function syncAllSwaps() {
    if (!state.swaps || !state.swaps.length) return;
    const keyOf = function (s) { return s.hrid + '|' + s.enh + '|' + (s.loc || INV_LOC); };
    const allKeys = {};
    for (let i = 0; i < state.swaps.length; i++) {
      const s = state.swaps[i];
      if (s.all) allKeys[keyOf(s)] = true;
    }
    if (!Object.keys(allKeys).length) return;

    let changed = false;
    const filtered = state.swaps.filter(function (s) {
      return s.all || !allKeys[keyOf(s)];
    });
    if (filtered.length !== state.swaps.length) {
      state.swaps = filtered;
      changed = true;
    }

    const seen = {};
    for (let i = state.swaps.length - 1; i >= 0; i--) {
      const s = state.swaps[i];
      if (!s.all) continue;
      const key = keyOf(s);
      if (seen[key]) {
        state.swaps.splice(i, 1);
        changed = true;
        continue;
      }
      seen[key] = true;
      const qty = locQty(s.hrid, s.enh, s.loc || INV_LOC);
      if (s.qty !== qty) {
        s.qty = qty;
        changed = true;
      }
    }

    if (changed) saveState();
  }

  function setInventory(items) {
    rt.inventoryRaw = items;
    let cid = null;
    for (let i = 0; i < (items || []).length; i++) {
      if (items[i] && items[i].characterID != null) { cid = items[i].characterID; break; }
    }
    if (cid != null && rt.characterID != null && String(cid) !== String(rt.characterID)) {
      onCharacterSwitch();
    }
    if (cid != null) rt.characterID = cid;
    const list = [];
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i];
      const hrid = it.itemHrid || it.hrid;
      if (!hrid) continue;
      const qty = Number(it.count != null ? it.count : it.quantity);
      if (!(qty > 0)) continue;
      list.push({
        hrid: hrid,
        enh: Number(it.enhancementLevel || it.enhancement || 0) || 0,
        qty: qty,
        loc: itemLoc(it)
      });
    }
    rt.inventory = list;
    let gold = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].hrid === '/items/coin' && list[i].loc === INV_LOC) gold += list[i].qty;
    }
    rt.gold = gold;
    rt.inventoryAt = Date.now();
    syncAllSwaps();
    scheduleRender();
  }

  function locQty(hrid, enh, loc) {
    loc = loc || INV_LOC;
    let n = 0;
    for (let i = 0; i < rt.inventory.length; i++) {
      const it = rt.inventory[i];
      if (it.hrid === hrid && it.enh === enh && it.loc === loc) n += it.qty;
    }
    return n;
  }

  function invQty(hrid, enh) {
    return locQty(hrid, enh, INV_LOC);
  }

  function swapAssigned(hrid, enh, loc) {
    let n = 0;
    for (let i = 0; i < state.swaps.length; i++) {
      const s = state.swaps[i];
      if (hrid && s.hrid !== hrid) continue;
      if (enh != null && s.enh !== enh) continue;
      if (loc && (s.loc || INV_LOC) !== loc) continue;
      n += s.qty;
    }
    return n;
  }

  function swapEntries() {
    const map = new Map();
    for (let i = 0; i < rt.inventory.length; i++) {
      const it = rt.inventory[i];
      if (it.hrid === '/items/coin' || !isSwapLoc(it.loc)) continue;
      const k = it.hrid + '|' + it.enh + '|' + it.loc;
      let e = map.get(k);
      if (!e) {
        e = { hrid: it.hrid, enh: it.enh, loc: it.loc, qty: 0 };
        map.set(k, e);
      }
      e.qty += it.qty;
    }
    return Array.from(map.values());
  }

  /* ---------------------------- 市场 ---------------------------- */

  function readMarketCache() {
    try {
      const c = readStore(MARKET_KEY, null);
      return c && c.data ? c : null;
    } catch (e) { return null; }
  }

  async function loadMarket(force) {
    const cached = readMarketCache();
    if (!force && cached && Date.now() - cached.ts < MARKET_TTL) return cached.data;

    const res = await pageFetch(MARKET_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const raw = json.marketData || json.market;
    if (!raw) throw new Error('行情结构异常');

    const data = {};
    for (const hrid in raw) {
      const levels = raw[hrid];
      for (const lv in levels) {
        const q = levels[lv] || {};
        const a = q.a > 0 ? q.a : -1;
        const b = q.b > 0 ? q.b : -1;
        if (a === -1 && b === -1) continue;
        if (!data[hrid]) data[hrid] = {};
        data[hrid][lv] = { a: a, b: b };
      }
    }
    try {
      writeStore(MARKET_KEY, { ts: Date.now(), data: data });
    } catch (e) { /* 容量不足 */ }
    return data;
  }

  async function ensureMarket(force) {
    if (rt.loadingMarket) return;
    rt.loadingMarket = true;
    scheduleRender();
    try {
      rt.market = await loadMarket(!!force);
      const cached = readMarketCache();
      rt.marketAt = cached && cached.ts ? cached.ts : Date.now();
      rt.lastError = '';
    } catch (e) {
      rt.lastError = e && e.message ? e.message : String(e);
      const cached = readMarketCache();
      if (cached && !rt.market) {
        rt.market = cached.data;
        rt.marketAt = cached.ts;
      }
    } finally {
      rt.loadingMarket = false;
      scheduleRender();
    }
  }

  function pickPrice(market, hrid, enh, side) {
    const q = market && market[hrid] && market[hrid][String(enh)];
    if (!q) return { value: null, exact: false };
    if (q[side] > 0) return { value: q[side], exact: true };
    const other = side === 'a' ? 'b' : 'a';
    if (q[other] > 0) return { value: q[other], exact: false };
    return { value: null, exact: false };
  }

  function applyOrderBook(m) {
    if (!m || !m.itemHrid) return;
    if (!rt.market) rt.market = {};
    const hrid = m.itemHrid;
    const books = m.orderBooks || [];
    const list = Array.isArray(books) ? books.map(function (b, i) { return [String(i), b]; }) : Object.entries(books);
    for (let i = 0; i < list.length; i++) {
      const lv = list[i][0];
      const b = list[i][1] || {};
      const ask = b.asks && b.asks[0] && b.asks[0].price > 0 ? b.asks[0].price : -1;
      const bid = b.bids && b.bids[0] && b.bids[0].price > 0 ? b.bids[0].price : -1;
      if (ask === -1 && bid === -1) continue;
      if (!rt.market[hrid]) rt.market[hrid] = {};
      rt.market[hrid][lv] = { a: ask, b: bid };
    }
    rt.marketAt = Date.now();
    scheduleRender();
  }

  /* ---------------------------- 评估 ---------------------------- */

  function evaluate() {
    const gold = rt.gold || 0;
    const swapQty = new Map();
    for (let i = 0; i < state.swaps.length; i++) {
      const s = state.swaps[i];
      if ((s.loc || INV_LOC) !== INV_LOC) continue;
      const k = s.hrid + '|' + s.enh;
      swapQty.set(k, (swapQty.get(k) || 0) + s.qty);
    }

    let swapsValue = 0;
    for (let i = 0; i < state.swaps.length; i++) {
      const s = state.swaps[i];
      const p = pickPrice(rt.market, s.hrid, s.enh, state.settings.swapBasis);
      swapsValue += (p.value || 0) * s.qty * (1 - SWAP_TAX);
    }

    const initialPool = gold + swapsValue;
    let pool = initialPool;
    let totalCost = 0;
    let totalWishValue = 0;
    let fundedValue = 0;
    let unpriced = 0;

    const rows = state.wishes.map(function (w) {
      const key = w.hrid + '|' + w.enh;
      const ownedRaw = invQty(w.hrid, w.enh);
      const owned = Math.max(0, ownedRaw - (swapQty.get(key) || 0));
      const need = Math.max(0, w.qty - owned);
      const q = rt.market && rt.market[w.hrid] && rt.market[w.hrid][String(w.enh)];
      const ask = q && q.a > 0 ? q.a : null;
      const bid = q && q.b > 0 ? q.b : null;
      const pick = pickPrice(rt.market, w.hrid, w.enh, state.settings.wishBasis);

      if (pick.value == null) {
        unpriced++;
        return {
          id: w.id, hrid: w.hrid, enh: w.enh, qty: w.qty,
          owned: owned, need: need, ask: ask, bid: bid,
          unit: null, unitApprox: false, cost: 0, funded: 0,
          progress: w.qty > 0 ? Math.min(1, owned / w.qty) : 1,
          gap: null, unpriced: true
        };
      }

      const unit = pick.value;
      const cost = need * unit;
      const funded = Math.min(pool, cost);
      pool -= funded;
      totalCost += cost;
      totalWishValue += w.qty * unit;
      fundedValue += owned * unit + funded;

      return {
        id: w.id, hrid: w.hrid, enh: w.enh, qty: w.qty,
        owned: owned, need: need, ask: ask, bid: bid,
        unit: unit, unitApprox: !pick.exact, cost: cost, funded: funded,
        progress: w.qty > 0 ? Math.min(1, (owned + funded / unit) / w.qty) : 1,
        gap: cost - funded, unpriced: false
      };
    });

    const totalGap = Math.max(0, totalCost - initialPool);
    const overall = totalWishValue > 0 ? Math.min(1, fundedValue / totalWishValue) : 0;
    const daily = Number(state.settings.dailyProfitM) || 0;
    const days = daily > 0 ? Math.ceil(totalGap / (daily * 1e6)) : null;

    return {
      rows: rows, gold: gold, swapsValue: swapsValue, initialPool: initialPool,
      totalCost: totalCost, totalWishValue: totalWishValue, fundedValue: fundedValue,
      totalGap: totalGap, overall: overall, days: days, unpriced: unpriced
    };
  }

  /* ---------------------------- 渲染 ---------------------------- */

  function render() {
    if (!rt.overlay) return;
    try {
      const scroll = rt.overlay.scrollTop;
      const ev = evaluate();
      let body = '';
      if (state.ui.sheet === 'swap') body = swapSheet();
      else if (state.ui.sheet === 'eval') body = evalSheet(ev);
      else body = wishSheet(ev);

      rt.overlay.innerHTML =
        '<div class="mwi-wrap">' +
          '<div class="mwi-top">' +
            '<div class="mwi-left-actions">' +
              '<button class="mwi-btn" data-act="refresh"' + (rt.loadingMarket ? ' disabled' : '') + '>' +
                (rt.loadingMarket ? '刷新中…' : '刷新价格') + '</button>' +
              '<button class="mwi-btn" data-act="refresh-inventory"' + (rt.inventoryLoading ? ' disabled' : '') + '>' +
                (rt.inventoryLoading ? '刷新中…' : '刷新库存') + '</button>' +
            '</div>' +
            '<div class="mwi-title">攒钱</div>' +
            '<div class="mwi-actions">' +
              '<button class="mwi-btn danger" data-act="clear">清空</button>' +
            '</div>' +
          '</div>' +
          '<div class="mwi-subtabs">' +
            subtab('wish', '心愿') + subtab('swap', '置换') + subtab('eval', '评估') +
          '</div>' +
          (rt.notice ? '<div class="mwi-notice">' + esc(rt.notice) + '</div>' : '') +
          body +
        '</div>' +
        (rt.modal === 'clear' ? clearModal() : '');

      rt.overlay.scrollTop = scroll;
    } catch (e) {
      console.error('[攒钱] 渲染失败', e);
      rt.overlay.innerHTML = '<div class="mwi-wrap"><div class="mwi-warn">渲染出错：' +
        esc(e && e.message ? e.message : e) + '</div></div>';
    }
  }

  function subtab(id, label) {
    return '<button class="mwi-subtab' + (state.ui.sheet === id ? ' active' : '') +
      '" data-act="sheet" data-sheet="' + id + '">' + label + '</button>';
  }

  function card(k, v) {
    return '<div class="mwi-card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }

  function wishSheet(ev) {
    return dataWarnings() + wishAddForm() + wishList(ev);
  }

  function dataWarnings() {
    const w = [];
    if (!rt.catalog) w.push('物品目录未加载：请刷新页面（脚本要读取 localStorage.initClientData）');
    if (!rt.inventory.length) w.push('未读取到库存：请刷新页面并重新进入角色');
    if (rt.namesLoading) w.push('中文物品名加载中…');
    if (rt.namesError) w.push('中文名加载失败：' + rt.namesError);
    if (!w.length) return '';
    return '<div class="mwi-warn">' + w.map(esc).join('<br>') + '</div>';
  }

  function wishAddForm() {
    const d = rt.draft.wish;
    const item = d.hrid && rt.catalog ? rt.catalog[d.hrid] : null;
    let pending = '';
    if (item) {
      const maxEnh = item.maxEnh || 0;
      pending =
        '<div class="mwi-pending">' + icon(d.hrid) +
        '<b>' + esc(displayName(d.hrid, 0)) + '</b>' +
        (maxEnh > 0
          ? '<label>强化 <input class="mwi-input" style="width:58px" type="number" min="0" max="' + maxEnh + '" value="' + esc(d.enh) + '" data-role="wish-enh"></label>'
          : '') +
        '<label>数量 <input class="mwi-input" style="width:64px" type="number" min="1" step="1" value="' + esc(d.qty) + '" data-role="wish-qty"></label>' +
        '<button class="mwi-btn primary" data-act="add-wish">添加</button>' +
        '<button class="mwi-btn" data-act="cancel-wish">取消</button>' +
        '</div>';
    }
    return '<div class="mwi-add">' +
      '<div class="mwi-combo">' +
        '<input class="mwi-input" style="width:100%" data-role="wish-search" autocomplete="off" ' +
          'placeholder="搜索物品（中文 / 英文），选中后设置强化与数量" value="' + esc(d.q) + '">' +
        '<div class="mwi-results" data-role="wish-results" hidden></div>' +
      '</div>' + pending +
    '</div>';
  }

  function wishResultsHtml() {
    if (!rt.catalog) return '<div class="mwi-dim" style="padding:8px">物品目录未加载，请刷新页面</div>';
    const rows = searchCatalog(rt.draft.wish.q, 40);
    if (!rows.length) return '<div class="mwi-dim" style="padding:8px">无匹配物品</div>';
    return rows.map(function (it) {
      const name = displayName(it.hrid, 0);
      const tags = (it.lab ? '<span class="mwi-tag">迷宫</span>' : '') +
        (!it.tradable ? '<span class="mwi-tag warn">不可交易</span>' : '');
      return '<div class="mwi-result" data-act="select-wish" data-hrid="' + esc(it.hrid) +
        '" data-name="' + esc(name) + '">' +
        icon(it.hrid) + '<span>' + esc(name) + '</span>' + tags +
      '</div>';
    }).join('');
  }

  function wishList(ev) {
    if (!state.wishes.length) {
      return '<div class="mwi-dim">还没有心愿物品。搜索并添加你想买的东西。</div>';
    }
    if (!ev) ev = evaluate();
    return '<div class="mwi-section">心愿列表</div>' +
      '<div class="mwi-table">' +
      '<div class="mwi-tr mwi-wish-tr mwi-th">' +
        '<span>#</span><span>物品</span><span class="num">数量</span>' +
        '<span class="num">卖价</span><span class="num">买价</span><span class="num">小计</span><span></span>' +
      '</div>' +
      ev.rows.map(function (r, i) {
        const sell = r.ask == null ? '—' : fmt(r.ask);
        const buy = r.bid == null ? '—' : fmt(r.bid);
        const subtotal = r.unit == null ? '—' : fmt(r.unit * r.qty);
        return '<div class="mwi-tr mwi-wish-tr">' +
          '<span class="mwi-prio">' + (i + 1) +
            '<span class="mwi-arrows">' +
              '<button class="mwi-btn" data-act="up-wish" data-id="' + esc(r.id) + '">↑</button>' +
              '<button class="mwi-btn" data-act="down-wish" data-id="' + esc(r.id) + '">↓</button>' +
            '</span>' +
          '</span>' +
          '<span class="mwi-item" title="' + esc(displayName(r.hrid, r.enh)) + '">' + icon(r.hrid) + '</span>' +
          '<span class="num">' + r.qty + '</span>' +
          '<span class="num">' + sell + '</span>' +
          '<span class="num">' + buy + '</span>' +
          '<span class="num">' + subtotal + '</span>' +
          '<span class="mwi-op"><button class="mwi-btn danger mwi-del" data-act="del-wish" data-id="' + esc(r.id) + '">删除</button></span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function swapSheet() {
    return dataWarnings() + swapAddForm() + swapList();
  }

  function swapAddForm() {
    const d = rt.draft.swap;
    let pending = '';
    if (d.hrid) {
      const loc = d.loc || INV_LOC;
      const stock = locQty(d.hrid, d.enh, loc);
      const avail = Math.max(0, stock - swapAssigned(d.hrid, d.enh, loc));
      const shown = d.all ? stock : avail;
      pending =
        '<div class="mwi-pending">' + icon(d.hrid) +
        '<b>' + esc(displayName(d.hrid, d.enh)) + '</b>' +
        '<span class="mwi-dim" title="' + locLabel(loc) + ' ' + stock + '">' +
          locLabel(loc) + ' ' + fmtQty(shown) + '</span>' +
        '<label>数量 <input class="mwi-input" style="width:64px" type="number" min="1" max="' + Math.max(1, shown) +
          '" value="' + esc(d.all ? stock : d.qty) + '" data-role="swap-qty"' + (d.all ? ' disabled' : '') + '></label>' +
        '<label class="mwi-check"><input type="checkbox" data-role="swap-all"' + (d.all ? ' checked' : '') +
          (stock <= 0 ? ' disabled' : '') + '> 全部</label>' +
        '<button class="mwi-btn primary" data-act="add-swap"' + (shown <= 0 ? ' disabled' : '') + '>添加</button>' +
        '<button class="mwi-btn" data-act="cancel-swap">取消</button>' +
        '</div>';
    }
    return '<div class="mwi-add">' +
      '<div class="mwi-combo">' +
        '<input class="mwi-input" style="width:100%" data-role="swap-search" autocomplete="off" ' +
          'placeholder="从库存、装备、市场挂单中选择要置换的物品（按名称搜索）" value="' + esc(d.q) + '">' +
        '<div class="mwi-results" data-role="swap-results" hidden></div>' +
      '</div>' + pending +
    '</div>';
  }

  function swapResultsHtml() {
    const q = String(rt.draft.swap.q || '').trim().toLowerCase();
    const entries = swapEntries().filter(function (e) {
      if (!q) return true;
      const it = rt.catalog && rt.catalog[e.hrid];
      const lab = isLabyrinth(e.hrid, it && it.category);
      const zh = String(zhName(e.hrid) || '').toLowerCase();
      const en = String((it && it.name) || '').toLowerCase();
      const extra = [];
      if (/_cape(_refined)?$/.test(e.hrid)) extra.push('披风', '斗篷');
      if (/lodestone$/.test(e.hrid)) extra.push('磁石', '路标');
      const hay = zh + ' ' + en + ' ' + e.hrid.toLowerCase() + (lab ? ' 迷宫 迷宮 labyrinth' : '') + ' ' + extra.join(' ');
      return hay.indexOf(q) !== -1;
    });
    entries.sort(function (a, b) {
      return locRank(a.loc) - locRank(b.loc) || a.hrid.localeCompare(b.hrid) || a.enh - b.enh;
    });
    const shown = [];
    const counts = {};
    for (let i = 0; i < entries.length && shown.length < 40; i++) {
      const e = entries[i];
      const max = e.loc === INV_LOC ? 16 : 12;
      if ((counts[e.loc] || 0) >= max) continue;
      counts[e.loc] = (counts[e.loc] || 0) + 1;
      shown.push(e);
    }
    if (!shown.length) return '<div class="mwi-dim" style="padding:8px">库存、装备、市场挂单中没有匹配物品</div>';
    return shown.map(function (e) {
      const it = rt.catalog && rt.catalog[e.hrid];
      const lab = isLabyrinth(e.hrid, it && it.category);
      const tags = (lab ? '<span class="mwi-tag">迷宫</span>' : '') +
        (it && !it.tradable ? '<span class="mwi-tag warn">不可交易</span>' : '');
      return '<div class="mwi-result" data-act="select-swap" data-hrid="' + esc(e.hrid) +
        '" data-enh="' + e.enh + '" data-loc="' + esc(e.loc) + '" data-name="' + esc(displayName(e.hrid, e.enh)) + '">' +
        icon(e.hrid) + '<span>' + esc(displayName(e.hrid, e.enh)) + '</span>' + tags +
        '<span class="mwi-dim" title="' + locLabel(e.loc) + ' ' + e.qty + '">' +
          locLabel(e.loc) + ' ' + fmtQty(e.qty) + '</span></div>';
    }).join('');
  }

  function swapList() {
    if (!state.swaps.length) {
      return '<div class="mwi-dim">还没有置换物品。从库存、装备或市场挂单中选择要卖掉的物品。</div>';
    }
    const swapTaxFactor = 1 - SWAP_TAX;
    return '<div class="mwi-section">置换列表</div>' +
      '<div class="mwi-table">' +
      '<div class="mwi-tr mwi-swap-tr mwi-th">' +
        '<span>物品</span><span class="num">数量</span><span class="num">卖价</span>' +
        '<span class="num">买价</span><span class="num">税后小计</span><span></span>' +
      '</div>' +
      state.swaps.map(function (s) {
        const q = rt.market && rt.market[s.hrid] && rt.market[s.hrid][String(s.enh)];
        const ask = q && q.a > 0 ? q.a : null;
        const bid = q && q.b > 0 ? q.b : null;
        const p = pickPrice(rt.market, s.hrid, s.enh, state.settings.swapBasis);
        const subtotal = p.value == null ? '—' : fmt(p.value * s.qty * swapTaxFactor);
        const loc = s.loc || INV_LOC;
        const stock = locQty(s.hrid, s.enh, loc);
        return '<div class="mwi-tr mwi-swap-tr">' +
          '<span class="mwi-item" title="' + esc(displayName(s.hrid, s.enh) + '（' + locLabel(loc) + ' ' + stock + '）') + '">' + icon(s.hrid) + '</span>' +
          '<span class="num" title="' + esc('数量 ' + s.qty + '（' + locLabel(loc) + (s.all ? '，全部' : '') + '）') + '">' +
            fmtQty(s.qty) + (s.all ? '<span class="mwi-tag">全部</span>' : '') +
          '</span>' +
          '<span class="num">' + (ask == null ? '—' : fmt(ask)) + '</span>' +
          '<span class="num">' + (bid == null ? '—' : fmt(bid)) + '</span>' +
          '<span class="num">' + subtotal + '</span>' +
          '<span class="mwi-op"><button class="mwi-btn danger mwi-del" data-act="del-swap" data-id="' + esc(s.id) + '">删除</button></span>' +
        '</div>';
      }).join('') +
    '</div>' +
    '<div class="mwi-dim" style="margin-top:6px">置换卖出按 4% 扣税（按买价或卖价估值都扣）；心愿购买不扣税。装备/市场挂单的物品需要先卸下/下架再卖出。</div>';
  }

  function evalSheet(ev) {
    const marketTime = rt.marketAt ? new Date(rt.marketAt).toLocaleString('zh-CN', { hour12: false }) : '未加载';
    const daily = state.settings.dailyProfitM || '';

    return '<div class="mwi-cards">' +
        card('当前金币', fmt(ev.gold)) +
        card('置换市值', fmt(ev.swapsValue)) +
        card('心愿总价', fmt(ev.totalWishValue)) +
        card('还差', fmt(ev.totalGap)) +
        card('总进度', pct(ev.overall)) +
        card('预计天数', ev.days == null ? '—' : ev.days + ' 天') +
      '</div>' +
      '<div class="mwi-basis">心愿价格 ' + basisGroup('wish', state.settings.wishBasis) +
        ' · 置换价格 ' + basisGroup('swap', state.settings.swapBasis) +
        ' <span class="mwi-dim">行情：' + esc(marketTime) + '</span></div>' +
      warnings(ev) +
      evalRows(ev) +
      '<div class="mwi-daily">每日利润 <input class="mwi-input" style="width:90px" type="number" min="0" step="1" ' +
        'data-role="daily" value="' + esc(daily) + '" placeholder="如 100"> M</div>';
  }

  function basisGroup(kind, current) {
    function btn(v, label) {
      return '<button class="mwi-btn' + (current === v ? ' primary' : '') + '" data-act="basis" data-kind="' +
        kind + '" data-basis="' + v + '">' + label + '</button>';
    }
    return btn('a', '卖价') + ' ' + btn('b', '买价');
  }

  function warnings(ev) {
    const w = [];
    if (!rt.catalog) w.push('物品目录未加载：请刷新页面（脚本要读取 initClientData）');
    if (!rt.inventory.length) w.push('未读取到库存：请刷新页面并重新进入角色');
    if (!rt.market) w.push('市场行情未加载：点击左上角「刷新价格」');
    if (ev.unpriced) w.push(ev.unpriced + ' 件心愿物品无报价，未计入总额');
    if (rt.lastError) w.push('行情错误：' + rt.lastError);
    if (!w.length) return '';
    return '<div class="mwi-warn">' + w.map(esc).join('<br>') + '</div>';
  }

  function evalRows(ev) {
    if (!ev.rows.length) return '<div class="mwi-dim">心愿区为空。</div>';
    return ev.rows.map(function (r, i) {
      return '<div class="mwi-row">' +
        icon(r.hrid) +
        '<div class="mwi-grow">' +
          '<div class="mwi-name">' + (i + 1) + '. ' + esc(displayName(r.hrid, r.enh)) +
            (r.progress >= 1 ? ' <span class="mwi-ok">已完成</span>' : '') + '</div>' +
          '<div class="mwi-progress"><i style="width:' + (r.progress * 100).toFixed(1) + '%"></i></div>' +
          '<div class="mwi-dim">已攒 ' + pct(r.progress) +
            ' · 还差 ' + (r.gap == null ? '—' : fmt(r.gap)) +
            ' · 成本 ' + (r.cost ? fmt(r.cost) : '—') +
            ' · 已拥有 ' + r.owned + '/' + r.qty + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function clearModal() {
    return '<div class="mwi-modal-mask"><div class="mwi-modal">' +
      '<div style="font-weight:600;margin-bottom:8px">确认清空？</div>' +
      '<div class="mwi-dim">将清空心愿区（' + state.wishes.length + ' 项）和置换区（' + state.swaps.length +
        ' 项），此操作不可撤销。</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">' +
        '<button class="mwi-btn" data-act="cancel-clear">取消</button>' +
        '<button class="mwi-btn danger" data-act="confirm-clear">确认清空</button>' +
      '</div>' +
    '</div></div>';
  }

  /* ---------------------------- 事件 ---------------------------- */

  function bindOverlay(ov) {
    ov.addEventListener('click', onClick);
    ov.addEventListener('input', onInput);
    ov.addEventListener('change', onChange);
    ov.addEventListener('focusin', onFocusIn);
  }

  function onClick(e) {
    if (e.target.classList && e.target.classList.contains('mwi-modal-mask')) {
      rt.modal = null;
      render();
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el || !rt.overlay || !rt.overlay.contains(el)) return;
    const act = el.dataset.act;

    if (act === 'sheet') {
      state.ui.sheet = el.dataset.sheet;
      saveState(); render(); return;
    }
    if (act === 'basis') {
      state.settings[el.dataset.kind === 'wish' ? 'wishBasis' : 'swapBasis'] = el.dataset.basis;
      saveState(); render(); return;
    }
    if (act === 'refresh') {
      ensureMarket(true); return;
    }
    if (act === 'refresh-inventory') {
      refreshInventory(); return;
    }
    if (act === 'clear') {
      rt.modal = 'clear'; render(); return;
    }
    if (act === 'cancel-clear') {
      rt.modal = null; render(); return;
    }
    if (act === 'confirm-clear') {
      state.wishes = [];
      state.swaps = [];
      rt.modal = null;
      saveState(); render(); return;
    }
    if (act === 'add-wish') {
      addWish(); return;
    }
    if (act === 'cancel-wish') {
      resetDraft('wish'); render(); return;
    }
    if (act === 'select-wish') {
      const d = rt.draft.wish;
      d.hrid = el.dataset.hrid;
      d.q = el.dataset.name || displayName(d.hrid, 0);
      d.enh = 0;
      d.qty = 1;
      render(); return;
    }
    if (act === 'up-wish') {
      moveWish(el.dataset.id, -1); return;
    }
    if (act === 'down-wish') {
      moveWish(el.dataset.id, 1); return;
    }
    if (act === 'del-wish') {
      state.wishes = state.wishes.filter(function (w) { return w.id !== el.dataset.id; });
      saveState(); render(); return;
    }
    if (act === 'add-swap') {
      addSwap(); return;
    }
    if (act === 'cancel-swap') {
      resetDraft('swap'); render(); return;
    }
    if (act === 'select-swap') {
      const d = rt.draft.swap;
      d.hrid = el.dataset.hrid;
      d.enh = Number(el.dataset.enh) || 0;
      d.q = el.dataset.name || displayName(d.hrid, d.enh);
      d.qty = 1;
      d.all = false;
      d.loc = el.dataset.loc || INV_LOC;
      render(); return;
    }
    if (act === 'del-swap') {
      state.swaps = state.swaps.filter(function (s) { return s.id !== el.dataset.id; });
      saveState(); render(); return;
    }
  }

  function onInput(e) {
    const role = e.target.dataset ? e.target.dataset.role : '';
    if (!role) return;
    if (role === 'wish-search') {
      rt.draft.wish.q = e.target.value;
      renderResultsOnly('wish');
    } else if (role === 'swap-search') {
      rt.draft.swap.q = e.target.value;
      renderResultsOnly('swap');
    } else if (role === 'wish-qty') {
      rt.draft.wish.qty = e.target.value;
    } else if (role === 'wish-enh') {
      rt.draft.wish.enh = e.target.value;
    } else if (role === 'swap-qty') {
      rt.draft.swap.qty = e.target.value;
    }
  }

  function onChange(e) {
    const role = e.target.dataset ? e.target.dataset.role : '';
    if (role === 'daily') {
      state.settings.dailyProfitM = Math.max(0, Number(e.target.value) || 0);
      saveState(); render();
    } else if (role === 'wish-enh') {
      const item = rt.draft.wish.hrid && rt.catalog ? rt.catalog[rt.draft.wish.hrid] : null;
      const max = item ? (item.maxEnh || 0) : 0;
      const v = clampInt(e.target.value, 0, max);
      rt.draft.wish.enh = v;
      e.target.value = v;
    } else if (role === 'swap-all') {
      const d = rt.draft.swap;
      d.all = !!e.target.checked;
      if (d.all && d.hrid) d.qty = locQty(d.hrid, d.enh, d.loc || INV_LOC);
      render();
    }
  }

  function onFocusIn(e) {
    const role = e.target.dataset ? e.target.dataset.role : '';
    if (role !== 'wish-search' && role !== 'swap-search') return;
    const kind = role === 'wish-search' ? 'wish' : 'swap';
    const box = rt.overlay.querySelector('[data-role="' + kind + '-results"]');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = kind === 'wish' ? wishResultsHtml() : swapResultsHtml();
  }

  function renderResultsOnly(kind) {
    if (!rt.overlay) return;
    const box = rt.overlay.querySelector('[data-role="' + kind + '-results"]');
    if (!box) return;
    const d = rt.draft[kind];
    box.hidden = !d.q;
    box.innerHTML = kind === 'wish' ? wishResultsHtml() : swapResultsHtml();
  }

  function resetDraft(kind) {
    rt.draft[kind] = { q: '', hrid: null, enh: 0, qty: 1, all: false, loc: INV_LOC };
  }

  function addWish() {
    const d = rt.draft.wish;
    if (!d.hrid) return;
    const item = rt.catalog ? rt.catalog[d.hrid] : null;
    const maxEnh = item ? (item.maxEnh || 0) : 0;
    const enh = clampInt(d.enh, 0, maxEnh);
    const qty = Math.max(1, Math.floor(Number(d.qty) || 1));
    const ex = state.wishes.find(function (w) { return w.hrid === d.hrid && w.enh === enh; });
    if (ex) ex.qty += qty;
    else state.wishes.push({ id: uid(), hrid: d.hrid, enh: enh, qty: qty });
    resetDraft('wish');
    saveState(); render();
  }

  function addSwap() {
    const d = rt.draft.swap;
    if (!d.hrid) return;
    const enh = Number(d.enh) || 0;
    const loc = d.loc || INV_LOC;
    const stock = locQty(d.hrid, enh, loc);
    const all = !!d.all;
    const same = function (s) {
      return s.hrid === d.hrid && s.enh === enh && (s.loc || INV_LOC) === loc;
    };

    if (all) {
      if (stock <= 0) return;
      const allSame = state.swaps.filter(function (s) { return s.all && same(s); });
      if (allSame.length) {
        const keep = allSame[0];
        keep.qty = stock;
        state.swaps = state.swaps.filter(function (s) { return s === keep || !same(s); });
      } else {
        state.swaps = state.swaps.filter(function (s) { return !same(s); });
        state.swaps.push({ id: uid(), hrid: d.hrid, enh: enh, qty: stock, all: true, loc: loc });
      }
      resetDraft('swap');
      saveState(); render();
      return;
    }

    const assigned = swapAssigned(d.hrid, enh, loc);
    const max = Math.max(0, stock - assigned);
    if (max <= 0) return;
    const qty = Math.min(max, Math.max(1, Math.floor(Number(d.qty) || 1)));
    state.swaps.push({ id: uid(), hrid: d.hrid, enh: enh, qty: qty, all: false, loc: loc });
    resetDraft('swap');
    saveState(); render();
  }

  function moveWish(id, delta) {
    const i = state.wishes.findIndex(function (w) { return w.id === id; });
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= state.wishes.length) return;
    const t = state.wishes[i];
    state.wishes[i] = state.wishes[j];
    state.wishes[j] = t;
    saveState(); render();
  }

  /* ---------------------------- 注入 ---------------------------- */

  function findTablist() {
    const lists = Array.prototype.slice.call(document.querySelectorAll('[role="tablist"]'));
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < lists.length; i++) {
      const text = lists[i].textContent || '';
      let score = 0;
      for (let k = 0; k < LOCATIONS.length; k++) {
        if (text.indexOf(LOCATIONS[k]) !== -1) score++;
      }
      if (score > bestScore) { best = lists[i]; bestScore = score; }
    }
    return bestScore >= 2 ? best : null;
  }

  function findHost(list) {
    let node = list.closest('.MuiTabs-root') || list.parentElement;
    let cur = node;
    for (let i = 0; i < 5 && cur && cur !== document.body; i++) {
      if (cur.querySelector && cur.querySelector('[role="tabpanel"]')) return cur;
      cur = cur.parentElement;
    }
    return node && node.parentElement ? node.parentElement : (node || document.body);
  }

  function makeTab() {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'mwi-tab';
    tab.textContent = '攒钱';
    tab.dataset.mwiTab = '1';
    tab.setAttribute('aria-pressed', 'false');
    return tab;
  }

  const FALLBACK_TAB = {
    normal: {
      background: '#2a3550', color: '#d8dce8', border: '1px solid #3f4a66',
      borderRadius: '4px 4px 0 0', boxShadow: 'none', padding: '8px 12px',
      minHeight: '36px', minWidth: 'auto', height: 'auto', margin: '0', flex: '0 0 auto', alignSelf: 'auto',
      fontFamily: 'inherit', fontSize: '13px', fontWeight: '500', lineHeight: '1.4',
      letterSpacing: 'normal', textTransform: 'none'
    },
    active: {
      background: '#2f6fe4', color: '#ffffff', border: '1px solid #2f6fe4',
      borderRadius: '4px 4px 0 0', boxShadow: 'none', padding: '8px 12px',
      minHeight: '36px', minWidth: 'auto', height: 'auto', margin: '0', flex: '0 0 auto', alignSelf: 'auto',
      fontFamily: 'inherit', fontSize: '13px', fontWeight: '500', lineHeight: '1.4',
      letterSpacing: 'normal', textTransform: 'none'
    }
  };

  function readTabStyle(el) {
    const cs = pageWin.getComputedStyle(el);
    return {
      background: cs.background,
      color: cs.color,
      border: cs.border,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
      padding: cs.padding,
      minHeight: cs.minHeight,
      minWidth: cs.minWidth,
      height: cs.height,
      margin: cs.margin,
      flex: cs.flex,
      alignSelf: cs.alignSelf,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform
    };
  }

  function isTransparentBg(bg) {
    if (!bg) return true;
    if (bg === 'transparent') return true;
    return /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg);
  }

  function captureTabStyle(list) {
    if (rt.tabStyle) return;
    const tabs = list.querySelectorAll('[role="tab"]');
    let normal = null;
    let active = null;
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('aria-selected') === 'true') active = tabs[i];
      else if (!normal) normal = tabs[i];
    }
    if (!normal) normal = tabs[0];
    if (!normal) { rt.tabStyle = FALLBACK_TAB; return; }
    if (!active) active = normal;

    const n = readTabStyle(normal);
    const a = readTabStyle(active);
    if (isTransparentBg(n.background)) {
      n.background = FALLBACK_TAB.normal.background;
      if (!n.border || n.border.indexOf('none') !== -1) n.border = FALLBACK_TAB.normal.border;
      if (!n.color || n.color === 'rgba(0, 0, 0, 0)') n.color = FALLBACK_TAB.normal.color;
      if (!n.borderRadius || n.borderRadius === '0px') n.borderRadius = FALLBACK_TAB.normal.borderRadius;
      if (!n.padding || n.padding === '0px') n.padding = FALLBACK_TAB.normal.padding;
      if (!n.minHeight || n.minHeight === '0px') n.minHeight = FALLBACK_TAB.normal.minHeight;
      if (!n.fontSize || n.fontSize === '0px') n.fontSize = FALLBACK_TAB.normal.fontSize;
    }
    if (isTransparentBg(a.background)) {
      a.background = FALLBACK_TAB.active.background;
      a.color = FALLBACK_TAB.active.color;
      if (!a.border || a.border.indexOf('none') !== -1) a.border = FALLBACK_TAB.active.border;
      if (!a.borderRadius || a.borderRadius === '0px') a.borderRadius = FALLBACK_TAB.active.borderRadius;
      if (!a.padding || a.padding === '0px') a.padding = FALLBACK_TAB.active.padding;
      if (!a.minHeight || a.minHeight === '0px') a.minHeight = FALLBACK_TAB.active.minHeight;
      if (!a.fontSize || a.fontSize === '0px') a.fontSize = FALLBACK_TAB.active.fontSize;
    }
    rt.tabStyle = { normal: n, active: a };
  }

  function applyTabStyle(tab, s) {
    if (!tab || !s) return;
    if (s.background) tab.style.background = s.background;
    if (s.color) tab.style.color = s.color;
    if (s.border) tab.style.border = s.border;
    if (s.borderRadius) tab.style.borderRadius = s.borderRadius;
    if (s.boxShadow) tab.style.boxShadow = s.boxShadow;
    if (s.padding) tab.style.padding = s.padding;
    if (s.minHeight) tab.style.minHeight = s.minHeight;
    if (s.minWidth) tab.style.minWidth = s.minWidth;
    if (s.height) tab.style.height = s.height;
    if (s.margin) tab.style.margin = s.margin;
    if (s.flex) tab.style.flex = s.flex;
    if (s.alignSelf) tab.style.alignSelf = s.alignSelf;
    if (s.fontFamily) tab.style.fontFamily = s.fontFamily;
    if (s.fontSize) tab.style.fontSize = s.fontSize;
    if (s.fontWeight) tab.style.fontWeight = s.fontWeight;
    if (s.lineHeight) tab.style.lineHeight = s.lineHeight;
    if (s.letterSpacing) tab.style.letterSpacing = s.letterSpacing;
    if (s.textTransform) tab.style.textTransform = s.textTransform;
  }

  function findTabAnchor(list) {
    const tabs = list.querySelectorAll('[role="tab"]');
    let house = null;
    for (let i = 0; i < tabs.length; i++) {
      const txt = (tabs[i].textContent || '').replace(/\s+/g, '');
      if (txt.indexOf('配装') !== -1 || txt.indexOf('Loadout') !== -1) return tabs[i];
      if (!house && (txt.indexOf('房屋') !== -1 || txt.indexOf('House') !== -1)) house = tabs[i];
    }
    return house;
  }

  function placeOwnTab(list, tab) {
    if (!tab) return;
    const anchor = findTabAnchor(list);
    if (anchor && anchor.parentElement === list) {
      if (anchor.nextSibling !== tab) list.insertBefore(tab, anchor.nextSibling);
    } else if (!list.contains(tab)) {
      list.appendChild(tab);
    }
  }

  function mountAll() {
    const list = findTablist();
    if (!list) return false;
    captureTabStyle(list);

    if (rt.tab && rt.tablist !== list) {
      if (rt.tab.parentElement) rt.tab.parentElement.removeChild(rt.tab);
      rt.tab = null;
    }

    const st = rt.tabStyle || FALLBACK_TAB;
    if (!rt.tab || !list.contains(rt.tab)) {
      const tab = makeTab();
      applyTabStyle(tab, st.normal);
      placeOwnTab(list, tab);
      rt.tab = tab;
    } else {
      placeOwnTab(list, rt.tab);
      applyTabStyle(rt.tab, (rt.overlay && rt.overlay.style.display !== 'none') ? st.active : st.normal);
    }
    rt.tablist = list;

    if (rt.fixed && rt.overlay) {
      if (rt.overlay.parentElement) rt.overlay.parentElement.removeChild(rt.overlay);
      rt.overlay = null;
      rt.fixed = false;
    }

    if (!rt.overlay || !document.body.contains(rt.overlay)) {
      if (rt.overlay && rt.overlay.parentElement) rt.overlay.parentElement.removeChild(rt.overlay);
      const ov = document.createElement('div');
      ov.className = 'mwi-savings-overlay';
      ov.style.display = 'none';
      document.body.appendChild(ov);
      rt.overlay = ov;
      rt.host = findHost(list);
      rt.fixed = false;
      bindOverlay(ov);
    }

    if (!rt.boundLists.has(list)) {
      rt.boundLists.add(list);
      list.addEventListener('click', function (e) {
        const target = e.target;
        if (!target || !target.closest) return;
        const own = target.closest('.mwi-tab');
        if (own === rt.tab) return;
        hideOwnTab();
      }, true);
    }

    render();
    return true;
  }

  function showOwnTab() {
    if (!rt.tab || !rt.overlay) return;
    const list = rt.tablist || findTablist();
    if (list) {
      const current = list.querySelector('[role="tab"][aria-selected="true"]');
      if (current && current !== rt.tab) rt.panelId = current.getAttribute('aria-controls');
      const tabs = list.querySelectorAll('[role="tab"]');
      for (let i = 0; i < tabs.length; i++) {
        tabs[i].classList.remove('Mui-selected');
        tabs[i].setAttribute('aria-selected', 'false');
      }
    }
    rt.tab.classList.add('active');
    rt.tab.setAttribute('aria-pressed', 'true');
    applyTabStyle(rt.tab, (rt.tabStyle || FALLBACK_TAB).active);
    if (!rt.fixed) positionOverlay();
    rt.overlay.style.display = 'block';
    render();
  }

  function hideOwnTab() {
    if (rt.tab) {
      rt.tab.classList.remove('active');
      rt.tab.setAttribute('aria-pressed', 'false');
      applyTabStyle(rt.tab, (rt.tabStyle || FALLBACK_TAB).normal);
    }
    if (rt.overlay) rt.overlay.style.display = 'none';
  }

  function positionOverlay() {
    if (!rt.overlay || rt.fixed) return;
    const list = rt.tablist || findTablist();
    if (!list) return;
    const host = findHost(list);
    rt.host = host;

    let panel = rt.panelId ? document.getElementById(rt.panelId) : null;
    if (!panel && host) panel = host.querySelector('[role="tabpanel"]');

    let r = panel ? panel.getBoundingClientRect() : null;
    if (!r || r.width < 100 || r.height < 80) {
      const lr = list.getBoundingClientRect();
      const hr = host ? host.getBoundingClientRect() : lr;
      r = {
        left: lr.left,
        top: lr.bottom,
        width: Math.max(lr.width, hr.width),
        height: Math.max(200, hr.bottom - lr.bottom)
      };
    }

    const left = Math.max(8, Math.min(r.left, pageWin.innerWidth - 240));
    const top = Math.max(8, Math.min(r.top, pageWin.innerHeight - 120));
    const width = Math.max(240, Math.min(r.width, pageWin.innerWidth - left - 8));
    const height = Math.max(180, Math.min(r.height, pageWin.innerHeight - top - 8));

    rt.overlay.style.left = left + 'px';
    rt.overlay.style.top = top + 'px';
    rt.overlay.style.width = width + 'px';
    rt.overlay.style.height = height + 'px';
  }

  function mountFab() {
    if (rt.fab) return;
    const btn = document.createElement('button');
    btn.className = 'mwi-fab';
    btn.textContent = '攒钱';
    btn.addEventListener('click', function () {
      if (!rt.overlay) {
        const ov = document.createElement('div');
        ov.className = 'mwi-savings-overlay';
        ov.style.cssText = 'position:fixed;left:32px;right:32px;top:70px;bottom:32px;display:block;z-index:9999;';
        document.body.appendChild(ov);
        rt.overlay = ov;
        rt.fixed = true;
        bindOverlay(ov);
        render();
      } else {
        const show = rt.overlay.style.display === 'none';
        rt.overlay.style.display = show ? 'block' : 'none';
        if (show) render();
      }
    });
    document.body.appendChild(btn);
    rt.fab = btn;
  }

  function ensureUI() {
    const list = findTablist();
    if (!list) {
      if (rt.overlay && rt.overlay.style.display !== 'none') hideOwnTab();
      if (rt.overlay && rt.fab) { rt.fab.remove(); rt.fab = null; }
      if (!rt.overlay && Date.now() - rt.startedAt > 8000) mountFab();
      return;
    }
    if (rt.fab) { rt.fab.remove(); rt.fab = null; }

    if (!rt.tab || !list.contains(rt.tab)) {
      mountAll();
      return;
    }
    if (!rt.overlay || !document.body.contains(rt.overlay)) {
      mountAll();
      return;
    }
    placeOwnTab(list, rt.tab);
    if (rt.overlay.style.display !== 'none') {
      const tabs = list.querySelectorAll('[role="tab"]');
      for (let i = 0; i < tabs.length; i++) {
        tabs[i].classList.remove('Mui-selected');
        tabs[i].setAttribute('aria-selected', 'false');
      }
      if (!rt.fixed) positionOverlay();
      rt.tab.classList.add('active');
      rt.tab.setAttribute('aria-pressed', 'true');
      applyTabStyle(rt.tab, (rt.tabStyle || FALLBACK_TAB).active);
    }
  }

  /* ---------------------------- 样式 ---------------------------- */

  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const css = `
      .mwi-savings-overlay {
        position: fixed; display: none; z-index: 1000; overflow: auto;
        box-sizing: border-box;
        background: #1e2233;
        color: #e8e8f2;
        font-family: inherit; font-size: 13px; border: 1px solid #2f3850;
      }
      .mwi-tab {
        display: inline-flex; align-items: center; justify-content: center;
        align-self: stretch; box-sizing: border-box;
        white-space: nowrap; cursor: pointer; text-decoration: none;
        padding: 8px 12px; min-height: 36px;
        border: 1px solid #3f4a66; border-radius: 4px 4px 0 0;
        background: #2a3550; color: #d8dce8;
        font-family: inherit; font-size: 13px; font-weight: 500; line-height: 1.4;
      }
      .mwi-tab:hover { filter: brightness(1.08); }
      .mwi-tab.active { background: #2f6fe4; border-color: #2f6fe4; color: #fff; }
      .mwi-wrap { padding: 10px 12px 24px; }
      .mwi-top { position: relative; display: flex; align-items: center; justify-content: center; margin-bottom: 8px; min-height: 24px; }
      .mwi-title { font-size: 16px; font-weight: 600; }
      .mwi-actions { position: absolute; right: 0; top: 0; display: flex; gap: 4px; }
      .mwi-left-actions { position: absolute; left: 0; top: 0; display: flex; gap: 4px; }
      .mwi-subtabs { display: flex; gap: 4px; margin-bottom: 10px; border-bottom: 1px solid #2f3850; }
      .mwi-notice { margin: -2px 0 8px; color: #9fb4e0; font-size: 12px; }
      .mwi-subtab { background: transparent; border: 0; color: #8f9ab3; padding: 4px 7px; cursor: pointer; border-bottom: 2px solid transparent; font: inherit; font-size: 13px; width: auto; min-width: 0; }
      .mwi-subtab.active { color: #f0c56a; border-bottom-color: #f0c56a; }
      .mwi-savings-overlay .mwi-btn {
        display: inline-flex; align-items: center; justify-content: center;
        flex: 0 0 auto !important;
        width: auto !important; min-width: 0 !important; max-width: none !important;
        height: auto !important; min-height: 0 !important;
        margin: 0 !important; padding: 3px 9px !important;
        border: 1px solid #3d4e70; border-radius: 4px;
        background: #2b3852; color: #dfe3ee;
        font: inherit; font-size: 12px !important; line-height: 1.3 !important;
        white-space: nowrap; cursor: pointer; text-transform: none;
        appearance: none; -webkit-appearance: none;
      }
      .mwi-savings-overlay .mwi-btn:hover { background: #35466a; }
      .mwi-savings-overlay .mwi-btn.primary { background: #3d5178; border-color: #5e75a3; color: #ffe2a0; }
      .mwi-savings-overlay .mwi-btn.danger { background: #4a2a32; border-color: #6d3a45; color: #ffb0b0; }
      .mwi-savings-overlay .mwi-btn:disabled { opacity: .5; cursor: default; }
      .mwi-savings-overlay .mwi-btn.mwi-del { padding: 0 5px !important; }
      .mwi-add { background: #232a3d; border: 1px solid #2f3850; border-radius: 4px; padding: 8px; margin-bottom: 8px; }
      .mwi-combo { position: relative; }
      .mwi-input { background: #151a28; border: 1px solid #3a4a6b; color: #e8e8f2; border-radius: 3px; padding: 3px 6px; font: inherit; font-size: 12px; }
      .mwi-input::placeholder { color: #6a6a80; }
      .mwi-results { position: absolute; left: 0; right: 0; top: 100%; z-index: 5; max-height: 260px; overflow: auto; background: #232a3d; border: 1px solid #3a4a6b; border-radius: 0 0 4px 4px; }
      .mwi-result { display: flex; align-items: center; gap: 7px; padding: 4px 7px; cursor: pointer; font-size: 12px; }
      .mwi-result:hover { background: #2e3a52; }
      .mwi-tag { display: inline-block; padding: 0 3px; margin-left: 2px; border: 1px solid #5e75a3; border-radius: 2px; font-size: 10px; line-height: 14px; color: #9fb4e0; }
      .mwi-tag.warn { border-color: #7a3030; color: #ffb0b0; }
      .mwi-icon { width: 22px; height: 22px; flex: 0 0 22px; }
      .mwi-icon-ph { display: inline-block; width: 22px; height: 22px; line-height: 22px; text-align: center; background: #2e3a52; border-radius: 3px; font-size: 11px; }
      .mwi-pending { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 7px; font-size: 12px; }
      .mwi-check { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
      .mwi-table { width: 100%; overflow-x: auto; }
      .mwi-tr { display: grid; align-items: center; gap: 4px; padding: 4px 0; border-bottom: 1px solid #2a3247; min-width: 0; }
      .mwi-wish-tr { grid-template-columns: 42px 32px 46px minmax(56px, 1fr) minmax(56px, 1fr) minmax(56px, 1fr) 46px; }
      .mwi-swap-tr { grid-template-columns: 32px 86px minmax(56px, 1fr) minmax(56px, 1fr) minmax(56px, 1fr) 46px; }
      .mwi-th { color: #8f9ab3; font-size: 11px; padding: 2px 0; border-bottom: 1px solid #2f3850; }
      .mwi-tr .num { text-align: right; white-space: nowrap; }
      .mwi-item { display: flex; align-items: center; justify-content: center; gap: 5px; min-width: 0; overflow: hidden; }
      .mwi-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mwi-op { text-align: right; }
      .mwi-prio { display: flex; flex-direction: column; align-items: center; gap: 0; color: #8f9ab3; font-size: 11px; }
      .mwi-arrows { display: flex; flex-direction: column; gap: 0; }
      .mwi-savings-overlay .mwi-arrows .mwi-btn { width: 16px !important; min-width: 16px !important; padding: 0 !important; font-size: 10px !important; line-height: 13px !important; }
      .mwi-row { display: flex; align-items: center; gap: 7px; padding: 7px 0; border-bottom: 1px solid #2a3247; }
      .mwi-row > .mwi-icon { flex: 0 0 22px; }
      .mwi-row > .mwi-btn { flex: 0 0 auto; }
      .mwi-row .mwi-grow { flex: 1 1 auto; min-width: 0; }
      .mwi-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 1px; font-size: 13px; }
      .mwi-section { margin: 10px 0 2px; font-size: 12px; color: #8f9ab3; }
      .mwi-dim { color: #8f9ab3; font-size: 11px; line-height: 1.45; }
      .mwi-warn { color: #f0a0a0; margin: 6px 0 10px; line-height: 1.6; }
      .mwi-ok { color: #8fd08f; }
      .mwi-progress { height: 7px; background: #2a3247; border-radius: 4px; overflow: hidden; margin: 4px 0; }
      .mwi-progress > i { display: block; height: 100%; background: linear-gradient(90deg, #c9973f, #ffd27a); }
      .mwi-cards { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
      .mwi-card { background: #232a3d; border: 1px solid #2f3850; border-radius: 6px; padding: 7px 10px; min-width: 96px; }
      .mwi-card .k { color: #8f9ab3; font-size: 12px; }
      .mwi-card .v { font-size: 16px; font-weight: 600; margin-top: 2px; }
      .mwi-basis { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
      .mwi-daily { margin-top: 14px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .mwi-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 10000; }
      .mwi-modal { background: #232a3d; border: 1px solid #3a4a6b; border-radius: 8px; padding: 16px 18px; max-width: 380px; }
      .mwi-fab { position: fixed; right: 20px; bottom: 20px; z-index: 9999; background: #5a4a1f; color: #ffe2a0; border: 1px solid #8a6a2a; border-radius: 20px; padding: 8px 14px; cursor: pointer; font: inherit; }
      @media (max-width: 700px) {
        .mwi-savings-overlay { font-size: 12px; }
        .mwi-cards { gap: 6px; }
        .mwi-card { min-width: 80px; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'mwi-savings-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------------------------- WebSocket ---------------------------- */

  function onGlobalClick(e) {
    if (!rt.tab && !rt.overlay) return;
    const target = e.target;
    if (!target || !target.closest) return;

    const own = target.closest('.mwi-tab');
    if (own && own === rt.tab) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showOwnTab();
      return;
    }

    const list = rt.tablist || findTablist();
    const inList = list && list.contains(target);
    const tabLike = target.closest('[role="tab"], .MuiTab-root, .income-tab');

    if (!inList && !tabLike) {
      const btn = target.closest('button, a, [role="button"], [role="menuitem"], [role="option"]');
      if (btn && /切换角色|切换账号|角色选择|选择角色|更换角色|退出登录|登出|Switch Character|Change Character|Logout|Sign Out/i.test(btn.textContent || '')) {
        hideOwnTab();
      }
      return;
    }

    hideOwnTab();
    if (tabLike && tabLike !== rt.tab) {
      setTimeout(function () {
        if (!tabLike.isConnected) return;
        if (!tabLike.classList.contains('Mui-selected') && !tabLike.classList.contains('selected')) {
          tabLike.classList.add('Mui-selected');
          tabLike.setAttribute('aria-selected', 'true');
        }
      }, 0);
    }
  }

  function hookWS() {
    const desc = Object.getOwnPropertyDescriptor(pageWin.MessageEvent.prototype, 'data');
    if (!desc || !desc.get) {
      console.warn('[攒钱] 无法拦截 WebSocket 消息');
      return;
    }
    const orig = desc.get;
    Object.defineProperty(pageWin.MessageEvent.prototype, 'data', {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        const raw = orig.call(this);
        try {
          const ws = this.currentTarget || this.target;
          if (ws && typeof ws.url === 'string' && /\/ws(\?|$)/.test(ws.url) && typeof raw === 'string' && raw.length < 8e6) {
            if (raw.indexOf('init_client_data') !== -1 ||
                raw.indexOf('init_character_data') !== -1 ||
                raw.indexOf('characterItems') !== -1 ||
                raw.indexOf('market_item_order_books_updated') !== -1) {
              onWs(JSON.parse(raw));
            }
          }
        } catch (e) { /* 绝不影响游戏 */ }
        return raw;
      }
    });
  }

  function onWs(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.itemDetailMap) {
      rt.catalog = buildCatalog(obj.itemDetailMap);
      rt.catalogSource = 'ws';
      if (needsNames()) loadNames(false);
      scheduleRender();
    }
    if (obj.type === 'init_character_data' && rt.characterID != null) {
      onCharacterSwitch();
    }
    if (Array.isArray(obj.characterItems)) {
      setInventory(obj.characterItems);
    }
    if (obj.marketItemOrderBooks) {
      applyOrderBook(obj.marketItemOrderBooks);
    }
  }

  /* ---------------------------- 启动 ---------------------------- */

  function boot() {
    injectStyle();
    saveState();
    setTimeout(initCatalog, 50);
    setTimeout(function () {
      if (!rt.names && needsNames()) loadNames(false);
    }, 1500);
    setTimeout(function () {
      try {
        const live = readLiveItems();
        if (live && live.length && live.length > rt.inventory.length) setInventory(live);
      } catch (e) { /* ignore */ }
    }, 3000);
    ensureMarket(false);
    ensureUI();
    setInterval(ensureUI, 1000);
    setInterval(function () {
      if (!rt.overlay || rt.overlay.style.display === 'none') return;
      if (!findTablist()) {
        hideOwnTab();
        if (rt.fab) { rt.fab.remove(); rt.fab = null; }
      }
    }, 200);
    pageWin.addEventListener('resize', function () {
      if (rt.overlay && rt.overlay.style.display !== 'none' && !rt.fixed) positionOverlay();
    });
    pageWin.addEventListener('storage', function (e) {
      if (e.key === KEY) {
        state = loadState();
        render();
      }
    });
    document.addEventListener('click', function (e) {
      if (!rt.overlay) return;
      if (e.target.closest && e.target.closest('.mwi-combo')) return;
      const boxes = rt.overlay.querySelectorAll('.mwi-results');
      for (let i = 0; i < boxes.length; i++) boxes[i].hidden = true;
    });
  }

  hookWS();
  pageWin.addEventListener('click', onGlobalClick, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  const api = {
    get state() { return state; },
    rt: rt,
    render: render,
    evaluate: evaluate
  };
  pageWin.__mwiSavings = api;
  try { window.__mwiSavings = api; } catch (e) { /* ignore */ }
})();
