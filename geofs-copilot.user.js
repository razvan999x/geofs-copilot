// ==UserScript==
// @name         GeoFS Copilot – auto takeoff, navigation, ILS approach & autoland
// @name:ro      GeoFS Copilot – decolare automată, navigație, apropiere ILS și aterizare
// @namespace    geofs-copilot-ro
// @version      1.8.3
// @description  Pick a destination by city name and fly from takeoff to landing: automatic takeoff, stopovers, moving map, step-by-step instructions, 3D approach corridor, ILS-style alignment, autoland, HUD, landing score, extended autopilot and aircraft systems panel.
// @description:ro Alegi destinația după oraș și zbori de la decolare la aterizare: decolare automată, escale, hartă, instrucțiuni pas cu pas, culoar de apropiere 3D, aliniere ca ILS, aterizare automată, HUD, scor de aterizare, autopilot extins și panou cu sistemele avionului.
// @author       Razvan Cristea
// @homepageURL  https://github.com/razvan999x/geofs-copilot
// @supportURL   https://github.com/razvan999x/geofs-copilot/issues
// @updateURL    https://github.com/razvan999x/geofs-copilot/raw/main/geofs-copilot.user.js
// @downloadURL  https://github.com/razvan999x/geofs-copilot/raw/main/geofs-copilot.user.js
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @sandbox      raw
// @inject-into  page
// @run-at       document-end
// ==/UserScript==

// Codul rulează direct în pagina GeoFS (nu în izolarea extensiei), ca să vadă simulatorul.
(function () {
function gcrMain() {
  'use strict';
  // marcaj în DOM (vizibil și din izolarea extensiei), ca pluginul să nu pornească de două ori
  if (document.documentElement.dataset.gcrLoaded) return;
  document.documentElement.dataset.gcrLoaded = '1';

  // Etichetă de stare: arată că pluginul rulează, chiar înainte să se încarce simulatorul.
  const bootBadge = document.createElement('div');
  bootBadge.style.cssText = 'position:fixed;z-index:100002;right:12px;bottom:12px;background:#8e24aa;color:#fff;font:600 12px system-ui,sans-serif;padding:6px 10px;border-radius:14px;box-shadow:0 3px 10px rgba(0,0,0,.4);pointer-events:none';
  bootBadge.textContent = '✈ GeoFS Copilot: loading…';
  (document.body || document.documentElement).appendChild(bootBadge);
  const bootStart = Date.now();

  /* =====================================================================
   *  CONSTANTE ȘI UTILITARE
   * ===================================================================== */
  const FT = 0.3048;          // m per ft
  const NM = 1852;            // m per NM
  const KT = 0.514444;        // m/s per kt
  const R_EARTH = 6371000;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const RUNWAYS_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
  const LS_KEY = 'geofsCopilotRO.settings';
  const LS_LANDINGS = 'geofsCopilotRO.landings';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const norm360 = (a) => ((a % 360) + 360) % 360;
  const norm180 = (a) => { a = norm360(a); return a > 180 ? a - 360 : a; };
  const fmt = (v, d = 0) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d));
  const pad3 = (v) => String(Math.round(norm360(v)) % 360).padStart(3, '0');

  function distM(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return norm360(Math.atan2(y, x) * R2D);
  }
  function destPoint(lat, lon, brgDeg, d) {
    const p1 = lat * D2R, l1 = lon * D2R, b = brgDeg * D2R, dr = d / R_EARTH;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * Math.sin(p2));
    return [p2 * R2D, ((l2 * R2D + 540) % 360) - 180];
  }
  /** Poziția (lat,lon) față de o axă care pleacă din (lat0,lon0) cu direcția crsDeg.
   *  along > 0 = înainte pe axă, cross > 0 = în dreapta axei. */
  function alongCross(lat0, lon0, crsDeg, lat, lon) {
    const x = (lon - lon0) * D2R * Math.cos(lat0 * D2R) * R_EARTH;
    const y = (lat - lat0) * D2R * R_EARTH;
    const ux = Math.sin(crsDeg * D2R), uy = Math.cos(crsDeg * D2R);
    return { along: x * ux + y * uy, cross: x * uy - y * ux };
  }

  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignorat */ } },
  };

  const settings = Object.assign({
    gsDeg: 3.0,           // panta de coborâre
    fafNm: 7,             // distanța punctului de interceptare a pantei (FAF)
    tchFt: 50,            // înălțimea de trecere peste prag
    vapp: 0,              // viteza de apropiere (0 = automat)
    autoConfig: true,     // tren + flaps automat
    autoland: false,      // aterizare automată (flare + frânare)
    minimumsFt: 200,      // decuplare AP dacă autoland e oprit
    drawTunnel: true,     // culoar 3D
    voice: true,          // anunțuri vocale
    hudVisible: true,
    panelVisible: true,
    panelPos: null,
    lastAirport: '',
    bankMax: 25,
    lang: 'en',           // 'en' sau 'ro'
    atcRole: 'pilot',     // 'pilot' sau 'ctrl'
    atcAnnounce: 'once',  // anunț turn în chat: once | never
    fuelOn: true,         // combustibil simulat
    onlineSync: true,     // publică zborurile în clasamentul online
    failures: 'rare',     // defecțiuni aleatorii: off | rare | normal
    fuelBurnMul: 1,       // multiplicator de consum
    limit250: false,      // regula reală: max. 250 kt sub 10.000 ft
    cpBeacon: true,       // îi arăt pe ceilalți utilizatori Copilot că folosesc pluginul
    ndTraffic: true,      // traficul pe hartă
    atcAuto: true,        // turn virtual când nu e controlor om
    atcStation: '',
    atcRwy: '',
    ndVisible: true,      // harta de navigație
    ndRange: 40,
    ndNorthUp: false,
    cruiseFt: 0,          // 0 = automat
    cruiseSpd: 0,         // 0 = automat
    autoTakeoff: true,    // decolare automată
    stopoverSec: 30,      // durata escalei
    trip: [],             // planul de zbor (escale)
  }, store.get(LS_KEY, {}));
  const saveSettings = () => store.set(LS_KEY, settings);
  /** Text în limba aleasă: L('română', 'English'). Implicit engleză. */
  const L = (ro, en) => (settings.lang === 'ro' ? ro : en);
  const VERSION = '1.8.3';
  const AUTHOR = 'Razvan Cristea';
  const REPO_URL = 'https://github.com/razvan999x/geofs-copilot';

  /* =====================================================================
   *  AȘTEPTARE ÎNCĂRCARE GEOFS
   * ===================================================================== */
  function geofsReady() {
    const g = window.geofs;
    return g && g.aircraft && g.aircraft.instance && g.aircraft.instance.llaLocation &&
      g.animation && g.animation.values && g.autopilot && g.api && g.api.viewer && window.controls && window.Cesium;
  }
  const bootTimer = setInterval(() => {
    if (!geofsReady()) {
      if (Date.now() - bootStart > 90000) {
        const g = window.geofs;
        const missing = !g ? 'geofs' : !g.aircraft || !g.aircraft.instance ? L('avion', 'aircraft') : !g.api || !g.api.viewer ? L('lumea 3D', '3D world') : !window.controls ? L('comenzi', 'controls') : !window.Cesium ? 'Cesium' : L('altceva', 'other');
        bootBadge.textContent = L('✈ GeoFS Copilot: nu găsesc simulatorul (' + missing + '). Reîncarcă pagina.', '✈ GeoFS Copilot: simulator not found (' + missing + '). Reload the page.');
        bootBadge.style.background = '#9c2f2f';
      }
      return;
    }
    clearInterval(bootTimer);
    try {
      init();
      bootBadge.textContent = L('✈ GeoFS Copilot pornit – Shift+N = panoul', '✈ GeoFS Copilot running – Shift+N = panel');
      setTimeout(() => bootBadge.remove(), 6000);
    } catch (e) {
      console.error('[GeoFS Copilot] init error', e);
      bootBadge.textContent = L('✈ GeoFS Copilot – eroare la pornire: ', '✈ GeoFS Copilot – startup error: ') + (e && e.message ? e.message : e);
      bootBadge.style.background = '#9c2f2f'; bootBadge.style.pointerEvents = 'auto';
    }
  }, 1000);

  /* =====================================================================
   *  BAZA DE DATE PISTE (OurAirports, domeniu public)
   * ===================================================================== */
  const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
  const CACHE_VER = 3;
  const DB = { loaded: false, loading: false, airports: new Map(), info: new Map(), search: [], error: null };

  function splitCSV(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  }

  // --- cache în IndexedDB, ca baza să nu se descarce la fiecare pornire ---
  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('geofsCopilotRO', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) {
    try { const d = await idbOpen(); return await new Promise((res) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); }
    catch (e) { return null; }
  }
  async function idbSet(k, v) { try { const d = await idbOpen(); d.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) { /* */ } }

  function parseRunways(text) {
    const lines = text.split('\n');
    const H = splitCSV(lines[0]); const ix = (n) => H.indexOf(n);
    const I = {
      apt: ix('airport_ident'), len: ix('length_ft'), wid: ix('width_ft'), surf: ix('surface'), closed: ix('closed'),
      le: ['le_ident', 'le_latitude_deg', 'le_longitude_deg', 'le_elevation_ft', 'le_heading_degT', 'le_displaced_threshold_ft'].map(ix),
      he: ['he_ident', 'he_latitude_deg', 'he_longitude_deg', 'he_elevation_ft', 'he_heading_degT', 'he_displaced_threshold_ft'].map(ix),
    };
    const map = new Map();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const f = splitCSV(lines[i]);
      if (f[I.closed] === '1') continue;
      const e1 = I.le.map((k) => f[k]), e2 = I.he.map((k) => f[k]);
      const lat1 = parseFloat(e1[1]), lon1 = parseFloat(e1[2]), lat2 = parseFloat(e2[1]), lon2 = parseFloat(e2[2]);
      if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) continue; // fără coordonate nu putem trasa apropierea
      const lenFt = parseFloat(f[I.len]) || distM(lat1, lon1, lat2, lon2) / FT;
      const apt = f[I.apt].toUpperCase();
      const mk = (e, oLat, oLon, lat, lon, eo) => {
        const hdg = bearing(lat, lon, oLat, oLon); // direcția reală de aterizare spre capătul opus
        const disp = parseFloat(e[5]) || 0;
        const [tLat, tLon] = disp > 0 ? destPoint(lat, lon, hdg, disp * FT) : [lat, lon];
        return {
          apt, ident: e[0] || pad3(hdg).slice(0, 2), lat: tLat, lon: tLon,
          elevFt: parseFloat(e[3]) || parseFloat(eo[3]) || 0, hdg, dispFt: disp,
          lenFt, ldaFt: lenFt - disp, widFt: parseFloat(f[I.wid]) || 150, surface: f[I.surf] || '', endLat: oLat, endLon: oLon,
        };
      };
      if (!map.has(apt)) map.set(apt, []);
      map.get(apt).push(mk(e1, lat2, lon2, lat1, lon1, e2), mk(e2, lat1, lon1, lat2, lon2, e1));
    }
    return map;
  }

  function parseAirports(text, runwayMap) {
    const lines = text.split('\n');
    const H = splitCSV(lines[0]); const ix = (n) => H.indexOf(n);
    const I = { id: ix('ident'), type: ix('type'), name: ix('name'), lat: ix('latitude_deg'), lon: ix('longitude_deg'), elev: ix('elevation_ft'),
      country: ix('iso_country'), city: ix('municipality'), sched: ix('scheduled_service'), iata: ix('iata_code'), kw: ix('keywords') };
    const info = new Map();
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]; if (!line) continue;
      const q = line.indexOf('"', line.indexOf(',') + 1); // citire rapidă a codului înainte de parsarea completă
      const id = line.slice(q + 1, line.indexOf('"', q + 1)).toUpperCase();
      if (!runwayMap.has(id)) continue;
      const f = splitCSV(line);
      if (f[I.type] === 'closed' || f[I.type] === 'heliport') continue;
      info.set(id, { apt: id, type: f[I.type], name: f[I.name], lat: +f[I.lat], lon: +f[I.lon], elevFt: +f[I.elev] || 0,
        country: f[I.country], city: f[I.city], sched: f[I.sched] === 'yes', iata: f[I.iata], kw: (f[I.kw] || '').slice(0, 120) });
    }
    return info;
  }

  const normTxt = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let regionNames = null;
  function initRegionNames() { try { regionNames = new Intl.DisplayNames([settings.lang === 'ro' ? 'ro' : 'en'], { type: 'region' }); } catch (e) { /* */ } }
  initRegionNames();
  const countryName = (iso) => { try { return (regionNames && iso && regionNames.of(iso)) || iso || ''; } catch (e) { return iso || ''; } };
  // nume românești de orașe → numele din baza de date (în engleză)
  const ALIASES = {
    bucuresti: 'bucharest', viena: 'vienna', londra: 'london', roma: 'rome', atena: 'athens', varsovia: 'warsaw', praga: 'prague',
    munchen: 'munich', moscova: 'moscow', lisabona: 'lisbon', bruxelles: 'brussels', copenhaga: 'copenhagen', belgrad: 'belgrade',
    budapesta: 'budapest', milano: 'milan', venetia: 'venice', napoli: 'naples', florenta: 'florence', nisa: 'nice', sevilla: 'seville',
    salonic: 'thessaloniki', haga: 'hague', varset: 'vrsac', germania: 'de', franta: 'fr', italia: 'it', spania: 'es', anglia: 'gb',
    romania: 'ro', grecia: 'gr', turcia: 'tr', ungaria: 'hu', bulgaria: 'bg', austria: 'at', elvetia: 'ch', olanda: 'nl', belgia: 'be',
    portugalia: 'pt', polonia: 'pl', cehia: 'cz', serbia: 'rs', moldova: 'md', ucraina: 'ua', croatia: 'hr', cipru: 'cy', malta: 'mt',
    zurich: 'zurich', geneva: 'geneva', istanbul: 'istanbul', dubai: 'dubai', paris: 'paris', madrid: 'madrid', berlin: 'berlin',
  };
  const TYPE_RANK = { large_airport: 300, medium_airport: 200, small_airport: 40, seaplane_base: 0, balloonport: 0 };

  function buildSearchIndex() {
    DB.search = [];
    for (const [apt, a] of DB.info) {
      const rws = DB.airports.get(apt); if (!rws) continue;
      a.maxLen = Math.max(...rws.map((r) => r.lenFt));
      a.countryName = countryName(a.country);
      DB.search.push({ a, text: normTxt([a.name, a.city, a.iata, apt, a.kw, a.countryName, a.country].join(' ')) });
    }
  }

  function searchAirports(q, lat, lon) {
    const toks = normTxt(q).split(/[\s,]+/).filter(Boolean).map((t) => ALIASES[t] || t);
    if (!toks.length) return [];
    const res = [];
    for (const s of DB.search) {
      const a = s.a;
      let score = 0, ok = true;
      for (const t of toks) {
        if (t.length === 2 && a.country.toLowerCase() === t) { score += 30; continue; }
        if (!s.text.includes(t)) { ok = false; break; }
        if (a.apt.toLowerCase() === t || (a.iata && a.iata.toLowerCase() === t)) score += 1000;
        if (normTxt(a.city).startsWith(t)) score += 120;
      }
      if (!ok) continue;
      score += (TYPE_RANK[a.type] || 0) + (a.sched ? 100 : 0) + Math.min(a.maxLen / 200, 60);
      if (lat != null) score -= distM(lat, lon, a.lat, a.lon) / NM / 50;
      res.push({ a, score });
    }
    res.sort((x, y) => y.score - x.score);
    return res.slice(0, 25).map((x) => x.a);
  }

  /** Eticheta prietenoasă: oraș + nume, nu doar codul. */
  function aptName(apt, long) {
    const a = DB.info.get(apt); if (!a) return apt;
    const city = a.city || a.name;
    return long ? `${a.name}${a.city && !normTxt(a.name).includes(normTxt(a.city)) ? ' – ' + a.city : ''}, ${a.countryName || a.country}` : city;
  }
  const DIRS = { ro: ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-vest', 'vest', 'nord-vest'], en: ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] };
  const dirWord = (brg) => DIRS[settings.lang === 'ro' ? 'ro' : 'en'][Math.round(norm360(brg) / 45) % 8];

  async function loadRunways() {
    if (DB.loaded || DB.loading) return;
    DB.loading = true;
    try {
      const cached = await idbGet('db');
      if (cached && cached.ver === CACHE_VER && Date.now() - cached.t < 30 * 864e5) {
        DB.airports = new Map(cached.rw); DB.info = new Map(cached.info);
      } else {
        ui.setStatus(L('Se descarcă baza de date cu aeroporturi și piste (doar prima dată, ~15 MB)…', 'Downloading the airport and runway database (first time only, ~15 MB)…'));
        const [rt, at] = await Promise.all([RUNWAYS_URL, AIRPORTS_URL].map(async (u) => {
          const res = await fetch(u); if (!res.ok) throw new Error('HTTP ' + res.status); return res.text();
        }));
        ui.setStatus(L('Se pregătește baza de date…', 'Preparing the database…'));
        await new Promise((r) => setTimeout(r, 30));
        DB.airports = parseRunways(rt);
        DB.info = parseAirports(at, DB.airports);
        idbSet('db', { ver: CACHE_VER, t: Date.now(), rw: [...DB.airports], info: [...DB.info] });
      }
      buildSearchIndex();
      DB.loaded = true;
      if (settings.atcRole === 'ctrl' && settings.atcStation) setTimeout(openAtcWindow, 500);
      ui.setStatus(L(`Bază de date gata: ${DB.info.size} aeroporturi. Caută după oraș sau nume.`, `Database ready: ${DB.info.size} airports. Search by city or name.`));
      ui.refreshNearest();
      TRIP.stops = TRIP.stops.filter((x) => DB.airports.has(x.apt));
      if (TRIP.stops.length) applyTripTarget();
    } catch (e) {
      DB.error = e; console.error('[GeoFS Copilot]', e);
      ui.setStatus(L('Nu am putut descărca baza de date (' + e.message + '). Reîncearcă din butonul „Reîncarcă baza”.', 'Could not download the database (' + e.message + '). Try again with “Reload database”.'));
    } finally { DB.loading = false; }
  }

  function nearestAirports(lat, lon, n = 12, filter, minLen = 2000) {
    const arr = [];
    for (const [apt, rws] of DB.airports) {
      const a = DB.info.get(apt);
      if (!a && minLen < 2000) continue; // pistele scurte doar pentru aeroporturi cunoscute (fără heliporturi)
      const maxLen = a ? a.maxLen : Math.max(...rws.map((r) => r.lenFt));
      if (maxLen < minLen) continue;
      if (filter && !filter(a, maxLen)) continue;
      arr.push({ apt, a, d: distM(lat, lon, rws[0].lat, rws[0].lon), maxLen });
    }
    arr.sort((x, y) => x.d - y.d);
    return arr.slice(0, n);
  }

  /** Destinații sugerate: aeroporturi mari/medii aflate la distanța aleasă. */
  function suggestDestinations(lat, lon, minNm, maxNm, needLen) {
    const out = [];
    for (const s of DB.search) {
      const a = s.a;
      if (a.type !== 'large_airport' && a.type !== 'medium_airport') continue;
      if (a.maxLen < needLen) continue;
      const d = distM(lat, lon, a.lat, a.lon) / NM;
      if (d < minNm || d > maxNm) continue;
      out.push({ a, d, w: (a.type === 'large_airport' ? 3 : 1) * (a.sched ? 2 : 1) * Math.random() });
    }
    out.sort((x, y) => y.w - x.w);
    return out.slice(0, 10).sort((x, y) => x.d - y.d);
  }

  /* =====================================================================
   *  ACCES LA STAREA AVIONULUI
   * ===================================================================== */
  const sim = {
    ac: () => geofs.aircraft.instance,
    v: () => geofs.animation.values,
    lla: () => geofs.aircraft.instance.llaLocation,
    altFt: () => geofs.aircraft.instance.llaLocation[2] / FT,
    hasAP: () => !!(geofs.aircraft.instance.definition && geofs.aircraft.instance.definition.autopilot),
    onGround: () => !!geofs.aircraft.instance.groundContact,
    paused: () => !!geofs.pause,
    flapsSteps: () => (geofs.aircraft.instance.definition && geofs.aircraft.instance.definition.flapsSteps) || 0,
  };

  // Calculează direcția reală de deplasare (track) din pozițiile recente.
  const trackBuf = [];
  let trackDeg = null;
  function updateTrack() {
    const [lat, lon] = sim.lla(); const t = performance.now();
    trackBuf.push({ t, lat, lon });
    while (trackBuf.length > 2 && t - trackBuf[0].t > 1500) trackBuf.shift();
    const a = trackBuf[0];
    if (distM(a.lat, a.lon, lat, lon) > 8) trackDeg = bearing(a.lat, a.lon, lat, lon);
    else trackDeg = null;
  }

  /* =====================================================================
   *  APROPIERE: CONSTRUCȚIE, DESEN 3D, GHIDARE
   * ===================================================================== */
  const AP = {
    rwy: null,           // capătul de pistă ales
    thrElevM: null,      // elevația pragului în sistemul de coordonate GeoFS
    legs: [],            // waypoint-uri
    legIdx: 0,
    active: false,       // ghidarea cuplată la autopilot
    phase: 'OFF',        // OFF, NAV, LOC, GS, FLARE, ROLLOUT, MAN
    entities: [],
    vapp: 140,
    calls: {},
    guide: null,
    full: false,
    cruiseFt: 0,
    cruiseSpd: 0,
  };

  function suggestedVapp() {
    const d = sim.ac().definition || {};
    if (settings.vapp > 0) return settings.vapp;
    if (d.minimumSpeed) return Math.round(clamp(d.minimumSpeed * 1.3, 55, 170));
    return 140;
  }

  function gpAltM(distBeforeThrM) { // altitudinea pe panta de coborâre
    return AP.thrElevM + settings.tchFt * FT + Math.max(0, distBeforeThrM) * Math.tan(settings.gsDeg * D2R);
  }

  function selectRunway(rwy) {
    if (!rwy) return;
    AP.rwy = rwy; AP.thrElevM = rwy.elevFt * FT; AP.vapp = suggestedVapp();
    if (AP.active && (AP.phase === 'LOC' || AP.phase === 'GS')) AP.phase = 'NAV'; // pistă schimbată în apropiere
    buildRoute();
    planCruise();
    drawApproach();
    // Elevația exactă a pragului din terenul GeoFS (în același sistem cu altitudinea avionului)
    try {
      geofs.api.getGuarantiedGroundAltitude([rwy.lat, rwy.lon, 0]).then((r) => {
        const h = r && r[0] && r[0].height;
        if (typeof h === 'number' && !isNaN(h) && AP.rwy === rwy) {
          AP.thrElevM = h; buildRoute(); planCruise(); drawApproach(); ui.renderNav();
        }
      }).catch(() => {});
    } catch (e) { /* ignorat */ }
    ui.renderNav();
  }

  function buildRoute() {
    const r = AP.rwy; if (!r) return;
    const back = norm360(r.hdg + 180);
    const fafD = settings.fafNm * NM, ifD = fafD + 4 * NM;
    const fafAlt = gpAltM(fafD);
    const [fLat, fLon] = destPoint(r.lat, r.lon, back, fafD);
    const [iLat, iLon] = destPoint(r.lat, r.lon, back, ifD);
    const legs = [];
    const [lat, lon] = sim.lla();
    // escale doar de survolat (fără aterizare) înainte de destinația curentă
    let fromLat = lat, fromLon = lon;
    if (typeof tripVias === 'function') tripVias().forEach((s) => {
      const a = DB.info.get(s.apt); const rw = DB.airports.get(s.apt);
      const la = a ? a.lat : rw && rw[0].lat, lo = a ? a.lon : rw && rw[0].lon; if (la == null) return;
      legs.push({ name: aptName(s.apt), lat: la, lon: lo, alt: fafAlt, via: true }); fromLat = la; fromLon = lo;
    });
    const ac = alongCross(r.lat, r.lon, r.hdg, fromLat, fromLon);
    // Dacă avionul nu e deja în spatele punctului IF, trecem întâi printr-un punct lateral (bază),
    // ca să intrăm pe aliniament din lateral, ca pe un circuit real.
    const aligned = fromLat === lat && fromLon === lon && -ac.along > 2 * NM && Math.abs(ac.cross) < 1.5 * NM &&
      Math.abs(norm180(sim.v().heading - r.hdg)) < 45 && !sim.onGround();
    if (aligned) { // deja pe finală: fără circuit, direct pe ax
      if (-ac.along > fafD + 0.5 * NM) legs.push({ name: 'FAF', lat: fLat, lon: fLon, alt: fafAlt });
      legs.push({ name: L('PRAG ', 'THR ') + r.ident, lat: r.lat, lon: r.lon, alt: AP.thrElevM + settings.tchFt * FT, thr: true });
      legs.push({ name: L('CAPĂT', 'END'), lat: r.endLat, lon: r.endLon, alt: AP.thrElevM, end: true });
      AP.legs = legs; AP.legIdx = 0; AP.start = { lat, lon };
      AP.fafAlt = fafAlt; AP.fafD = fafD; AP.ifD = ifD;
      return;
    }
    if (-ac.along < ifD + 1 * NM || Math.abs(ac.cross) > -ac.along) {
      const side = ac.cross >= 0 ? 1 : -1;
      const [bLat0, bLon0] = destPoint(r.lat, r.lon, back, ifD);
      const [bLat, bLon] = destPoint(bLat0, bLon0, norm360(r.hdg + 90 * side), 4 * NM);
      if (distM(fromLat, fromLon, bLat, bLon) > 3 * NM) legs.push({ name: L('BAZĂ', 'BASE'), lat: bLat, lon: bLon, alt: fafAlt + 500 * FT });
    }
    legs.push({ name: 'IF', lat: iLat, lon: iLon, alt: fafAlt });
    legs.push({ name: 'FAF', lat: fLat, lon: fLon, alt: fafAlt });
    legs.push({ name: L('PRAG ', 'THR ') + r.ident, lat: r.lat, lon: r.lon, alt: AP.thrElevM + settings.tchFt * FT, thr: true });
    legs.push({ name: L('CAPĂT', 'END'), lat: r.endLat, lon: r.endLon, alt: AP.thrElevM, end: true });
    AP.legs = legs; AP.legIdx = 0; AP.start = { lat, lon };
    AP.fafAlt = fafAlt; AP.fafD = fafD; AP.ifD = ifD;
  }

  function clearEntities() {
    const v = geofs.api.viewer;
    AP.entities.forEach((e) => { try { v.entities.remove(e); } catch (x) { /* */ } });
    AP.entities = [];
  }
  function addLine(points, color, width, geodesic) {
    const pos = Cesium.Cartesian3.fromDegreesArrayHeights(points.flatMap((p) => [p[1], p[0], p[2]]));
    const e = geofs.api.viewer.entities.add({
      polyline: { positions: pos, width: width || 2, material: color, arcType: Cesium.ArcType ? (geodesic ? Cesium.ArcType.GEODESIC : Cesium.ArcType.NONE) : undefined, followSurface: !!geodesic },
    });
    AP.entities.push(e);
  }

  function drawApproach() {
    clearEntities();
    const r = AP.rwy; if (!r || !settings.drawTunnel) return;
    const back = norm360(r.hdg + 180);
    const magenta = Cesium.Color.MAGENTA.withAlpha(0.9);
    const cyan = Cesium.Color.CYAN.withAlpha(0.75);
    const green = Cesium.Color.LIME.withAlpha(0.85);
    // Traseul ideal: legs anterioare FAF la altitudinea de interceptare, apoi panta până la prag
    const pts = [];
    AP.legs.forEach((l) => { if (!l.end) pts.push([l.lat, l.lon, l.via && AP.cruiseFt ? AP.cruiseFt * FT : l.alt]); });
    addLine(pts, magenta, 3, true);
    // Prelungirea axului pistei pe sol (10 NM)
    const [eLat, eLon] = destPoint(r.lat, r.lon, back, 10 * NM);
    addLine([[r.lat, r.lon, AP.thrElevM + 2], [eLat, eLon, AP.thrElevM + 2]], cyan, 2);
    addLine([[r.lat, r.lon, AP.thrElevM + 2], [r.endLat, r.endLon, AP.thrElevM + 2]], green, 4);
    // Culoarul (porți dreptunghiulare) de la IF până la prag
    const step = 0.5 * NM;
    for (let d = AP.ifD; d >= 0.2 * NM; d -= step) {
      const [cLat, cLon] = destPoint(r.lat, r.lon, back, d);
      const alt = Math.max(gpAltM(d), d > AP.fafD ? AP.fafAlt : 0);
      const hw = 45 + d * Math.tan(0.9 * D2R), hh = 15 + d * Math.tan(0.3 * D2R);
      const [lLat, lLon] = destPoint(cLat, cLon, norm360(r.hdg - 90), hw);
      const [rLat, rLon] = destPoint(cLat, cLon, norm360(r.hdg + 90), hw);
      const col = d <= AP.fafD ? magenta : cyan;
      addLine([[lLat, lLon, alt + hh], [rLat, rLon, alt + hh], [rLat, rLon, alt - hh], [lLat, lLon, alt - hh], [lLat, lLon, alt + hh]], col, 2);
    }
    try { geofs.api.viewer.scene.requestRender(); } catch (e) { /* */ }
  }

  /** Calculul deviațiilor față de aliniament și pantă (ca un ILS). */
  function approachState() {
    const r = AP.rwy; if (!r) return null;
    const [lat, lon, altM] = sim.lla();
    const ac = alongCross(r.lat, r.lon, r.hdg, lat, lon);
    const distBefore = -ac.along;                                  // m până la prag (pozitiv = înainte de prag)
    const locRef = distBefore + r.lenFt * FT + 300;                 // antena LOC e după capătul pistei
    const locDevDeg = Math.atan2(ac.cross, Math.max(locRef, 100)) * R2D; // + = avion în dreapta axei
    const gsRef = Math.max(distBefore + 300, 60);                  // antena GS ~300 m după prag
    const gpAngle = Math.atan2(altM - AP.thrElevM, gsRef) * R2D;
    const gsDevDeg = gpAngle - settings.gsDeg;                      // + = avion deasupra pantei
    const hatFt = (altM - AP.thrElevM) / FT;                        // înălțimea față de prag
    const gpTargetFt = gpAltM(distBefore) / FT;
    return {
      ac, distBefore, locDevDeg, gsDevDeg, hatFt, gpTargetFt,
      locDots: clamp(locDevDeg / 1.0, -2.5, 2.5),                   // 1 punct ≈ 1°
      gsDots: clamp(gsDevDeg / 0.35, -2.5, 2.5),                    // 1 punct ≈ 0.35°
      distNm: distM(lat, lon, r.lat, r.lon) / NM,
    };
  }

  function apOn() {
    if (!sim.hasAP()) return false;
    if (!geofs.autopilot.on) geofs.autopilot.turnOn();
    try { geofs.autopilot.setMode('HDG'); } catch (e) { /* */ }
    return geofs.autopilot.on;
  }
  function setVS(v) { // VS direct (ft/min) – folosim modul VNAV intern al autopilotului GeoFS
    const d = geofs.autopilot.definition || { maxDescentrate: -6000, maxClimbrate: 6000 };
    let x = Math.round(clamp(v, d.maxDescentrate, d.maxClimbrate));
    if (x === 0) x = -1;
    geofs.autopilot.VNAV = true;
    geofs.autopilot.values.verticalSpeed = x;
  }
  function releaseVS() { geofs.autopilot.VNAV = false; }

  function isLight() { return AP.vapp <= 95; }
  /** Altitudinea și viteza de croazieră, în funcție de distanță și de avion. */
  function planCruise() {
    const r = AP.rwy; if (!r) return;
    const [lat, lon] = sim.lla();
    const dNm = (AP.legs.length ? remainingPathM(lat, lon) : distM(lat, lon, r.lat, r.lon)) / NM;
    const thrFt = AP.thrElevM / FT;
    const cap = isLight() ? 9500 : 37000;
    const base = Math.max(thrFt, (sim.v().groundElevationFeet || 0));
    let alt = base + clamp(dNm * 150, 3000, cap);
    alt = Math.min(Math.round(alt / 500) * 500, cap);
    alt = Math.max(alt, Math.ceil((AP.fafAlt / FT + 1000) / 500) * 500);
    AP.cruiseFt = settings.cruiseFt > 0 ? settings.cruiseFt : alt;
    AP.cruiseSpd = settings.cruiseSpd > 0 ? settings.cruiseSpd : (isLight() ? Math.round(AP.vapp * 1.7) : 270);
  }
  function vrSpeed() {
    const d = sim.ac().definition || {};
    return Math.round(d.minimumSpeed ? d.minimumSpeed * 1.05 : AP.vapp * 0.95);
  }

  function engage() { // doar apropierea, de unde ești acum
    if (!AP.rwy) { ui.toast(L('Alege mai întâi destinația.', 'Choose a destination first.')); return; }
    AP.full = false;
    if (sim.onGround()) { ui.toast(L('Ești la sol – pentru tot zborul folosește „Zbor complet”.', 'You are on the ground – use “Full flight” for the whole trip.')); }
    if (!apOn()) { ui.toast(L('Avionul ăsta nu are autopilot în GeoFS. Urmează instrucțiunile din HUD și de pe hartă.', 'This aircraft has no autopilot in GeoFS. Follow the instructions on the HUD and the map.')); AP.active = false; AP.phase = 'MAN'; }
    else { AP.active = true; AP.phase = 'NAV'; }
    AP.vapp = suggestedVapp(); buildRoute(); drawApproach();
    if (geofs.autopilot.definition) geofs.autopilot.definition.maxBankAngle = settings.bankMax;
    ui.toast(L(`Apropiere activă: ${aptName(AP.rwy.apt)}, pista ${AP.rwy.ident}. Vapp ${AP.vapp} kt.`, `Approach active: ${aptName(AP.rwy.apt)}, runway ${AP.rwy.ident}. Vapp ${AP.vapp} kt.`));
    say(`Approach armed, runway ${AP.rwy.ident.split('').join(' ')}`);
    ui.renderNav();
  }
  function engageFull() { // decolare → croazieră → coborâre → apropiere → aterizare
    if (!AP.rwy) { ui.toast(L('Alege mai întâi destinația.', 'Choose a destination first.')); return; }
    if (MISSION && MISSION.state === 'boarding') { ui.toast(L(`Îmbarcarea mai durează ${Math.ceil((MISSION.boardEnd - Date.now()) / 1000)} s.`, `Boarding takes ${Math.ceil((MISSION.boardEnd - Date.now()) / 1000)} more seconds.`)); return; }
    if (settings.fuelOn && sim.onGround()) {
      if (FUEL.kg <= 0) { ui.toast(L('Rezervorul e gol – alimentează din tab-ul Misiuni.', 'The tank is empty – refuel in the Missions tab.')); return; }
      buildRoute(); const need = fuelNeededKg();
      if (need && FUEL.kg < need) ui.toast(L(`Atenție: combustibil ${Math.round(FUEL.kg)} kg, necesar ~${need} kg. Alimentează din tab-ul Misiuni!`, `Warning: fuel ${Math.round(FUEL.kg)} kg, needed ~${need} kg. Refuel in the Missions tab!`), 9000);
    }
    AP.full = true; AP.flapsUp = false; AP.vapp = suggestedVapp();
    buildRoute(); planCruise(); drawApproach();
    if (geofs.autopilot.definition) geofs.autopilot.definition.maxBankAngle = settings.bankMax;
    if (sim.onGround() && settings.autoTakeoff && sim.hasAP()) {
      if (atcHoldForTakeoff()) return; // așteptăm autorizarea de decolare
      if (!autoTakeoffStart()) {
        const near = nearestAirports(...sim.lla().slice(0, 2), 1)[0];
        const dep = near && near.d < 4 * NM ? bestRunwayForDeparture(near.apt) : null;
        if (!dep) { ui.toast(L('Nu ești pe o pistă și nu e niciun aeroport aproape. Pune avionul pe o pistă.', 'You are not on a runway and there is no airport nearby. Put the aircraft on a runway.')); AP.full = false; return; }
        AP.phase = 'MAN'; AP.active = false;
        positionOnRunway(dep, () => { if (!autoTakeoffStart()) ui.toast(L('Nu am reușit să aliniez avionul pe pistă. Încearcă din nou „Zbor complet”.', 'Could not line the aircraft up on the runway. Try “Full flight” again.')); });
      }
      return;
    }
    if (sim.onGround()) {
      AP.active = true; AP.phase = 'TAKEOFF';
      ui.toast(L(`Gata de decolare spre ${aptName(AP.rwy.apt)}. Motor la maxim, iar la ${vrSpeed()} kt trage ușor de manșă. `, `Ready for takeoff to ${aptName(AP.rwy.apt)}. Full power, and at ${vrSpeed()} kt pull back gently. `) + (sim.hasAP() ? L('La 400 ft preia autopilotul.', 'The autopilot takes over at 400 ft.') : ''), 9000);
      say('Ready for takeoff');
    } else if (!apOn()) {
      AP.active = false; AP.phase = 'MAN';
      ui.toast(L('Avionul ăsta nu are autopilot. Urmează instrucțiunile din HUD și de pe hartă.', 'This aircraft has no autopilot. Follow the instructions on the HUD and the map.'));
    } else {
      AP.active = true; AP.phase = 'NAV'; releaseVS();
      geofs.autopilot.setSpeed(settings.limit250 && sim.altFt() < 10000 ? Math.min(AP.cruiseSpd, 250) : AP.cruiseSpd); AP.lastCmdSpd = geofs.autopilot.values.speed; AP.userSpd = null;
      ui.toast(L(`Zbor automat spre ${aptName(AP.rwy.apt)} · croazieră ${AP.cruiseFt} ft / ${AP.cruiseSpd} kt.`, `Automatic flight to ${aptName(AP.rwy.apt)} · cruise ${AP.cruiseFt} ft / ${AP.cruiseSpd} kt.`));
    }
    ui.renderNav();
  }
  function disengage(silent) {
    if (TO.active) { autoTakeoffAbort(L('oprită de pilot.', 'stopped by the pilot.')); return; }
    if (AP.active) { try { releaseVS(); } catch (e) { /* */ } }
    AP.active = false; AP.full = false; AP.phase = AP.rwy ? 'MAN' : 'OFF';
    if (!silent) ui.toast(L('Ghidarea automată a fost oprită (instrucțiunile din HUD rămân).', 'Automatic guidance stopped (HUD instructions remain).'));
    ui.renderNav();
  }

  function setFlaps(n) {
    const steps = sim.flapsSteps(); if (!steps) return;
    n = clamp(Math.round(n), 0, steps);
    if (controls.flaps.target === n) return;
    controls.flaps.target = n;
    controls.setters.setFlaps.set();
  }

  function takeoffTick() {
    const v = sim.v();
    if (sim.onGround()) return; // instrucțiunile de decolare sunt în HUD
    if ((v.haglFeet || 0) > 400 && (v.verticalSpeed || 0) > 0) {
      if (settings.autoConfig && controls.gear.target === 0) { controls.setters.setGearUp.set(); say('Gear up'); }
      if (!apOn()) { AP.active = false; AP.phase = 'MAN'; ui.toast(L('Avionul nu are autopilot – urmează instrucțiunile din HUD și de pe hartă.', 'This aircraft has no autopilot – follow the instructions on the HUD and the map.')); ui.renderNav(); return; }
      buildRoute(); drawApproach(); releaseVS();
      geofs.autopilot.setSpeed(settings.limit250 ? Math.min(AP.cruiseSpd, 250) : AP.cruiseSpd); AP.lastCmdSpd = geofs.autopilot.values.speed; AP.userSpd = null;
      AP.phase = 'NAV';
      say('Autopilot engaged');
      ui.toast(L(`Autopilot cuplat: urcăm la ${AP.cruiseFt} ft și zburăm spre ${aptName(AP.rwy.apt)}.`, `Autopilot engaged: climbing to ${AP.cruiseFt} ft and flying to ${aptName(AP.rwy.apt)}.`), 7000);
      ui.renderNav();
    }
  }

  /** Bucla de ghidare – rulează de 10 ori pe secundă. Calculează mereu instrucțiunile
   *  (pentru HUD și hartă) și, dacă ghidarea automată e activă, comandă autopilotul. */
  function guidanceTick() {
    const st = approachState(); if (!st || !AP.legs.length) { AP.guide = null; return; }
    const v = sim.v(); const r = AP.rwy; const ap = geofs.autopilot;
    const [lat, lon, altM] = sim.lla();
    const gsMs = sim.ac().groundSpeed || v.groundSpeed || 0;
    const hdg = norm360(v.heading);
    const airborne = !sim.onGround();

    // ---------- Secvențierea punctelor ----------
    let leg = AP.legs[AP.legIdx];
    if (airborne) {
      const prev = AP.legIdx === 0 ? AP.start : AP.legs[AP.legIdx - 1];
      const legCrs0 = bearing(prev.lat, prev.lon, leg.lat, leg.lon);
      const toLeg = alongCross(leg.lat, leg.lon, legCrs0, lat, lon);   // along < 0 înainte de punct
      const nextLeg = AP.legs[AP.legIdx + 1];
      if (!leg.thr && !leg.end) {
        let anticip = 0.3 * NM;
        if (nextLeg) { // anticipăm virajul: rază ≈ v²/(g·tan(bank))
          const turn = Math.abs(norm180(bearing(leg.lat, leg.lon, nextLeg.lat, nextLeg.lon) - legCrs0));
          const radius = (gsMs * gsMs) / (9.81 * Math.tan(settings.bankMax * D2R));
          anticip = Math.max(anticip, radius * Math.tan(Math.min(turn, 120) * D2R / 2));
        }
        const near = distM(lat, lon, leg.lat, leg.lon) < 15 * NM;
        if (near && toLeg.along > -anticip) { AP.legIdx++; leg = AP.legs[AP.legIdx]; ui.toast(L('Următorul punct: ', 'Next waypoint: ') + leg.name); }
      } else if (leg.thr && st.distBefore < 0) { AP.legIdx++; leg = AP.legs[AP.legIdx]; }
    }

    // ---------- Lateral ----------
    const onFinal = leg.thr || leg.end || leg.name === 'FAF';
    const legDist = distM(lat, lon, leg.lat, leg.lon);
    let desiredTrack;
    if (onFinal) {
      const L = Math.max(1000, gsMs * 22);
      desiredTrack = r.hdg + clamp(-Math.atan2(st.ac.cross, L) * R2D, -35, 35);
      if (AP.active && AP.phase === 'NAV' && Math.abs(st.ac.cross) < 2 * NM && Math.abs(norm180(hdg - r.hdg)) < 60) { AP.phase = 'LOC'; say('Localizer captured'); }
    } else if (legDist > 20 * NM || legDist < 1.5 * NM) {
      desiredTrack = bearing(lat, lon, leg.lat, leg.lon); // direct (pe ortodromă) spre punct
    } else {
      const p2 = AP.legIdx === 0 ? AP.start : AP.legs[AP.legIdx - 1];
      const legCrs = bearing(p2.lat, p2.lon, leg.lat, leg.lon);
      const xt = alongCross(p2.lat, p2.lon, legCrs, lat, lon).cross;
      desiredTrack = legCrs + clamp(-Math.atan2(xt, Math.max(1500, gsMs * 30)) * R2D, -45, 45);
    }
    let wca = 0; // corecția de vânt: diferența dintre cap și drumul real
    if (trackDeg != null && gsMs > 25) wca = clamp(norm180(hdg - trackDeg), -25, 25);
    AP.wca = AP.wca == null ? wca : AP.wca * 0.9 + wca * 0.1;
    let desiredHdg = norm360(desiredTrack + AP.wca);

    // ---------- Vertical: ținta de altitudine ----------
    const altFt = altM / FT, gsKt = gsMs / KT;
    const fafFt = AP.fafAlt / FT;
    const pathRemain = remainingPathM(lat, lon);
    const inGS = AP.phase === 'GS' || (onFinal && st.distBefore < AP.fafD + 0.6 * NM && altFt >= st.gpTargetFt - 60 && st.distBefore > 0);
    const profileFt = (AP.thrElevM + pathRemain * Math.tan(settings.gsDeg * D2R)) / FT + 300;
    let tgtFt;
    if (inGS) tgtFt = st.gpTargetFt;
    else {
      const ceiling = (AP.full || !AP.active) && AP.cruiseFt ? AP.cruiseFt : Math.max(altFt, fafFt);
      tgtFt = Math.max(fafFt, Math.min(ceiling, profileFt));
      // protecție la teren: dacă solul e prea aproape departe de pistă, urcăm
      if (airborne && v.haglFeet < 1000 && st.distBefore > AP.fafD + 2 * NM) tgtFt = Math.max(tgtFt, altFt + 1500);
    }
    const todNm = AP.cruiseFt ? Math.max(0, pathRemain - (AP.cruiseFt - 300 - AP.thrElevM / FT) * FT / Math.tan(settings.gsDeg * D2R)) / NM : null;
    AP.guide = { track: desiredTrack, hdg: desiredHdg, tgtFt, leg, legDistNm: legDist / NM, inGS, onFinal, todNm, pathNm: pathRemain / NM };

    if (AP.phase === 'TAKEOFF') { takeoffTick(); return; }
    if (AP.phase === 'AUTOTO' || AP.phase === 'STOPOVER' || AP.phase === 'WAITTO') return;
    if (!AP.active) return;
    if (!ap.on && AP.phase !== 'ROLLOUT') { AP.active = false; AP.phase = 'MAN'; releaseVS(); ui.toast(L('Autopilotul a fost decuplat – ghidare automată oprită (instrucțiunile rămân în HUD).', 'Autopilot disconnected – automatic guidance stopped (instructions remain on the HUD).')); ui.renderNav(); return; }
    const atcRes = atcGuidance(st); // vectori de la controlor / ratare / autorizare de aterizare
    if (atcRes === true) return;
    if (atcRes === 'GA') { ap.setCourse(desiredHdg, true); return; }

    if (AP.phase === 'FLARE' || AP.phase === 'ROLLOUT') {
      // tratat mai jos
    } else if (inGS) {
      if (AP.phase !== 'GS') { AP.phase = 'GS'; say('Glideslope captured'); }
      const nominal = -gsKt * 101.27 * Math.tan(settings.gsDeg * D2R);
      setVS(nominal + clamp((st.gpTargetFt - altFt) * 4, -900, 600));
    } else {
      releaseVS();
      ap.setAltitude(Math.round(tgtFt / 10) * 10);
      if (tgtFt < altFt - 300) { // coborâre: rată proporțională cu viteza față de sol
        setVS(-clamp(gsKt * 101.27 * Math.tan(settings.gsDeg * D2R) * 1.3, 700, 2500));
        if (altFt - tgtFt < 400) releaseVS();
      }
    }

    // ---------- Viteză și configurație ----------
    const vapp = AP.vapp;
    const cap = (spd) => (settings.limit250 && altFt < 10000 ? Math.min(spd, 250) : spd);
    const setSpd = (spd) => { ap.setSpeed(spd); AP.lastCmdSpd = spd; };
    // viteza schimbată de pilot (din panoul GeoFS sau al pluginului) se respectă în croazieră
    if (AP.lastCmdSpd != null && Math.abs(ap.values.speed - AP.lastCmdSpd) > 1) { AP.userSpd = ap.values.speed; AP.lastCmdSpd = ap.values.speed; }
    const nearApp = st.distBefore < AP.ifD + 3 * NM && st.distBefore > -1 * NM && AP.legIdx >= AP.legs.findIndex((l) => l.name === 'IF');
    if (AP.phase === 'GS' || (onFinal && st.distBefore < AP.fafD)) {
      AP.userSpd = null;
      if (ap.values.speed > vapp) setSpd(vapp);
    } else if (nearApp) {
      AP.userSpd = null;
      if (ap.values.speed > vapp + 30) setSpd(vapp + 30);
    } else if (AP.full) {
      if (AP.userSpd != null) { if (ap.values.speed !== cap(AP.userSpd)) setSpd(cap(AP.userSpd)); }
      else {
        const want = cap(AP.cruiseSpd);
        const slow = pathRemain < 25 * NM ? Math.min(want, isLight() ? want : 210) : want;
        if (Math.abs(ap.values.speed - slow) > 2) setSpd(slow);
      }
      if (!AP.flapsUp && v.kias > vapp + 25 && v.haglFeet > 1000) { setFlaps(0); AP.flapsUp = true; }
    } else if (settings.limit250 && altFt < 10000 && ap.values.speed > 250) setSpd(250);
    if (settings.autoConfig) {
      const steps = sim.flapsSteps();
      if (nearApp && st.distBefore > 0 && steps) setFlaps(Math.max(controls.flaps.target, Math.ceil(steps / 3)));
      if (AP.phase === 'GS' && st.distBefore < AP.fafD + 0.3 * NM) {
        if (controls.gear.target === 1) { controls.setters.setGearDown.set(); say('Gear down'); }
        if (steps) setFlaps(Math.max(controls.flaps.target, steps - 1));
      }
      if (AP.phase === 'GS' && st.hatFt < 1200 && steps) setFlaps(steps);
    }

    // ---------- Minime / flare / aterizare ----------
    const radioFt = Math.min(st.hatFt, v.haglFeet != null ? v.haglFeet : st.hatFt);
    if (AP.phase === 'GS' && !settings.autoland && st.hatFt < settings.minimumsFt) {
      say('Minimums'); releaseVS(); ap.turnOff(); AP.active = false; AP.phase = 'MAN';
      ui.toast(L('MINIME – autopilot decuplat. Aterizează manual: ține avionul pe ax, redu motorul și fă flare-ul.', 'MINIMUMS – autopilot off. Land manually: stay on the centerline, reduce power and flare.'));
      ui.renderNav(); return;
    }
    if (settings.autoland) {
      if (AP.phase === 'GS' && radioFt < 40 && st.distBefore < 1500) { AP.phase = 'FLARE'; say('Flare'); }
      if (AP.phase === 'FLARE') {
        // păstrăm corecția de vânt până aproape de sol, apoi aliniem botul cu axul (decrab)
        if (radioFt < 12) desiredHdg = norm360(r.hdg + clamp(-st.ac.cross * 0.8, -4, 4));
        ap.setSpeed(0);                // motor la ralanti
        setVS(radioFt > 25 ? -450 : radioFt > 10 ? -250 : -150);
        if (sim.onGround()) {
          AP.phase = 'ROLLOUT'; ap.turnOff(); releaseVS();
          controls.throttle = 0;
          if (controls.airbrakes && controls.airbrakes.target === 0) controls.setters.setAirbrakes.set();
          ui.toast(L('Contact cu pista – frânare automată.', 'Touchdown – automatic braking.'));
        }
      }
    }
    if (AP.phase === 'ROLLOUT') {
      controls.throttle = 0; controls.brakes = 1; sim.ac().brakesOn = true;
      if ((v.groundSpeedKnt || 0) < 15) { controls.brakes = 0; sim.ac().brakesOn = false; AP.active = false; AP.full = false; AP.phase = 'MAN'; ui.toast(L('Aterizare încheiată. Bun venit la ', 'Landing complete. Welcome to ') + aptName(r.apt) + '!'); ui.renderNav(); }
      return;
    }
    ap.setCourse(desiredHdg, true);
  }

  function remainingPathM(lat, lon) {
    let d = 0, pLat = lat, pLon = lon;
    for (let i = AP.legIdx; i < AP.legs.length; i++) {
      const l = AP.legs[i]; if (l.end) break;
      d += distM(pLat, pLon, l.lat, l.lon); pLat = l.lat; pLon = l.lon;
    }
    return d;
  }

  /* =====================================================================
   *  PLAN DE ZBOR CU ESCALE
   *  stops: [{apt, mode:'land'|'via'}] – 'land' = aterizare (escală), 'via' = doar survol.
   *  Ultimul punct e mereu destinația finală (aterizare).
   * ===================================================================== */
  const TRIP = { stops: (settings.trip || []).filter((s) => s && s.apt), from: 0, wasAirborne: false, departAt: 0 };
  const saveTrip = () => { settings.trip = TRIP.stops; saveSettings(); };
  function tripTargetIdx() {
    for (let i = TRIP.from; i < TRIP.stops.length; i++) if (TRIP.stops[i].mode !== 'via' || i === TRIP.stops.length - 1) return i;
    return -1;
  }
  function tripVias() { const t = tripTargetIdx(); return t < 0 ? [] : TRIP.stops.slice(TRIP.from, t); }
  function applyTripTarget() {
    const t = tripTargetIdx();
    if (t < 0 || !DB.loaded) { ui.renderTrip && ui.renderTrip(); return; }
    const apt = TRIP.stops[t].apt;
    if (!AP.rwy || AP.rwy.apt !== apt) selectRunway(bestRunway(apt));
    else { buildRoute(); planCruise(); drawApproach(); }
    ui.showAirport(apt);
    ui.renderTrip && ui.renderTrip();
  }
  function setSingleDestination(apt) {
    TRIP.stops = [{ apt, mode: 'land' }]; TRIP.from = 0; saveTrip();
    applyTripTarget();
    ui.toast(L(`Destinație: ${aptName(apt, true)} · pista ${AP.rwy ? AP.rwy.ident : '?'}`, `Destination: ${aptName(apt, true)} · runway ${AP.rwy ? AP.rwy.ident : '?'}`));
  }
  function addStop(apt) {
    if (!TRIP.stops.length || TRIP.from >= TRIP.stops.length) { setSingleDestination(apt); return; }
    TRIP.stops.push({ apt, mode: 'land' }); saveTrip();
    applyTripTarget();
    ui.toast(L(`Adăugat în plan: ${aptName(apt)}. ${TRIP.stops.length > 1 ? aptName(TRIP.stops[TRIP.stops.length - 2].apt) + ' devine escală.' : ''}`, `Added to the plan: ${aptName(apt)}. ${TRIP.stops.length > 1 ? aptName(TRIP.stops[TRIP.stops.length - 2].apt) + ' becomes a stopover.' : ''}`));
  }
  function removeStop(i) {
    TRIP.stops.splice(i, 1); if (i < TRIP.from) TRIP.from--;
    saveTrip();
    if (!TRIP.stops.length) { disengage(true); AP.rwy = null; AP.legs = []; AP.phase = 'OFF'; clearEntities(); ui.renderNav(); ui.renderTrip(); return; }
    applyTripTarget();
  }
  function moveStop(i, d) {
    const j = i + d; if (j < TRIP.from || j >= TRIP.stops.length) return;
    [TRIP.stops[i], TRIP.stops[j]] = [TRIP.stops[j], TRIP.stops[i]]; saveTrip(); applyTripTarget();
  }
  function toggleStopMode(i) {
    if (i === TRIP.stops.length - 1) { ui.toast(L('Destinația finală e mereu cu aterizare.', 'The final destination always includes a landing.')); return; }
    TRIP.stops[i].mode = TRIP.stops[i].mode === 'via' ? 'land' : 'via'; saveTrip(); applyTripTarget();
  }

  /** Detectează aterizarea la ținta curentă și pornește escala sau încheie călătoria. */
  function tripTick() {
    if (!AP.rwy || !TRIP.stops.length) return;
    const v = sim.v();
    if (!sim.onGround()) { TRIP.wasAirborne = true; return; }
    if (AP.phase === 'STOPOVER') {
      controls.throttle = 0; controls.brakes = 1; sim.ac().brakesOn = true;
      if (Date.now() >= TRIP.departAt) departStopover();
      return;
    }
    if (!TRIP.wasAirborne || (v.groundSpeedKnt || 0) > 20 || AP.phase === 'AUTOTO') return;
    const st = approachState(); if (!st || st.distNm > 3) return;
    TRIP.wasAirborne = false;
    const t = tripTargetIdx(); if (t < 0) return;
    const here = TRIP.stops[t].apt;
    TRIP.from = t + 1; TRIP.lastApt = here;
    if (TRIP.from >= TRIP.stops.length) {
      AP.active = false; AP.full = false; AP.phase = 'MAN';
      ui.toast(L(`Ai ajuns la destinația finală: ${aptName(here)}. Felicitări!`, `You have reached your final destination: ${aptName(here)}. Congratulations!`), 9000); say('Welcome to destination');
      ui.renderTrip(); ui.renderNav(); return;
    }
    if (geofs.autopilot.on) geofs.autopilot.turnOff();
    releaseVS();
    AP.active = true; AP.full = false; AP.phase = 'STOPOVER';
    TRIP.departAt = Date.now() + settings.stopoverSec * 1000;
    applyTripTarget(); // ținta devine următoarea escală
    ui.toast(L(`Escală la ${aptName(here)}. Plecăm spre ${aptName(AP.rwy.apt)} în ${settings.stopoverSec} s (Shift+P = acum).`, `Stopover at ${aptName(here)}. Departing for ${aptName(AP.rwy.apt)} in ${settings.stopoverSec} s (Shift+P = now).`), 8000);
    say('Stopover');
    ui.renderNav();
  }
  function departStopover() {
    const here = TRIP.lastApt || (nearestAirports(...sim.lla().slice(0, 2), 1)[0] || {}).apt;
    const dep = bestRunwayForDeparture(here);
    AP.phase = 'MAN'; AP.active = false;
    if (!dep) { ui.toast(L('Nu am găsit pista de decolare. Pornește manual cu „Zbor complet”.', 'No departure runway found. Start manually with “Full flight”.')); return; }
    positionOnRunway(dep, () => engageFull());
  }

  /* =====================================================================
   *  DECOLARE AUTOMATĂ
   *  Pe sol, autopilotul GeoFS nu poate rula pe pistă, așa că pluginul controlează direct
   *  maneta, bracajul roții de bot și profundorul. După desprindere predă autopilotului.
   * ===================================================================== */
  const TO = { active: false, rwy: null, t0: 0, vr: 0, lastPitch: null, lastHdg: null };

  function runwayUnderAircraft() {
    if (!DB.loaded) return null;
    const [lat, lon] = sim.lla(); const hdg = sim.v().heading;
    let best = null, bestRem = 0;
    for (const a of nearestAirports(lat, lon, 3)) {
      for (const r of DB.airports.get(a.apt)) {
        const ac = alongCross(r.lat, r.lon, r.hdg, lat, lon);
        const rem = (r.lenFt - r.dispFt) * FT - ac.along;  // pistă rămasă în față
        if (Math.abs(ac.cross) < (r.widFt * FT) / 2 + 8 && ac.along > -r.dispFt * FT - 80 && rem > 450 &&
            Math.abs(norm180(hdg - r.hdg)) < 30 && rem > bestRem) { best = r; bestRem = rem; }
      }
    }
    if (best) best._rem = bestRem;
    return best;
  }
  function bestRunwayForDeparture(apt) { return bestRunway(apt); } // aceeași logică: vânt din față, lungime suficientă

  /** Mută avionul la începutul pistei (rularea pe sol nu e automatizată). */
  function positionOnRunway(r, then) {
    const back = norm360(r.hdg + 180);
    const [lat, lon] = destPoint(r.lat, r.lon, back, Math.max(0, r.dispFt * FT - 30)); // începutul fizic al pistei
    geofs.flyTo([lat, lon, 0, r.hdg]);
    ui.toast(L(`Te mut la începutul pistei ${r.ident} (${aptName(r.apt)})…`, `Moving you to the start of runway ${r.ident} (${aptName(r.apt)})…`));
    setTimeout(() => {
      try {
        sim.ac().brakesOn = true; controls.brakes = 1;
        if (then) then();
      } catch (e) { console.error('[GeoFS Copilot] positioning', e); }
    }, 5000);
  }

  function autoTakeoffStart() {
    if (settings.fuelOn && FUEL.kg != null && FUEL.kg <= 0) { ui.toast(L('Fără combustibil nu se poate decola.', 'Cannot take off without fuel.')); return false; }
    const r = runwayUnderAircraft();
    if (!r) return false;
    if (geofs.autopilot.on) geofs.autopilot.turnOff();
    releaseVS();
    TO.active = true; TO.rwy = r; TO.t0 = Date.now(); TO.vr = vrSpeed(); TO.lastPitch = null; TO.lastHdg = null;
    AP.active = true; AP.full = true; AP.phase = 'AUTOTO'; AP.flapsUp = false;
    const ac = sim.ac();
    if (ac.engine && !ac.engine.on) controls.setters.toggleEngines.set();
    ac.brakesOn = false; controls.brakes = 0;
    if (controls.airbrakes && controls.airbrakes.target === 1) controls.setters.setAirbrakes.set();
    const steps = sim.flapsSteps(); if (steps && settings.autoConfig) setFlaps(Math.ceil(steps / 3));
    ui.toast(L(`Decolare automată de pe pista ${r.ident} · Vr ${TO.vr} kt. Nu atinge comenzile (Shift+P oprește).`, `Automatic takeoff from runway ${r.ident} · Vr ${TO.vr} kt. Do not touch the controls (Shift+P aborts).`), 7000);
    say('Takeoff');
    ui.renderNav();
    return true;
  }
  function autoTakeoffAbort(reason) {
    TO.active = false;
    controls.throttle = 0; controls.brakes = 1; sim.ac().brakesOn = true;
    controls.yaw = 0; controls.steering = 0; controls.rawPitch = 0;
    AP.active = false; AP.full = false; AP.phase = 'MAN';
    ui.toast(L('Decolare întreruptă: ', 'Takeoff aborted: ') + reason, 8000); say('Reject takeoff');
    ui.renderNav();
  }

  /** Rulează la fiecare cadru, după ce GeoFS citește comenzile pilotului. */
  function autoTakeoffControl(dt) {
    if (!TO.active || sim.paused()) return;
    const v = sim.v(), r = TO.rwy, [lat, lon] = sim.lla();
    dt = dt || 0.016;
    const ac = alongCross(r.lat, r.lon, r.hdg, lat, lon);
    const hdgErr = norm180(v.heading - r.hdg);
    const yawRate = TO.lastHdg == null ? 0 : norm180(v.heading - TO.lastHdg) / dt; TO.lastHdg = v.heading;
    const pitch = -(v.atilt || 0);
    const pitchRate = TO.lastPitch == null ? 0 : (pitch - TO.lastPitch) / dt; TO.lastPitch = pitch;
    controls.throttle = 1; controls.brakes = 0; sim.ac().brakesOn = false;
    if ((v.haglFeet || 0) < 30) {
      // menținere pe ax: roata de bot / palonier
      const spdF = Math.max(1, (v.kias || 0) / 30);
      const yaw = clamp(-(hdgErr * 0.12 + ac.cross * 0.03 + yawRate * 0.06) / spdF, -1, 1);
      controls.yaw = yaw; controls.rawYaw = yaw; controls.steering = yaw;
      controls.roll = clamp((v.aroll || 0) * 0.03, -0.4, 0.4); // aripi orizontale
      if ((v.kias || 0) >= TO.vr) { // rotire lină spre ~8°
        const tgt = isLight() ? 7 : 8;
        controls.rawPitch = clamp((tgt - pitch) * 0.07 - pitchRate * 0.05, -0.3, 0.8);
      } else controls.rawPitch = 0;
      controls.pitch = controls.rawPitch + (controls.elevatorTrim || 0);
    }
  }
  /** Verificări la 10 Hz: întrerupere sau predare către autopilot după desprindere. */
  function autoTakeoffTick() {
    if (!TO.active) return;
    const v = sim.v(), r = TO.rwy, [lat, lon] = sim.lla();
    const ac = alongCross(r.lat, r.lon, r.hdg, lat, lon);
    if (sim.onGround()) {
      if (Math.abs(ac.cross) > (r.widFt * FT) / 2 + 5) return autoTakeoffAbort(L('avionul a ieșit de pe axul pistei.', 'the aircraft left the runway centerline.'));
      if (Math.abs(norm180(v.heading - r.hdg)) > 25) return autoTakeoffAbort(L('direcția s-a abătut prea mult.', 'the heading drifted too far.'));
      if (Date.now() - TO.t0 > 120000) return autoTakeoffAbort(L('avionul nu a atins viteza de decolare.', 'the aircraft did not reach takeoff speed.'));
      const rem = (r.lenFt - r.dispFt) * FT - ac.along;
      if (rem < 150 && (v.kias || 0) < TO.vr) return autoTakeoffAbort(L('pista s-a terminat înainte de viteza de decolare.', 'the runway ran out before takeoff speed.'));
      return;
    }
    if ((v.haglFeet || 0) > 35 && (v.verticalSpeed || 0) > 150) {
      TO.active = false;
      if (!apOn()) { AP.active = false; AP.phase = 'MAN'; ui.toast(L('Avionul nu are autopilot – preia comenzile!', 'This aircraft has no autopilot – take the controls!')); return; }
      geofs.autopilot.setCourse(r.hdg, true);
      geofs.autopilot.setAltitude(Math.max(AP.cruiseFt || 0, sim.altFt() + 3000));
      geofs.autopilot.setSpeed(Math.min(TO.vr + (isLight() ? 20 : 40), 250)); AP.lastCmdSpd = geofs.autopilot.values.speed;
      setVS(isLight() ? 700 : 2000);
      AP.phase = 'TAKEOFF'; // de aici preia logica existentă: tren sus la 400 ft, apoi navigație
      say('Positive rate');
      ui.renderNav();
    }
  }

  /* =====================================================================
   *  ASISTENT DE ATERIZARE: avertizări, anunțuri, scor
   * ===================================================================== */
  const lastSaid = {};
  function say(text, minGapMs = 4000) {
    const now = Date.now();
    if (lastSaid[text] && now - lastSaid[text] < minGapMs) return;
    lastSaid[text] = now;
    if (!settings.voice || !window.speechSynthesis) return;
    try { const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 1.1; speechSynthesis.speak(u); } catch (e) { /* */ }
  }

  const LA = { airborneSince: null, vsHist: [], maxG: 0, pendingTouch: null, warnings: [], lastAgl: null };

  function assistantTick() {
    const v = sim.v(); const now = performance.now();
    const onG = sim.onGround();
    const st = approachState();
    const agl = st && st.distBefore > -500 && st.distBefore < 8 * NM ? Math.min(st.hatFt, v.haglFeet) : v.haglFeet;
    const vs = v.verticalSpeed || 0;
    LA.vsHist.push({ t: now, vs }); while (LA.vsHist.length && now - LA.vsHist[0].t > 700) LA.vsHist.shift();

    // ------ avertizări ------
    const w = [];
    if (!onG && LA.airborneSince && now - LA.airborneSince > 8000 && agl != null) {
      const descending = vs < -200;
      if (agl < 2500 && vs < -Math.max(1800, agl * 1.3)) w.push(['SINK RATE', L('Rată de coborâre prea mare', 'Descent rate too high')]);
      if (agl < 1000 && descending && controls.gear && controls.gear.target === 1 && (v.kias || 0) < 220 && sim.ac().definition.gearTravelTime !== 0) w.push(['TOO LOW GEAR', L('Trenul de aterizare e ridicat', 'Landing gear is up')]);
      if (agl < 500 && descending && sim.flapsSteps() > 0 && controls.flaps.target === 0) w.push(['TOO LOW FLAPS', L('Flapsurile sunt retrase', 'Flaps are retracted')]);
      if (agl < 500 && Math.abs(v.aroll || 0) > 30) w.push(['BANK ANGLE', L('Înclinare prea mare', 'Bank angle too steep')]);
      if ((v.haglFeet || 0) < 700 && vs < -500 && (!st || st.distBefore > 4 * NM || st.distBefore < -500)) w.push(['TERRAIN, PULL UP', L('Te apropii periculos de sol', 'Dangerously close to the ground')]);
      if (st && st.distBefore > 0 && st.distBefore < 10 * NM && agl < 1000 && descending) {
        if (st.gsDots < -1.3) w.push(['GLIDESLOPE', L('Ești sub panta de coborâre', 'You are below the glide path')]);
        if (Math.abs(st.locDots) > 1.5) w.push(['LOCALIZER', L('Nu ești aliniat cu pista', 'You are not aligned with the runway')]);
        if ((v.kias || 0) < AP.vapp - 12) w.push(['SPEED', L('Viteză prea mică', 'Speed too low')]);
        if ((v.kias || 0) > AP.vapp + 25 && agl < 500) w.push(['SPEED HIGH', L('Viteză prea mare', 'Speed too high')]);
      }
      // anunțuri de înălțime
      if (descending) {
        for (const h of [2500, 1000, 500, 100, 50, 40, 30, 20, 10]) {
          if (LA.lastAgl != null && LA.lastAgl > h && agl <= h) {
            const words = { 2500: 'Twenty five hundred', 1000: 'One thousand', 500: 'Five hundred', 100: 'One hundred' };
            say(words[h] || String(h), 1500);
            if (h === 500 && st && Math.abs(st.locDots) < 1 && Math.abs(st.gsDots) < 1 && Math.abs((v.kias || 0) - AP.vapp) < 15) ui.toast(L('500 ft – STABILIZAT ✔', '500 ft – STABILIZED ✔'));
            if (h === 500 && st && st.distBefore > 0 && st.distBefore < 4 * NM && (Math.abs(st.locDots) > 1 || Math.abs(st.gsDots) > 1)) { ui.toast(L('500 ft – NESTABILIZAT: ia în calcul ratarea (GO AROUND)', '500 ft – UNSTABLE: consider a GO AROUND')); say('Unstable, go around'); }
          }
        }
      }
    }
    LA.lastAgl = agl;
    w.forEach((x) => say(x[0]));
    LA.warnings = w;

    // ------ detectare aterizare + scor ------
    if (!onG) { if (!LA.airborneSince) LA.airborneSince = now; }
    if (onG && LA.airborneSince && now - LA.airborneSince > 5000 && !LA.pendingTouch) {
      const tdVs = Math.min(...LA.vsHist.map((x) => x.vs), vs);
      LA.pendingTouch = { t: now, vs: tdVs, kias: v.kias, lla: sim.lla().slice(), hdg: v.heading, maxG: v.loadFactor || 1 };
    }
    if (LA.pendingTouch) {
      LA.pendingTouch.maxG = Math.max(LA.pendingTouch.maxG, v.loadFactor || 1);
      if (now - LA.pendingTouch.t > 1200) { finishLanding(LA.pendingTouch); LA.pendingTouch = null; LA.airborneSince = null; }
    }
    if (onG && !LA.pendingTouch) LA.airborneSince = null;
  }

  function findLandingRunway(lat, lon, hdg) {
    if (AP.rwy && distM(lat, lon, AP.rwy.lat, AP.rwy.lon) < 6000) return AP.rwy;
    if (!DB.loaded) return null;
    let best = null, bd = 1e9;
    for (const a of nearestAirports(lat, lon, 6, null, 0)) {
      for (const r of DB.airports.get(a.apt)) {
        if (Math.abs(norm180(r.hdg - hdg)) > 30) continue;
        const ac = alongCross(r.lat, r.lon, r.hdg, lat, lon);
        if (ac.along < -1000 || ac.along > r.lenFt * FT + 200) continue;
        if (Math.abs(ac.cross) < bd) { bd = Math.abs(ac.cross); best = r; }
      }
    }
    return best;
  }

  function finishLanding(td) {
    const [lat, lon] = td.lla; const vsAbs = Math.abs(td.vs);
    let score = 0; const notes = [];
    const vsPts = vsAbs <= 100 ? 40 : vsAbs <= 200 ? 35 : vsAbs <= 300 ? 28 : vsAbs <= 450 ? 18 : vsAbs <= 600 ? 8 : 0;
    score += vsPts;
    const gPts = td.maxG <= 1.3 ? 15 : td.maxG <= 1.6 ? 10 : td.maxG <= 2 ? 5 : 0; score += gPts;
    const r = findLandingRunway(lat, lon, td.hdg);
    let clM = null, tdzM = null, alignDeg = null;
    if (r) {
      const ac = alongCross(r.lat, r.lon, r.hdg, lat, lon);
      clM = ac.cross; tdzM = ac.along; alignDeg = norm180(td.hdg - r.hdg);
      const half = (r.widFt * FT) / 2;
      score += Math.abs(clM) <= 3 ? 20 : Math.abs(clM) <= 8 ? 15 : Math.abs(clM) <= 15 ? 8 : Math.abs(clM) <= half ? 3 : 0;
      score += tdzM >= 150 && tdzM <= 600 ? 15 : tdzM >= 0 && tdzM <= 900 ? 10 : 0;
      score += Math.abs(alignDeg) <= 2 ? 10 : Math.abs(alignDeg) <= 5 ? 6 : 2;
      if (tdzM < 0) notes.push(L('Ai aterizat înainte de prag!', 'You landed before the threshold!'));
      if (tdzM > 900) notes.push(L('Aterizare lungă – ai consumat multă pistă.', 'Long landing – you used a lot of runway.'));
      if (Math.abs(clM) > half) notes.push(L('Ai aterizat în afara pistei!', 'You landed off the runway!'));
    } else { score = Math.round(score / 55 * 100); notes.push(L('Nu am identificat pista – scor doar din rată și G.', 'Runway not identified – score based on sink rate and G only.')); }
    if (vsAbs > 600) notes.push(L('Aterizare dură (HARD LANDING).', 'HARD LANDING.'));
    else if (vsAbs < 120) notes.push(L('Butter! Aterizare foarte lină.', 'Butter! Very smooth landing.'));
    const grade = score >= 90 ? L('Excelent', 'Excellent') : score >= 75 ? L('Foarte bine', 'Very good') : score >= 60 ? L('Bine', 'Good') : score >= 40 ? L('Acceptabil', 'Acceptable') : L('Slab', 'Poor');
    const rec = { date: new Date().toISOString(), apt: r ? r.apt : '?', rwy: r ? r.ident : '?', vs: Math.round(td.vs), g: +td.maxG.toFixed(2), clM: clM == null ? null : +clM.toFixed(1), tdzM: tdzM == null ? null : Math.round(tdzM), alignDeg: alignDeg == null ? null : +alignDeg.toFixed(1), kias: Math.round(td.kias || 0), score, grade };
    const hist = store.get(LS_LANDINGS, []); hist.unshift(rec); store.set(LS_LANDINGS, hist.slice(0, 20));
    ui.showLanding(rec, notes);
    try { careerOnLanding(rec); } catch (e) { /* */ }
    say(`Landing ${score >= 90 ? 'excellent' : ''}, ${Math.round(vsAbs)} feet per minute`, 0);
  }

  /* =====================================================================
   *  CONTROL SEPARAT PE FIECARE MOTOR
   *  GeoFS calculează tracțiunea fiecărui motor din controls.throttle, dar
   *  respectă o animație de tip "throttle" definită pe motor. Adăugăm o astfel
   *  de animație care citește o valoare proprie (gcrThr0, gcrThr1, …).
   *  Moduri: 'link' = urmează maneta generală, 'man' = maneta proprie, 'off' = tăiat.
   * ===================================================================== */
  const ENG = { modes: [], levers: [], acId: null, hooked: false };

  function engines() { return (sim.ac() && sim.ac().engines) || []; }
  function engSync() {
    const ac = sim.ac(); const id = ac.id || (ac.definition && ac.definition.name);
    if (ENG.acId !== id) { ENG.acId = id; ENG.modes = engines().map(() => 'link'); ENG.levers = engines().map(() => 0); ui.buildEngines && ui.buildEngines(); }
  }
  function engAnim(eng, i) {
    eng.animations = eng.animations || [];
    let a = eng.animations.find((x) => x.gcr);
    if (!a) { a = { type: 'throttle', value: 'gcrThr' + i, gcr: true }; eng.animations.push(a); }
    return a;
  }
  function engSetMode(i, mode) {
    const eng = engines()[i]; if (!eng) return;
    ENG.modes[i] = mode;
    if (mode === 'link') { if (eng.animations) eng.animations = eng.animations.filter((x) => !x.gcr); }
    else engAnim(eng, i);
  }
  function engWriteValues() {
    const vals = geofs.animation.values; const list = engines();
    for (let i = 0; i < list.length; i++) {
      const m = ENG.modes[i];
      if (!m || m === 'link') continue;
      vals['gcrThr' + i] = m === 'off' ? 0 : ENG.levers[i];
      engAnim(list[i], i); // reaplicăm dacă GeoFS a reîncărcat definiția
    }
  }
  function hookControls() {
    if (ENG.hooked || !controls.update) return;
    const orig = controls.update;
    controls.update = function () { const r = orig.apply(this, arguments); try { engWriteValues(); } catch (e) { /* */ } try { autoTakeoffControl(arguments[0]); } catch (e) { console.error('[GeoFS Copilot] takeoff', e); } return r; };
    ENG.hooked = true;
  }

  /* =====================================================================
   *  AUTOPILOT EXTINS
   * ===================================================================== */
  const apx = {
    sync() {
      const v = sim.v();
      return { alt: Math.round(sim.altFt() / 100) * 100, hdg: Math.round(norm360(v.heading)), spd: Math.round(v.kias || 0), vs: 0 };
    },
    apply(vals) {
      if (!apOn()) { ui.toast(L('Avionul ăsta nu are autopilot în GeoFS.', 'This aircraft has no autopilot in GeoFS.')); return; }
      if (AP.active) disengage(true);
      releaseVS();
      const a = geofs.autopilot;
      if (!isNaN(vals.alt)) a.setAltitude(vals.alt);
      if (!isNaN(vals.hdg)) a.setCourse(norm360(vals.hdg), true);
      if (!isNaN(vals.spd)) a.setSpeed(vals.spd);
      if (!isNaN(vals.vs) && vals.vs !== 0) { a.values.verticalSpeed = null; a.setVerticalSpeed(vals.vs); a.setVerticalSpeed(vals.vs); }
      if (!isNaN(vals.bank) && a.definition) { a.definition.maxBankAngle = clamp(vals.bank, 5, 45); settings.bankMax = a.definition.maxBankAngle; saveSettings(); }
    },
    nudge(kind, delta) {
      if (!apOn()) return;
      if (AP.active) disengage(true);
      const a = geofs.autopilot;
      if (kind === 'alt') a.setAltitude(Math.max(0, Math.round((a.values.altitude + delta) / 100) * 100));
      if (kind === 'hdg') a.setCourse(norm360(a.values.course + delta), true);
      if (kind === 'spd') a.setSpeed(Math.max(0, a.values.speed + delta));
      ui.toast(`AP: ALT ${fmt(a.values.altitude)} ft · HDG ${pad3(a.values.course)}° · SPD ${fmt(a.values.speed)} kt`);
    },
    directTo() {
      if (!AP.rwy) { ui.toast(L('Alege mai întâi destinația.', 'Choose a destination first.')); return; }
      engage();
    },
  };

  /* =====================================================================
   *  INTERFAȚĂ
   * ===================================================================== */
  const ui = {};
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'style') e.style.cssText = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    kids.flat().forEach((c) => c != null && e.append(c.nodeType ? c : document.createTextNode(c)));
    return e;
  }

  const CSS = `
  #gcr-panel{position:fixed;z-index:100000;top:70px;right:12px;width:360px;max-height:calc(100vh - 100px);overflow:auto;background:rgba(14,20,30,.93);color:#e8eef7;font:12px/1.4 system-ui,Segoe UI,Roboto,sans-serif;border:1px solid #2b3a52;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45)}
  #gcr-panel *{box-sizing:border-box}
  #gcr-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#18243a;border-radius:10px 10px 0 0;cursor:move;user-select:none}
  #gcr-head b{flex:1;font-size:13px}
  #gcr-head button{background:none;border:0;color:#9fb3cf;font-size:16px;cursor:pointer}
  .gcr-tabs{display:flex;flex-wrap:wrap;border-bottom:1px solid #2b3a52}
  .gcr-tabs button{flex:1 0 19%;padding:6px 1px;background:none;border:0;color:#9fb3cf;cursor:pointer;font-size:11px;border-bottom:2px solid transparent}
  .gcr-tabs button.on{color:#fff;border-bottom-color:#e040fb}
  .gcr-body{padding:10px}
  .gcr-row{display:flex;gap:6px;align-items:center;margin:5px 0;flex-wrap:wrap}
  .gcr-row label{color:#9fb3cf;min-width:92px}
  #gcr-panel input,#gcr-panel select{background:#0c1320;color:#fff;border:1px solid #33465f;border-radius:5px;padding:4px 6px;font-size:12px}
  #gcr-panel input[type=number]{width:72px}
  #gcr-panel input[type=checkbox]{width:auto}
  .gcr-btn{background:#2a3d5c;color:#fff;border:1px solid #3d5679;border-radius:6px;padding:5px 9px;cursor:pointer;font-size:12px}
  .gcr-btn:hover{background:#355078}
  .gcr-btn.pri{background:#8e24aa;border-color:#b14fd0}
  .gcr-btn.ok{background:#1f7a44;border-color:#2e9e5c}
  .gcr-btn.warn{background:#9c2f2f;border-color:#c24646}
  .gcr-btn.sm{padding:3px 7px}
  .gcr-list{max-height:170px;overflow:auto;border:1px solid #26354b;border-radius:6px}
  .gcr-item{padding:5px 8px;border-bottom:1px solid #1d2a3d;cursor:pointer;display:flex;justify-content:space-between;gap:6px}
  .gcr-item:hover{background:#1c2b44}
  .gcr-item.sel{background:#3b1f4a}
  .gcr-muted{color:#8193ad}
  .gcr-status{color:#9fb3cf;font-size:11px;margin-top:6px}
  .gcr-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .gcr-sys{background:#101a2a;border:1px solid #26354b;border-radius:8px;padding:7px;text-align:center}
  .gcr-sys .t{color:#8193ad;font-size:11px}
  .gcr-sys .s{font-size:14px;font-weight:600;margin:3px 0}
  .gcr-on{color:#4cff8f}.gcr-off{color:#ff6b6b}.gcr-tr{color:#ffd54f}
  #gcr-hud{position:fixed;z-index:99999;left:50%;top:118px;transform:translateX(-50%);display:flex;gap:10px;align-items:stretch;background:rgba(0,10,0,.55);color:#5cff7a;font:600 13px/1.25 ui-monospace,Consolas,monospace;padding:6px 10px;border-radius:8px;border:1px solid rgba(92,255,122,.35);pointer-events:none;text-shadow:0 0 3px #000}
  #gcr-hud .c{display:flex;flex-direction:column;min-width:78px;white-space:nowrap}
  #gcr-hud .k{font-size:10px;color:#9be7a8;opacity:.8}
  #gcr-hud .warn{color:#ff4d4d;font-size:15px}
  #gcr-hud canvas{display:block}
  #gcr-warn{position:fixed;z-index:99999;left:50%;top:330px;transform:translateX(-50%);color:#fff;background:rgba(200,20,20,.85);font:700 18px system-ui;padding:6px 16px;border-radius:6px;display:none;pointer-events:none;letter-spacing:1px}
  #gcr-toast{position:fixed;z-index:100001;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(20,30,48,.95);color:#fff;font:13px system-ui;padding:8px 14px;border-radius:8px;border:1px solid #3d5679;display:none;max-width:70vw;text-align:center}
  #gcr-landing{position:fixed;z-index:100001;left:50%;top:30%;transform:translateX(-50%);background:rgba(14,20,30,.96);color:#fff;font:13px system-ui;padding:14px 18px;border-radius:12px;border:1px solid #8e24aa;display:none;min-width:280px;text-align:center}
  #gcr-landing .score{font-size:40px;font-weight:800;color:#e040fb}
  #gcr-fab{position:fixed;z-index:100000;right:12px;top:70px;background:#8e24aa;color:#fff;border:0;border-radius:20px;padding:6px 12px;font:600 12px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)}
  .gcr-here{background:#101a2a;border:1px solid #26354b;border-radius:8px;padding:6px 8px;margin-bottom:6px}
  .gcr-destcard{background:linear-gradient(135deg,#2a1636,#16233a);border:1px solid #6a2c86;border-radius:9px;padding:8px 10px;margin-top:10px}
  .gcr-btn.big{width:100%;padding:9px;font-size:13px;font-weight:600}
  #gcr-guide{position:fixed;z-index:99999;left:50%;top:228px;transform:translateX(-50%);background:rgba(10,14,22,.78);color:#fff;font:13px/1.45 system-ui,Segoe UI,sans-serif;padding:7px 14px;border-radius:9px;border:1px solid rgba(224,64,251,.45);display:none;pointer-events:none;text-align:center;max-width:80vw;text-shadow:0 1px 2px #000}
  #gcr-guide .gh{font-size:16px;font-weight:700;color:#ffe082}
  #gcr-guide .gm{color:#d59ce6;font-size:12px}
  #gcr-guide .gi{color:#b3e5fc;font-size:12px;border-top:1px solid rgba(255,255,255,.12);margin-top:3px;padding-top:2px}
  #gcr-guide .gw{color:#ff8a80;font-size:12px;font-weight:700;border-top:1px solid rgba(255,255,255,.12);margin-top:3px;padding-top:2px}
  #gcr-nd{position:fixed;z-index:99999;left:12px;bottom:12px;background:rgba(5,8,13,.92);border:1px solid #2b3a52;border-radius:10px;padding:6px;color:#e8eef7;font:11px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  #gcr-nd canvas{display:block;border-radius:6px}
  .gcr-ndgrip{display:flex;justify-content:space-between;align-items:center;gap:6px;margin:-2px -2px 4px;padding:3px 6px;background:#18243a;border-radius:6px;cursor:move;user-select:none;color:#9fb3cf}
  .gcr-ndh{padding:0 2px 4px;line-height:1.35}
  .gcr-trip{margin-top:10px;background:#101a2a;border:1px solid #26354b;border-radius:8px;padding:7px}
  .gcr-trip:empty{display:none}
  .gcr-stop{display:flex;align-items:center;gap:5px;padding:4px 2px;border-top:1px solid #1d2a3d}
  .gcr-stop .n{display:inline-block;min-width:20px;height:20px;line-height:20px;text-align:center;border-radius:10px;background:#2a3d5c;font-size:11px}
  .gcr-stop.cur .n{background:#8e24aa}
  .gcr-stop.done{opacity:.55}
  .gcr-link{color:#d59ce6}
  .gcr-about{margin-top:12px;padding:8px 10px;border:1px solid #6a2c86;border-radius:8px;background:linear-gradient(135deg,#2a1636,#16233a)}
  .gcr-atclog{max-height:180px;overflow:auto;border:1px solid #26354b;border-radius:6px;padding:4px 6px;background:#0b111c}
  .gcr-atcmsg{padding:2px 0;border-bottom:1px solid #16202f}
  .gcr-atcmsg.out b{color:#90caf9}.gcr-atcmsg.in b{color:#ffd54f}.gcr-atcmsg.sys b{color:#d59ce6}
  #gcr-atccard{position:fixed;z-index:100003;left:50%;top:340px;transform:translateX(-50%);background:rgba(20,30,48,.97);border:2px solid #ffd54f;border-radius:12px;padding:10px 16px;color:#fff;font:13px system-ui,sans-serif;text-align:center;display:none;box-shadow:0 8px 30px rgba(0,0,0,.5);min-width:280px}
  #gcr-atccard .big{font-size:17px;font-weight:700;color:#ffe082;margin:4px 0}
  #gcr-atcwin{position:fixed;z-index:100000;left:80px;top:90px;background:rgba(5,10,8,.96);border:1px solid #2e5a3c;border-radius:10px;padding:6px;color:#e8eef7;font:12px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.55)}
  #gcr-atcwin canvas{border-radius:8px;cursor:crosshair}
  #gcr-atcwin input{background:#0c1320;color:#fff;border:1px solid #33465f;border-radius:5px;padding:3px 5px;font-size:12px}
  .gcr-strips{max-height:260px;overflow:auto}
  .gcr-strip{display:grid;grid-template-columns:1fr auto;gap:0 6px;padding:4px 6px;margin-bottom:3px;background:#0f1d16;border-left:4px solid #5cff8a;border-radius:4px;cursor:pointer}
  .gcr-strip .tag{grid-column:1/3;color:#ffab91;font-size:11px}
  .gcr-strip.req{border-left-color:#ff8a80;background:#2a1414}
  .gcr-strip.sel{outline:1px solid #ffd54f}
  .gcr-atccmd{margin-top:6px;border-top:1px solid #1d3326;padding-top:4px}
  .gcr-grip{pointer-events:auto;cursor:move;user-select:none;color:#9be7a8;opacity:.75;font-size:14px;padding:0 3px;align-self:center}
  .gcr-grip:hover{opacity:1}
  #gcr-guide .gcr-grip{position:absolute;left:4px;top:4px;color:#d59ce6;font-size:13px}
  .gcr-copbadge{background:#3b2a05;color:#ffd54f;border:1px solid #8d6e00;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700;cursor:help}
  .gcr-fuel{background:#101a2a;border:1px solid #26354b;border-radius:8px;padding:7px;margin-top:4px}
  .gcr-bar{position:relative;height:10px;background:#0c1320;border:1px solid #33465f;border-radius:5px;overflow:hidden;margin-bottom:5px}
  .gcr-bar>div:first-child{height:100%}
  .gcr-bar .need{position:absolute;top:-2px;bottom:-2px;width:2px;background:#fff}
  #gcr-emerg{position:fixed;z-index:100004;left:50%;top:300px;transform:translateX(-50%);background:rgba(40,8,8,.96);border:2px solid #ff5252;border-radius:12px;padding:10px 16px;color:#fff;font:13px system-ui,sans-serif;display:none;max-width:560px;box-shadow:0 8px 34px rgba(0,0,0,.6)}
  #gcr-emerg .title{font-size:18px;font-weight:800;color:#ff8a80;text-align:center;margin-bottom:4px}
  #gcr-emerg ol{margin:4px 0 8px 18px;padding:0}
  .gcr-ach{display:grid;grid-template-columns:1fr 1fr;gap:4px}
  .gcr-ach .a{display:flex;gap:5px;align-items:center;padding:4px 6px;border:1px solid #26354b;border-radius:6px;opacity:.4;font-size:11px;cursor:help}
  .gcr-ach .a.on{opacity:1;border-color:#8d6e00;background:#2a2005}
  .gcr-ach .i{font-size:15px}
  .gcr-code{font:11px ui-monospace,Consolas,monospace;background:#0b1220;border:1px solid #33465f;border-radius:5px;padding:2px 5px;word-break:break-all;flex:1}
  .gcr-kbd{display:inline-block;background:#0c1320;border:1px solid #33465f;border-radius:4px;padding:0 5px;font-family:monospace;color:#fff}
  `;

  /** Reconstruiește interfața (de ex. după schimbarea limbii), fără a opri zborul. */
  function rebuildUI() {
    ['gcr-panel', 'gcr-fab', 'gcr-hud', 'gcr-nd', 'gcr-guide', 'gcr-atcwin'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
    initRegionNames();
    if (DB.loaded) buildSearchIndex();
    buildPanel(); buildHud(); buildNd();
    const tab = 'set';
    const b = document.querySelector('#gcr-panel .gcr-tabs button[data-k="' + tab + '"]'); if (b) b.click();
    if (DB.loaded) { ui.refreshNearest(); if (TRIP.stops.length) applyTripTarget(); }
    if (settings.atcRole === 'ctrl' && settings.atcStation) openAtcWindow();
    ui.renderNav();
  }

  function init() {
    document.head.append(el('style', {}, CSS));
    buildPanel();
    buildHud();
    buildNd();
    document.body.append(el('div', { id: 'gcr-warn' }), el('div', { id: 'gcr-toast' }), el('div', { id: 'gcr-landing' }));
    bindKeys();
    hookControls();
    hookChat();
    hookBeacon();
    setInterval(() => {
      if (!geofsReady() || sim.paused()) return;
      try { updateTrack(); guidanceTick(); autoTakeoffTick(); tripTick(); atcTick(); fuelTick(); missionTick(); passFill(); if (MISSION && MISSION.points && !MENT.length && MISSION.points.some((p) => !p.done)) drawMissionMarks(); flightTick(); emergencyTick(); lessonTick(); } catch (e) { console.error('[GeoFS Copilot] guidance', e); }
    }, 100);
    setInterval(() => {
      if (!geofsReady() || sim.paused()) return;
      try { assistantTick(); } catch (e) { console.error('[GeoFS Copilot] assistant', e); }
    }, 100);
    setInterval(() => { if (geofsReady()) { try { updateHud(); ui.updateLive(); } catch (e) { console.error('[GeoFS Copilot] HUD', e); } } }, 200);
    setInterval(() => { if (geofsReady()) { try { updateGuide(); drawNd(); drawAtcWindow(); } catch (e) { console.error('[GeoFS Copilot] map', e); } } }, 250);
    setInterval(() => { try { if (ui.tab === 'atc' && settings.panelVisible) ui.renderAtc(); if (ui.tab === 'mis' && settings.panelVisible) ui.renderMissions(); if (ui.tab === 'trn' && settings.panelVisible) ui.renderTraining(); } catch (e) { /* */ } }, 2000);
    setInterval(() => { try { fetchGlobalCopilots(); updateCopBadge(); const typing = document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName) && document.activeElement.closest('#gcr-panel'); if (ui.tab === 'car' && settings.panelVisible && !typing) ui.renderCareer(); if (ui.tab === 'air' && settings.panelVisible && !typing) ui.renderAirline(); } catch (e) { /* */ } }, 5000);
    setInterval(() => { if (geofsReady() && DB.loaded && ui.tab === 'nav' && settings.panelVisible) { try { ui.refreshNearestHere(); if (AP.rwy) ui.renderNav(); } catch (e) { /* */ } } }, 15000);
    // Când avionul e schimbat sau zborul resetat, pistele trebuie redesenate
    try { $(document).on('flyto', () => setTimeout(() => { if (AP.rwy) { buildRoute(); drawApproach(); } }, 1500)); } catch (e) { /* */ }
    loadRunways();
    setTimeout(() => { try { cloudInit(); } catch (e) { /* */ } }, 4000);
    setTimeout(() => { adminCheck(); pollNotices(); }, 7000);
    setTimeout(() => { checkUpdate(); }, 15000);
    setInterval(() => { checkUpdate(); }, 3 * 3600000);
    setInterval(() => { try { adminTick(); } catch (e) { /* */ } }, 2000);
    setInterval(() => { pollNotices(); }, 60000);
    setInterval(() => { adminCheck(); }, 600000);
    setInterval(() => { try { cloudSave(false); } catch (e) { /* */ } }, 30000);
    ui.toast(L('GeoFS Copilot RO încărcat – Shift+N deschide/închide panoul.', 'GeoFS Copilot loaded – Shift+N opens/closes the panel.'));
  }

  /* ---------------- Panou principal ---------------- */
  function buildPanel() {
    const fab = el('button', { id: 'gcr-fab', title: 'Shift+N', onclick: () => togglePanel(true) }, '✈ Copilot');
    const panel = el('div', { id: 'gcr-panel' });
    const copBadge = el('span', { class: 'gcr-copbadge', title: '' }, '★ 1');
    ui.copBadge = copBadge;
    const updBadge = el('span', { title: '', style: 'display:none;cursor:pointer;background:#1b5e20;color:#b9f6ca;border-radius:8px;padding:0 6px;font-size:11px;margin-left:4px', onclick: () => showUpdate() }, '⬆️');
    ui.markUpdate = () => { if (UPD.latest) { updBadge.style.display = ''; updBadge.textContent = '⬆️ ' + UPD.latest; updBadge.title = L('Versiune nouă disponibilă', 'New version available'); } };
    const head = el('div', { id: 'gcr-head' }, el('span', {}, '✈'), el('b', {}, 'GeoFS Copilot'), copBadge, updBadge,
      el('button', { title: L('Ascunde (Shift+N)', 'Hide (Shift+N)'), onclick: () => togglePanel(false) }, '–'));
    const tabsBar = el('div', { class: 'gcr-tabs' });
    const body = el('div', { class: 'gcr-body' });
    const tabs = { nav: L('Navigație', 'Nav'), ap: L('Pilot auto', 'Autopilot'), sys: L('Avion', 'Aircraft'), mis: L('Misiuni', 'Missions'), car: L('Carieră', 'Career'), air: L('Companie', 'Airline'), trn: L('Școală', 'Training'), log: L('Jurnal', 'Logbook'), atc: 'ATC', set: L('Setări', 'Settings'), adm: '🛡️ Admin' };
    const pages = {};
    Object.keys(tabs).forEach((k) => {
      const b = el('button', { onclick: () => showTab(k) }, tabs[k]); b.dataset.k = k; tabsBar.append(b);
      pages[k] = el('div', { style: 'display:none' }); body.append(pages[k]);
    });
    function showTab(k) {
      [...tabsBar.children].forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      Object.keys(pages).forEach((p) => { pages[p].style.display = p === k ? '' : 'none'; });
      ui.tab = k;
      if (k === 'adm' && ui.renderAdmin) ui.renderAdmin();
    }
    panel.append(head, tabsBar, body);
    document.body.append(panel, fab);

    // Tastele apăsate în panou nu trebuie să ajungă la comenzile GeoFS
    ['keydown', 'keyup', 'keypress'].forEach((t) => panel.addEventListener(t, (e) => { if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) e.stopPropagation(); }));
    // Panoul nu trebuie să miște avionul când dai click în el
    ['mousedown', 'pointerdown', 'wheel', 'touchstart'].forEach((t) => panel.addEventListener(t, (e) => e.stopPropagation()));

    // drag
    let drag = null;
    head.addEventListener('mousedown', (e) => { if (e.target.tagName === 'BUTTON') return; const r = panel.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (!drag) return; panel.style.left = (e.clientX - drag.dx) + 'px'; panel.style.top = (e.clientY - drag.dy) + 'px'; panel.style.right = 'auto'; });
    window.addEventListener('mouseup', () => { if (drag) { drag = null; settings.panelPos = [panel.style.left, panel.style.top]; saveSettings(); } });
    if (settings.panelPos) { panel.style.left = settings.panelPos[0]; panel.style.top = settings.panelPos[1]; panel.style.right = 'auto'; }

    function togglePanel(show) {
      settings.panelVisible = show == null ? !settings.panelVisible : show; saveSettings();
      panel.style.display = settings.panelVisible ? '' : 'none';
      fab.style.display = settings.panelVisible ? 'none' : '';
    }
    ui.togglePanel = togglePanel;
    togglePanel(settings.panelVisible);

    buildNavPage(pages.nav);
    buildApPage(pages.ap);
    buildSysPage(pages.sys);
    buildMissionsPage(pages.mis);
    buildCareerPage(pages.car);
    buildAirlinePage(pages.air);
    buildTrainingPage(pages.trn);
    buildLogPage(pages.log);
    buildAtcPage(pages.atc);
    buildSetPage(pages.set);
    buildAdminPage(pages.adm);
    ui.showAdminTab = (on) => { const b = tabsBar.querySelector('button[data-k=adm]'); if (b) b.style.display = on ? '' : 'none'; if (!on && ui.tab === 'adm') showTab('nav'); };
    ui.showAdminTab(ADMIN.on);
    showTab('nav');
  }

  /* ---------------- Navigație ---------------- */
  function bestRunway(apt) {
    const rws = DB.airports.get(apt); if (!rws) return null;
    const wDir = (window.weather && weather.currentWindDirection) || 0, wSpd = (window.weather && weather.currentWindSpeed) || 0;
    const need = isLight() ? 1500 : 5000;
    return rws.slice().sort((a, b) => {
      const okA = a.ldaFt >= need, okB = b.ldaFt >= need;
      if (okA !== okB) return okB - okA;
      const ha = wSpd * Math.cos((wDir - a.hdg) * D2R), hb = wSpd * Math.cos((wDir - b.hdg) * D2R);
      return (Math.round(hb) - Math.round(ha)) || (b.lenFt - a.lenFt);
    })[0];
  }
  function selectDestination(apt) { setSingleDestination(apt); }

  function buildNavPage(p) {
    const here = el('div', { class: 'gcr-here' }, L('Se încarcă baza de date…', 'Loading the database…'));
    const q = el('input', { placeholder: L('Unde zbori? Oraș, aeroport sau cod (ex. Cluj, Viena, Paris)', 'Where to? City, airport or code (e.g. London, Paris, JFK)'), style: 'flex:1;min-width:0' });
    const go = el('button', { class: 'gcr-btn', onclick: () => doSearch() }, L('Caută', 'Search'));
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    let qTimer = null; q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(doSearch, 350); });
    const results = el('div', { class: 'gcr-list', style: 'display:none' });
    const band = el('select', {}, el('option', { value: '30,150' }, L('Zbor scurt (30–150 NM)', 'Short flight (30–150 NM)')), el('option', { value: '150,400' }, L('Zbor mediu (150–400 NM)', 'Medium flight (150–400 NM)')), el('option', { value: '400,1500' }, L('Zbor lung (400–1500 NM)', 'Long flight (400–1500 NM)')), el('option', { value: '0,40' }, L('Lângă mine (sub 40 NM)', 'Near me (under 40 NM)')));
    const sugg = el('div', { class: 'gcr-list' });
    const more = el('button', { class: 'gcr-btn sm', onclick: () => ui.refreshNearest(true) }, L('Altele', 'Others'));
    band.addEventListener('change', () => ui.refreshNearest(true));
    const dest = el('div', { class: 'gcr-dest' });
    const rwList = el('div', { class: 'gcr-list', style: 'margin-top:6px' });
    const crzAlt = el('input', { type: 'number', step: 500, style: 'width:80px' });
    const crzSpd = el('input', { type: 'number', step: 10, style: 'width:64px' });
    crzAlt.addEventListener('change', () => { settings.cruiseFt = +crzAlt.value || 0; saveSettings(); planCruise(); ui.renderNav(); });
    crzSpd.addEventListener('change', () => { settings.cruiseSpd = +crzSpd.value || 0; saveSettings(); planCruise(); ui.renderNav(); });
    const btnFull = el('button', { class: 'gcr-btn pri big', onclick: () => (AP.active ? disengage() : engageFull()) }, L('✈ Zbor complet: decolare → aterizare', '✈ Full flight: takeoff → landing'));
    const btnApp = el('button', { class: 'gcr-btn', title: 'Shift+L', onclick: () => (AP.active ? disengage() : engage()) }, L('Doar apropierea', 'Approach only'));
    const btnTp = el('button', { class: 'gcr-btn', title: 'Shift+R', onclick: teleportFinal }, L('Teleportează pe finală', 'Teleport to final'));
    const route = el('div', { class: 'gcr-muted', style: 'margin-top:6px' });
    const status = el('div', { class: 'gcr-status' }, '…');
    const btnClear = el('button', { class: 'gcr-btn sm', onclick: () => { disengage(true); AP.rwy = null; AP.legs = []; AP.phase = 'OFF'; clearEntities(); TRIP.stops = []; TRIP.from = 0; saveTrip(); ui.renderNav(); ui.renderTrip(); } }, L('Șterge planul', 'Clear plan'));
    const btnLoad = el('button', { class: 'gcr-btn sm', onclick: () => { DB.loaded = false; idbSet('db', null); loadRunways(); } }, L('Reîncarcă baza', 'Reload database'));
    const tripBox = el('div', { class: 'gcr-trip' });
    const autoTo = el('input', { type: 'checkbox' }); autoTo.checked = !!settings.autoTakeoff;
    autoTo.addEventListener('change', () => { settings.autoTakeoff = autoTo.checked; saveSettings(); });
    const stopSec = el('input', { type: 'number', step: 10, min: 0, style: 'width:56px', value: settings.stopoverSec });
    stopSec.addEventListener('change', () => { settings.stopoverSec = Math.max(0, +stopSec.value || 0); saveSettings(); });
    const btnRwy = el('button', { class: 'gcr-btn sm', title: L('Mută avionul la începutul pistei de decolare potrivite vântului', 'Move the aircraft to the start of the runway best suited to the wind'), onclick: () => {
      const near = nearestAirports(...sim.lla().slice(0, 2), 1)[0];
      if (!near || near.d > 5 * NM) { ui.toast(L('Nu ești lângă un aeroport.', 'You are not near an airport.')); return; }
      positionOnRunway(bestRunwayForDeparture(near.apt));
    } }, L('Du-mă pe pista de decolare', 'Put me on the departure runway'));
    const plan = el('div', {},
      el('div', { class: 'gcr-row' }, el('label', { style: 'min-width:0' }, autoTo, L(' Decolare automată', ' Automatic takeoff')), el('span', { class: 'gcr-muted' }, L('· escală', '· stopover')), stopSec, el('span', { class: 'gcr-muted' }, 's')),
      el('div', { class: 'gcr-row' }, btnRwy),
      el('div', { class: 'gcr-row' }, el('label', {}, L('Croazieră', 'Cruise')), crzAlt, el('span', { class: 'gcr-muted' }, 'ft'), crzSpd, el('span', { class: 'gcr-muted' }, L('kt (gol = automat)', 'kt (empty = auto)'))),
      el('div', { class: 'gcr-row', style: 'margin-top:6px' }, btnFull),
      el('div', { class: 'gcr-row' }, btnApp, btnTp),
      route,
      el('div', { class: 'gcr-muted', style: 'margin:8px 0 0' }, L('Pista de aterizare (✓ = recomandată după vânt):', 'Landing runway (✓ = recommended for the wind):')), rwList);
    p.append(
      here,
      el('div', { class: 'gcr-row' }, q, go), results,
      el('div', { class: 'gcr-row', style: 'margin-top:8px' }, el('b', {}, L('Idei de destinații', 'Destination ideas')), band, more), sugg,
      tripBox, dest, plan,
      el('div', { class: 'gcr-row', style: 'margin-top:8px' }, btnClear, btnLoad),
      status,
    );
    ui.setStatus = (t) => { status.textContent = t; };

    const destRow = (a, lat, lon) => {
      const d = distM(lat, lon, a.lat, a.lon) / NM, b = bearing(lat, lon, a.lat, a.lon);
      const spd = AP.cruiseSpd || (isLight() ? 120 : 400);
      const mins = (d / (isLight() ? spd : Math.max(spd * 1.5, 250))) * 60 + 12;
      const add = el('button', { class: 'gcr-btn sm', title: L('Adaugă în plan ca escală / următoarea oprire', 'Add to the plan as a stopover / next stop'), onclick: (e) => { e.stopPropagation(); results.style.display = 'none'; addStop(a.apt); } }, L('+ escală', '+ stopover'));
      return el('div', { class: 'gcr-item', title: L('Click = zbor direct aici', 'Click = fly directly here'), onclick: () => { results.style.display = 'none'; selectDestination(a.apt); } },
        el('div', { style: 'flex:1;min-width:0' }, el('b', {}, a.city || a.name), el('div', { class: 'gcr-muted', style: 'font-size:11px' }, `${a.name} · ${a.countryName || a.country}${a.iata ? ' · ' + a.iata : ''}`)),
        el('div', { class: 'gcr-muted', style: 'text-align:right;white-space:nowrap' }, `${d.toFixed(0)} NM`, el('br'), `${L('spre ', '')}${dirWord(b)} · ~${mins < 90 ? Math.round(mins) + ' min' : (mins / 60).toFixed(1) + ' h'}`),
        TRIP.stops.length && TRIP.from < TRIP.stops.length ? add : null);
    };

    function doSearch() {
      const txt = q.value.trim();
      if (!txt) { results.style.display = 'none'; return; }
      if (!DB.loaded) { ui.toast(L('Baza de date încă se încarcă…', 'The database is still loading…')); return; }
      const [lat, lon] = sim.lla();
      const found = searchAirports(txt, lat, lon);
      results.innerHTML = ''; results.style.display = '';
      if (!found.length) { results.append(el('div', { class: 'gcr-item gcr-muted' }, L('Nu am găsit nimic. Încearcă numele orașului (ex. „Iași”, „Londra”) sau al țării.', 'Nothing found. Try a city name (e.g. “Munich”, “London”) or a country.'))); return; }
      found.forEach((a) => results.append(destRow(a, lat, lon)));
    }

    ui.refreshNearest = () => {
      if (!DB.loaded) return;
      ui.refreshNearestHere();
      const [lat, lon] = sim.lla();
      const [mn, mx] = band.value.split(',').map(Number);
      const list = suggestDestinations(lat, lon, mn, mx, isLight() ? 2500 : 6000);
      sugg.innerHTML = '';
      if (!list.length) sugg.append(el('div', { class: 'gcr-item gcr-muted' }, L('Nicio destinație potrivită la distanța asta – alege altă categorie.', 'No suitable destination at this distance – pick another category.')));
      list.forEach((x) => sugg.append(destRow(x.a, lat, lon)));
    };
    ui.refreshNearestHere = () => {
      if (!DB.loaded) return;
      const [lat, lon] = sim.lla();
      const near = nearestAirports(lat, lon, 1, (a) => !!a)[0];
      here.innerHTML = '';
      if (near) {
        const d = near.d / NM;
        here.append(el('span', { class: 'gcr-muted' }, sim.onGround() && d < 3 ? L('Ești la: ', 'You are at: ') : L('Ești lângă: ', 'You are near: ')), el('b', {}, aptName(near.apt)),
          el('span', { class: 'gcr-muted' }, ` — ${near.a.name}${d >= 3 ? ` · ${d.toFixed(0)} NM ${L('spre', '')} ${dirWord(bearing(near.a.lat, near.a.lon, lat, lon))}${L(' de aeroport', ' of the airport')}` : ''}`));
      }
    };

    ui.showAirport = (code) => {
      code = (code || '').trim().toUpperCase(); if (!code || !DB.loaded) return;
      const rws = DB.airports.get(code); if (!rws) return;
      settings.lastAirport = code; saveSettings();
      if (!AP.rwy || AP.rwy.apt !== code) { selectRunway(bestRunway(code)); }
      const wDir = (window.weather && weather.currentWindDirection) || 0, wSpd = (window.weather && weather.currentWindSpeed) || 0;
      const best = bestRunway(code);
      rwList.innerHTML = '';
      rws.forEach((r) => {
        const head = wSpd * Math.cos((wDir - r.hdg) * D2R), cross = wSpd * Math.sin((wDir - r.hdg) * D2R);
        const sel = AP.rwy && AP.rwy.apt === r.apt && AP.rwy.ident === r.ident;
        rwList.append(el('div', { class: 'gcr-item' + (sel ? ' sel' : ''), onclick: () => { selectRunway(r); ui.showAirport(code); } },
          el('span', {}, best === r ? '✓ ' : '', el('b', {}, r.ident), ` · ${pad3(r.hdg)}°`),
          el('span', { class: 'gcr-muted' }, `${Math.round(r.ldaFt)} ft · ${L('vânt ', '')}${head >= 0 ? L('din față', 'headwind') : L('din spate', 'tailwind')} ${Math.abs(head).toFixed(0)} kt, ${L('lateral', 'crosswind')} ${Math.abs(cross).toFixed(0)} kt`)));
      });
      ui.renderNav();
    };

    ui.renderTrip = () => {
      tripBox.innerHTML = '';
      if (TRIP.stops.length < 1) return;
      const [lat, lon] = sim.lla();
      const near = DB.loaded ? nearestAirports(lat, lon, 1, (a) => !!a)[0] : null;
      const tgt = tripTargetIdx();
      tripBox.append(el('div', { class: 'gcr-row', style: 'justify-content:space-between;margin:0 0 4px' }, el('b', {}, L('Plan de zbor', 'Flight plan')),
        el('span', { class: 'gcr-muted' }, L('caută un oraș și apasă „+ escală” ca să adaugi opriri', 'search for a city and press “+ stopover” to add stops'))));
      if (near && TRIP.from === 0) tripBox.append(el('div', { class: 'gcr-stop done' }, el('span', { class: 'n' }, '⬤'), el('span', { style: 'flex:1' }, L('Plecare: ', 'Departure: ') + aptName(near.apt))));
      let prev = near ? [near.a.lat, near.a.lon] : [lat, lon], total = 0;
      TRIP.stops.forEach((st, i) => {
        const a = DB.info.get(st.apt);
        const leg = a ? distM(prev[0], prev[1], a.lat, a.lon) / NM : 0; if (a) prev = [a.lat, a.lon];
        if (i >= TRIP.from) total += leg;
        const last = i === TRIP.stops.length - 1, done = i < TRIP.from;
        const label = last ? L('destinație finală', 'final destination') : st.mode === 'via' ? L('doar survol', 'fly-over only') : L('escală (aterizare)', 'stopover (landing)');
        const B = (t, fn, title) => el('button', { class: 'gcr-btn sm', title, onclick: (e) => { e.stopPropagation(); fn(); } }, t);
        tripBox.append(el('div', { class: 'gcr-stop' + (done ? ' done' : '') + (i === tgt ? ' cur' : '') },
          el('span', { class: 'n' }, done ? '✓' : String(i + 1)),
          el('span', { style: 'flex:1;min-width:0' }, el('b', {}, aptName(st.apt)), el('span', { class: 'gcr-muted' }, ` · ${leg.toFixed(0)} NM · `),
            last || done ? el('span', { class: 'gcr-muted' }, label) : el('a', { href: '#', class: 'gcr-link', onclick: (e) => { e.preventDefault(); toggleStopMode(i); } }, label)),
          done ? null : B('↑', () => moveStop(i, -1), L('mută mai devreme', 'move earlier')), done ? null : B('↓', () => moveStop(i, 1), L('mută mai târziu', 'move later')), B('✕', () => removeStop(i), L('șterge', 'remove'))));
      });
      tripBox.append(el('div', { class: 'gcr-muted', style: 'margin-top:3px' }, `${L('Total rămas', 'Remaining')}: ~${total.toFixed(0)} NM · ${TRIP.stops.slice(TRIP.from).filter((x, k, arr) => x.mode !== 'via' && k < arr.length - 1).length} ${L('escale cu aterizare', 'landing stopovers')}`));
    };

    ui.renderNav = () => {
      const r = AP.rwy;
      const busy = AP.active;
      btnFull.textContent = busy && AP.full ? L('■ Oprește zborul automat', '■ Stop automatic flight') : L('✈ Zbor complet: decolare → aterizare', '✈ Full flight: takeoff → landing');
      btnFull.className = 'gcr-btn big ' + (busy && AP.full ? 'warn' : 'pri');
      btnApp.textContent = busy && !AP.full ? L('Oprește apropierea', 'Stop approach') : L('Doar apropierea', 'Approach only');
      plan.style.display = r ? '' : 'none';
      dest.innerHTML = '';
      if (!r) { dest.append(el('div', { class: 'gcr-muted', style: 'margin-top:8px' }, L('Caută un oraș sau alege una dintre idei. Pluginul alege singur pista potrivită după vânt.', 'Search for a city or pick one of the ideas. The plugin chooses the best runway for the wind.'))); return; }
      const a = DB.info.get(r.apt);
      const [lat, lon] = sim.lla();
      const d = distM(lat, lon, r.lat, r.lon) / NM, b = bearing(lat, lon, r.lat, r.lon);
      dest.append(el('div', { class: 'gcr-destcard' },
        el('div', { class: 'gcr-muted', style: 'font-size:11px' }, L('DESTINAȚIE', 'DESTINATION')),
        el('div', { style: 'font-size:15px;font-weight:700' }, a ? (a.city || a.name) : r.apt),
        el('div', { class: 'gcr-muted' }, a ? `${a.name}, ${a.countryName || a.country} · ${r.apt}${a.iata ? '/' + a.iata : ''}` : r.apt),
        el('div', { style: 'margin-top:4px' }, `${d.toFixed(0)} NM ${L('spre ', '')}${dirWord(b)} (${pad3(b)}°) · ${L('pista', 'runway')} ${r.ident} · ${L('prag', 'threshold')} ${Math.round(AP.thrElevM / FT)} ft`),
        AP.active ? el('div', { style: 'color:#e040fb;margin-top:3px' }, L('Faza: ', 'Phase: ') + phaseText()) : null));
      crzAlt.placeholder = AP.cruiseFt || ''; crzSpd.placeholder = AP.cruiseSpd || '';
      crzAlt.value = settings.cruiseFt || ''; crzSpd.value = settings.cruiseSpd || '';
      route.textContent = L('Traseu: ', 'Route: ') + AP.legs.filter((l) => !l.end).map((l, i) => (i === AP.legIdx && (AP.active || AP.guide) ? '▶ ' : '') + l.name).join(' → ') +
        ` · FAF ${settings.fafNm} NM / ${Math.round(AP.fafAlt / FT)} ft · Vapp ${AP.vapp} kt`;
    };
    ui.renderNav();
  }

  function phaseText() {
    const m = { WAITTO: L('așteaptă autorizarea de decolare', 'waiting for takeoff clearance'), AUTOTO: L('decolare automată', 'automatic takeoff'), STOPOVER: L('escală', 'stopover'), TAKEOFF: L('urcare inițială', 'initial climb'), NAV: L('în drum spre destinație', 'en route to destination'), LOC: L('aliniat cu pista', 'aligned with the runway'), GS: L('pe panta de coborâre', 'on the glide path'), FLARE: 'flare', ROLLOUT: L('rulare și frânare', 'rollout and braking'), MAN: 'manual', OFF: '—' };
    return m[AP.phase] || AP.phase;
  }

  function teleportFinal() {
    const r = AP.rwy; if (!r) { ui.toast(L('Alege mai întâi pista.', 'Choose a runway first.')); return; }
    const d = AP.fafD + 3 * NM;
    const [lat, lon] = destPoint(r.lat, r.lon, norm360(r.hdg + 180), d);
    const alt = AP.fafAlt;
    const spd = suggestedVapp() + 20;
    geofs.flyTo([lat, lon, alt, r.hdg, true, spd]);
    setTimeout(() => {
      try {
        if (controls.gear.target === 0) controls.setters.setGearUp.set();
        buildRoute(); drawApproach();
        if (sim.hasAP()) { engage(); geofs.autopilot.setSpeed(spd); }
      } catch (e) { console.error(e); }
    }, 2500);
    ui.toast(L(`Teleportare la ${(d / NM).toFixed(0)} NM pe finala pistei ${r.ident}…`, `Teleporting to a ${(d / NM).toFixed(0)} NM final for runway ${r.ident}…`));
  }

  /* ---------------- Autopilot ---------------- */
  function buildApPage(p) {
    const f = {};
    const inp = (k, step) => (f[k] = el('input', { type: 'number', step: step || 1 }));
    const status = el('div', { class: 'gcr-status' });
    const row = (lbl, k, step, unit, dn, up, dv) => el('div', { class: 'gcr-row' }, el('label', {}, lbl), inp(k, step), el('span', { class: 'gcr-muted' }, unit),
      el('button', { class: 'gcr-btn sm', onclick: () => { f[k].value = (+f[k].value || 0) - dv; } }, dn),
      el('button', { class: 'gcr-btn sm', onclick: () => { f[k].value = (+f[k].value || 0) + dv; } }, up));
    p.append(
      row(L('Altitudine', 'Altitude'), 'alt', 100, 'ft', '−1000', '+1000', 1000),
      row(L('Direcție (cap)', 'Heading'), 'hdg', 1, '°', '−10', '+10', 10),
      row(L('Viteză', 'Speed'), 'spd', 1, 'kt', '−10', '+10', 10),
      row(L('Viteză vert.', 'Vertical speed'), 'vs', 100, 'ft/min', '−500', '+500', 500),
      el('div', { class: 'gcr-row' }, el('label', {}, L('Înclinare max', 'Max bank')), inp('bank'), el('span', { class: 'gcr-muted' }, '°')),
      el('div', { class: 'gcr-row', style: 'margin-top:8px' },
        el('button', { class: 'gcr-btn ok', onclick: () => apx.apply(read()) }, L('Aplică & cuplează', 'Apply & engage')),
        el('button', { class: 'gcr-btn', onclick: () => fill(apx.sync()) }, L('Valorile actuale', 'Current values')),
        el('button', { class: 'gcr-btn warn', onclick: () => { if (AP.active) disengage(true); releaseVS(); geofs.autopilot.turnOff(); } }, L('Decuplează', 'Disengage'))),
      el('div', { class: 'gcr-row' },
        el('button', { class: 'gcr-btn pri', onclick: engageFull }, L('Zbor automat spre destinație', 'Fly to destination automatically')),
        el('button', { class: 'gcr-btn sm', onclick: () => { fill(Object.assign(apx.sync(), { vs: 0 })); apx.apply(read()); } }, L('Ține tot ce am acum', 'Hold current values'))),
      el('div', { class: 'gcr-muted', style: 'margin-top:6px' }, L('Taste: Shift+↑/↓ altitudine ±1000 ft, Shift+←/→ cap ±5°, Shift+PgUp/PgDn viteză ±10 kt.', 'Keys: Shift+↑/↓ altitude ±1000 ft, Shift+←/→ heading ±5°, Shift+PgUp/PgDn speed ±10 kt.')),
      status,
    );
    f.bank.value = settings.bankMax;
    const read = () => ({ alt: +f.alt.value, hdg: +f.hdg.value, spd: +f.spd.value, vs: +f.vs.value, bank: +f.bank.value });
    const fill = (v) => { f.alt.value = v.alt; f.hdg.value = v.hdg; f.spd.value = v.spd; f.vs.value = v.vs || 0; };
    fill(apx.sync());
    ui.apStatus = () => {
      const a = geofs.autopilot;
      if (!sim.hasAP()) { status.textContent = L('Avionul curent nu are autopilot în GeoFS.', 'The current aircraft has no autopilot in GeoFS.'); return; }
      status.innerHTML = `AP <b class="${a.on ? 'gcr-on' : 'gcr-off'}">${a.on ? L('CUPLAT', 'ENGAGED') : L('DECUPLAT', 'DISENGAGED')}</b> · ALT ${fmt(a.values.altitude)} · HDG ${pad3(a.values.course)} · SPD ${fmt(a.values.speed)} · VS ${a.values.verticalSpeed == null ? '—' : fmt(a.values.verticalSpeed)}${AP.active ? ' · <b style="color:#e040fb">APR ' + AP.phase + '</b>' : ''}`;
    };
  }

  /* ---------------- Sistemele avionului ---------------- */
  function buildSysPage(p) {
    const grid = el('div', { class: 'gcr-grid' });
    const cells = {};
    const cell = (k, title, buttons) => {
      const s = el('div', { class: 's' }, '—');
      cells[k] = s;
      grid.append(el('div', { class: 'gcr-sys' }, el('div', { class: 't' }, title), s, el('div', { class: 'gcr-row', style: 'justify-content:center;margin:0' }, buttons)));
    };
    const B = (txt, fn, cls) => el('button', { class: 'gcr-btn sm ' + (cls || ''), onclick: () => { try { fn(); } catch (e) { console.error(e); } } }, txt);
    const S = (name) => () => controls.setters[name].set();
    cell('eng', L('Motoare', 'Engines'), [B(L('Pornit/Oprit', 'On/Off'), S('toggleEngines'))]);
    cell('gear', L('Tren de aterizare', 'Landing gear'), [B(L('Jos', 'Down'), S('setGearDown')), B(L('Sus', 'Up'), S('setGearUp'))]);
    cell('flaps', 'Flaps', [B('−', S('setFlapsUp')), B('+', S('setFlapsDown')), B('0', () => setFlaps(0))]);
    cell('abrk', L('Spoilere / frână aer', 'Spoilers / airbrake'), [B(L('Comută', 'Toggle'), S('setAirbrakes'))]);
    cell('pbrk', L('Frână de parcare', 'Parking brake'), [B(L('Comută', 'Toggle'), S('toggleParkingBrake'))]);
    cell('trim', L('Trim profundor', 'Elevator trim'), [B('▼', S('setElevatorTrimDown')), B('0', S('setElevatorTrimNeutral')), B('▲', S('setElevatorTrimUp'))]);
    cell('acc', L('Accesorii (cârlig/flotoare)', 'Accessories (hook/floats)'), [B(L('Comută', 'Toggle'), S('setAccessories'))]);
    cell('opt', L('Piesă opțională (uși etc.)', 'Optional part (doors etc.)'), [B(L('Comută', 'Toggle'), S('setOptionalAnimatedPart'))]);
    cell('thr', L('Manetă generală', 'Main throttle'), [B(L('Ralanti', 'Idle'), () => { controls.throttle = 0; }), B('−', S('decreaseThrottle')), B('+', S('increaseThrottle')), B('Max', () => { controls.throttle = 1; })]);
    cell('rev', L('Reverse (inversor)', 'Reverse thrust'), [B(L('Comută', 'Toggle'), S('toggleReverse'))]);
    cell('ap', 'Autopilot', [B(L('Comută', 'Toggle'), () => geofs.autopilot.toggle())]);
    cell('brk', L('Frâne roți', 'Wheel brakes'), [B(L('Apasă', 'Apply'), () => { controls.brakes = 1; sim.ac().brakesOn = true; }), B(L('Eliberează', 'Release'), () => { controls.brakes = 0; sim.ac().brakesOn = false; })]);

    // ---- motoare individuale ----
    const engBox = el('div', { style: 'margin-top:10px' });
    ui.buildEngines = () => {
      engBox.innerHTML = '';
      const list = engines();
      engBox.append(el('b', {}, `Motoare individuale (${list.length})`));
      if (!list.length) { engBox.append(el('div', { class: 'gcr-muted' }, L('Avionul ăsta nu are motoare definite separat.', 'This aircraft has no separately defined engines.'))); return; }
      engBox.append(el('div', { class: 'gcr-muted', style: 'margin:3px 0 5px' }, L('„Legat” = urmează maneta generală/autopilotul · „Manual” = maneta proprie · „Tăiat” = fără tracțiune.', '“Linked” = follows the main throttle/autopilot · “Manual” = its own lever · “Cut” = no thrust.')));
      const rev = !!(sim.ac().definition && sim.ac().definition.reverse);
      list.forEach((eng, i) => {
        const sel = el('select', {}, ...[['link', L('Legat', 'Linked')], ['man', 'Manual'], ['off', L('Tăiat', 'Cut')]].map(([v, t]) => el('option', { value: v }, t)));
        sel.value = ENG.modes[i] || 'link';
        const sl = el('input', { type: 'range', min: rev ? -1 : 0, max: 1, step: 0.01, value: ENG.levers[i] || 0, style: 'flex:1;min-width:90px' });
        const lab = el('span', { class: 'gcr-muted', style: 'min-width:120px;text-align:right' }, '—');
        sel.addEventListener('change', () => { if (sel.value === 'man') { ENG.levers[i] = clamp(controls.throttle || 0, rev ? -1 : 0, 1); sl.value = ENG.levers[i]; } engSetMode(i, sel.value); });
        sl.addEventListener('input', () => { ENG.levers[i] = +sl.value; if (ENG.modes[i] !== 'man') { sel.value = 'man'; engSetMode(i, 'man'); } });
        eng._gcr = { sl, lab, sel };
        engBox.append(el('div', { class: 'gcr-row' }, el('b', { style: 'min-width:22px' }, 'M' + (i + 1)), sel, sl), el('div', { class: 'gcr-row', style: 'justify-content:flex-end;margin-top:-4px' }, lab));
      });
      engBox.append(el('div', { class: 'gcr-row' },
        B(L('Toate legate', 'All linked'), () => { list.forEach((e, i) => engSetMode(i, 'link')); ui.buildEngines(); }),
        B(L('Toate manual la maneta actuală', 'All manual at current throttle'), () => { list.forEach((e, i) => { ENG.levers[i] = clamp(controls.throttle || 0, -1, 1); engSetMode(i, 'man'); }); ui.buildEngines(); })));
    };

    const misc = el('div', { class: 'gcr-row', style: 'margin-top:8px' },
      B(L('Pauză', 'Pause'), () => geofs.togglePause()),
      B(L('Cameră următoare', 'Next camera'), () => geofs.camera.cycle()),
      B(L('◀ Privește', '◀ Look'), () => controls.setters.lookLeft && controls.setters.lookLeft.set()),
      B(L('Privește ▶', 'Look ▶'), () => controls.setters.lookRight && controls.setters.lookRight.set()),
      B(L('Resetează zborul', 'Reset flight'), () => geofs.resetFlight(), 'warn'));
    const data = el('div', { class: 'gcr-status' });
    p.append(grid, engBox, misc, data);
    ui.buildEngines();
    const state = (on, a, b) => `<span class="${on ? 'gcr-on' : 'gcr-off'}">${on ? a : b}</span>`;
    ui.sysUpdate = () => {
      const ac = sim.ac(), v = sim.v();
      cells.eng.innerHTML = state(ac.engine && ac.engine.on, L('PORNITE', 'ON'), L('OPRITE', 'OFF')) + (ac.engine && ac.engine.rpm != null ? ` <span class="gcr-muted">${Math.round(ac.engine.rpm)} rpm</span>` : '');
      const gp = controls.gear.position, gt = controls.gear.target;
      cells.gear.innerHTML = gp !== gt ? L('<span class="gcr-tr">ÎN TRANZIT</span>', '<span class="gcr-tr">IN TRANSIT</span>') : state(gt === 0, L('JOS ✓', 'DOWN ✓'), L('SUS', 'UP'));
      const fs = sim.flapsSteps();
      cells.flaps.innerHTML = fs ? `${controls.flaps.target} / ${fs}` : '<span class="gcr-muted">n/a</span>';
      cells.abrk.innerHTML = controls.airbrakes ? state(controls.airbrakes.target === 1, L('EXTINSE', 'EXTENDED'), L('RETRASE', 'RETRACTED')) : '—';
      cells.pbrk.innerHTML = state(!!ac.brakesOn, L('TRASĂ', 'SET'), L('LIBERĂ', 'RELEASED'));
      cells.trim.textContent = fmt((controls.elevatorTrim || 0) * 100, 0) + ' %';
      cells.acc.innerHTML = controls.accessories ? state(controls.accessories.target === 1, L('ACTIV', 'ACTIVE'), L('INACTIV', 'INACTIVE')) : '—';
      cells.opt.innerHTML = controls.optionalAnimatedPart ? state(controls.optionalAnimatedPart.target === 1, L('ACTIV', 'ACTIVE'), L('INACTIV', 'INACTIVE')) : '—';
      cells.thr.textContent = fmt((controls.throttle || 0) * 100, 0) + ' %';
      const hasRev = !!(ac.definition && ac.definition.reverse);
      cells.rev.innerHTML = hasRev ? state(controls.reverse > 0 || controls.throttle < 0, L('ACTIV', 'ACTIVE'), L('INACTIV', 'INACTIVE')) : '<span class="gcr-muted">n/a</span>';
      cells.brk.innerHTML = state(controls.brakes > 0, L('APĂSATE', 'APPLIED'), L('LIBERE', 'RELEASED'));
      engSync();
      engines().forEach((eng, i) => {
        if (!eng._gcr) return;
        const m = ENG.modes[i] || 'link';
        const lever = m === 'off' ? 0 : m === 'man' ? ENG.levers[i] : controls.throttle;
        if (m !== 'man') eng._gcr.sl.value = lever || 0;
        const kN = (eng.currentThrust || 0) / 1000;
        eng._gcr.lab.textContent = `${fmt((lever || 0) * 100)}% · ${fmt(eng.rpm)} rpm · ${fmt(kN, 1)} kN`;
      });
      cells.ap.innerHTML = sim.hasAP() ? state(geofs.autopilot.on, L('CUPLAT', 'ENGAGED'), L('DECUPLAT', 'DISENGAGED')) : '<span class="gcr-muted">n/a</span>';
      data.innerHTML = `${L('Avion', 'Aircraft')}: <b>${(ac.definition && ac.definition.name) || ac.id || '?'}</b> · ${L('masă', 'mass')} ${ac.definition && ac.definition.mass ? Math.round(ac.definition.mass) + ' kg' : '—'} · AoA ${fmt(v.aoa, 1)}° · G ${fmt(v.loadFactor, 2)} · ${sim.onGround() ? L('la sol', 'on the ground') : L('în zbor', 'airborne')}`;
    };
  }

  /* ---------------- Setări ---------------- */
  function buildSetPage(p) {
    const num = (k, step, lbl, unit, after) => {
      const i = el('input', { type: 'number', step, value: settings[k] });
      i.addEventListener('change', () => { settings[k] = +i.value; saveSettings(); if (after) after(); });
      return el('div', { class: 'gcr-row' }, el('label', {}, lbl), i, el('span', { class: 'gcr-muted' }, unit));
    };
    const chk = (k, lbl, after) => {
      const i = el('input', { type: 'checkbox' }); i.checked = !!settings[k];
      i.addEventListener('change', () => { settings[k] = i.checked; saveSettings(); if (after) after(); });
      return el('div', { class: 'gcr-row' }, el('label', { style: 'min-width:0' }, i, ' ', lbl));
    };
    const rebuild = () => { if (AP.rwy) { AP.vapp = suggestedVapp(); buildRoute(); drawApproach(); ui.renderNav(); } };
    const hist = el('div', { class: 'gcr-status' });
    const langSel = el('select', {}, el('option', { value: 'en' }, 'English'), el('option', { value: 'ro' }, 'Română'));
    langSel.value = settings.lang === 'ro' ? 'ro' : 'en';
    langSel.addEventListener('change', () => { settings.lang = langSel.value; saveSettings(); rebuildUI(); });
    const about = el('div', { class: 'gcr-about' },
      el('div', { style: 'font-size:14px;font-weight:700' }, '✈ GeoFS Copilot ', el('span', { class: 'gcr-muted', style: 'font-weight:400' }, 'v' + VERSION),
        UPD.latest ? el('a', { href: '#', class: 'gcr-link', style: 'margin-left:6px;color:#4cff8f', onclick: (e) => { e.preventDefault(); showUpdate(); } }, `⬆️ ${UPD.latest} ${L('disponibil', 'available')}`) : null),
      el('div', {}, L('Creat de ', 'Made by '), el('b', {}, AUTHOR)),
      el('div', {}, el('a', { href: REPO_URL, target: '_blank', rel: 'noopener', class: 'gcr-link' }, REPO_URL.replace('https://', ''))),
      el('div', { class: 'gcr-muted', style: 'margin-top:3px' }, L('Date aeroporturi: OurAirports (domeniu public)', 'Airport data: OurAirports (public domain)')));
    p.append(
      el('div', { class: 'gcr-row' }, el('label', {}, 'Language / Limba'), langSel),
      el('b', { style: 'display:block;margin-top:6px' }, L('Apropiere', 'Approach')),
      num('gsDeg', 0.1, L('Pantă', 'Glide slope'), L('° (standard 3°)', '° (standard 3°)'), rebuild),
      num('fafNm', 1, 'FAF', L('NM de prag', 'NM from threshold'), rebuild),
      num('tchFt', 5, L('Peste prag', 'Over threshold'), 'ft', rebuild),
      num('vapp', 1, 'Vapp', L('kt (0 = automat)', 'kt (0 = auto)'), rebuild),
      num('minimumsFt', 10, L('Minime', 'Minimums'), L('ft (decuplare AP)', 'ft (AP disconnect)')),
      chk('autoConfig', L('Coboară automat trenul și flapsurile', 'Lower gear and flaps automatically')),
      chk('onlineSync', L('Publică zborurile mele în clasamentul online (indicativ + statistici de zbor)', 'Publish my flights on the online leaderboard (callsign + flight stats)')),
      (() => { const sel = el('select', {}, ...[['off', L('fără', 'off')], ['rare', L('rare', 'rare')], ['normal', L('normale', 'normal')]].map(([v, t]) => el('option', { value: v }, t)));
        sel.value = settings.failures || 'rare'; sel.addEventListener('change', () => { settings.failures = sel.value; saveSettings(); });
        return el('div', { class: 'gcr-row' }, el('label', {}, L('Defecțiuni aleatorii', 'Random failures')), sel); })(),
      chk('limit250', L('Limitează viteza la 250 kt sub 10.000 ft (ca în aviația reală)', 'Limit speed to 250 kt below 10,000 ft (like real aviation)')),
      chk('autoland', L('Aterizare automată (flare + frânare) – altfel AP se decuplează la minime', 'Automatic landing (flare + braking) – otherwise the AP disconnects at minimums')),
      chk('drawTunnel', L('Desenează culoarul 3D', 'Draw the 3D approach corridor'), () => (settings.drawTunnel ? drawApproach() : clearEntities())),
      el('b', { style: 'display:block;margin-top:8px' }, L('Afișare și sunet', 'Display and sound')),
      chk('hudVisible', L('Afișează HUD-ul (Shift+H)', 'Show the HUD (Shift+H)'), () => { ui.hud.style.display = settings.hudVisible ? '' : 'none'; }),
      chk('voice', L('Anunțuri vocale (callouts / avertizări)', 'Voice callouts and warnings')),
      chk('ndTraffic', L('Arată traficul pe hartă (★ auriu = utilizatori GeoFS Copilot)', 'Show traffic on the map (gold ★ = GeoFS Copilot users)')),
      el('b', { style: 'display:block;margin-top:8px' }, L('Taste rapide', 'Keyboard shortcuts')),
      el('div', { html: [
        ['Shift+N', L('arată/ascunde panoul', 'show/hide the panel')], ['Shift+M', L('arată/ascunde harta', 'show/hide the map')], ['Shift+P', L('zbor complet / oprește / pleacă din escală', 'full flight / stop / leave stopover')], ['Shift+H', L('arată/ascunde HUD-ul', 'show/hide the HUD')], ['Shift+L', L('activează/oprește apropierea', 'start/stop approach')],
        ['Shift+R', L('teleportare pe finală', 'teleport to final')], ['Shift+A', L('cuplează AP și ține valorile actuale', 'engage AP and hold current values')], ['Shift+↑/↓', L('AP altitudine ±1000 ft', 'AP altitude ±1000 ft')],
        ['Shift+←/→', L('AP cap ±5°', 'AP heading ±5°')], ['Shift+PgUp/PgDn', L('AP viteză ±10 kt', 'AP speed ±10 kt')], ['Shift+G', L('tren jos/sus', 'gear down/up')], ['Shift+F', L('flaps complet / retrase', 'flaps full / up')],
        ['Shift+S', L('spoilere', 'spoilers')], ['Shift+E', L('motoare pornit/oprit', 'engines on/off')], ['Shift+C', L('cameră următoare', 'next camera')], ['Shift+X', L('ultima aterizare', 'last landing')], ['Shift+Y / U', L('ATC: accept / refuz', 'ATC: accept / unable')],
      ].map(([k, d]) => `<div><span class="gcr-kbd">${k}</span> ${d}</div>`).join('') }),
      el('b', { style: 'display:block;margin-top:8px' }, L('Ultimele aterizări', 'Recent landings')), hist,
      about, adminLoginBox(),
    );
    ui.renderHist = () => {
      const h = store.get(LS_LANDINGS, []);
      hist.innerHTML = h.length ? h.slice(0, 8).map((r) => `<div>${r.apt} ${r.rwy} · <b>${r.score}</b> (${r.grade}) · ${r.vs} fpm · ${r.g} G</div>`).join('') : L('Încă nicio aterizare înregistrată.', 'No landings recorded yet.');
    };
    ui.renderHist();
  }

  /* ---------------- HUD ---------------- */
  /** Face un element fix mutabil prin tragere de `handle`; poziția se salvează în settings[key]. */
  function makeDraggable(box, handle, key) {
    let drag = null;
    const place = (x, y) => {
      const W = window.innerWidth, H = window.innerHeight;
      box.style.left = clamp(x, 0, Math.max(0, W - box.offsetWidth)) + 'px';
      box.style.top = clamp(y, 0, Math.max(0, H - 30)) + 'px';
      box.style.transform = 'none'; box.style.right = 'auto'; box.style.bottom = 'auto';
    };
    handle.addEventListener('mousedown', (e) => { const r = box.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; e.preventDefault(); e.stopPropagation(); });
    handle.addEventListener('pointerdown', (e) => e.stopPropagation());
    window.addEventListener('mousemove', (e) => { if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy); });
    window.addEventListener('mouseup', () => { if (!drag) return; drag = null; settings[key] = [parseInt(box.style.left), parseInt(box.style.top)]; saveSettings(); });
    handle.addEventListener('dblclick', () => { // dublu-click: înapoi la poziția implicită
      box.style.left = ''; box.style.top = ''; box.style.transform = ''; delete settings[key]; saveSettings();
    });
    if (settings[key]) setTimeout(() => place(settings[key][0], settings[key][1]), 0);
  }

  function buildHud() {
    const hud = el('div', { id: 'gcr-hud' });
    const cols = {};
    const col = (k, label) => { const v = el('div', {}, '—'); cols[k] = v; hud.append(el('div', { class: 'c' }, el('span', { class: 'k' }, label), v)); };
    col('ias', 'IAS / GS kt'); col('alt', 'ALT / AGL ft'); col('vs', 'V/S ft/min'); col('hdg', 'HDG / TRK');
    col('g', 'G / AoA'); col('fuel', L('COMBUSTIBIL', 'FUEL')); col('apr', L('APROPIERE', 'APPROACH'));
    const cv = el('canvas', { width: 92, height: 92 });
    hud.append(cv);
    const grip = el('span', { class: 'gcr-grip', title: L('Trage ca să muți HUD-ul (dublu-click = poziția implicită)', 'Drag to move the HUD (double-click = default position)') }, '⠿');
    hud.prepend(grip);
    document.body.append(hud);
    makeDraggable(hud, grip, 'hudPos');
    ui.hud = hud; ui.hudCols = cols; ui.hudCanvas = cv;
    hud.style.display = settings.hudVisible ? '' : 'none';
  }

  function updateHud() {
    if (!settings.hudVisible) return;
    const v = sim.v(), c = ui.hudCols;
    c.ias.textContent = `${fmt(v.kias)} / ${fmt(v.groundSpeedKnt)}`;
    c.alt.textContent = `${fmt(sim.altFt())} / ${fmt(v.haglFeet)}`;
    c.vs.textContent = (v.verticalSpeed > 0 ? '+' : '') + fmt(v.verticalSpeed);
    c.hdg.textContent = `${pad3(v.heading)} / ${trackDeg == null ? '—' : pad3(trackDeg)}`;
    c.g.textContent = `${fmt(v.loadFactor, 2)} / ${fmt(v.aoa, 1)}°`;
    if (settings.fuelOn && FUEL.kg != null) {
      const pct = Math.round((FUEL.pct || 0) * 100);
      c.fuel.innerHTML = `<span style="color:${pct < 10 ? '#ff5252' : pct < 25 ? '#ffd54f' : 'inherit'}">${Math.round(FUEL.kg)} kg · ${pct}%</span>` +
        (FUEL.endurMin != null && FUEL.flow > 0 && !sim.onGround() ? `<br><span class="k">${Math.floor(FUEL.endurMin / 60)}h${String(Math.round(FUEL.endurMin % 60)).padStart(2, '0')} ${L('autonomie', 'left')}</span>` : '');
    } else c.fuel.textContent = '—';
    const st = approachState();
    if (st) {
      const gsKt = v.groundSpeedKnt || 0;
      const eta = gsKt > 30 ? (st.distNm / gsKt) * 60 : null;
      c.apr.innerHTML = `${aptName(AP.rwy.apt)} ${AP.rwy.ident} ${fmt(st.distNm, 1)} NM${eta ? ' · ' + fmt(eta, 0) + ' min' : ''}<br><span class="k">${AP.active ? 'AUTO ' + AP.phase : 'MANUAL'} ${st.distBefore > 0 && st.distBefore < 15 * NM ? L(' · țintă ', ' · target ') + fmt(st.gpTargetFt) + ' ft' : ''}</span>`;
    } else c.apr.innerHTML = L('<span class="k">nicio pistă aleasă</span>', '<span class="k">no runway selected</span>');
    drawIls(st);
    const w = LA.warnings;
    const wb = document.getElementById('gcr-warn');
    if (w.length) { wb.style.display = 'block'; wb.textContent = w.map((x) => x[0]).join(' · '); wb.title = w.map((x) => x[1]).join(', '); }
    else wb.style.display = 'none';
  }

  function drawIls(st) {
    const cv = ui.hudCanvas, x = cv.getContext('2d'), W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, sc = 15;
    x.clearRect(0, 0, W, H);
    x.strokeStyle = 'rgba(92,255,122,.6)'; x.lineWidth = 1;
    x.strokeRect(1, 1, W - 2, H - 2);
    x.fillStyle = 'rgba(155,231,168,.9)';
    for (let i = -2; i <= 2; i++) { if (!i) continue; x.beginPath(); x.arc(cx + i * sc, H - 8, 2.2, 0, 7); x.fill(); x.beginPath(); x.arc(W - 8, cy + i * sc, 2.2, 0, 7); x.fill(); }
    x.beginPath(); x.moveTo(cx - 6, cy); x.lineTo(cx + 6, cy); x.moveTo(cx, cy - 6); x.lineTo(cx, cy + 6); x.stroke();
    if (!st || st.distBefore < -200 || st.distBefore > 25 * NM) { x.fillStyle = '#9be7a8'; x.font = '10px monospace'; x.fillText('ILS', 4, 12); return; }
    // localizer: acul arată unde e axul (dacă avionul e în dreapta, acul e în stânga)
    x.strokeStyle = '#e040fb'; x.lineWidth = 3;
    const lx = cx - st.locDots * sc; x.beginPath(); x.moveTo(lx, 8); x.lineTo(lx, H - 14); x.stroke();
    // glideslope: dacă avionul e deasupra pantei, acul e jos
    const gy = cy + st.gsDots * sc; x.beginPath(); x.moveTo(8, gy); x.lineTo(W - 14, gy); x.stroke();
    x.fillStyle = '#9be7a8'; x.font = '10px monospace'; x.fillText(AP.rwy.ident, 4, 12);
  }

  /* ---------------- Instrucțiuni pas cu pas + hartă (ND) ---------------- */
  /** Rânduri suplimentare în caseta de instrucțiuni: misiunea și combustibilul, în timp real. */
  function infoLines() {
    const out = [];
    const v = sim.v(), gs = v.groundSpeedKnt || 0;
    const pathNm = AP.guide && AP.guide.pathNm != null ? AP.guide.pathNm : null;
    const etaMin = pathNm != null && gs > 60 ? (pathNm / gs) * 60 : null;
    if (MISSION) {
      const t = mtype(MISSION.type);
      const load = MISSION.isPax ? `${MISSION.load} pax` : `${MISSION.load.toLocaleString('en-US')} kg`;
      let timing = '';
      if (MISSION.state === 'boarding') timing = L(`îmbarcare ${Math.max(0, Math.ceil((MISSION.boardEnd - Date.now()) / 1000))} s`, `boarding ${Math.max(0, Math.ceil((MISSION.boardEnd - Date.now()) / 1000))} s`);
      else {
        const left = MISSION.deadlineMin - (Date.now() - (MISSION.departedAt || MISSION.readyAt || MISSION.acceptedAt)) / 60000;
        timing = left >= 0 ? L(`${Math.round(left)} min rămase`, `${Math.round(left)} min left`) : L(`întârziere ${Math.round(-left)} min`, `late by ${Math.round(-left)} min`);
        if (etaMin != null && left >= 0) timing += etaMin <= left ? L(' · ✓ la timp', ' · ✓ on time') : L(` · ⚠ ~${Math.round(etaMin - left)} min întârziere`, ` · ⚠ ~${Math.round(etaMin - left)} min late`);
      }
      out.push([`${t.icon} ${L(t.ro, t.en)}${MISSION.points && nextPoint() ? '' : ' → ' + aptName(MISSION.to)} · ${load} · $${MISSION.pay.toLocaleString('en-US')} · ${timing}`, 'i']);
      try { const pl = pointLine(); if (pl) out.unshift(pl); } catch (e) { /* */ }
    }
    if (settings.fuelOn && FUEL.kg != null) {
      const pct = Math.round((FUEL.pct || 0) * 100);
      let txt = `⛽ ${Math.round(FUEL.kg).toLocaleString('en-US')} kg (${pct}%)`;
      if (FUEL.flow > 0) txt += ` · ${Math.round(FUEL.flow).toLocaleString('en-US')} kg/h`;
      if (FUEL.endurMin != null && FUEL.flow > 0 && !sim.onGround()) txt += ` · ${L('autonomie', 'endurance')} ${Math.floor(FUEL.endurMin / 60)}h${String(Math.round(FUEL.endurMin % 60)).padStart(2, '0')}`;
      let cls = pct < 10 ? 'w' : 'i';
      if (etaMin != null && FUEL.flow > 0 && AP.rwy) {
        const arrive = FUEL.kg - (FUEL.flow * etaMin) / 60;
        const reserve = FUEL.flow * 0.5;
        txt += ` · ${L('la sosire', 'at arrival')} ~${Math.max(0, Math.round(arrive)).toLocaleString('en-US')} kg`;
        if (arrive <= 0) { txt += L(' ⚠ NU AJUNGE', ' ⚠ NOT ENOUGH'); cls = 'w'; }
        else if (arrive < reserve) { txt += L(' ⚠ sub rezerva de 30 min', ' ⚠ below 30-min reserve'); cls = 'w'; }
        else txt += ' ✓';
      }
      out.push([txt, cls]);
    }
    return out;
  }

  function guideLines() {
    const les = lessonLines();
    const core = les.length ? les.concat(LES.id === 'takeoff' || LES.id === 'handling' || LES.id === 'engine_out' ? [] : guideLinesCore().filter((x) => x[1] !== 'm')) : guideLinesCore();
    if (!les.length && !AP.rwy && !MISSION && sim.onGround()) return core; // parcat fără plan: fără casetă // parcat fără plan: fără casetă
    const extra = infoLines();
    return core.length || extra.length ? core.concat(extra) : core;
  }

  function guideLinesCore() {
    if (!AP.rwy) return [];
    const g = AP.guide, v = sim.v(), lines = [];
    const dest = aptName(AP.rwy.apt);
    if (AP.phase === 'STOPOVER') {
      const left = Math.max(0, Math.ceil((TRIP.departAt - Date.now()) / 1000));
      return [[L(`ESCALĂ la ${aptName(TRIP.lastApt || AP.rwy.apt)} · plecăm spre ${dest} în ${left} s`, `STOPOVER at ${aptName(TRIP.lastApt || AP.rwy.apt)} · departing for ${dest} in ${left} s`), 'h'],
        [L(`Următoarea etapă: ${g ? fmt(g.pathNm) + ' NM' : ''} · Shift+P = pleacă acum`, `Next leg: ${g ? fmt(g.pathNm) + ' NM' : ''} · Shift+P = leave now`)], [L('Avionul va fi mutat la începutul pistei și decolează automat.', 'The aircraft will be moved to the start of the runway and take off automatically.'), 'm']];
    }
    if (AP.phase === 'FLARE' || AP.phase === 'ROLLOUT') return [[L('ATERIZARE – flare și frânare', 'LANDING – flare and braking'), 'h']];
    if (AP.phase === 'WAITTO') {
      const near = nearestAirports(...sim.lla().slice(0, 2), 1)[0];
      const human = near && humanAtcAt(near.apt);
      return [[L('AȘTEPTĂM AUTORIZAREA DE DECOLARE', 'WAITING FOR TAKEOFF CLEARANCE'), 'h'],
        [human ? L(`Controlor: ${human.cs} – cererea a fost trimisă.`, `Controller: ${human.cs} – request sent.`) : L('Turnul virtual verifică pista și finala…', 'The virtual tower is checking the runway and final…')],
        [L('Shift+P anulează.', 'Shift+P cancels.'), 'm']];
    }
    if (ATC.vector && !sim.onGround()) {
      const vct = ATC.vector;
      lines.push([`ATC: ${vct.hold ? L('așteptare (orbită)', 'holding') : vct.hdg != null ? L('cap ', 'heading ') + pad3(vct.hdg) + '°' : ''}${vct.alt != null ? ' · ' + vct.alt + ' ft' : ''}${vct.spd != null ? ' · ' + vct.spd + ' kt' : ''}`, 'h']);
      lines.push([L('Instrucțiune de la controlor – navigația proprie e suspendată până la „Reia navigația”.', 'Controller instruction – own navigation suspended until “Resume nav”.'), 'm']);
      return lines;
    }
    if (AP.phase === 'AUTOTO' && TO.active) {
      const vr = TO.vr, k = Math.round(v.kias || 0);
      return [[L(`DECOLARE AUTOMATĂ · pista ${TO.rwy.ident} · ${k} / ${vr} kt`, `AUTOMATIC TAKEOFF · runway ${TO.rwy.ident} · ${k} / ${vr} kt`), 'h'],
        [sim.onGround() ? (k < vr ? L('Motor la maxim, menținem axul pistei…', 'Full power, holding the runway centerline…') : L('ROTIRE – botul se ridică…', 'ROTATE – nose coming up…')) : L('Desprindere – urcăm, autopilotul preia imediat.', 'Liftoff – climbing, the autopilot takes over now.')],
        [L('Nu atinge comenzile. Shift+P oprește decolarea.', 'Do not touch the controls. Shift+P aborts the takeoff.'), 'm']];
    }
    if (sim.onGround()) {
      if (AP.phase === 'ROLLOUT' || !g) return lines;
      const st = approachState();
      if (st && st.distNm < 3) return [[L('Ai ajuns la ', 'You have arrived at ') + dest + '. ' + L('Rulează încet și oprește motorul (Shift+E).', 'Taxi slowly and shut down the engine (Shift+E).'), 'h']];
      const pb = !!sim.ac().brakesOn, thr = controls.throttle || 0, vr = vrSpeed();
      lines.push([L(`DECOLARE spre ${dest} (${fmt(g.pathNm)} NM)`, `TAKEOFF to ${dest} (${fmt(g.pathNm)} NM)`), 'h']);
      lines.push([`${pb ? L('✗ Frâna de parcare e trasă – eliberează-o (tasta ;)', '✗ Parking brake is set – release it (key ;)') : L('✓ Frâna de parcare eliberată', '✓ Parking brake released')}`]);
      lines.push([`${thr > 0.9 ? '✓' : '➜'} ` + L(`Motor la maxim (acum ${Math.round(thr * 100)}%)   ➜ La ${vr} kt (acum ${Math.round(v.kias || 0)}) trage ușor de manșă`, `Full power (now ${Math.round(thr * 100)}%)   ➜ At ${vr} kt (now ${Math.round(v.kias || 0)}) pull back gently`)]);
      lines.push([AP.active && AP.full && sim.hasAP() ? L('La 400 ft trenul se ridică și autopilotul preia zborul.', 'At 400 ft the gear comes up and the autopilot takes over.') : L('Pentru zbor automat apasă „Zbor complet”; altfel urmează instrucțiunile de aici după decolare.', 'For an automatic flight press “Full flight”; otherwise follow these instructions after takeoff.'), 'm']);
      return lines;
    }
    if (!g) return lines;
    const diff = norm180(g.hdg - v.heading);
    const turn = Math.abs(diff) < 5 ? L(`✓ Menține capul ${pad3(g.hdg)}°`, `✓ Hold heading ${pad3(g.hdg)}°`)
      : `${diff > 0 ? L('➜ Virează la DREAPTA', '➜ Turn RIGHT') : L('⬅ Virează la STÂNGA', '⬅ Turn LEFT')} ${Math.round(Math.abs(diff))}° → ${L('cap', 'heading')} ${pad3(g.hdg)}°`;
    const altFt = sim.altFt(), dv = g.tgtFt - altFt, t100 = Math.round(g.tgtFt / 100) * 100;
    const vert = g.inGS ? (Math.abs(dv) < 80 ? L('✓ Pe panta de coborâre', '✓ On the glide path') : dv > 0 ? L('⬆ Ești sub pantă – coboară mai încet', '⬆ Below the glide path – descend slower') : L('⬇ Ești deasupra pantei – coboară mai repede', '⬇ Above the glide path – descend faster'))
      : Math.abs(dv) < 250 ? L(`✓ Menține ${t100} ft`, `✓ Maintain ${t100} ft`) : dv > 0 ? L(`⬆ Urcă la ${t100} ft`, `⬆ Climb to ${t100} ft`) : L(`⬇ Coboară la ${t100} ft`, `⬇ Descend to ${t100} ft`);
    lines.push([turn + '    ' + vert, 'h']);
    const gsKt = v.groundSpeedKnt || 0, eta = gsKt > 40 ? (g.pathNm / gsKt) * 60 : null;
    lines.push([`${L('Spre', 'To')} ${dest} · ${fmt(g.pathNm)} NM${eta ? ' · ~' + (eta < 90 ? Math.round(eta) + ' min' : (eta / 60).toFixed(1) + ' h') : ''} · ${L('următorul punct', 'next waypoint')}: ${g.leg.name} (${fmt(g.legDistNm, g.legDistNm < 10 ? 1 : 0)} NM)`]);
    if (!g.inGS && g.todNm != null && g.todNm > 1 && AP.cruiseFt && Math.abs(altFt - AP.cruiseFt) < 1500 && g.tgtFt >= AP.cruiseFt - 50) lines.push([L(`Coborârea spre ${dest} începe în ~${Math.round(g.todNm)} NM`, `Descent to ${dest} begins in ~${Math.round(g.todNm)} NM`)]);
    if (g.onFinal && !g.inGS) lines.push([L('Pe finală: trenul jos, flapsuri complet, viteza ', 'On final: gear down, full flaps, speed ') + AP.vapp + ' kt']);
    if (AP.active) lines.push([L('Pilot automat: ', 'Autopilot: ') + phaseText(), 'm']);
    return lines;
  }

  const ND = { ranges: [5, 10, 20, 40, 80, 160, 320, 640], near: [], nearT: 0 };
  function buildNd() {
    const sizes = { mic: [220, 200], mediu: [300, 270], mare: [400, 360] };
    if (!sizes[settings.ndSize]) settings.ndSize = 'mediu';
    const cv = el('canvas', { width: sizes[settings.ndSize][0], height: sizes[settings.ndSize][1] });
    const head = el('div', { class: 'gcr-ndh' }, '—');
    const sizeBtn = el('button', { class: 'gcr-btn sm', title: L('Mărimea hărții', 'Map size'), onclick: () => {
      const order = ['mic', 'mediu', 'mare'];
      settings.ndSize = order[(order.indexOf(settings.ndSize) + 1) % 3]; saveSettings();
      [cv.width, cv.height] = sizes[settings.ndSize]; keepInside(); try { drawNd(); } catch (e) { /* */ }
    } }, '⤢');
    const grip = el('div', { class: 'gcr-ndgrip', title: L('Trage de aici ca să muți harta', 'Drag here to move the map') }, el('span', {}, L('⠿ Hartă – trage ca s-o muți', '⠿ Map – drag to move')), sizeBtn);
    const B = (t, fn, title) => el('button', { class: 'gcr-btn sm', title: title || '', onclick: fn }, t);
    const lab = el('span', { class: 'gcr-muted' }, '');
    const setLab = () => { lab.textContent = settings.ndRange + ' NM'; };
    const zoom = (d) => { const i = clamp(ND.ranges.indexOf(settings.ndRange) + d, 0, ND.ranges.length - 1); settings.ndRange = ND.ranges[i]; saveSettings(); setLab(); ND.nearT = 0; };
    const foot = el('div', { class: 'gcr-row', style: 'margin:4px 0 0;justify-content:space-between' },
      el('span', {}, B('−', () => zoom(1), L('micșorează', 'zoom out')), ' ', B('+', () => zoom(-1), L('mărește', 'zoom in')), ' ', lab),
      B(L('Nord sus / Cap sus', 'North up / Heading up'), () => { settings.ndNorthUp = !settings.ndNorthUp; saveSettings(); }),
      B('✕', () => toggleNd(false), 'Shift+M'));
    const box = el('div', { id: 'gcr-nd' }, grip, head, cv, foot);
    // mutare prin tragere de bara de sus; poziția se ține minte
    let drag = null;
    const startDrag = (cx, cy) => { const r = box.getBoundingClientRect(); drag = { dx: cx - r.left, dy: cy - r.top }; };
    const moveTo = (x, y) => {
      const W = window.innerWidth, H = window.innerHeight, bw = box.offsetWidth, bh = box.offsetHeight;
      box.style.left = clamp(x, 0, Math.max(0, W - bw)) + 'px'; box.style.top = clamp(y, 0, Math.max(0, H - bh)) + 'px';
      box.style.bottom = 'auto'; box.style.right = 'auto';
    };
    function keepInside() { const r = box.getBoundingClientRect(); if (settings.ndPos) moveTo(r.left, r.top); }
    grip.addEventListener('mousedown', (e) => { if (e.target.tagName === 'BUTTON') return; startDrag(e.clientX, e.clientY); e.preventDefault(); });
    grip.addEventListener('touchstart', (e) => { const t = e.touches[0]; startDrag(t.clientX, t.clientY); }, { passive: true });
    window.addEventListener('mousemove', (e) => { if (drag) moveTo(e.clientX - drag.dx, e.clientY - drag.dy); });
    window.addEventListener('touchmove', (e) => { if (drag) { const t = e.touches[0]; moveTo(t.clientX - drag.dx, t.clientY - drag.dy); } }, { passive: true });
    const endDrag = () => { if (!drag) return; drag = null; settings.ndPos = [parseInt(box.style.left), parseInt(box.style.top)]; saveSettings(); };
    window.addEventListener('mouseup', endDrag); window.addEventListener('touchend', endDrag);
    window.addEventListener('resize', keepInside);
    ['mousedown', 'pointerdown', 'wheel', 'touchstart'].forEach((t) => box.addEventListener(t, (e) => e.stopPropagation()));
    box.addEventListener('wheel', (e) => { zoom(e.deltaY > 0 ? 1 : -1); e.preventDefault(); }, { passive: false });
    document.body.append(box);
    if (!ND.ranges.includes(settings.ndRange)) settings.ndRange = 40;
    setLab();
    ui.nd = box; ui.ndCanvas = cv; ui.ndHead = head;
    if (settings.ndPos) setTimeout(() => moveTo(settings.ndPos[0], settings.ndPos[1]), 0);
    const guide = el('div', { id: 'gcr-guide' });
    guide._grip = el('span', { class: 'gcr-grip', title: L('Trage ca să muți instrucțiunile (dublu-click = poziția implicită)', 'Drag to move the instructions (double-click = default position)') }, '⠿');
    const guideBody = el('div', { style: 'padding-left:10px' });
    guide.append(guide._grip, guideBody);
    document.body.append(guide); ui.guide = guide; ui.guideBody = guideBody;
    makeDraggable(guide, guide._grip, 'guidePos');
    toggleNd(settings.ndVisible);
  }
  function toggleNd(show) {
    settings.ndVisible = show == null ? !settings.ndVisible : show; saveSettings();
    ui.nd.style.display = settings.ndVisible ? '' : 'none';
  }

  function updateGuide() {
    const lines = guideLines();
    const g = ui.guide;
    if (!lines.length) { g.style.display = 'none'; return; }
    g.style.display = 'block';
    const html = lines.map(([t, c]) => `<div class="${c === 'h' ? 'gh' : c === 'm' ? 'gm' : c === 'i' ? 'gi' : c === 'w' ? 'gw' : ''}">${t}</div>`).join('');
    if (g._h !== html) { ui.guideBody.innerHTML = html; g._h = html; }
  }

  function drawNd() {
    if (!settings.ndVisible) return;
    const cv = ui.ndCanvas, x = cv.getContext('2d'), W = cv.width, H = cv.height;
    const v = sim.v(); const [lat, lon] = sim.lla(); const hdg = norm360(v.heading);
    const northUp = !!settings.ndNorthUp, rot = (northUp ? 0 : hdg) * D2R;
    const cx = W / 2, cy = northUp ? H / 2 : H * 0.66;
    const Rpx = northUp ? Math.min(cx, cy) - 14 : cy - 16;
    const range = settings.ndRange * NM, sc = Rpx / range;
    const cosLat = Math.cos(lat * D2R);
    const toXY = (la, lo) => {
      const dx = (lo - lon) * D2R * cosLat * R_EARTH, dy = (la - lat) * D2R * R_EARTH;
      const sx = dx * Math.cos(rot) - dy * Math.sin(rot), sy = dx * Math.sin(rot) + dy * Math.cos(rot);
      return [cx + sx * sc, cy - sy * sc];
    };
    x.clearRect(0, 0, W, H);
    x.fillStyle = '#05080d'; x.fillRect(0, 0, W, H);
    x.save(); x.beginPath(); x.rect(0, 0, W, H); x.clip();
    // cercuri de distanță
    x.strokeStyle = 'rgba(255,255,255,.18)'; x.lineWidth = 1; x.setLineDash([4, 4]);
    [0.5, 1].forEach((f) => { x.beginPath(); x.arc(cx, cy, Rpx * f, 0, 7); x.stroke(); });
    x.setLineDash([]);
    x.fillStyle = 'rgba(255,255,255,.45)'; x.font = '10px system-ui';
    x.fillText(settings.ndRange / 2 + '', cx + Rpx * 0.5 * 0.71 + 2, cy - Rpx * 0.5 * 0.71);
    // gradație busolă
    for (let d = 0; d < 360; d += 10) {
      const a = (d * D2R) - rot; const s = Math.sin(a), c = Math.cos(a);
      const r1 = Rpx, r2 = Rpx - (d % 30 === 0 ? 8 : 4);
      x.strokeStyle = 'rgba(255,255,255,.5)'; x.beginPath(); x.moveTo(cx + s * r1, cy - c * r1); x.lineTo(cx + s * r2, cy - c * r2); x.stroke();
      if (d % 30 === 0) {
        const t = { 0: 'N', 90: 'E', 180: 'S', 270: L('V', 'W') }[d] || String(d / 10);
        x.fillStyle = d === 0 ? '#ff6b6b' : 'rgba(255,255,255,.75)'; x.font = d % 90 === 0 ? 'bold 11px system-ui' : '10px system-ui';
        const rr = Rpx - 16; x.fillText(t, cx + s * rr - x.measureText(t).width / 2, cy - c * rr + 4);
      }
    }
    // aeroporturi din jur, cu numele orașului
    if (DB.loaded && performance.now() - ND.nearT > 4000) {
      ND.nearT = performance.now(); const rg = settings.ndRange;
      ND.near = nearestAirports(lat, lon, 50, (a) => a && (rg > 80 ? a.type === 'large_airport' : rg > 20 ? a.type !== 'small_airport' : true)).filter((n) => n.d < range * 1.3);
    }
    x.font = '10px system-ui';
    const placed = [];
    ND.near.forEach((n) => {
      const [px, py] = toXY(n.a.lat, n.a.lon);
      const isDest = AP.rwy && AP.rwy.apt === n.apt;
      x.strokeStyle = isDest ? '#e040fb' : '#4dd0e1'; x.lineWidth = 1.5;
      x.beginPath(); x.arc(px, py, n.a.type === 'large_airport' ? 4.5 : 3, 0, 7); x.stroke();
      const label = n.a.city || n.a.name, lw = x.measureText(label).width;
      if (!isDest && placed.some((b) => px + 6 < b[0] + b[2] && px + 6 + lw > b[0] && Math.abs(py - b[1]) < 11)) return; // fără suprapuneri
      placed.push([px + 6, py, lw]);
      x.fillStyle = isDest ? '#f3b6ff' : 'rgba(150,230,240,.9)'; x.fillText(label, px + 6, py + 3);
    });
    // traseul zburat până acum în zborul curent
    if (FLT && FLT.track.length > 1) {
      x.strokeStyle = 'rgba(92,255,122,.45)'; x.lineWidth = 1.5; x.beginPath();
      FLT.track.concat([[lat, lon]]).forEach((pt, i) => { const [px, py] = toXY(pt[0], pt[1]); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
    }
    try { ndMissionMarks(x, toXY, sc); } catch (e) { /* */ }
    // traficul din multiplayer: utilizatorii GeoFS Copilot sunt evidențiați cu auriu
    if (settings.ndTraffic && window.multiplayer) {
      const myAltFt = sim.altFt();
      getTraffic().filter((t) => t.age < 20000 && distM(lat, lon, t.lat, t.lon) < range * 1.1).forEach((t) => {
        const [px, py] = toXY(t.lat, t.lon);
        const a = t.hdg * D2R - rot;
        x.save(); x.translate(px, py); x.rotate(a);
        x.fillStyle = t.cp ? '#ffd54f' : t.ai ? 'rgba(128,203,196,.55)' : 'rgba(220,230,240,.85)';
        x.beginPath(); x.moveTo(0, t.cp ? -8 : -6); x.lineTo(t.cp ? 5 : 4, t.cp ? 6 : 5); x.lineTo(0, 2.5); x.lineTo(t.cp ? -5 : -4, t.cp ? 6 : 5); x.closePath(); x.fill();
        x.restore();
        if (t.cp) { x.strokeStyle = '#ffd54f'; x.lineWidth = 1.2; x.beginPath(); x.arc(px, py, 10, 0, 7); x.stroke(); }
        if (t.cp || (!t.ai && settings.ndRange <= 40)) {
          const dAlt = Math.round((t.altM / FT - myAltFt) / 100);
          x.font = t.cp ? 'bold 10px system-ui' : '9px system-ui';
          x.fillStyle = t.cp ? '#ffe082' : 'rgba(220,230,240,.8)';
          x.fillText((t.cp ? '★ ' : '') + t.cs.slice(0, 14), px + 9, py - 3);
          x.fillText((dAlt >= 0 ? '+' : '') + String(Math.abs(dAlt)).padStart(2, '0') + (dAlt >= 0 ? '' : '↓'), px + 9, py + 8);
        }
      });
    }
    // traseul
    if (AP.rwy && AP.legs.length) {
      const pts = [[lat, lon]].concat(AP.legs.slice(AP.legIdx).filter((l) => !l.end).map((l) => [l.lat, l.lon]));
      x.strokeStyle = '#e040fb'; x.lineWidth = 2.5; x.beginPath();
      pts.forEach((p, i) => { const [px, py] = toXY(p[0], p[1]); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
      AP.legs.slice(AP.legIdx).forEach((l) => {
        if (l.end) return; const [px, py] = toXY(l.lat, l.lon);
        x.fillStyle = '#e040fb'; x.beginPath(); x.moveTo(px, py - 5); x.lineTo(px + 4, py + 3); x.lineTo(px - 4, py + 3); x.fill();
        x.fillStyle = '#f3b6ff'; x.fillText(l.name, px + 6, py - 4);
      });
      const r = AP.rwy; const [a1, b1] = toXY(r.lat, r.lon), [a2, b2] = toXY(r.endLat, r.endLon);
      x.strokeStyle = '#fff'; x.lineWidth = Math.max(3, Math.min(8, r.lenFt * FT * sc)); x.beginPath(); x.moveTo(a1, b1); x.lineTo(a2, b2); x.stroke();
      // destinația în afara hărții: săgeată pe margine
      const dNm = distM(lat, lon, r.lat, r.lon) / NM;
      if (dNm > settings.ndRange * 0.95) {
        const a = bearing(lat, lon, r.lat, r.lon) * D2R - rot; const s = Math.sin(a), c = Math.cos(a), rr = Rpx - 26;
        const ax = cx + s * rr, ay = cy - c * rr;
        x.fillStyle = '#e040fb'; x.save(); x.translate(ax, ay); x.rotate(a);
        x.beginPath(); x.moveTo(0, -9); x.lineTo(7, 5); x.lineTo(-7, 5); x.fill(); x.restore();
        x.font = 'bold 11px system-ui'; const t = `${aptName(r.apt)} ${dNm.toFixed(0)} NM`;
        const tw = x.measureText(t).width; x.fillStyle = 'rgba(0,0,0,.6)'; x.fillRect(clamp(ax - tw / 2, 2, W - tw - 2) - 2, ay + 8, tw + 4, 14);
        x.fillStyle = '#f3b6ff'; x.fillText(t, clamp(ax - tw / 2, 2, W - tw - 2), ay + 19);
      }
    }
    // direcția de deplasare (track) și avionul
    if (trackDeg != null) {
      const a = trackDeg * D2R - rot; x.strokeStyle = 'rgba(92,255,122,.8)'; x.lineWidth = 1.5; x.setLineDash([6, 4]);
      x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.sin(a) * Rpx, cy - Math.cos(a) * Rpx); x.stroke(); x.setLineDash([]);
    }
    x.save(); x.translate(cx, cy); x.rotate(hdg * D2R - rot);
    x.fillStyle = '#ffd54f'; x.strokeStyle = '#000'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, -11); x.lineTo(2, -3); x.lineTo(10, 2); x.lineTo(10, 4); x.lineTo(2, 2); x.lineTo(1.5, 8); x.lineTo(4, 10); x.lineTo(4, 11.5);
    x.lineTo(0, 10.5); x.lineTo(-4, 11.5); x.lineTo(-4, 10); x.lineTo(-1.5, 8); x.lineTo(-2, 2); x.lineTo(-10, 4); x.lineTo(-10, 2); x.lineTo(-2, -3); x.closePath(); x.fill(); x.stroke();
    x.restore();
    // vântul
    const wd = (window.weather && weather.currentWindDirection) || 0, ws = (window.weather && weather.currentWindSpeed) || 0;
    if (ws > 0.5) {
      const a = (wd + 180) * D2R - rot; x.save(); x.translate(22, 24); x.rotate(a);
      x.strokeStyle = '#90caf9'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, 10); x.lineTo(0, -10); x.moveTo(-4, -5); x.lineTo(0, -10); x.lineTo(4, -5); x.stroke(); x.restore();
      x.fillStyle = '#90caf9'; x.font = '10px system-ui'; x.fillText(`${pad3(wd)}°/${Math.round(ws)}kt`, 6, 48);
    }
    x.restore();
    const g = AP.guide;
    ui.ndHead.innerHTML = `HDG <b>${pad3(hdg)}</b> · TRK <b>${trackDeg == null ? '—' : pad3(trackDeg)}</b> · GS <b>${fmt(v.groundSpeedKnt)}</b> kt` +
      (AP.rwy ? `<br><span style="color:#f3b6ff">${L('Spre', 'To')} ${aptName(AP.rwy.apt)}: ${g ? pad3(g.track) + '° · ' + fmt(g.pathNm) + ' NM' : ''}${TRIP.stops.length > 1 ? ` · ${L('etapa', 'leg')} ${Math.min(TRIP.stops.filter((x, i) => i <= tripTargetIdx() && (x.mode !== 'via' || i === TRIP.stops.length - 1)).length, 99)}/${TRIP.stops.filter((x, i) => x.mode !== 'via' || i === TRIP.stops.length - 1).length}` : ''}</span>` : '<br><span class="gcr-muted">' + L('Nicio destinație aleasă', 'No destination selected') + '</span>');
  }

  ui.toast = (t, ms = 4500) => {
    const e = document.getElementById('gcr-toast'); if (!e) return;
    e.textContent = t; e.style.display = 'block';
    clearTimeout(ui._tt); ui._tt = setTimeout(() => { e.style.display = 'none'; }, ms);
  };
  ui.showLanding = (r, notes) => {
    const e = document.getElementById('gcr-landing');
    e.innerHTML = `<div class="gcr-muted">${L('Aterizare', 'Landing')} ${r.apt} ${r.rwy}</div><div class="score">${r.score}</div><div><b>${r.grade}</b></div>
      <div style="margin-top:8px;text-align:left">${L('Rată la contact', 'Touchdown rate')}: <b>${r.vs} ft/min</b><br>${L('Forță G', 'G-force')}: <b>${r.g}</b><br>
      ${L('Abatere de la ax', 'Centerline offset')}: <b>${r.clM == null ? '—' : Math.abs(r.clM) + ' m ' + (r.clM > 0 ? L('dreapta', 'right') : L('stânga', 'left'))}</b><br>
      ${L('Punct de contact', 'Touchdown point')}: <b>${r.tdzM == null ? '—' : r.tdzM + L(' m după prag', ' m past threshold')}</b><br>${L('Aliniere', 'Alignment')}: <b>${r.alignDeg == null ? '—' : r.alignDeg + '°'}</b><br>${L('Viteză', 'Speed')}: <b>${r.kias} kt</b></div>
      ${notes.length ? '<div style="margin-top:8px;color:#ffd54f">' + notes.join('<br>') + '</div>' : ''}
      <div class="gcr-muted" style="margin-top:8px">${L('(click pentru a închide)', '(click to close)')}</div>`;
    e.style.display = 'block'; e.onclick = () => { e.style.display = 'none'; };
    clearTimeout(ui._lt); ui._lt = setTimeout(() => { e.style.display = 'none'; }, 20000);
    ui.renderHist && ui.renderHist();
  };
  ui.updateLive = () => {
    if (settings.panelVisible) {
      if (ui.tab === 'sys') ui.sysUpdate();
      if (ui.tab === 'ap') ui.apStatus();
      if (ui.tab === 'nav' && AP.active) {
        if (ui._lastLeg !== AP.legIdx || ui._lastPhase !== AP.phase) { ui._lastLeg = AP.legIdx; ui._lastPhase = AP.phase; ui.renderNav(); }
      }
    }
  };

  /* =====================================================================
   *  ATC – CONTROL DE TRAFIC AERIAN
   *  Transport: chatul GeoFS (max. 70 de caractere / mesaj, necesită login în GeoFS).
   *  Format mesaj:  "@DESTINATAR text lizibil #COD [argument]"
   *    controlor → pilot:  #TO rwy  #LU rwy  #LD rwy  #GA  #HOLD  #RES  #HDG deg  #ALT ft  #SPD kt  #SEQ n  #MSG
   *    pilot → controlor:  #RQTO rwy  #RQLD rwy  #WILCO cod  #UNABLE cod
   *    anunț controlor:    "... #ATC ICAO"  (la 60 s)   /   "... #ATCOFF ICAO"
   *  Fără controlor om: turn virtual local, pe baza pozițiilor din multiplayer-ul GeoFS.
   * ===================================================================== */
  const ATC = {
    stations: {},          // controlori om cunoscuți: { ICAO: { cs, t } }
    log: [],               // { t, from, text, dir: 'in'|'out'|'sys' }
    pending: null,         // pilot: instrucțiune ce așteaptă confirmare
    vector: null,          // pilot: { hdg, alt, spd, hold:{lat,lon} }
    toClr: false, landClr: false, landReqSent: false, toReqSent: false, inbSent: false,
    requests: {},          // controlor: { callsign: { code, arg, t } }
    acks: {},              // controlor: ultima confirmare de la fiecare pilot
    outQ: [], lastSend: 0, lastBeat: 0, warnedLogin: false,
    sel: null,             // controlor: callsign selectat
    autoT: 0, autoMsgs: {},
  };
  const ATC_CODES_ACTION = ['TO', 'LU', 'LD', 'GA', 'HOLD', 'RES', 'HDG', 'ALT', 'SPD'];

  function myCallsign() {
    const u = geofs.userRecord || {};
    let cs = u.callsign;
    if (!cs) { const e = document.querySelector('.geofs-callsign'); cs = e ? e.textContent.trim() : ''; }
    return (cs || 'Foo').trim();
  }
  const geofsLoggedIn = () => !!(geofs.userRecord && geofs.userRecord.id);

  function atcLog(from, text, dir) {
    ATC.log.unshift({ t: Date.now(), from, text, dir });
    ATC.log = ATC.log.slice(0, 40);
    ui.renderAtc && ui.renderAtc();
  }
  /** Pune un mesaj în coada de chat (GeoFS trimite câte unul la fiecare actualizare). */
  function atcSend(text) {
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 70) { // păstrăm codul de la final, scurtăm textul lizibil
      const i = text.lastIndexOf('#'); const code = i >= 0 ? text.slice(i) : '';
      text = text.slice(0, 70 - code.length - 2).trim() + '… ' + code;
    }
    ATC.outQ.push(text);
    atcLog(myCallsign(), text, 'out');
    if (!geofsLoggedIn() && !ATC.warnedLogin) {
      ATC.warnedLogin = true;
      ui.toast(L('Chatul GeoFS cere login – conectează-te în GeoFS ca mesajele ATC să ajungă la ceilalți.', 'GeoFS chat requires login – sign in to GeoFS so ATC messages reach other pilots.'), 9000);
    }
  }
  function atcFlushQueue() {
    if (!ATC.outQ.length || !window.multiplayer) return;
    if (multiplayer.chatMessage || Date.now() - ATC.lastSend < 2200) return;
    multiplayer.setChatMessage(ATC.outQ.shift());
    ATC.lastSend = Date.now();
  }

  function parseAtc(msg) {
    const m = msg.match(/#([A-Z]+)(?:\s+([A-Z0-9.\-]+))?\s*$/);
    if (!m) return null;
    const to = msg.startsWith('@') ? msg.slice(1, msg.indexOf(' ') > 0 ? msg.indexOf(' ') : undefined) : null;
    return { code: m[1], arg: m[2] || '', to, text: msg.replace(/\s*#[A-Z]+(?:\s+\S+)?\s*$/, '') };
  }
  function addressedToMe(msg) { const me = myCallsign(); return msg.startsWith('@' + me + ' ') || msg === '@' + me; }

  /** Primește toate mesajele din chatul GeoFS. */
  function atcOnChat(d) {
    let msg = ''; try { msg = decodeURIComponent(d.msg || ''); } catch (e) { msg = d.msg || ''; }
    const from = d.cs || '?';
    if (!msg || from === myCallsign()) return;
    const p = parseAtc(msg); if (!p) return;
    markCopilot(from, 'chat');
    if (p.code === 'ATC' && p.arg) { ATC.stations[p.arg.toUpperCase()] = { cs: from, t: Date.now() }; ui.renderAtc && ui.renderAtc(); return; }
    if (p.code === 'ATCOFF' && p.arg) { delete ATC.stations[p.arg.toUpperCase()]; ui.renderAtc && ui.renderAtc(); return; }
    if (!addressedToMe(msg)) return;
    atcLog(from, msg, 'in');
    if (settings.atcRole === 'ctrl') {
      if (p.code === 'RQTO' || p.code === 'RQLD') { ATC.requests[from] = { code: p.code, arg: p.arg, t: Date.now() }; say(p.code === 'RQTO' ? 'Departure request' : 'Landing request'); }
      if (p.code === 'WILCO' || p.code === 'UNABLE') ATC.acks[from] = { code: p.code, arg: p.arg, t: Date.now() };
      ui.renderAtc && ui.renderAtc();
      return;
    }
    // pilot: instrucțiune de la controlor
    const words = p.text.replace('@' + myCallsign(), '').trim();
    say(words, 0);
    if (ATC_CODES_ACTION.includes(p.code)) {
      ATC.pending = { code: p.code, arg: p.arg, text: words, from, t: Date.now() };
      ui.showAtcCard();
    } else ui.toast('ATC ' + from + ': ' + words, 8000);
  }
  function hookChat() {
    if (!window.ui || !window.ui.chat || window.ui.chat.__gcr) return;
    const orig = window.ui.chat.publish;
    window.ui.chat.publish = function (d) { try { atcOnChat(d); } catch (e) { console.error('[GeoFS Copilot] atc', e); } return orig.apply(this, arguments); };
    window.ui.chat.__gcr = true;
  }
  // atenție: în acest fișier `ui` e interfața pluginului; chatul GeoFS e în window.ui

  /* ---------------- Trafic (din multiplayer-ul GeoFS) ---------------- */
  /* ---------------- Recunoașterea altor utilizatori GeoFS Copilot ----------------
   * Metoda 1: un câmp mic (st.cp = versiunea) adăugat în actualizarea de poziție trimisă oricum de GeoFS.
   *           Dacă serverul dă erori după ce îl adăugăm, ne oprim singuri (multiplayerul rămâne neatins).
   * Metoda 2: oricine trimite mesaje ATC prin plugin e marcat. */
  const COP = { byId: {}, byCs: {}, beaconOff: false, errStreak: 0, okSinceOn: 0 };
  // numele „Foo” e comun tuturor piloților nelogați – nu identifică pe nimeni
  const genericCs = (cs) => !cs || /^foo$/i.test(String(cs).trim());
  function hookBeacon() {
    if (!geofs.ajax || geofs.ajax.__gcr) return;
    const orig = geofs.ajax.post;
    geofs.ajax.post = function (url, data, ok, err) {
      let tagged = false;
      try {
        if (settings.cpBeacon && !COP.beaconOff && typeof url === 'string' && url.indexOf('/update') >= 0 && data && data.st && typeof data.st === 'object') {
          data.st.cp = `${VERSION}|${rankIdx()}|${CAREER.xp}` + (settings.atcRole === 'ctrl' && settings.atcStation ? `|ATC:${settings.atcStation}:${settings.atcRwy || ''}` : ''); tagged = true;
        }
      } catch (e) { /* */ }
      if (!tagged) return orig.apply(this, arguments);
      const ok2 = function () { COP.errStreak = 0; COP.okSinceOn++; return ok && ok.apply(this, arguments); };
      const err2 = function () {
        COP.errStreak++;
        if (COP.errStreak >= 3 && COP.okSinceOn < 3) { // serverul nu acceptă câmpul: îl oprim
          COP.beaconOff = true;
          console.warn('[GeoFS Copilot] beacon disabled – the multiplayer server rejected the extra field');
        }
        return err && err.apply(this, arguments);
      };
      return orig.call(this, url, data, ok2, err2);
    };
    geofs.ajax.__gcr = true;
  }
  /** Ține minte un utilizator Copilot: după ID-ul de jucător GeoFS când îl avem, altfel după indicativ (doar dacă e unic). */
  function markCopilot(cs, via, ver, id) {
    const rec = { t: Date.now(), via, ver: ver || '', cs };
    if (id != null) { COP.byId[id] = rec; return; }
    if (genericCs(cs) || cs === myCallsign()) return;
    COP.byCs[cs] = rec;
  }
  function isCopilot(u, cs) {
    const lu = u && u.lastUpdate;
    if (lu && lu.st && lu.st.cp) { markCopilot(cs, 'beacon', String(lu.st.cp), u.id); towerFromBeacon(cs, lu.st.cp); return true; }
    const k = u && COP.byId[u.id];
    if (k && Date.now() - k.t < 10 * 60000) return true;
    if (genericCs(cs)) return false;
    const c = COP.byCs[cs]; return !!(c && Date.now() - c.t < 45 * 60000);
  }

  /** Numărul global de utilizatori Copilot, din lista de piloți online a GeoFS (aceeași cerere ca harta GeoFS). */
  function fetchGlobalCopilots() {
    if (!geofs.multiplayerHost || !geofs.ajax || !window.multiplayer || !multiplayer.myId) return;
    if (COP.global && Date.now() - COP.global.t < 120000) return;
    COP.global = Object.assign(COP.global || {}, { t: Date.now() });
    try {
      geofs.ajax.post(geofs.multiplayerHost + '/map', { id: multiplayer.myId, gid: geofs.userRecord.licenseid }, (e) => {
        const users = (e && e.users) || [];
        let n = 0, seenField = false;
        users.forEach((c) => {
          if (!c || c.id === multiplayer.myId) return;
          if (c.st) seenField = true;
          if (c.st && c.st.cp) { n++; markCopilot(c.cs, 'beacon', String(c.st.cp), c.id); towerFromBeacon(c.cs, c.st.cp); }
        });
        COP.global = { t: Date.now(), count: n, total: users.length, ok: seenField };
        updateCopBadge();
      }, () => {});
    } catch (e) { /* */ }
  }
  function copNearbyCount() { return window.multiplayer ? getTraffic().filter((t) => t.cp && t.age < 30000).length : 0; }
  function updateCopBadge() {
    if (!ui.copBadge) return;
    const me = settings.cpBeacon !== false ? 1 : 0;
    const near = copNearbyCount();
    const g = COP.global && COP.global.ok && Date.now() - COP.global.t < 600000 ? COP.global.count : null;
    const others = g != null ? g : Math.max(near, Object.values(COP.byId).filter((k) => Date.now() - k.t < 10 * 60000).length);
    ui.copBadge.textContent = '★ ' + (others + me);
    ui.copBadge.title = (g != null
      ? L(`Utilizatori GeoFS Copilot online acum: ${others + me} (tu inclus) · în zona ta: ${near}`, `GeoFS Copilot users online now: ${others + me} (including you) · near you: ${near}`)
      : L(`Utilizatori GeoFS Copilot cunoscuți: ${others + me} (tu inclus) · în zona ta: ${near}. Numărul global apare dacă serverul GeoFS îl transmite.`, `Known GeoFS Copilot users: ${others + me} (including you) · near you: ${near}. The global count appears if the GeoFS server provides it.`));
  }

  /** Un controlor își anunță turnul prin semnalul ascuns (…|ATC:LROP:26R), fără mesaje în chat. */
  function towerFromBeacon(cs, cp) {
    const part = String(cp).split('|').find((x) => x.startsWith('ATC:'));
    if (!part || !cs || cs === myCallsign()) return;
    const [, icao, rwy] = part.split(':');
    if (icao) ATC.stations[icao.toUpperCase()] = { cs, t: Date.now(), rwy: rwy || '' };
  }

  function getTraffic() {
    const out = []; const users = (window.multiplayer && multiplayer.users) || {};
    for (const id in users) {
      const u = users[id]; const lu = u && u.lastUpdate; if (!lu || !lu.co) continue;
      out.push({ id, cs: u.callsign || (u.isTraffic ? 'TFC' : '?'), lat: lu.co[0], lon: lu.co[1], altM: lu.co[2], hdg: norm360(lu.co[3] || 0),
        kias: (lu.st && lu.st.as) || 0, gear: lu.st ? !!lu.st.gr : true, ai: !!u.isTraffic, age: Date.now() - (u.lastHeartbeatTime || 0),
        cp: !u.isTraffic && isCopilot(u, u.callsign), rank: lu.st && typeof lu.st.cp === 'string' && lu.st.cp.split('|')[1] != null ? clamp(+lu.st.cp.split('|')[1] || 0, 0, 6) : null });
    }
    return out;
  }
  function trafficVsRunway(t, r, elevM) {
    const ac = alongCross(r.lat, r.lon, r.hdg, t.lat, t.lon);
    return { ac, hgt: (t.altM - elevM) / FT, onRwy: Math.abs(ac.cross) < (r.widFt * FT) / 2 + 30 && ac.along > -150 && ac.along < r.lenFt * FT + 150 && (t.altM - elevM) / FT < 150,
      onFinal: ac.along < 0 && -ac.along < 8 * NM && Math.abs(ac.cross) < 1.2 * NM && (t.altM - elevM) / FT < 4000 && Math.abs(norm180(t.hdg - r.hdg)) < 50 };
  }
  function humanAtcAt(apt) { const s = apt && ATC.stations[apt]; return s && Date.now() - s.t < 180000 ? s : null; }

  /* ---------------- Pilot: aplicarea instrucțiunilor ---------------- */
  function atcAccept() {
    const p = ATC.pending; if (!p) return;
    ATC.pending = null; ui.hideAtcCard();
    atcSend(`@${p.from} wilco ${p.text.split(' ').slice(0, 5).join(' ')} #WILCO ${p.code}`);
    const v = sim.v();
    const apAlt = geofs.autopilot.on && geofs.autopilot.values.altitude ? Math.round(geofs.autopilot.values.altitude / 100) * 100 : Math.round(sim.altFt() / 100) * 100;
    switch (p.code) {
      case 'TO': ATC.toClr = true; ATC.lastToRwy = p.arg; if (AP.phase === 'WAITTO') { if (!autoTakeoffStart()) engageFull(); } else if (sim.onGround()) engageFull(); break;
      case 'LU': atcLineUp(p.arg); break;
      case 'LD': ATC.landClr = true; ui.toast(L('Autorizat la aterizare.', 'Cleared to land.')); break;
      case 'GA': goAround(L('la cererea controlorului', 'requested by ATC')); break;
      case 'RES': ATC.vector = null; ui.toast(L('Navigație proprie reluată.', 'Resuming own navigation.')); break;
      case 'HOLD': ATC.vector = { hold: { lat: sim.lla()[0], lon: sim.lla()[1] }, alt: Math.round(sim.altFt() / 100) * 100 }; break;
      case 'HDG': ATC.vector = Object.assign(ATC.vector || { alt: apAlt }, { hdg: norm360(+p.arg), hold: null }); break;
      case 'ALT': ATC.vector = Object.assign(ATC.vector || { hdg: Math.round(norm360(v.heading)) }, { alt: +p.arg }); break;
      case 'SPD': ATC.vector = Object.assign(ATC.vector || { hdg: Math.round(norm360(v.heading)), alt: apAlt }, { spd: +p.arg }); break;
    }
    if (ATC.vector && !sim.onGround()) { if (apOn()) { AP.active = true; if (AP.phase === 'MAN' || AP.phase === 'OFF') AP.phase = 'NAV'; } }
    ui.renderAtc(); ui.renderNav && ui.renderNav();
  }
  function atcRefuse() {
    const p = ATC.pending; if (!p) return;
    ATC.pending = null; ui.hideAtcCard();
    atcSend(`@${p.from} unable #UNABLE ${p.code}`);
    ui.renderAtc();
  }
  function atcLineUp(ident) {
    const near = nearestAirports(...sim.lla().slice(0, 2), 1)[0]; if (!near || near.d > 5 * NM) return;
    const rws = DB.airports.get(near.apt) || [];
    const r = rws.find((x) => x.ident === ident) || bestRunwayForDeparture(near.apt);
    positionOnRunway(r, () => { AP.phase = 'WAITTO'; AP.active = true; AP.full = true; ui.renderNav && ui.renderNav(); });
  }
  function goAround(why) {
    if (!AP.rwy) return;
    say('Going around', 0);
    ui.toast(L('RATARE (go around) – ', 'GO AROUND – ') + why, 8000);
    ATC.landClr = false; ATC.landReqSent = false;
    if (!apOn()) return;
    AP.active = true; AP.phase = 'NAV';
    releaseVS();
    geofs.autopilot.setSpeed(AP.vapp + 30);
    if (controls.gear.target === 0) controls.setters.setGearUp.set();
    const steps = sim.flapsSteps(); if (steps) setFlaps(Math.ceil(steps / 3));
    buildRoute(); drawApproach();
    AP.goAroundUntil = Date.now() + 25000; // urcare fermă câteva secunde
    setVS(1500);
  }

  /** Apelată din bucla de ghidare. Întoarce true dacă a comandat ea autopilotul. */
  function atcGuidance(st) {
    const v = sim.v(), ap = geofs.autopilot;
    if (AP.goAroundUntil && Date.now() < AP.goAroundUntil) {
      setVS(1500); ap.setAltitude(Math.round((AP.fafAlt / FT + 1000) / 100) * 100);
      if (sim.altFt() > AP.fafAlt / FT + 800) AP.goAroundUntil = 0;
      return 'GA'; // lateral: traseul nou (circuit), vertical: urcare
    }
    if (ATC.vector && !sim.onGround()) {
      const vec = ATC.vector; const [lat, lon] = sim.lla();
      releaseVS();
      if (vec.alt != null) ap.setAltitude(vec.alt);
      if (vec.spd != null) ap.setSpeed(vec.spd);
      if (vec.hold) { // orbită de așteptare (viraje la dreapta, raza ~2.5 NM)
        const d = distM(lat, lon, vec.hold.lat, vec.hold.lon), R = 2.5 * NM;
        const toC = bearing(lat, lon, vec.hold.lat, vec.hold.lon);
        ap.setCourse(norm360(toC - 90 + clamp(((d - R) / R) * 60, -45, 45)), true);
      } else if (vec.hdg != null) ap.setCourse(vec.hdg, true);
      return true;
    }
    // autorizarea de aterizare
    if (!st || !AP.rwy || sim.onGround() || st.distBefore < 0 || st.distBefore > 12 * NM) return false;
    const human = humanAtcAt(AP.rwy.apt);
    if (human) {
      if (!ATC.landReqSent && st.distBefore < 12 * NM) {
        ATC.landReqSent = true;
        atcSend(`@${human.cs} ${Math.round(st.distBefore / NM)}NM final ${AP.rwy.ident} #RQLD ${AP.rwy.ident}`);
      }
      if (!ATC.landClr && st.hatFt < 500 && (AP.phase === 'GS' || AP.phase === 'LOC')) { goAround(L('fără autorizare de aterizare', 'no landing clearance')); return 'GA'; }
    } else if (settings.atcAuto) {
      const auto = autoTower();
      if (auto && st.distBefore < 4 * NM && !ATC.landClr) {
        if (!auto.rwyBusy) { ATC.landClr = true; atcLog(L('Turn virtual', 'Virtual tower'), `cleared to land ${AP.rwy.ident}`, 'sys'); say('Cleared to land', 0); }
      }
      if (auto && st.hatFt < 400 && st.distBefore > 0 && (auto.rwyBusy || (auto.ahead && auto.ahead.gapNm < 1.2))) {
        if (AP.phase === 'GS' || AP.phase === 'LOC' || AP.phase === 'FLARE') { goAround(auto.rwyBusy ? L('pista e ocupată', 'runway occupied') : L('trafic prea aproape în față', 'traffic too close ahead')); return 'GA'; }
      }
    }
    return false;
  }

  /** Turnul virtual: starea pistei și a finalei, calculată local din trafic. */
  function autoTower(rwy) {
    const r = rwy || AP.rwy; if (!r || !DB.loaded) return null;
    const elev = AP.rwy === r ? AP.thrElevM : (sim.onGround() && geofs.groundElevation ? geofs.groundElevation : r.elevFt * FT);
    const [lat, lon] = sim.lla(); const meAc = alongCross(r.lat, r.lon, r.hdg, lat, lon);
    let rwyBusy = false, arrivals = [];
    getTraffic().forEach((t) => {
      if (t.age > 15000 || distM(t.lat, t.lon, r.lat, r.lon) > 15 * NM) return;
      const k = trafficVsRunway(t, r, elev);
      // pista: orice avion pe pistă; pentru capătul opus verificăm și direcția inversă
      if (k.onRwy && (t.kias > 3 || Math.abs(k.ac.cross) < (r.widFt * FT) / 2 + 10)) rwyBusy = true;
      if (k.onFinal) arrivals.push({ t, dist: -k.ac.along / NM });
    });
    arrivals.sort((a, b) => a.dist - b.dist);
    const myDist = -meAc.along / NM;
    const ahead = arrivals.filter((a) => a.dist < myDist);
    const near = ahead.length ? ahead[ahead.length - 1] : null;
    return { rwyBusy, arrivals, number: ahead.length + 1, ahead: near ? { cs: near.t.cs, gapNm: myDist - near.dist } : null, nextArrivalNm: arrivals.length ? arrivals[0].dist : null };
  }

  /** La sol, înainte de decolare: cerem autorizarea (om) sau verificăm pista (automat). True = așteptăm. */
  function atcHoldForTakeoff() {
    if (ATC.toClr) return false;
    const near = nearestAirports(...sim.lla().slice(0, 2), 1)[0];
    if (!near || near.d > 5 * NM) return false;
    const human = humanAtcAt(near.apt);
    if (!human && !settings.atcAuto) return false;
    const onRwy = runwayUnderAircraft();
    const start = () => {
      AP.active = true; AP.full = true; AP.phase = 'WAITTO';
      const r = runwayUnderAircraft();
      if (human && !ATC.toReqSent) { ATC.toReqSent = true; atcSend(`@${human.cs} ready for departure ${r ? r.ident : ''} #RQTO ${r ? r.ident : ''}`); }
      ui.renderNav && ui.renderNav();
    };
    if (!onRwy) {
      const dep = bestRunwayForDeparture(near.apt);
      if (human) { start(); return true; } // cu controlor om: așteptăm „line up” sau „cleared takeoff”
      positionOnRunway(dep, start);
      return true;
    }
    start();
    return true;
  }
  /** În faza WAITTO: turnul virtual dă autorizarea când pista și finala sunt libere. */
  function atcWaitTick() {
    if (AP.phase !== 'WAITTO') return;
    controls.throttle = 0; controls.brakes = 1; sim.ac().brakesOn = true;
    const near = nearestAirports(...sim.lla().slice(0, 2), 1)[0]; if (!near) return;
    if (humanAtcAt(near.apt)) return; // așteptăm controlorul
    if (Date.now() - ATC.autoT < 2000) return; ATC.autoT = Date.now();
    const r = runwayUnderAircraft(); if (!r) return;
    const tw = autoTower(r);
    if (!tw) return;
    const others = tw.rwyBusy && getTraffic().some((t) => t.age < 15000 && trafficVsRunway(t, r, geofs.groundElevation || r.elevFt * FT).onRwy && distM(t.lat, t.lon, ...sim.lla().slice(0, 2)) > 60);
    if (!others && (tw.nextArrivalNm == null || tw.nextArrivalNm > 4)) {
      ATC.toClr = true;
      atcLog(L('Turn virtual', 'Virtual tower'), `runway ${r.ident} cleared for takeoff`, 'sys'); say('Cleared for takeoff', 0);
      if (!autoTakeoffStart()) engageFull();
    } else if (!ATC.autoMsgs.hold || Date.now() - ATC.autoMsgs.hold > 20000) {
      ATC.autoMsgs.hold = Date.now();
      const why = others ? L('pista e ocupată', 'runway occupied') : L(`trafic pe finală la ${tw.nextArrivalNm.toFixed(1)} NM`, `traffic on final at ${tw.nextArrivalNm.toFixed(1)} NM`);
      atcLog(L('Turn virtual', 'Virtual tower'), L('Așteaptă: ', 'Hold position: ') + why, 'sys');
    }
  }

  /** La 10 Hz: coada de chat, anunțul controlorului, resetări între etape. */
  function atcTick() {
    atcFlushQueue();
    // anunț în chat doar o dată, la deschiderea turnului (prezența se transmite apoi prin semnalul ascuns)
    if (settings.atcRole === 'ctrl' && settings.atcStation && ATC.announced !== settings.atcStation) {
      ATC.announced = settings.atcStation;
      if (settings.atcAnnounce !== 'never') {
        const a = DB.info.get(settings.atcStation);
        atcSend(`${a ? (a.city || a.name).slice(0, 18) : settings.atcStation} Tower online${settings.atcRwy ? ', rwy ' + settings.atcRwy : ''} #ATC ${settings.atcStation}`);
      }
    }
    if (settings.atcRole !== 'ctrl') {
      atcWaitTick();
      // după aterizare, autorizările se resetează pentru etapa următoare
      if (sim.onGround() && (sim.v().groundSpeedKnt || 0) < 30 && ATC.landClr) { ATC.landClr = false; ATC.landReqSent = false; }
      if (!sim.onGround() && ATC.toClr && sim.v().haglFeet > 1500) { ATC.toClr = false; ATC.toReqSent = false; }
      if (ATC.pending && Date.now() - ATC.pending.t > 60000) { ATC.pending = null; ui.hideAtcCard(); }
    }
  }

  /* ---------------- Interfață ATC ---------------- */
  function buildAtcPage(p) {
    const role = el('select', {}, el('option', { value: 'pilot' }, L('Pilot', 'Pilot')), el('option', { value: 'ctrl' }, L('Controlor de trafic (ATC)', 'Air traffic controller (ATC)')));
    role.value = settings.atcRole === 'ctrl' ? 'ctrl' : 'pilot';
    const auto = el('input', { type: 'checkbox' }); auto.checked = settings.atcAuto !== false;
    auto.addEventListener('change', () => { settings.atcAuto = auto.checked; saveSettings(); });
    const pilotBox = el('div'), ctrlBox = el('div');
    const logBox = el('div', { class: 'gcr-atclog' });
    const status = el('div', { class: 'gcr-here' });
    // pilot
    const free = el('input', { placeholder: L('Mesaj către controlor…', 'Message to controller…'), style: 'flex:1;min-width:0', maxlength: 50 });
    const sendFree = () => { const st = currentAtcFor(); if (!st || !free.value.trim()) return; atcSend(`@${st.cs} ${free.value.trim()} #MSG`); free.value = ''; };
    free.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendFree(); });
    const beacon = el('input', { type: 'checkbox' }); beacon.checked = settings.cpBeacon !== false;
    beacon.addEventListener('change', () => { settings.cpBeacon = beacon.checked; saveSettings(); });
    const copBox = el('div', { class: 'gcr-muted', style: 'margin:4px 0' });
    ui.renderCop = () => {
      const list = window.multiplayer ? getTraffic().filter((t) => t.cp && t.age < 30000) : [];
      const [la, lo] = sim.lla();
      copBox.innerHTML = '';
      copBox.append(el('div', {}, '★ ' + L('Utilizatori GeoFS Copilot în zonă: ', 'GeoFS Copilot users nearby: '), el('b', { style: 'color:#ffd54f' }, String(list.length)),
        COP.global && COP.global.ok ? el('span', {}, L(' · online în total: ', ' · online worldwide: '), el('b', { style: 'color:#ffd54f' }, String(COP.global.count + (settings.cpBeacon !== false ? 1 : 0)))) : null));
      list.sort((a, b) => distM(la, lo, a.lat, a.lon) - distM(la, lo, b.lat, b.lon)).slice(0, 8).forEach((t) =>
        copBox.append(el('div', {}, `★ ${t.cs}${t.rank != null ? ' · ' + rankName(t.rank) : ''} · ${Math.round(distM(la, lo, t.lat, t.lon) / NM)} NM · ${Math.round(t.altM / FT)} ft · ${Math.round(t.kias)} kt`)));
      if (COP.beaconOff) copBox.append(el('div', { style: 'color:#ff8a80' }, L('Serverul GeoFS nu a acceptat semnalul ascuns – recunoașterea merge doar prin mesajele ATC.', 'The GeoFS server rejected the hidden signal – recognition works through ATC messages only.')));
    };
    pilotBox.append(
      el('div', { class: 'gcr-row' }, el('label', { style: 'min-width:0' }, beacon, ' ', L('Arată-le celorlalți utilizatori Copilot că folosesc pluginul', 'Show other Copilot users that I use the plugin'))),
      copBox,
      el('div', { class: 'gcr-row' }, el('label', { style: 'min-width:0' }, auto, ' ', L('Turn virtual automat când nu e controlor om', 'Automatic virtual tower when no human controller'))),
      el('div', { class: 'gcr-row' },
        el('button', { class: 'gcr-btn sm', onclick: () => { const st = currentAtcFor(); const r = runwayUnderAircraft(); if (st) atcSend(`@${st.cs} ready for departure ${r ? r.ident : ''} #RQTO ${r ? r.ident : ''}`); else ui.toast(L('Niciun controlor om la acest aeroport.', 'No human controller at this airport.')); } }, L('Cere decolarea', 'Request takeoff')),
        el('button', { class: 'gcr-btn sm', onclick: () => { const st = AP.rwy && humanAtcAt(AP.rwy.apt); if (st) atcSend(`@${st.cs} request landing ${AP.rwy.ident} #RQLD ${AP.rwy.ident}`); else ui.toast(L('Niciun controlor om la destinație.', 'No human controller at the destination.')); } }, L('Cere aterizarea', 'Request landing'))),
      el('div', { class: 'gcr-row' }, free, el('button', { class: 'gcr-btn sm', onclick: sendFree }, L('Trimite', 'Send'))));
    // controlor
    const stIn = el('input', { placeholder: L('Aeroport (oraș sau cod)', 'Airport (city or code)'), style: 'flex:1;min-width:0', value: settings.atcStation || '' });
    const rwSel = el('select', {});
    const fillRw = () => {
      rwSel.innerHTML = ''; const rws = DB.airports.get(settings.atcStation) || [];
      rws.forEach((r) => rwSel.append(el('option', { value: r.ident }, r.ident)));
      if (!settings.atcRwy && rws.length) settings.atcRwy = (bestRunway(settings.atcStation) || rws[0]).ident;
      rwSel.value = settings.atcRwy || '';
    };
    rwSel.addEventListener('change', () => { settings.atcRwy = rwSel.value; saveSettings(); });
    const setStation = () => {
      if (!DB.loaded) { ui.toast(L('Baza de date încă se încarcă…', 'The database is still loading…')); return; }
      const q = stIn.value.trim(); const code = q.toUpperCase();
      const apt = DB.airports.has(code) ? code : (searchAirports(q, ...sim.lla().slice(0, 2))[0] || {}).apt;
      if (!apt) { ui.toast(L('Nu am găsit aeroportul.', 'Airport not found.')); return; }
      if (settings.atcStation && settings.atcStation !== apt) atcSend(`Tower closed #ATCOFF ${settings.atcStation}`);
      settings.atcStation = apt; settings.atcRwy = ''; saveSettings(); stIn.value = apt; fillRw(); ATC.announced = null;
      openAtcWindow(); ui.renderAtc();
    };
    ctrlBox.append(
      el('div', { class: 'gcr-row' }, stIn, el('button', { class: 'gcr-btn pri sm', onclick: setStation }, L('Preia turnul', 'Open tower'))),
      (() => { const an = el('select', {}, el('option', { value: 'once' }, L('o singură dată, la deschidere', 'once, when opening')), el('option', { value: 'never' }, L('niciodată', 'never')));
        an.value = settings.atcAnnounce === 'never' ? 'never' : 'once'; an.addEventListener('change', () => { settings.atcAnnounce = an.value; saveSettings(); });
        return el('div', { class: 'gcr-row' }, el('label', { style: 'min-width:0' }, L('Anunț turn în chat', 'Announce tower in chat')), an); })(),
      el('div', { class: 'gcr-muted', style: 'margin:-2px 0 4px' }, L('Piloții cu plugin văd turnul automat, fără mesaje în chat.', 'Pilots with the plugin see your tower automatically, without chat messages.')),
      el('div', { class: 'gcr-row' }, el('label', {}, L('Pista activă', 'Active runway')), rwSel,
        el('button', { class: 'gcr-btn sm', onclick: () => openAtcWindow() }, L('Deschide radarul', 'Open radar')),
        el('button', { class: 'gcr-btn sm warn', onclick: () => { if (settings.atcStation && settings.atcAnnounce !== 'never') atcSend(`Tower closed #ATCOFF ${settings.atcStation}`); settings.atcStation = ''; saveSettings(); closeAtcWindow(); ui.renderAtc(); } }, L('Închide turnul', 'Close tower'))));
    role.addEventListener('change', () => { settings.atcRole = role.value; saveSettings(); if (role.value !== 'ctrl') { if (settings.atcStation && settings.atcAnnounce !== 'never') atcSend(`Tower closed #ATCOFF ${settings.atcStation}`); closeAtcWindow(); } ui.renderAtc(); });
    p.append(el('div', { class: 'gcr-row' }, el('label', {}, L('Rol', 'Role')), role), status, pilotBox, ctrlBox,
      el('b', { style: 'display:block;margin-top:8px' }, L('Mesaje ATC', 'ATC messages')), logBox,
      el('div', { class: 'gcr-muted', style: 'margin-top:6px' }, L('Mesajele merg prin chatul GeoFS (trebuie să fii logat în GeoFS). Shift+Y = accept, Shift+U = refuz.', 'Messages go through the GeoFS chat (you must be signed in to GeoFS). Shift+Y = accept, Shift+U = refuse.')));
    ui.renderAtc = () => {
      const ctrl = settings.atcRole === 'ctrl';
      try { ui.renderCop(); } catch (e) { /* */ }
      pilotBox.style.display = ctrl ? 'none' : ''; ctrlBox.style.display = ctrl ? '' : 'none';
      if (ctrl) { if (DB.loaded && settings.atcStation && !rwSel.options.length) fillRw(); }
      const me = myCallsign();
      status.innerHTML = '';
      if (ctrl) {
        status.append(el('div', {}, L('Indicativul tău: ', 'Your callsign: '), el('b', {}, me), geofsLoggedIn() ? '' : el('span', { style: 'color:#ff8a80' }, L(' · nelogat în GeoFS', ' · not signed in to GeoFS'))),
          el('div', { class: 'gcr-muted' }, settings.atcStation ? L(`Controlezi ${aptName(settings.atcStation)} (${settings.atcStation})`, `Controlling ${aptName(settings.atcStation)} (${settings.atcStation})`) : L('Alege aeroportul pe care îl controlezi.', 'Choose the airport you control.')));
      } else {
        const st = currentAtcFor();
        const apt = AP.rwy ? AP.rwy.apt : null;
        status.append(...[el('div', {}, L('Indicativul tău: ', 'Your callsign: '), el('b', {}, me), geofsLoggedIn() ? '' : el('span', { style: 'color:#ff8a80' }, L(' · nelogat în GeoFS', ' · not signed in to GeoFS'))),
          el('div', { class: 'gcr-muted' }, st ? L(`Controlor la ${st.apt}: ${st.cs}`, `Controller at ${st.apt}: ${st.cs}`) : (settings.atcAuto !== false ? L('Fără controlor om – turnul virtual automat e activ.', 'No human controller – automatic virtual tower active.') : L('Fără controlor.', 'No controller.'))),
          el('div', { class: 'gcr-muted' }, Object.keys(ATC.stations).filter((k) => humanAtcAt(k)).length ? L('Turnuri active: ', 'Active towers: ') + Object.keys(ATC.stations).filter((k) => humanAtcAt(k)).map((k) => `${k} (${ATC.stations[k].cs})`).join(', ') : ''),
          apt && (ATC.landClr || ATC.toClr) ? el('div', { style: 'color:#4cff8f' }, (ATC.toClr ? L('✓ Autorizat la decolare', '✓ Cleared for takeoff') : '') + (ATC.landClr ? L('✓ Autorizat la aterizare', '✓ Cleared to land') : '')) : null].filter(Boolean));
      }
      logBox.innerHTML = ATC.log.length ? '' : `<div class="gcr-muted">${L('Niciun mesaj încă.', 'No messages yet.')}</div>`;
      ATC.log.slice(0, 15).forEach((m) => logBox.append(el('div', { class: 'gcr-atcmsg ' + m.dir },
        el('span', { class: 'gcr-muted' }, new Date(m.t).toTimeString().slice(0, 5) + ' '), el('b', {}, m.from + ': '), m.text)));
    };
    ui.renderAtc();
  }
  /** Controlorul om pentru aeroportul relevant (cel de lângă tine la sol, altfel destinația). */
  function currentAtcFor() {
    if (sim.onGround()) {
      const near = DB.loaded ? nearestAirports(...sim.lla().slice(0, 2), 1)[0] : null;
      if (near && near.d < 5 * NM) { const s = humanAtcAt(near.apt); if (s) return { apt: near.apt, cs: s.cs }; }
    }
    if (AP.rwy) { const s = humanAtcAt(AP.rwy.apt); if (s) return { apt: AP.rwy.apt, cs: s.cs }; }
    return null;
  }

  // card de instrucțiune pentru pilot
  ui.showAtcCard = () => {
    let c = document.getElementById('gcr-atccard');
    if (!c) {
      c = el('div', { id: 'gcr-atccard' });
      ['mousedown', 'pointerdown'].forEach((t) => c.addEventListener(t, (e) => e.stopPropagation()));
      document.body.append(c);
    }
    const p = ATC.pending; if (!p) return;
    c.innerHTML = '';
    c.append(el('div', { class: 'gcr-muted' }, 'ATC · ' + p.from), el('div', { class: 'big' }, p.text),
      el('div', { class: 'gcr-row', style: 'justify-content:center;margin-top:6px' },
        el('button', { class: 'gcr-btn ok', onclick: atcAccept }, L('✓ Accept (Shift+Y)', '✓ Accept (Shift+Y)')),
        el('button', { class: 'gcr-btn warn', onclick: atcRefuse }, L('✕ Refuz (Shift+U)', '✕ Unable (Shift+U)'))));
    c.style.display = 'block';
  };
  ui.hideAtcCard = () => { const c = document.getElementById('gcr-atccard'); if (c) c.style.display = 'none'; };

  /* ---------------- Fereastra controlorului: radar + benzi de trafic ---------------- */
  const ATCW = { range: 10 };
  function closeAtcWindow() { const w = document.getElementById('gcr-atcwin'); if (w) w.remove(); }
  function openAtcWindow() {
    if (document.getElementById('gcr-atcwin')) return;
    const cv = el('canvas', { width: 460, height: 460 });
    const strips = el('div', { class: 'gcr-strips' });
    const cmd = el('div', { class: 'gcr-atccmd' });
    const title = el('div', { class: 'gcr-ndgrip' }, el('span', {}, '📡 ' + L('Radar ATC – trage ca să muți', 'ATC radar – drag to move')),
      el('span', {}, el('button', { class: 'gcr-btn sm', onclick: () => { ATCW.range = Math.min(80, ATCW.range * 2); } }, '−'), ' ',
        el('button', { class: 'gcr-btn sm', onclick: () => { ATCW.range = Math.max(2.5, ATCW.range / 2); } }, '+'), ' ',
        el('button', { class: 'gcr-btn sm', onclick: closeAtcWindow }, '✕')));
    const w = el('div', { id: 'gcr-atcwin' }, title, el('div', { style: 'display:flex;gap:8px;align-items:flex-start' }, cv, el('div', { style: 'width:330px' }, strips, cmd)));
    ['mousedown', 'pointerdown', 'wheel', 'touchstart'].forEach((t) => w.addEventListener(t, (e) => e.stopPropagation()));
    ['keydown', 'keyup', 'keypress'].forEach((t) => w.addEventListener(t, (e) => { if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) e.stopPropagation(); }));
    w.addEventListener('wheel', (e) => { ATCW.range = clamp(e.deltaY > 0 ? ATCW.range * 1.25 : ATCW.range / 1.25, 2.5, 80); e.preventDefault(); }, { passive: false });
    let drag = null;
    title.addEventListener('mousedown', (e) => { if (e.target.tagName === 'BUTTON') return; const r = w.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (drag) { w.style.left = clamp(e.clientX - drag.dx, 0, window.innerWidth - 100) + 'px'; w.style.top = clamp(e.clientY - drag.dy, 0, window.innerHeight - 60) + 'px'; } });
    window.addEventListener('mouseup', () => { drag = null; });
    cv.addEventListener('click', (e) => { // selectare avion pe radar
      const r = cv.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 18; (ATCW.blips || []).forEach((b) => { const d = Math.hypot(b.x - x, b.y - y); if (d < bd) { bd = d; best = b; } });
      if (best) { ATC.sel = best.cs; renderCmd(); }
    });
    document.body.append(w);
    ATCW.cv = cv; ATCW.strips = strips; ATCW.cmd = cmd;

    function renderCmd() {
      cmd.innerHTML = '';
      const cs = ATC.sel;
      if (!cs) { cmd.append(el('div', { class: 'gcr-muted' }, L('Selectează un avion din listă sau de pe radar.', 'Select an aircraft from the list or the radar.'))); return; }
      const rw = settings.atcRwy || '';
      const send = (txt, code, arg) => atcSend(`@${cs} ${txt} #${code}${arg != null && arg !== '' ? ' ' + arg : ''}`);
      const wind = (window.weather ? `wind ${pad3(weather.currentWindDirection || 0)}/${Math.round(weather.currentWindSpeed || 0)}` : '');
      const B = (t, fn, cls) => el('button', { class: 'gcr-btn sm ' + (cls || ''), onclick: fn }, t);
      const hdg = el('input', { type: 'number', placeholder: 'HDG', style: 'width:62px' });
      const alt = el('input', { type: 'number', placeholder: 'ALT', step: 500, style: 'width:70px' });
      const spd = el('input', { type: 'number', placeholder: 'SPD', step: 10, style: 'width:60px' });
      const txt = el('input', { placeholder: L('Text liber…', 'Free text…'), maxlength: 45, style: 'flex:1;min-width:0' });
      cmd.append(el('div', { style: 'margin:6px 0 4px' }, el('b', {}, cs), ' ', el('span', { class: 'gcr-muted' }, L('pista ', 'runway ') + rw)),
        el('div', { class: 'gcr-row' },
          B(L('Aliniere', 'Line up'), () => send(`line up and wait ${rw}`, 'LU', rw)),
          B(L('Decolare', 'Takeoff'), () => send(`cleared takeoff ${rw} ${wind}`, 'TO', rw), 'ok'),
          B(L('Aterizare', 'Landing'), () => send(`cleared to land ${rw} ${wind}`, 'LD', rw), 'ok'),
          B(L('Ratare', 'Go around'), () => send('go around', 'GA'), 'warn')),
        el('div', { class: 'gcr-row' },
          B(L('Așteptare', 'Hold'), () => send('hold present position', 'HOLD')),
          B(L('Reia navigația', 'Resume nav'), () => send('resume own navigation', 'RES')),
          B('#1', () => send('number 1', 'SEQ', 1)), B('#2', () => send('number 2, follow traffic', 'SEQ', 2)), B('#3', () => send('number 3, follow traffic', 'SEQ', 3))),
        el('div', { class: 'gcr-row' }, hdg, B('→', () => hdg.value && send(`turn heading ${pad3(+hdg.value)}`, 'HDG', pad3(+hdg.value))),
          alt, B('→', () => alt.value && send(`${+alt.value > sim.altFt() ? 'climb' : 'maintain'} ${+alt.value} ft`, 'ALT', +alt.value)),
          spd, B('→', () => spd.value && send(`speed ${+spd.value} kt`, 'SPD', +spd.value))),
        el('div', { class: 'gcr-row' }, txt, B(L('Trimite', 'Send'), () => { if (txt.value.trim()) { send(txt.value.trim(), 'MSG'); txt.value = ''; } })));
      const ack = ATC.acks[cs]; if (ack && Date.now() - ack.t < 120000) cmd.append(el('div', { class: 'gcr-muted' }, `${ack.code === 'WILCO' ? '✓' : '✕'} ${ack.code} ${ack.arg}`));
    }
    ATCW.renderCmd = renderCmd;
    renderCmd();
  }
  function drawAtcWindow() {
    if (!ATCW.cv || !document.getElementById('gcr-atcwin')) return;
    const apt = settings.atcStation; const a = DB.info.get(apt); const rws = DB.airports.get(apt) || [];
    if (!a && !rws.length) return;
    const cLat = a ? a.lat : rws[0].lat, cLon = a ? a.lon : rws[0].lon;
    const cv = ATCW.cv, x = cv.getContext('2d'), W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, Rpx = W / 2 - 10, sc = Rpx / (ATCW.range * NM);
    const cosLat = Math.cos(cLat * D2R);
    const toXY = (la, lo) => [cx + (lo - cLon) * D2R * cosLat * R_EARTH * sc, cy - (la - cLat) * D2R * R_EARTH * sc];
    x.fillStyle = '#02130a'; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(90,255,140,.25)'; x.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach((f) => { x.beginPath(); x.arc(cx, cy, Rpx * f, 0, 7); x.stroke(); });
    x.fillStyle = 'rgba(90,255,140,.5)'; x.font = '10px monospace';
    [0.5, 1].forEach((f) => x.fillText((ATCW.range * f).toFixed(ATCW.range < 10 ? 1 : 0) + 'NM', cx + 3, cy - Rpx * f + 11));
    // piste + prelungiri de ax pentru pista activă
    rws.forEach((r) => {
      const [x1, y1] = toXY(r.lat, r.lon), [x2, y2] = toXY(r.endLat, r.endLon);
      x.strokeStyle = '#e8eef7'; x.lineWidth = 3; x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke();
      if (r.ident === settings.atcRwy) {
        const [fx, fy] = toXY(...destPoint(r.lat, r.lon, norm360(r.hdg + 180), 10 * NM));
        x.strokeStyle = 'rgba(224,64,251,.6)'; x.setLineDash([6, 5]); x.lineWidth = 1.5; x.beginPath(); x.moveTo(x1, y1); x.lineTo(fx, fy); x.stroke(); x.setLineDash([]);
        x.fillStyle = '#e040fb'; x.fillText(r.ident, x1 + 4, y1 + 12);
      }
    });
    // trafic
    const act = rws.find((r) => r.ident === settings.atcRwy);
    const list = getTraffic().filter((t) => t.age < 20000 && distM(t.lat, t.lon, cLat, cLon) < ATCW.range * NM * 1.05);
    // includem și avionul controlorului (dacă e în zonă)
    ATCW.blips = [];
    list.forEach((t) => {
      const [px, py] = toXY(t.lat, t.lon); const sel = ATC.sel === t.cs; const req = ATC.requests[t.cs] && Date.now() - ATC.requests[t.cs].t < 300000;
      const col = sel ? '#ffd54f' : req ? '#ff8a80' : t.cp ? '#ffb300' : t.ai ? '#80cbc4' : '#5cff8a';
      x.strokeStyle = col; x.fillStyle = col; x.lineWidth = 1.5;
      x.strokeRect(px - 3.5, py - 3.5, 7, 7);
      const vlen = clamp(t.kias / 4, 4, 40); x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.sin(t.hdg * D2R) * vlen, py - Math.cos(t.hdg * D2R) * vlen); x.stroke();
      x.font = sel ? 'bold 11px monospace' : '10px monospace';
      const elevFt = act ? act.elevFt : (a ? a.elevFt : 0);
      x.fillText((t.cp ? '★' : '') + t.cs.slice(0, 12), px + 7, py - 4);
      x.fillText(`${String(Math.max(0, Math.round(t.altM / FT / 100))).padStart(3, '0')} ${Math.round(t.kias)}kt${(t.altM / FT - elevFt) < 80 && t.kias < 50 ? ' GND' : ''}`, px + 7, py + 8);
      ATCW.blips.push({ x: px, y: py, cs: t.cs });
    });
    // benzi de trafic (strips)
    if (!ATCW.lastStrips || Date.now() - ATCW.lastStrips > 1000) {
      ATCW.lastStrips = Date.now();
      const sorted = list.slice().sort((p, q) => distM(p.lat, p.lon, cLat, cLon) - distM(q.lat, q.lon, cLat, cLon));
      ATCW.strips.innerHTML = '';
      ATCW.strips.append(el('div', { class: 'gcr-muted', style: 'margin-bottom:3px' }, `${aptName(apt)} · ${sorted.length} ${L('avioane', 'aircraft')}`));
      sorted.slice(0, 14).forEach((t) => {
        const d = distM(t.lat, t.lon, cLat, cLon) / NM; const req = ATC.requests[t.cs] && Date.now() - ATC.requests[t.cs].t < 300000 ? ATC.requests[t.cs] : null;
        const k = act ? trafficVsRunway(t, act, act.elevFt * FT) : null;
        const stTxt = k && k.onRwy ? L('PE PISTĂ', 'ON RWY') : k && k.onFinal ? L('FINALĂ', 'FINAL') : (t.altM / FT - (act ? act.elevFt : 0)) < 80 && t.kias < 50 ? L('SOL', 'GND') : '';
        const row = el('div', { class: 'gcr-strip' + (ATC.sel === t.cs ? ' sel' : '') + (req ? ' req' : ''), onclick: () => { ATC.sel = t.cs; ATCW.renderCmd(); ATCW.lastStrips = 0; } },
          el('b', {}, t.cs.slice(0, 14)), el('span', {}, `${Math.round(t.altM / FT)}ft ${Math.round(t.kias)}kt ${d.toFixed(1)}NM`),
          el('span', { class: 'tag' }, (req ? (req.code === 'RQTO' ? L('cere decolare ', 'req TKOF ') : L('cere aterizare ', 'req LAND ')) + req.arg : '') + (stTxt ? ' ' + stTxt : '') + (t.ai ? ' AI' : '') + (t.cp ? ' ★ Copilot' : '')));
        ATCW.strips.append(row);
      });
    }
  }

  /* =====================================================================
   *  COMBUSTIBIL + MISIUNI
   *  GeoFS nu are combustibil. Capacitatea și consumul se estimează din masa avionului;
   *  consumul urmează turația fiecărui motor. La 0 kg motoarele se opresc și nu mai pornesc.
   * ===================================================================== */
  const FUEL_PRICE = 0.35;         // $/kg (echilibrat cu plata misiunilor)
  const ECON = Object.assign({ balance: 10000, missions: 0, hours: 0, nm: 0, earned: 0, history: [] }, store.get('geofsCopilotRO.econ', {}));
  const saveEcon = () => { store.set('geofsCopilotRO.econ', ECON); if (window.__gcrDirty) window.__gcrDirty(); };
  const FUEL = { kg: null, acId: null, flow: 0, lastT: 0, refuel: null, warned: {} };
  let MISSION = store.get('geofsCopilotRO.mission', null);  // misiunea activă
  let OFFERS = { apt: null, list: [], t: 0 };
  const saveMission = () => store.set('geofsCopilotRO.mission', MISSION);

  function acProfile() {
    const ac = sim.ac(), d = ac.definition || {};
    const mass = d.mass || 5000;
    const light = isLight();
    return {
      id: ac.id || d.name || 'ac', name: d.name || ac.id || '?',
      capKg: Math.round(clamp(mass * (light ? 0.14 : 0.28), 40, 160000)),           // capacitatea rezervorului
      maxFlowKgH: clamp(mass * (light ? 0.14 : 0.28), 40, 160000) / (light ? 3.0 : 3.6), // consum la putere maximă
      seats: Math.max(1, Math.round(light ? clamp(mass / 350, 1, 9) : clamp(mass / 420, 4, 600))),
      cargoKg: Math.round(clamp(mass * (light ? 0.15 : 0.22), 50, 140000)),
      cruiseKt: AP.cruiseSpd || (light ? 120 : 420),
    };
  }
  function fuelStore() { return store.get('geofsCopilotRO.fuel', {}); }
  function fuelSync() {
    const p = acProfile();
    if (FUEL.acId !== p.id) {
      const all = fuelStore();
      FUEL.acId = p.id;
      FUEL.kg = all[p.id] != null ? Math.min(all[p.id], p.capKg) : Math.round(p.capKg * 0.6); // avion nou: 60%
      FUEL.warned = {};
    }
    return p;
  }
  function fuelSave() { const all = fuelStore(); all[FUEL.acId] = Math.round(FUEL.kg); store.set('geofsCopilotRO.fuel', all); }

  /** Puterea relativă a motoarelor (0..1), din turația calculată de GeoFS. */
  function powerFraction() {
    const ac = sim.ac(), d = ac.definition || {};
    if (!ac.engine || !ac.engine.on) return 0;
    const list = engines();
    if (list.length && d.maxRPM && d.minRPM != null) {
      let s = 0; list.forEach((e) => { s += clamp((Math.abs(e.rpm || 0) - d.minRPM) / Math.max(1, d.maxRPM - d.minRPM), 0, 1); });
      return s / list.length;
    }
    return clamp(Math.abs(controls.throttle || 0), 0, 1);
  }

  function fuelTick() {
    if (!settings.fuelOn) return;
    const p = fuelSync();
    const now = performance.now(); const dt = FUEL.lastT ? Math.min(1, (now - FUEL.lastT) / 1000) : 0; FUEL.lastT = now;
    const ac = sim.ac();
    // consum: ralanti ~6% + proporțional cu puterea
    const pf = powerFraction();
    FUEL.flow = ac.engine && ac.engine.on ? p.maxFlowKgH * (0.06 + 0.94 * pf) * (settings.fuelBurnMul || 1) : 0;
    FUEL.kg = Math.max(0, FUEL.kg - (FUEL.flow / 3600) * dt);
    // alimentare la sol
    if (FUEL.refuel) {
      if (!sim.onGround() || (sim.v().groundSpeedKnt || 0) > 3) { FUEL.refuel = null; ui.toast(L('Alimentare întreruptă – avionul s-a mișcat.', 'Refuelling stopped – the aircraft moved.')); }
      else {
        const rate = Math.max(p.capKg / 75, 2);            // plin în ~75 s
        const add = Math.min(rate * dt, FUEL.refuel.target - FUEL.kg, ECON.balance / FUEL_PRICE);
        if (add > 0) { FUEL.kg += add; ECON.balance -= add * FUEL_PRICE; FUEL.refuel.cost += add * FUEL_PRICE; }
        if (add <= 0.001 || FUEL.kg >= FUEL.refuel.target - 0.5) {
          ui.toast(L(`Alimentare terminată: ${Math.round(FUEL.kg)} kg · cost $${Math.round(FUEL.refuel.cost)}`, `Refuelling complete: ${Math.round(FUEL.kg)} kg · cost $${Math.round(FUEL.refuel.cost)}`) + (ECON.balance < 1 ? L(' (fonduri epuizate)', ' (out of money)') : ''));
          FUEL.refuel = null; saveEcon();
        }
      }
    }
    // fără combustibil: motoarele se opresc și rămân oprite
    if (FUEL.kg <= 0 && ac.engine && ac.engine.on) {
      controls.setters.toggleEngines.set();
      if (!FUEL.warned.empty) { FUEL.warned.empty = true; say('Fuel exhausted, engine failure', 0); ui.toast(L('COMBUSTIBIL EPUIZAT – motoarele s-au oprit! Planează spre cel mai apropiat aeroport.', 'FUEL EXHAUSTED – engines have stopped! Glide to the nearest airport.'), 12000); }
    }
    // avertizări
    const pct = FUEL.kg / p.capKg, endurMin = FUEL.flow > 0 ? (FUEL.kg / FUEL.flow) * 60 : null;
    if (!sim.onGround() && pct < 0.1 && !FUEL.warned.low) { FUEL.warned.low = true; say('Low fuel', 0); ui.toast(L('COMBUSTIBIL PUȚIN – sub 10%.', 'LOW FUEL – below 10%.'), 8000); }
    if (pct > 0.15) FUEL.warned.low = false;
    if (FUEL.kg > 0) FUEL.warned.empty = false;
    FUEL.pct = pct; FUEL.endurMin = endurMin;
    if (Math.floor(now / 5000) !== Math.floor((now - dt * 1000) / 5000)) fuelSave();
    // statistici de zbor
    if (!sim.onGround() && dt > 0) { ECON.hours += dt / 3600; ECON.nm += ((sim.v().groundSpeedKnt || 0) * dt) / 3600; }
  }
  /** Combustibilul necesar pentru traseul planificat (+ 30 min rezervă). */
  function fuelNeededKg() {
    const p = acProfile();
    if (!AP.rwy || !AP.legs.length) return null;
    const [lat, lon] = sim.lla();
    const nm = remainingPathM(lat, lon) / NM;
    const cruiseFlow = p.maxFlowKgH * (0.06 + 0.94 * 0.62) * (settings.fuelBurnMul || 1);
    const hours = nm / Math.max(80, p.cruiseKt) + 0.15 + 0.5; // urcare/coborâre + rezervă
    return Math.round(cruiseFlow * hours);
  }
  function startRefuel(targetPct) {
    const p = fuelSync();
    if (!sim.onGround() || (sim.v().groundSpeedKnt || 0) > 3) { ui.toast(L('Poți alimenta doar la sol, cu avionul oprit.', 'You can refuel only on the ground, with the aircraft stopped.')); return; }
    const near = DB.loaded ? nearestAirports(...sim.lla().slice(0, 2), 1)[0] : null;
    if (!near || near.d > 3 * NM) { ui.toast(L('Nu ești pe un aeroport.', 'You are not at an airport.')); return; }
    if (ECON.balance < 1) { ui.toast(L('Nu ai bani pentru combustibil. Fă o misiune!', 'Not enough money for fuel. Fly a mission!')); return; }
    FUEL.refuel = { target: Math.min(p.capKg, p.capKg * targetPct), cost: 0 };
    ui.toast(L('Alimentare în curs…', 'Refuelling…'));
  }

  /* ---------------- Misiuni ---------------- */
  const MTYPES = [
    { k: 'pax', ro: 'Pasageri', en: 'Passengers', icon: '🧑‍🤝‍🧑', rate: 1.0 },
    { k: 'cargo', ro: 'Marfă', en: 'Cargo', icon: '📦', rate: 0.8 },
    { k: 'fragile', ro: 'Marfă fragilă', en: 'Fragile cargo', icon: '🍷', rate: 1.3 },
    { k: 'med', ro: 'Transport medical urgent', en: 'Urgent medical flight', icon: '🚑', rate: 1.6 },
    { k: 'vip', ro: 'Zbor VIP', en: 'VIP flight', icon: '🎩', rate: 2.0 },
  ];
  const mtype = (k) => MTYPES.find((t) => t.k === k) || MTYPES[0];

  function generateOffers() {
    if (!DB.loaded) return;
    const [lat, lon] = sim.lla();
    const here = nearestAirports(lat, lon, 1, null, isLight() ? 0 : 2000)[0];
    if (!here || here.d > 4 * NM) { OFFERS = { apt: null, list: [], t: Date.now() }; return; }
    const p = fuelSync();
    const rangeNm = Math.max(40, (p.capKg / (p.maxFlowKgH * (0.06 + 0.94 * 0.62) * (settings.fuelBurnMul || 1)) - 0.65) * p.cruiseKt);
    const light = suggestedVapp() <= 95; // recalculat: avionul poate fi schimbat
    const bands = light ? [[25, 80], [60, 150], [100, Math.min(300, rangeNm)]] : [[60, 200], [180, 500], [450, Math.min(1800, rangeNm)]];
    const list = [];
    bands.forEach(([mn, mx]) => {
      if (mx <= mn) return;
      suggestDestinations(lat, lon, mn, mx, light ? 2000 : 6000).slice(0, 3).forEach((dd) => {
        const t = MTYPES[Math.floor(Math.random() * 5)]; // tipurile clasice
        const isPax = t.k === 'pax' || t.k === 'vip' || t.k === 'med';
        const load = isPax ? Math.max(1, Math.round(p.seats * (t.k === 'vip' ? 0.1 : t.k === 'med' ? 0.05 : 0.5 + Math.random() * 0.5))) : Math.round(p.cargoKg * (0.4 + Math.random() * 0.6));
        const loadFactor = isPax ? load / p.seats : load / p.cargoKg;
        const pay = Math.round((300 + dd.d * (light ? 6 : 22) * (0.5 + loadFactor)) * t.rate * payMul() / 10) * 10;
        const mins = (dd.d / Math.max(80, p.cruiseKt)) * 60 + 25;
        list.push({ id: Math.random().toString(36).slice(2, 8), type: t.k, from: here.apt, to: dd.a.apt, nm: Math.round(dd.d), load, isPax, pay,
          deadlineMin: Math.round(mins * (t.k === 'med' ? 1.25 : 1.6)), locked: !classAllowed(acClass()) });
      });
    });
    let sp = []; try { sp = specialOffers(here, p, light); } catch (e) { console.warn('[GeoFS Copilot] special offers', e); }
    OFFERS = { apt: here.apt, list: list.slice(0, 6).concat(sp), t: Date.now() };
  }

  function acceptMission(o) {
    if (!classAllowed(acClass())) { ui.toast(L('Rangul tău nu permite încă acest avion în misiuni. Cumpără licența de tip din tab-ul Carieră sau alege un avion mai mic.', 'Your rank does not allow this aircraft on missions yet. Buy the type rating in the Career tab or pick a smaller aircraft.'), 9000); return; }
    if (MISSION && MISSION.state !== 'done') { ui.toast(L('Ai deja o misiune activă.', 'You already have an active mission.')); return; }
    MISSION = Object.assign(JSON.parse(JSON.stringify(o)), { state: 'boarding', acceptedAt: Date.now(), boardEnd: Date.now() + (o.isPax ? 30000 : 20000), maxVs: 0, maxG: 1, wasAirborne: false, pIdx: 0 });
    saveMission();
    if (o.points) { if (TRIP.stops.length || AP.rwy) { disengage(true); AP.rwy = null; AP.legs = []; AP.phase = 'OFF'; clearEntities(); TRIP.stops = []; TRIP.from = 0; saveTrip(); ui.renderNav(); ui.renderTrip(); } drawMissionMarks(); ui.toast(L(`${mtype(o.type).icon} ${L(mtype(o.type).ro, mtype(o.type).en)}: punctele sunt pe hartă (romburi aurii). Instrucțiunile apar în casetă după decolare.`, `${mtype(o.type).icon} ${mtype(o.type).en}: the points are on the map (gold diamonds). Directions appear in the instruction box after takeoff.`), 9000); ui.renderMissions && ui.renderMissions(); return; }
    setSingleDestination(o.to);
    const need = fuelNeededKg();
    ui.toast(L(`Misiune acceptată: ${mtype(o.type).ro} spre ${aptName(o.to)}. Îmbarcare…`, `Mission accepted: ${mtype(o.type).en} to ${aptName(o.to)}. Boarding…`) +
      (need && FUEL.kg < need ? L(` Atenție: îți trebuie ~${need} kg combustibil, ai ${Math.round(FUEL.kg)} kg.`, ` Note: you need ~${need} kg of fuel, you have ${Math.round(FUEL.kg)} kg.`) : ''), 9000);
    ui.renderMissions && ui.renderMissions();
  }
  function abandonMission() {
    if (!MISSION) return;
    const pen = Math.round(MISSION.pay * 0.2);
    ECON.balance -= pen; ECON.history.unshift({ t: Date.now(), from: MISSION.from, to: MISSION.to, type: MISSION.type, result: 'abandoned', pay: -pen });
    ECON.history = ECON.history.slice(0, 25); saveEcon();
    ui.toast(L(`Misiune anulată. Penalizare: $${pen}`, `Mission cancelled. Penalty: $${pen}`));
    airOnMission(null, false);
    MISSION = null; saveMission(); drawMissionMarks(); ui.renderMissions && ui.renderMissions();
  }

  function missionTick() {
    if (!MISSION || !DB.loaded) return;
    const v = sim.v(), onG = sim.onGround();
    const [lat, lon] = sim.lla();
    if (MISSION.state === 'boarding') {
      if (Date.now() >= MISSION.boardEnd) { MISSION.state = 'ready'; MISSION.readyAt = Date.now(); saveMission(); say('Boarding complete', 0); ui.toast(L('Îmbarcare terminată – poți pleca (Zbor complet / Shift+P).', 'Boarding complete – you can depart (Full flight / Shift+P).')); ui.renderMissions && ui.renderMissions(); }
      return;
    }
    if (MISSION.state === 'ready' && !onG) { MISSION.state = 'flying'; MISSION.departedAt = Date.now(); saveMission(); }
    if (MISSION.state === 'flying') {
      if (!onG) {
        MISSION.wasAirborne = true;
        MISSION.maxBank = Math.max(MISSION.maxBank || 0, Math.abs(v.aroll || 0));
        MISSION.maxG = Math.max(MISSION.maxG || 1, v.loadFactor || 1);
        pointsTick();
      }
      // a aterizat și s-a oprit: la destinație sau în altă parte
      if (onG && MISSION.wasAirborne && (v.groundSpeedKnt || 0) < 5) {
        const near = landedApt(lat, lon);
        const last = store.get(LS_LANDINGS, [])[0];
        const np = nextPoint();
        if (np && near && near.d < 4 * NM) { MISSION.wasAirborne = false; ui.toast(L(`Misiunea nu e gata: următorul punct este ${np.name}. Decolează din nou.`, `The mission is not finished: the next point is ${np.name}. Take off again.`), 9000); return; }
        if (near && (near.apt === MISSION.to || near.apt === MISSION.divertApt || MISSION.anyApt) && near.d < 4 * NM) completeMission(last, near.apt !== MISSION.to && !MISSION.anyApt);
        else if (near && near.d < 4 * NM) { MISSION.wasAirborne = false; ui.toast(L(`Ai aterizat la ${aptName(near.apt)}, nu la destinație (${aptName(MISSION.to)}). Misiunea continuă.`, `You landed at ${aptName(near.apt)}, not the destination (${aptName(MISSION.to)}). The mission continues.`), 9000); }
        else failMission(L('aterizare în afara unui aeroport', 'landed away from an airport'));
      }
    }
  }
  function completeMission(landing, diverted) {
    const m = MISSION; const t = mtype(m.type);
    const flownMin = (Date.now() - (m.departedAt || m.acceptedAt)) / 60000;
    let pay = m.pay; const notes = [];
    if (diverted) {
      const med = EMERG.active && EMERG.active.type === 'medical' && Date.now() <= EMERG.active.deadline;
      pay = med ? Math.round(m.pay * 0.7) + 800 : Math.round(m.pay * 0.5);
      notes.push(med ? L('Deviere medicală reușită: 70% + $800 bonus 🚑', 'Successful medical diversion: 70% + $800 bonus 🚑') : L('Aterizare de urgență la alt aeroport: 50%', 'Emergency landing at another airport: 50%'));
    }
    const score = landing ? landing.score : 60;
    const vs = landing ? Math.abs(landing.vs) : 300;
    if (score >= 85) { pay += Math.round(m.pay * 0.15); notes.push(L('+15% aterizare excelentă', '+15% excellent landing')); }
    if (vs > 600) { pay -= Math.round(m.pay * (m.type === 'fragile' ? 0.6 : 0.3)); notes.push(m.type === 'fragile' ? L('−60% marfă deteriorată (aterizare dură)', '−60% damaged cargo (hard landing)') : L('−30% aterizare dură', '−30% hard landing')); }
    if ((m.maxBank || 0) > 45 && (m.isPax)) { pay -= Math.round(m.pay * 0.1); notes.push(L('−10% pasageri speriați (înclinare mare)', '−10% scared passengers (steep bank)')); }
    if (!diverted && flownMin > m.deadlineMin) { const late = m.type === 'med' ? 0.5 : 0.2; pay -= Math.round(m.pay * late); notes.push(L(`−${late * 100}% întârziere`, `−${late * 100}% late`)); }
    else if (m.type === 'med' || m.type === 'vip') { pay += Math.round(m.pay * 0.1); notes.push(L('+10% la timp', '+10% on time')); }
    try { pay += specialScoring(m, landing, notes); } catch (e) { console.warn('[GeoFS Copilot] scoring', e); }
    pay = Math.max(0, pay);
    ECON.balance += pay; ECON.earned += pay; ECON.missions++;
    if (MACH[m.type]) unlock(MACH[m.type]);
    airOnMission(score, true);
    try { careerOnMission(pay, m.type, 'ok'); } catch (e) { /* */ }
    ECON.history.unshift({ t: Date.now(), from: m.from, to: m.to, type: m.type, result: 'ok', pay, score });
    ECON.history = ECON.history.slice(0, 25); saveEcon();
    say('Mission complete', 0);
    ui.showMissionResult(m, pay, notes, flownMin);
    MISSION = null; saveMission(); drawMissionMarks(); OFFERS.t = 0; ui.renderMissions && ui.renderMissions();
  }
  function failMission(why) {
    const m = MISSION; if (!m) return;
    ECON.history.unshift({ t: Date.now(), from: m.from, to: m.to, type: m.type, result: 'failed', pay: 0 }); ECON.history = ECON.history.slice(0, 25); saveEcon();
    ui.toast(L('Misiune eșuată: ', 'Mission failed: ') + why, 10000); say('Mission failed', 0);
    airOnMission(null, false);
    MISSION = null; saveMission(); drawMissionMarks(); ui.renderMissions && ui.renderMissions();
  }

  /* ---------------- Interfață: tab-ul Misiuni ---------------- */
  function buildMissionsPage(p) {
    const top = el('div', { class: 'gcr-here' });
    const fuelBox = el('div', { class: 'gcr-fuel' });
    const active = el('div');
    const offers = el('div', { class: 'gcr-list', style: 'max-height:260px' });
    const hist = el('div', { class: 'gcr-status' });
    const offersHead = el('div', { class: 'gcr-row', style: 'margin-top:8px;justify-content:space-between' }, el('b', {}, L('Misiuni disponibile aici', 'Missions available here')),
      el('button', { class: 'gcr-btn sm', onclick: () => { OFFERS.t = 0; generateOffers(); ui.renderMissions(); } }, L('Altele', 'Others')));
    const fuelOn = el('input', { type: 'checkbox' }); fuelOn.checked = settings.fuelOn !== false;
    fuelOn.addEventListener('change', () => { settings.fuelOn = fuelOn.checked; saveSettings(); ui.renderMissions(); });
    const mul = el('select', {}, ...[['0.5', '×0.5'], ['1', L('×1 realist', '×1 realistic')], ['2', '×2'], ['3', '×3']].map(([v, t]) => el('option', { value: v }, t)));
    mul.value = String(settings.fuelBurnMul || 1);
    mul.addEventListener('change', () => { settings.fuelBurnMul = +mul.value; saveSettings(); OFFERS.t = 0; });
    const dailyBox = el('div');
    p.append(dailyBox, top, el('b', { style: 'display:block;margin-top:6px' }, L('Combustibil', 'Fuel')), fuelBox,
      el('div', { class: 'gcr-row' }, el('label', { style: 'min-width:0' }, fuelOn, ' ', L('Simulează combustibilul (motoarele se opresc la 0)', 'Simulate fuel (engines stop at 0)')), el('span', { class: 'gcr-muted' }, L('consum', 'burn')), mul),
      active,
      offersHead,
      offers, el('b', { style: 'display:block;margin-top:8px' }, L('Istoric', 'History')), hist);

    ui.renderFuel = () => {
      const pr = fuelSync();
      const pct = Math.round((FUEL.kg / pr.capKg) * 100);
      const need = fuelNeededKg();
      const col = pct < 10 ? '#ff5252' : pct < 25 ? '#ffd54f' : '#4cff8f';
      fuelBox.innerHTML = '';
      fuelBox.append(...[
        el('div', { class: 'gcr-bar' }, el('div', { style: `width:${clamp(pct, 0, 100)}%;background:${col}` }), need ? el('div', { class: 'need', style: `left:${clamp((need / pr.capKg) * 100, 0, 100)}%`, title: L('necesar pentru traseu + rezervă', 'needed for the route + reserve') }) : null),
        el('div', {}, el('b', {}, `${Math.round(FUEL.kg)} / ${pr.capKg} kg (${pct}%)`),
          el('span', { class: 'gcr-muted' }, ` · ${L('consum', 'flow')} ${Math.round(FUEL.flow)} kg/h${FUEL.endurMin != null && FUEL.flow > 0 ? ` · ${L('autonomie', 'endurance')} ${Math.floor(FUEL.endurMin / 60)}h${String(Math.round(FUEL.endurMin % 60)).padStart(2, '0')}` : ''}`)),
        need ? el('div', { class: 'gcr-muted', style: FUEL.kg < need ? 'color:#ff8a80' : '' }, L(`Necesar până la ${aptName(AP.rwy.apt)}: ~${need} kg (cu rezervă 30 min)`, `Needed to ${aptName(AP.rwy.apt)}: ~${need} kg (incl. 30 min reserve)`) + (FUEL.kg < need ? L(' – NU AJUNGE!', ' – NOT ENOUGH!') : ' ✓')) : null,
        el('div', { class: 'gcr-row' },
          el('button', { class: 'gcr-btn sm', onclick: () => startRefuel(1) }, L('Alimentează plin', 'Fill up')),
          need ? el('button', { class: 'gcr-btn sm', onclick: () => startRefuel(Math.min(1, (need * 1.1) / pr.capKg)) }, L('Cât trebuie pentru traseu', 'Enough for the route')) : null,
          el('button', { class: 'gcr-btn sm', onclick: () => startRefuel(Math.min(1, FUEL.kg / pr.capKg + 0.25)) }, '+25%'),
          el('span', { class: 'gcr-muted' }, `$${FUEL_PRICE}/kg`), FUEL.refuel ? el('span', { style: 'color:#4dd0e1' }, L(' ⛽ alimentare…', ' ⛽ refuelling…')) : null)].filter(Boolean));
    };
    ui.renderMissions = () => {
      try { renderDailyBox(dailyBox); } catch (e) { console.warn('[GeoFS Copilot] daily box', e); }
      top.innerHTML = '';
      top.append(el('div', {}, '💰 ', el('b', { style: 'font-size:15px;color:#4cff8f' }, '$' + Math.round(ECON.balance).toLocaleString('en-US')),
        el('span', { class: 'gcr-muted' }, ` · ${ECON.missions} ${L('misiuni', 'missions')} · ${ECON.hours.toFixed(1)} h · ${Math.round(ECON.nm)} NM`)));
      ui.renderFuel();
      // misiunea activă
      active.innerHTML = '';
      if (MISSION) {
        const t = mtype(MISSION.type);
        const st = { boarding: L('îmbarcare…', 'boarding…'), ready: L('gata de plecare', 'ready to depart'), flying: L('în zbor', 'in flight') }[MISSION.state] || MISSION.state;
        const left = MISSION.departedAt ? MISSION.deadlineMin - (Date.now() - MISSION.departedAt) / 60000 : MISSION.deadlineMin;
        active.append(el('div', { class: 'gcr-destcard' },
          el('div', { class: 'gcr-muted', style: 'font-size:11px' }, L('MISIUNE ACTIVĂ', 'ACTIVE MISSION')),
          el('div', { style: 'font-size:14px;font-weight:700' }, `${t.icon} ${L(t.ro, t.en)}: ${aptName(MISSION.from)} → ${aptName(MISSION.to)}`),
          el('div', {}, `${MISSION.isPax ? MISSION.load + L(' pasageri', ' passengers') : MISSION.load + ' kg'} · ${MISSION.nm} NM · $${MISSION.pay}`),
          el('div', { class: 'gcr-muted' }, `${L('Stare', 'Status')}: ${st} · ${L('timp rămas', 'time left')}: ${Math.max(0, Math.round(left))} min`),
          MISSION.points ? el('div', { style: 'margin-top:4px' }, ...MISSION.points.map((pt, i) => el('div', { style: pt.done ? 'color:#4cff8f' : i === MISSION.pIdx ? 'color:#ffd54f' : 'opacity:.7' },
            `${pt.done ? '✓' : i === MISSION.pIdx ? '➡' : '·'} ${pt.kind === 'search' ? L('Găsește naufragiatul în zona marcată', 'Find the survivor in the marked zone') : pt.name}` +
            (pt.kind === 'survey' ? ` · ${pt.altFt} ft${pt.dev != null ? ` (±${pt.dev})` : ''}` : pt.kind === 'drop' ? ` · ${pt.minAlt} ft` : '')))) : null,
          MISSION.stripFt ? el('div', { class: 'gcr-muted' }, L(`Pistă de doar ${MISSION.stripFt} ft – apropiere lentă, aterizează la începutul pistei.`, `Only ${MISSION.stripFt} ft of runway – slow approach, touch down early.`)) : null,
          el('div', { class: 'gcr-row' },
            MISSION.points && nextPoint() ? el('button', { class: 'gcr-btn sm' + (MISSION.steer ? ' ok' : ''), title: L('Pilotul automat ține direcția spre următorul punct', 'The autopilot heads to the next point'), onclick: () => { MISSION.steer = !MISSION.steer; saveMission(); if (MISSION.steer && !geofs.autopilot.on) ui.toast(L('Pornește pilotul automat (tasta A) ca să urmeze direcția.', 'Turn on the autopilot (A key) so it follows the heading.')); ui.renderMissions(); } }, `🧭 ${L('Pilot auto → punct', 'AP → point')}: ${MISSION.steer ? 'ON' : 'OFF'}`) : null,
            el('button', { class: 'gcr-btn sm warn', onclick: abandonMission }, L('Anulează (penalizare 20%)', 'Cancel (20% penalty)')))));
      }
      // oferte: doar la sol, pe un aeroport, fără misiune activă
      offers.innerHTML = '';
      offersHead.style.display = MISSION ? 'none' : '';
      if (MISSION) { offers.style.display = 'none'; }
      else if (!sim.onGround()) { offers.style.display = ''; OFFERS = { apt: null, list: [], t: 0 }; offers.append(el('div', { class: 'gcr-item gcr-muted' }, L('Misiunile noi apar după ce aterizezi pe un aeroport.', 'New missions appear once you land at an airport.'))); }
      else { offers.style.display = ''; if (!OFFERS.t || Date.now() - OFFERS.t > 300000) generateOffers(); }
      if (MISSION || !sim.onGround()) { /* nimic de listat */ }
      else if (!OFFERS.apt) offers.append(el('div', { class: 'gcr-item gcr-muted' }, L('Misiunile apar când ești la sol pe un aeroport.', 'Missions appear when you are on the ground at an airport.')));
      else if (!OFFERS.list.length) offers.append(el('div', { class: 'gcr-item gcr-muted' }, L('Nicio misiune potrivită pentru avionul ăsta aici.', 'No suitable missions for this aircraft here.')));
      if (!MISSION && sim.onGround()) OFFERS.list.forEach((o) => {
        const t = mtype(o.type);
        offers.append(el('div', { class: 'gcr-item' },
          el('div', { style: 'flex:1;min-width:0' }, el('b', {}, o.points ? `${t.icon} ${L(t.ro, t.en)}` : `${t.icon} ${aptName(o.to)}`), el('div', { class: 'gcr-muted', style: 'font-size:11px' },
            o.points ? `${o.type === 'survey' ? L(`3 fotografii la ${o.points[0].altFt} ft, în linie`, `3 photos at ${o.points[0].altFt} ft, in a line`) : o.points.length > 1 ? o.points.map((x) => x.name).join(' · ') : o.points[0].kind === 'search' ? L('zonă de căutare la ', 'search zone ') + Math.round(distM(...sim.lla().slice(0, 2), o.points[0].lat, o.points[0].lon) / NM) + ' NM' : o.points[0].kind === 'drop' ? L(`${o.load} parașutiști · urcă la ${o.points[0].minAlt} ft`, `${o.load} jumpers · climb to ${o.points[0].minAlt} ft`) : ''} · ${L('termen', 'deadline')} ${o.deadlineMin} min`
              : `${L(t.ro, t.en)} · ${o.isPax ? o.load + ' pax' : o.load + ' kg'} · ${o.nm} NM${o.stripFt ? ` · ${L('pistă', 'strip')} ${o.stripFt} ft` : ''} · ${L('termen', 'deadline')} ${o.deadlineMin} min`)),
          el('div', { style: 'text-align:right' }, el('b', { style: 'color:#4cff8f' }, '$' + o.pay.toLocaleString('en-US')), el('br'),
            classAllowed(acClass()) ? el('button', { class: 'gcr-btn sm ok', onclick: () => acceptMission(o) }, L('Acceptă', 'Accept'))
              : el('button', { class: 'gcr-btn sm', title: L('Licență necesară', 'Type rating required'), onclick: () => { document.querySelector('#gcr-panel .gcr-tabs button[data-k=car]').click(); } }, '🔒 ' + L('Licență', 'Rating')))));
      });
      hist.innerHTML = ECON.history.length ? ECON.history.slice(0, 8).map((h) => `<div>${mtype(h.type).icon} ${h.from} → ${h.to} · ${h.result === 'ok' ? '✓' : '✕'} <b style="color:${h.pay >= 0 ? '#4cff8f' : '#ff8a80'}">$${h.pay}</b></div>`).join('') : L('Nicio misiune încă.', 'No missions yet.');
    };
    ui.renderMissions();
  }
  ui.showMissionResult = (m, pay, notes, mins) => {
    const e = document.getElementById('gcr-landing'); if (!e) return;
    const t = mtype(m.type);
    setTimeout(() => { // după cardul de aterizare
      e.innerHTML = `<div class="gcr-muted">${L('MISIUNE ÎNDEPLINITĂ', 'MISSION COMPLETE')}</div><div style="font-size:18px;font-weight:700;margin:4px 0">${t.icon} ${aptName(m.from)} → ${aptName(m.to)}</div>
        <div class="score" style="color:#4cff8f">$${pay.toLocaleString('en-US')}</div>
        <div class="gcr-muted">${L('plată de bază', 'base pay')} $${m.pay} · ${Math.round(mins)} min</div>
        ${notes.length ? '<div style="margin-top:6px">' + notes.join('<br>') + '</div>' : ''}
        <div style="margin-top:8px">${L('Sold', 'Balance')}: <b>$${Math.round(ECON.balance).toLocaleString('en-US')}</b></div>
        <div class="gcr-muted" style="margin-top:8px">${L('(click pentru a închide)', '(click to close)')}</div>`;
      e.style.display = 'block'; e.onclick = () => { e.style.display = 'none'; };
    }, 4000);
  };

  /* =====================================================================
   *  CARIERĂ · JURNAL DE ZBOR · REALIZĂRI · URGENȚE · ȘCOALĂ DE ZBOR · CLASAMENT ONLINE
   * ===================================================================== */
  const ONLINE = { url: 'https://hpsvmyidwqgptgiaweuo.supabase.co', key: 'sb_publishable_NGXvayFPZlpCXkPywDVF9w_D7rUw0Bb', site: 'https://razvan999x.github.io/geofs-copilot/' };
  const ADMIN = { on: !!store.get('geofsCopilotRO.admin', false), hidden: false }; // confirmat de server la pornire
  const RANKS = [
    { xp: 0, ro: 'Elev pilot', en: 'Student Pilot', cls: 0 },
    { xp: 150, ro: 'Pilot privat', en: 'Private Pilot', cls: 1 },
    { xp: 500, ro: 'Pilot comercial', en: 'Commercial Pilot', cls: 2 },
    { xp: 1200, ro: 'Copilot', en: 'First Officer', cls: 3 },
    { xp: 2500, ro: 'Comandant', en: 'Captain', cls: 4 },
    { xp: 5000, ro: 'Comandant senior', en: 'Senior Captain', cls: 5 },
    { xp: 10000, ro: 'Pilot șef', en: 'Chief Pilot', cls: 5 },
  ];
  const CLASSES = [
    { max: 2500, ro: 'avioane ușoare', en: 'light aircraft', price: 0 },
    { max: 6000, ro: 'avioane mici', en: 'small aircraft', price: 4000 },
    { max: 25000, ro: 'avioane regionale', en: 'regional aircraft', price: 12000 },
    { max: 90000, ro: 'avioane medii (A320/737)', en: 'narrow-body jets (A320/737)', price: 30000 },
    { max: 250000, ro: 'avioane lung-curier', en: 'wide-body jets', price: 70000 },
    { max: Infinity, ro: 'avioane grele (747/A380)', en: 'heavy jets (747/A380)', price: 150000 },
  ];
  const CAREER = Object.assign({ xp: null, ratings: [], ach: {}, lessons: {}, key: null, pilotId: null, rankPos: null }, store.get('geofsCopilotRO.career', {}));
  if (CAREER.xp == null) CAREER.xp = (ECON.missions || 0) * 40; // pornire pentru cei care aveau deja misiuni
  if (!CAREER.key) { const b = new Uint8Array(24); crypto.getRandomValues(b); CAREER.key = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
  const saveCareer = () => { store.set('geofsCopilotRO.career', CAREER); if (window.__gcrDirty) window.__gcrDirty(); };
  saveCareer();
  function rankIdx(xp) { if (xp == null && adminCheats()) return RANKS.length - 1; let i = 0; RANKS.forEach((r, k) => { if ((xp != null ? xp : CAREER.xp) >= r.xp) i = k; }); return i; }
  const rankName = (i) => L(RANKS[i].ro, RANKS[i].en);
  function acClass() { const m = (sim.ac().definition && sim.ac().definition.mass) || 5000; return CLASSES.findIndex((c) => m < c.max); }
  function classAllowed(ci) { return ci <= RANKS[rankIdx()].cls || CAREER.ratings.includes(ci); }
  function payMul() { return 1 + 0.05 * rankIdx(); }
  function addXp(n, why) {
    const before = rankIdx(); CAREER.xp += Math.round(n); saveCareer();
    const after = rankIdx();
    if (after > before) { say('Promotion', 0); ui.toast(L(`🎖️ PROMOVARE: ești acum ${rankName(after)}! Ai deblocat ${L(CLASSES[RANKS[after].cls].ro, CLASSES[RANKS[after].cls].en)}.`, `🎖️ PROMOTION: you are now ${rankName(after)}! Unlocked: ${CLASSES[RANKS[after].cls].en}.`), 10000); }
    ui.renderCareer && ui.renderCareer();
  }
  function buyRating(ci) {
    const c = CLASSES[ci];
    if (CAREER.ratings.includes(ci)) return;
    if (ECON.balance < c.price) { ui.toast(L(`Licența costă $${c.price.toLocaleString('en-US')} – nu ai destui bani.`, `The type rating costs $${c.price.toLocaleString('en-US')} – not enough money.`)); return; }
    ECON.balance -= c.price; saveEcon(); CAREER.ratings.push(ci); saveCareer();
    ui.toast(L(`Licență de tip cumpărată: ${c.ro}.`, `Type rating purchased: ${c.en}.`)); OFFERS.t = 0;
    ui.renderMissions && ui.renderMissions(); ui.renderCareer && ui.renderCareer();
  }

  /* ---------------- Realizări ---------------- */
  const ACH = [
    { k: 'first_flight', icon: '🛫', ro: 'Primul zbor', en: 'First flight', dro: 'Termină un zbor', den: 'Complete a flight' },
    { k: 'butter', icon: '🧈', ro: 'Butter', en: 'Butter', dro: 'Aterizare sub 100 ft/min', den: 'Land below 100 ft/min' },
    { k: 'butter5', icon: '🧈', ro: 'Mâini de catifea', en: 'Velvet hands', dro: '5 aterizări sub 150 ft/min', den: '5 landings below 150 ft/min' },
    { k: 'smooth10', icon: '🪶', ro: 'Pasagerii te iubesc', en: 'Passengers love you', dro: '10 aterizări sub 200 ft/min', den: '10 landings below 200 ft/min' },
    { k: 'precision', icon: '🎯', ro: 'Precizie', en: 'Precision', dro: 'Contact la 150–450 m după prag, sub 3 m de ax', den: 'Touch down 150–450 m past the threshold, within 3 m of the centerline' },
    { k: 'explorer10', icon: '🗺️', ro: 'Explorator', en: 'Explorer', dro: 'Aterizează la 10 aeroporturi diferite', den: 'Land at 10 different airports' },
    { k: 'explorer25', icon: '🌍', ro: 'Globetrotter', en: 'Globetrotter', dro: 'Aterizează la 25 de aeroporturi diferite', den: 'Land at 25 different airports' },
    { k: 'long_haul', icon: '🌐', ro: 'Lung-curier', en: 'Long haul', dro: 'Un zbor de peste 1000 NM', den: 'A single flight over 1000 NM' },
    { k: 'missions10', icon: '💼', ro: 'Profesionist', en: 'Professional', dro: '10 misiuni îndeplinite', den: '10 missions completed' },
    { k: 'missions50', icon: '🏢', ro: 'Linie aeriană', en: 'Airline', dro: '50 de misiuni îndeplinite', den: '50 missions completed' },
    { k: 'rich100k', icon: '💰', ro: 'Bogat', en: 'Rich', dro: 'Sold de $100.000', den: 'Balance of $100,000' },
    { k: 'hero', icon: '🦸', ro: 'Erou', en: 'Hero', dro: 'Aterizează în siguranță după o urgență', den: 'Land safely after an emergency' },
    { k: 'deadstick', icon: '🪂', ro: 'Planorist', en: 'Glider pilot', dro: 'Aterizează cu motoarele oprite', den: 'Land with the engines off' },
    { k: 'school', icon: '🎓', ro: 'Absolvent', en: 'Graduate', dro: 'Termină toate lecțiile școlii de zbor', den: 'Finish every flight school lesson' },
    { k: 'captain', icon: '👨‍✈️', ro: 'Comandant', en: 'Captain', dro: 'Ajungi la rangul de Comandant', den: 'Reach the rank of Captain' },
    { k: 'airports50', icon: '🛂', ro: 'Pașaport plin', en: 'Full passport', dro: 'Aterizează la 50 de aeroporturi diferite', den: 'Land at 50 different airports' },
    { k: 'countries5', icon: '🧳', ro: 'Turist', en: 'Tourist', dro: 'Vizitează 5 țări', den: 'Visit 5 countries' },
    { k: 'countries15', icon: '🗺️', ro: 'Călător', en: 'Traveller', dro: 'Vizitează 15 țări', den: 'Visit 15 countries' },
    { k: 'countries30', icon: '🌎', ro: 'Cetățean al lumii', en: 'Citizen of the world', dro: 'Vizitează 30 de țări', den: 'Visit 30 countries' },
    { k: 'streak7', icon: '🔥', ro: 'O săptămână la rând', en: 'One week straight', dro: 'Zboară 7 zile la rând', den: 'Fly 7 days in a row' },
    { k: 'streak30', icon: '☄️', ro: 'De neoprit', en: 'Unstoppable', dro: 'Zboară 30 de zile la rând', den: 'Fly 30 days in a row' },
    { k: 'daily', icon: '🏆', ro: 'Provocare acceptată', en: 'Challenge accepted', dro: 'Termină o provocare a zilei', den: 'Complete a daily challenge' },
    { k: 'daily_top3', icon: '🥇', ro: 'Pe podium', en: 'On the podium', dro: 'Top 3 la provocarea zilei', den: 'Top 3 in a daily challenge' },
    { k: 'airline', icon: '🏢', ro: 'Director general', en: 'CEO', dro: 'Înființează o companie aeriană', den: 'Found an airline' },
    { k: 'fleet5', icon: '🛫', ro: 'Flotă', en: 'Fleet', dro: '5 avioane în compania ta', den: '5 aircraft in your airline' },
    { k: 'bush_pilot', icon: '🛩️', ro: 'Pilot bush', en: 'Bush pilot', dro: 'Termină un zbor bush pe pistă scurtă', den: 'Complete a bush flight to a short strip' },
    { k: 'tour_guide', icon: '📸', ro: 'Ghid turistic', en: 'Tour guide', dro: 'Termină un tur turistic', den: 'Complete a sightseeing tour' },
    { k: 'skydive', icon: '🪂', ro: 'Lansare reușită', en: 'Jump pilot', dro: 'Lansează parașutiști', den: 'Drop a team of skydivers' },
    { k: 'surveyor', icon: '🗺️', ro: 'Cartograf', en: 'Surveyor', dro: 'Termină o misiune de fotografie aeriană', den: 'Complete an aerial survey' },
    { k: 'sar_hero', icon: '🛟', ro: 'Salvator', en: 'Rescuer', dro: 'Găsește un naufragiat', den: 'Find a survivor in search & rescue' },
  ];
  function unlock(code) {
    if (CAREER.ach[code]) return false;
    CAREER.ach[code] = Date.now(); saveCareer();
    const a = ACH.find((x) => x.k === code);
    if (a) { ui.toast(`${a.icon} ${L('Realizare deblocată: ', 'Achievement unlocked: ')}${L(a.ro, a.en)} (+50 XP)`, 7000); say('Achievement unlocked', 0); }
    addXp(50);
    return true;
  }
  function checkAchievements(flight) {
    const log = LOGB.list;
    if (flight) {
      unlock('first_flight');
      if (flight.landing_vs != null && Math.abs(flight.landing_vs) <= 100) unlock('butter');
      if (flight.tdz_m != null && flight.tdz_m >= 150 && flight.tdz_m <= 450 && flight.cl_m != null && Math.abs(flight.cl_m) < 3) unlock('precision');
      if (flight.dist_nm >= 1000) unlock('long_haul');
      if (flight.emergency && flight.landing_score != null && Math.abs(flight.landing_vs) < 900) unlock('hero');
      if (flight.deadstick) unlock('deadstick');
    }
    if (log.filter((f) => f.landing_vs != null && Math.abs(f.landing_vs) <= 150).length >= 5) unlock('butter5');
    if (log.filter((f) => f.landing_vs != null && Math.abs(f.landing_vs) <= 200).length >= 10) unlock('smooth10');
    const apts = new Set(log.map((f) => f.arr).filter(Boolean));
    if (apts.size >= 10) unlock('explorer10');
    if (apts.size >= 25) unlock('explorer25');
    if (ECON.missions >= 10) unlock('missions10');
    if (ECON.missions >= 50) unlock('missions50');
    if (ECON.balance >= 100000) unlock('rich100k');
    if (rankIdx() >= 4) unlock('captain');
    if (LESSONS.every((l) => CAREER.lessons[l.id])) unlock('school');
  }

  /* ---------------- Jurnal de zbor ---------------- */
  const LOGB = { list: store.get('geofsCopilotRO.log', []) };
  const saveLog = () => { try { store.set('geofsCopilotRO.log', LOGB.list.slice(0, 40)); } catch (e) { /* */ } };
  let FLT = null;          // zborul în desfășurare
  const FLTS = { airT: 0, groundT: 0, last: null };
  function flightTick() {
    const onG = sim.onGround(), v = sim.v(), [lat, lon, altM] = sim.lla(), now = Date.now();
    // teleportare (salt mare de poziție) = zborul se anulează
    if (FLTS.last && distM(FLTS.last[0], FLTS.last[1], lat, lon) > 8000 && now - FLTS.last[2] < 2000) { if (FLT && !FLT.lesson) FLT = null; }
    FLTS.last = [lat, lon, now];
    if (!onG) { FLTS.airT = FLTS.airT || now; FLTS.groundT = 0; } else { FLTS.groundT = FLTS.groundT || now; FLTS.airT = 0; }
    if (!FLT && !onG && now - FLTS.airT > 5000 && (v.haglFeet || 0) > 50) {
      const near = DB.loaded ? nearestAirports(lat, lon, 1)[0] : null;
      FLT = { t0: now - 5000, dep: near && near.d < 5 * NM ? near.apt : null, aircraft: acName(),
        fuel0: FUEL.kg, dist: 0, track: [[+lat.toFixed(5), +lon.toFixed(5), Math.round(altM)]], lastPt: now, emergency: null, missionPay: 0 };
    }
    if (!FLT) return;
    if (!onG) {
      FLT.dist += ((v.groundSpeedKnt || 0) * 0.1) / 3600;
      if (now - FLT.lastPt > 10000) { FLT.track.push([+lat.toFixed(5), +lon.toFixed(5), Math.round(altM)]); FLT.lastPt = now; }
      FLT.tLand = null;
    } else {
      if (!FLT.tLand) { FLT.tLand = now; FLT.engOffAtTouch = !(sim.ac().engine && sim.ac().engine.on); FLT.track.push([+lat.toFixed(5), +lon.toFixed(5), Math.round(altM)]); }
      // terminat: oprit (sau 90 s la sol)
      if (((v.groundSpeedKnt || 0) < 5 && now - FLTS.groundT > 3000) || now - FLTS.groundT > 90000) finishFlight();
    }
  }
  function finishFlight() {
    const f = FLT; FLT = null; if (!f) return;
    const [lat, lon] = sim.lla();
    const near = DB.loaded ? nearestAirports(lat, lon, 1)[0] : null;
    const land = f.landing || null;
    const rec = {
      t: f.t0, aircraft: f.aircraft, dep: f.dep, arr: land && land.apt && land.apt !== '?' ? land.apt : near && near.d < 5 * NM ? near.apt : null,
      dist_nm: Math.round(f.dist * 10) / 10, duration_min: Math.round(((f.tLand || Date.now()) - f.t0) / 6000) / 10,
      fuel_kg: f.fuel0 != null && FUEL.kg != null ? Math.max(0, Math.round(f.fuel0 - FUEL.kg)) : null,
      landing_vs: land ? land.vs : null, landing_g: land ? land.g : null, landing_score: land ? land.score : null, cl_m: land ? land.clM : null, tdz_m: land ? land.tdzM : null,
      mission_type: f.missionType || null, mission_pay: f.missionPay || 0, mission_result: f.missionResult || null, emergency: f.emergency || null,
      deadstick: !!f.engOffAtTouch, track: decimate(f.track, 400),
    };
    // XP local (aceeași formulă ca pe server)
    const xp = Math.min(400, Math.round(rec.mission_pay / 50) + (rec.landing_score != null ? Math.floor(rec.landing_score / 5) : 0) + (rec.mission_pay ? 0 : Math.min(60, Math.floor(rec.duration_min / 3))));
    rec.xp = xp;
    LOGB.list.unshift(rec); saveLog();
    if (rec.duration_min >= 1) addXp(xp);
    resolveEmergency(rec);
    try { onFlightFinished(rec); } catch (e) { console.warn('[GeoFS Copilot] flight hooks', e); }
    checkAchievements(rec);
    try { checkAchievements18(); } catch (e) { /* */ }
    submitOnline(rec).then(() => dailyAfterFlight(rec)).catch(() => { /* */ });
    ui.renderLog && ui.renderLog();
  }
  function decimate(arr, max) { if (arr.length <= max) return arr; const step = arr.length / max; const out = []; for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]); out.push(arr[arr.length - 1]); return out; }
  function careerOnLanding(landingRec) { if (FLT) FLT.landing = landingRec; }
  function careerOnMission(pay, type, result) { if (FLT) { FLT.missionPay = pay; FLT.missionType = type; FLT.missionResult = result; } else { const f = LOGB.list[0]; if (f && Date.now() - f.t < 3 * 3600000 && !f.mission_type) { f.mission_pay = pay; f.mission_type = type; f.mission_result = result; saveLog(); } } }

  function download(name, text, mime) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  function exportKml(f) {
    const coords = f.track.map((p) => `${p[1]},${p[0]},${p[2]}`).join(' ');
    const name = `${f.dep || '?'} → ${f.arr || '?'} · ${f.aircraft}`;
    download(`geofs-${f.dep || 'X'}-${f.arr || 'X'}-${new Date(f.t).toISOString().slice(0, 10)}.kml`,
      `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>
<Style id="t"><LineStyle><color>ffff40e0</color><width>3</width></LineStyle></Style>
<Placemark><name>${esc(name)}</name><description>${esc(`${f.dist_nm} NM · ${f.duration_min} min · landing ${f.landing_vs ?? '—'} fpm, score ${f.landing_score ?? '—'}`)}</description><styleUrl>#t</styleUrl>
<LineString><altitudeMode>absolute</altitudeMode><coordinates>${coords}</coordinates></LineString></Placemark></Document></kml>`, 'application/vnd.google-earth.kml+xml');
  }
  function exportGpx(f) {
    const pts = f.track.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"><ele>${p[2]}</ele></trkpt>`).join('');
    download(`geofs-${f.dep || 'X'}-${f.arr || 'X'}.gpx`, `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="GeoFS Copilot" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc((f.dep || '?') + ' - ' + (f.arr || '?'))}</name><trkseg>${pts}</trkseg></trk></gpx>`, 'application/gpx+xml');
  }
  function exportCsv() {
    const cols = ['date', 'aircraft', 'dep', 'arr', 'dist_nm', 'duration_min', 'fuel_kg', 'landing_vs', 'landing_g', 'landing_score', 'mission_type', 'mission_pay', 'emergency', 'xp'];
    const rows = LOGB.list.map((f) => cols.map((c) => (c === 'date' ? new Date(f.t).toISOString() : f[c] ?? '')).map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','));
    download('geofs-logbook.csv', cols.join(',') + '\n' + rows.join('\n'), 'text/csv');
  }

  /* ---------------- Online: trimitere zboruri + clasament ---------------- */
  async function rpc(fn, body) {
    const r = await fetch(`${ONLINE.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ONLINE.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.message) || 'HTTP ' + r.status);
    return j;
  }
  async function submitOnline(rec) {
    if (!settings.onlineSync || rec.duration_min < 1) return;
    try {
      const flight = Object.assign({}, rec); delete flight.track; delete flight.t; delete flight.deadstick;
      const res = await rpc('submit_flight', { p_key: CAREER.key, p_callsign: myCallsign(), p_flight: flight, p_achievements: Object.keys(CAREER.ach).concat(Object.keys(CAREER.lessons).map((k) => 'lesson_' + k)) });
      CAREER.pilotId = res.pilot_id; CAREER.rankPos = res.rank_pos;
      if (res.xp != null && res.xp > CAREER.xp) CAREER.xp = res.xp; // serverul e sursa de adevăr
      try { streakOnResult(res); } catch (e) { /* */ }
      saveCareer(); rec.online = true; saveLog();
      ui.toast(L(`🌐 Zbor publicat · locul #${res.rank_pos} în clasament`, `🌐 Flight published · #${res.rank_pos} on the leaderboard`), 6000);
      LB.t = 0; ui.renderCareer && ui.renderCareer();
      cloudSave(true);
    } catch (e) { console.warn('[GeoFS Copilot] online', e.message); rec.onlineErr = e.message; saveLog(); }
  }
  const LB = { t: 0, list: [], err: null };
  async function loadLeaderboard() {
    if (Date.now() - LB.t < 60000) return;
    LB.t = Date.now();
    try { const r = await rpc('get_leaderboard', { p_sort: 'xp', p_limit: 10 }); LB.list = Array.isArray(r) ? r : []; LB.err = null; } catch (e) { LB.err = e.message; }
    ui.renderCareer && ui.renderCareer();
  }

  /* ---------------- Același pilot pe mai multe calculatoare: cod de pilot + progres în cloud ---------------- */
  const CLOUD = { dirty: false, lastSave: 0, other: null, dismissed: store.get('geofsCopilotRO.cloudDismiss', null), busy: false };
  window.__gcrDirty = () => { CLOUD.dirty = true; CAREER.stateT = Date.now(); store.set('geofsCopilotRO.career', CAREER); };
  function buildState() {
    return { v: 1, t: CAREER.stateT || Date.now(), xp: CAREER.xp, ratings: CAREER.ratings, ach: CAREER.ach, lessons: CAREER.lessons,
      econ: { balance: Math.round(ECON.balance), missions: ECON.missions, hours: +ECON.hours.toFixed(3), nm: Math.round(ECON.nm), earned: Math.round(ECON.earned) },
      history: ECON.history.slice(0, 10), airline: AIR || undefined, passport: PASS.apts, streak: CAREER.streak || undefined };
  }
  /** Combină două progrese fără să dubleze nimic: maxim pentru numere, reuniune pentru liste. */
  function mergeStates(...list) {
    const out = { v: 1, t: Date.now(), xp: 0, ratings: [], ach: {}, lessons: {}, econ: { balance: 0, missions: 0, hours: 0, nm: 0, earned: 0 }, history: [] };
    list.filter(Boolean).forEach((st) => {
      out.xp = Math.max(out.xp, st.xp || 0);
      (st.ratings || []).forEach((r) => { if (!out.ratings.includes(r)) out.ratings.push(r); });
      Object.entries(st.ach || {}).forEach(([k, v]) => { out.ach[k] = out.ach[k] ? Math.min(out.ach[k], v) : v; });
      Object.entries(st.lessons || {}).forEach(([k, v]) => { out.lessons[k] = out.lessons[k] ? Math.min(out.lessons[k], v) : v; });
      Object.keys(out.econ).forEach((k) => { out.econ[k] = Math.max(out.econ[k], (st.econ && st.econ[k]) || 0); });
      out.history = out.history.concat(st.history || []);
    });
    list.filter(Boolean).forEach((st) => {
      if (st.airline && (!out.airline || (st.airline.fleet || []).length > (out.airline.fleet || []).length || ((st.airline.fleet || []).length === (out.airline.fleet || []).length && (st.airline.earned || 0) > (out.airline.earned || 0)))) out.airline = st.airline;
      Object.entries(st.passport || {}).forEach(([k, v]) => { const o = (out.passport = out.passport || {})[k]; out.passport[k] = o ? { c: o.c || v.c, t: Math.min(o.t, v.t), n: Math.max(o.n || 1, v.n || 1) } : v; });
      if (st.streak && (!out.streak || st.streak.day > out.streak.day || (st.streak.day === out.streak.day && st.streak.n > out.streak.n))) out.streak = st.streak;
    });
    out.history = out.history.sort((a, b) => b.t - a.t).filter((h, i, arr) => i === 0 || h.t !== arr[i - 1].t).slice(0, 25);
    return out;
  }
  function applyState(st) {
    if (!st) return;
    CAREER.xp = st.xp || 0; CAREER.ratings = st.ratings || []; CAREER.ach = st.ach || {}; CAREER.lessons = st.lessons || {};
    if (st.econ) Object.assign(ECON, st.econ);
    if (st.history && st.history.length) ECON.history = st.history;
    if (st.airline && st.airline.name) { AIR = st.airline; store.set('geofsCopilotRO.airline', AIR); }
    if (st.passport) { Object.entries(st.passport).forEach(([k, v]) => { const o = PASS.apts[k]; PASS.apts[k] = o ? { c: o.c || v.c, t: Math.min(o.t, v.t), n: Math.max(o.n || 1, v.n || 1) } : v; }); store.set('geofsCopilotRO.passport', PASS); }
    if (st.streak && (!CAREER.streak || st.streak.day >= CAREER.streak.day)) CAREER.streak = st.streak;
    ui.renderAirline && ui.renderAirline();
    CAREER.stateT = st.t || Date.now();
    store.set('geofsCopilotRO.career', CAREER); store.set('geofsCopilotRO.econ', ECON);
    ui.renderCareer && ui.renderCareer(); ui.renderMissions && ui.renderMissions();
  }
  const geofsId = () => { const u = geofs.userRecord || {}; return u.id ? String(u.id) : ''; };
  async function cloudSave(force) {
    if (!settings.onlineSync || CLOUD.busy) return;
    if (!force && (!CLOUD.dirty || Date.now() - CLOUD.lastSave < 60000)) return;
    CLOUD.busy = true;
    try {
      const res = await rpc('save_state', { p_key: CAREER.key, p_callsign: myCallsign(), p_geofs_id: geofsId(), p_state: buildState() });
      CLOUD.dirty = false; CLOUD.lastSave = Date.now(); CAREER.pilotId = res.pilot_id || CAREER.pilotId;
      const o = res.other_profile;
      CLOUD.other = o && !(CLOUD.dismissed && CLOUD.dismissed === o.callsign + o.flights) ? o : null;
      if (CLOUD.other && !CLOUD.toldOther) {
        CLOUD.toldOther = true;
        ui.toast(L(`Contul tău GeoFS are deja un alt profil de pilot (${o.callsign}, ${o.xp} XP, ${o.flights} zboruri) pe alt calculator. Unește-le din tab-ul Carieră cu codul de pilot.`,
          `Your GeoFS account already has another pilot profile (${o.callsign}, ${o.xp} XP, ${o.flights} flights) on another computer. Merge them in the Career tab with your pilot code.`), 12000);
      }
      ui.renderCareer && ui.renderCareer();
    } catch (e) { console.warn('[GeoFS Copilot] cloud save', e.message); } finally { CLOUD.busy = false; }
  }
  async function cloudInit() {
    if (!settings.onlineSync) return;
    try {
      const res = await rpc('get_state', { p_key: CAREER.key });
      if (res && res.state && (res.state.t || 0) > (CAREER.stateT || 0)) { applyState(res.state); ui.toast(L('Progresul tău a fost încărcat din cloud ☁️', 'Your progress was loaded from the cloud ☁️'), 5000); }
      if (res && res.pilot_id) { CAREER.pilotId = res.pilot_id; CAREER.rankPos = res.rank_pos; }
    } catch (e) { /* pilot nou sau server indisponibil */ }
    cloudSave(true);
  }
  async function linkWithCode(code) {
    const clean = String(code || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (clean.length < 24) { ui.toast(L('Codul nu e valid – copiază-l întreg din tab-ul Carieră de pe celălalt calculator.', 'Invalid code – copy it in full from the Career tab on the other computer.')); return; }
    if (clean === CAREER.key) { ui.toast(L('Acesta e chiar codul acestui calculator.', 'That is this computer\'s own code.')); return; }
    try {
      const local = buildState();
      const res = await rpc('link_device', { p_key: CAREER.key, p_code: clean });
      CAREER.key = clean; CAREER.pilotId = res.pilot_id; CAREER.rankPos = res.rank_pos;
      applyState(mergeStates(local, res.state, res.merged_state, { xp: res.xp }));
      CLOUD.other = null; CLOUD.dismissed = null; store.set('geofsCopilotRO.cloudDismiss', null);
      await cloudSave(true);
      LB.t = 0;
      ui.toast(L(`✅ Calculatoare legate! Profil comun: ${res.callsign} · ${res.flights} zboruri · ${res.xp} XP.`, `✅ Computers linked! Shared profile: ${res.callsign} · ${res.flights} flights · ${res.xp} XP.`), 9000);
    } catch (e) { ui.toast(L('Legarea a eșuat: ', 'Linking failed: ') + (e.message === 'code not found' ? L('codul nu există pe server (celălalt calculator trebuie să fi publicat măcar un zbor).', 'code not found on the server (the other computer must have published at least one flight).') : e.message), 9000); }
  }

  /* ---------------- Urgențe și defecțiuni ---------------- */
  const EMERG = { active: null, nextT: 0, flightHad: false };
  const ETYPES = {
    engine: { icon: '🔥', ro: 'Motor defect', en: 'Engine failure' },
    gear: { icon: '⚙️', ro: 'Trenul de aterizare blocat', en: 'Landing gear jammed' },
    bird: { icon: '🐦', ro: 'Impact cu pasăre – motor avariat', en: 'Bird strike – engine damaged' },
    leak: { icon: '💧', ro: 'Scurgere de combustibil', en: 'Fuel leak' },
    medical: { icon: '🚑', ro: 'Urgență medicală la bord', en: 'Medical emergency on board' },
    apfail: { icon: '⚡', ro: 'Defecțiune autopilot', en: 'Autopilot failure' },
  };
  function triggerEmergency(type) {
    if (EMERG.active) return;
    const list = engines(); const multi = list.length > 1;
    if (!type) {
      const pool = ['engine', 'gear', 'bird', 'leak', 'apfail'];
      if (MISSION && MISSION.isPax) pool.push('medical', 'medical');
      type = pool[Math.floor(Math.random() * pool.length)];
    }
    const e = { type, t0: Date.now(), multi, engIdx: multi ? Math.floor(Math.random() * list.length) : 0 };
    if (type === 'engine') { if (multi) engSetMode(e.engIdx, 'off'); else e.dead = true; }
    if (type === 'bird') { ENG.levers[e.engIdx] = 0.35; engSetMode(e.engIdx, 'man'); }
    if (type === 'gear') e.gearStuck = true;
    if (type === 'apfail') { e.apUntil = Date.now() + 180000; if (geofs.autopilot.on) geofs.autopilot.turnOff(); }
    if (type === 'medical') e.deadline = Date.now() + 35 * 60000;
    EMERG.active = e; EMERG.flightHad = true;
    if (FLT) FLT.emergency = type;
    say(type === 'medical' ? 'Medical emergency' : type === 'engine' ? 'Engine failure' : 'Caution, ' + ETYPES[type].en, 0);
    ui.showEmergency();
  }
  function emergencyTick() {
    const e = EMERG.active, onG = sim.onGround();
    if (!e) {
      if (onG || settings.failures === 'off' || LES.id || !FLT) return;
      if ((sim.v().haglFeet || 0) < 1500 || EMERG.flightHad) return;
      if (Date.now() < EMERG.nextT) return; EMERG.nextT = Date.now() + 10000;
      const perHour = settings.failures === 'normal' ? 0.45 : 0.12;
      if (Math.random() < perHour / 360) triggerEmergency();
      return;
    }
    if (e.type === 'engine' && e.dead && sim.ac().engine && sim.ac().engine.on) controls.setters.toggleEngines.set();
    if (e.type === 'gear' && e.gearStuck && controls.gear.target === 0) controls.setters.setGearUp.set();
    if (e.type === 'leak' && FUEL.kg != null) { const p = acProfile(); FUEL.kg = Math.max(0, FUEL.kg - (p.capKg * 0.3 / 3600) * 0.1); }
    if (e.type === 'apfail' && Date.now() < e.apUntil && geofs.autopilot.on) { geofs.autopilot.turnOff(); if (AP.active) disengage(true); }
    if (e.type === 'apfail' && Date.now() >= e.apUntil && !e.apBack) { e.apBack = true; ui.toast(L('Autopilotul funcționează din nou.', 'The autopilot works again.')); }
    if (e.crank && Date.now() >= e.crank) { e.crank = 0; e.gearStuck = false; controls.setters.setGearDown.set(); ui.toast(L('Trenul a coborât prin sistemul de rezervă ✓', 'Gear extended with the alternate system ✓')); ui.showEmergency(); }
  }
  function emergencyAction(kind) {
    const e = EMERG.active; if (!e) return;
    if (kind === 'restart') {
      if (Date.now() - e.t0 < 45000) { ui.toast(L('Prea devreme – așteaptă să se răcească motorul (45 s).', 'Too early – wait for the engine to cool (45 s).')); return; }
      if (Math.random() < 0.35) { if (e.multi) engSetMode(e.engIdx, 'link'); else { e.dead = false; if (!sim.ac().engine.on) controls.setters.toggleEngines.set(); } e.restarted = true; ui.toast(L('Motorul a repornit ✓', 'Engine restarted ✓')); say('Engine restarted', 0); }
      else { e.t0 = Date.now(); ui.toast(L('Repornire eșuată. Mai poți încerca peste 45 s – sau deviază.', 'Restart failed. Try again in 45 s – or divert.')); }
    }
    if (kind === 'crank') { e.crank = Date.now() + 20000; ui.toast(L('Cobori trenul manual… (20 s)', 'Cranking the gear down manually… (20 s)')); }
    if (kind === 'divert') divertNearest();
    if (kind === 'mayday') atcSend(`MAYDAY MAYDAY MAYDAY ${myCallsign()} ${ETYPES[e.type].en} #MSG`);
    ui.showEmergency();
  }
  function divertNearest() {
    const [lat, lon] = sim.lla();
    const need = isLight() ? 2000 : 5500;
    const cand = nearestAirports(lat, lon, 10, (a, len) => len >= need)[0];
    if (!cand) { ui.toast(L('Nu am găsit un aeroport potrivit în apropiere.', 'No suitable airport nearby.')); return; }
    if (MISSION) { MISSION.divertApt = cand.apt; saveMission(); }
    const keepTrip = TRIP.stops.slice();
    setSingleDestination(cand.apt);
    if (MISSION) { TRIP.after = keepTrip; }
    if (sim.hasAP() && !(EMERG.active && EMERG.active.type === 'apfail' && Date.now() < EMERG.active.apUntil)) engage();
    ui.toast(L(`Deviere spre ${aptName(cand.apt)} (${(cand.d / NM).toFixed(0)} NM).`, `Diverting to ${aptName(cand.apt)} (${(cand.d / NM).toFixed(0)} NM).`), 8000);
  }
  function resolveEmergency(rec) {
    const e = EMERG.active; EMERG.flightHad = false;
    if (!e) return;
    engines().forEach((x, i) => { if (ENG.modes[i] !== 'link') engSetMode(i, 'link'); });
    EMERG.active = null; ui.hideEmergency();
    if (rec && rec.landing_score != null && Math.abs(rec.landing_vs) < 900) ui.toast(L('Urgență gestionată – ai adus avionul la sol în siguranță! 🦸', 'Emergency handled – you brought the aircraft down safely! 🦸'), 8000);
  }
  ui.showEmergency = () => {
    const e = EMERG.active; if (!e) return;
    let c = document.getElementById('gcr-emerg');
    if (!c) { c = el('div', { id: 'gcr-emerg' }); ['mousedown', 'pointerdown'].forEach((t) => c.addEventListener(t, (ev) => ev.stopPropagation())); document.body.append(c); }
    const T = ETYPES[e.type];
    const steps = {
      engine: e.multi ? [L('Menține viteza și direcția – compensează cu direcția (palonier).', 'Keep speed and heading – counter the yaw with rudder.'), L('Motorul defect e tăiat automat. Poți încerca o repornire după 45 s.', 'The failed engine is shut down. You can try a restart after 45 s.'), L('Deviază spre cel mai apropiat aeroport.', 'Divert to the nearest airport.')]
        : [L('MOTORUL S-A OPRIT! Coboară botul și menține viteza de planare.', 'ENGINE OUT! Lower the nose and keep glide speed.'), L('Caută cel mai apropiat aeroport sau un teren liber.', 'Find the nearest airport or open field.'), L('Poți încerca o repornire după 45 s.', 'You can try a restart after 45 s.')],
      gear: [L('Trenul nu coboară normal.', 'The gear will not extend normally.'), L('Folosește coborârea de rezervă (durează 20 s).', 'Use the alternate extension (takes 20 s).'), L('Verifică că trenul e jos înainte de aterizare.', 'Check the gear is down before landing.')],
      bird: [L(`Motorul ${e.engIdx + 1} a pierdut putere (35%).`, `Engine ${e.engIdx + 1} has lost power (35%).`), L('Redu viteza, evită manevrele bruște.', 'Reduce speed, avoid abrupt manoeuvres.'), L('Deviază spre cel mai apropiat aeroport.', 'Divert to the nearest airport.')],
      leak: [L('Pierzi combustibil rapid!', 'You are losing fuel fast!'), L('Verifică autonomia în caseta de instrucțiuni.', 'Watch your endurance in the instruction box.'), L('Aterizează cât mai repede.', 'Land as soon as possible.')],
      medical: [L('Un pasager are nevoie urgentă de spital.', 'A passenger urgently needs a hospital.'), L(`Aterizează în ${Math.max(0, Math.round((e.deadline - Date.now()) / 60000))} min la cel mai apropiat aeroport.`, `Land within ${Math.max(0, Math.round((e.deadline - Date.now()) / 60000))} min at the nearest airport.`), L('Misiunea se plătește la aeroportul de deviere (70% + bonus $800).', 'The mission is paid at the diversion airport (70% + $800 bonus).')],
      apfail: [L('Autopilotul nu funcționează 3 minute.', 'The autopilot is out for 3 minutes.'), L('Zboară manual: menține altitudinea și direcția din instrucțiuni.', 'Fly by hand: hold the altitude and heading from the instructions.')],
    }[e.type];
    const B = (t, k, cls) => el('button', { class: 'gcr-btn sm ' + (cls || ''), onclick: () => emergencyAction(k) }, t);
    c.innerHTML = '';
    c.append(el('div', { class: 'title' }, `${T.icon} ${L(T.ro, T.en)}`),
      el('ol', {}, ...steps.map((s) => el('li', {}, s))),
      el('div', { class: 'gcr-row', style: 'justify-content:center' },
        B(L('Deviază la cel mai apropiat aeroport', 'Divert to nearest airport'), 'divert', 'warn'),
        (e.type === 'engine' && !e.restarted) ? B(L('Încearcă repornirea', 'Try restart'), 'restart') : null,
        (e.type === 'gear' && e.gearStuck && !e.crank) ? B(L('Coborâre de rezervă a trenului', 'Alternate gear extension'), 'crank') : null,
        B('MAYDAY', 'mayday'),
        el('button', { class: 'gcr-btn sm', onclick: () => ui.hideEmergency() }, L('Ascunde', 'Hide'))));
    c.style.display = 'block';
  };
  ui.hideEmergency = () => { const c = document.getElementById('gcr-emerg'); if (c) c.style.display = 'none'; };

  /* ---------------- Școala de zbor ---------------- */
  const LES = { id: null, i: 0, t0: 0, st: {} };
  function nearAptOrAny() { const [la, lo] = sim.lla(); return nearestAirports(la, lo, 1, (a, len) => len >= (isLight() ? 2000 : 6000))[0]; }
  function setupOnRunway(then) {
    const a = nearAptOrAny(); if (!a) return;
    const r = bestRunwayForDeparture(a.apt);
    if (geofs.autopilot.on) geofs.autopilot.turnOff(); disengage(true);
    positionOnRunway(r, () => { controls.throttle = 0; sim.ac().brakesOn = true; LES.st.rwy = r; if (then) then(r); });
  }
  function setupFinal(nm) {
    const a = nearAptOrAny(); if (!a) return;
    selectRunway(bestRunway(a.apt));
    const r = AP.rwy, d = nm * NM;
    const [la, lo] = destPoint(r.lat, r.lon, norm360(r.hdg + 180), d);
    if (geofs.autopilot.on) geofs.autopilot.turnOff(); disengage(true);
    geofs.flyTo([la, lo, gpAltM(d), r.hdg, true, suggestedVapp() + 10]);
    setTimeout(() => { if (controls.gear.target === 0) controls.setters.setGearUp.set(); }, 1500);
  }
  const hold = (key, cond, secs) => { if (cond) { LES.st[key] = LES.st[key] || Date.now(); return Date.now() - LES.st[key] >= secs * 1000; } LES.st[key] = 0; return false; };
  const LESSONS = [
    { id: 'takeoff', icon: '🛫', ro: 'Prima decolare', en: 'First takeoff', xp: 50, setup: () => setupOnRunway(),
      steps: [
        { ro: 'Eliberează frâna de parcare (tasta ;)', en: 'Release the parking brake (key ;)', ok: () => !sim.ac().brakesOn },
        { ro: 'Motor la maxim (tasta Page Up sau maneta)', en: 'Full power (Page Up or the throttle)', ok: () => (controls.throttle || 0) > 0.9 },
        { ro: 'Ține avionul pe ax și accelerează până la viteza de decolare', en: 'Keep it on the centerline and accelerate to rotation speed', ok: () => (sim.v().kias || 0) >= vrSpeed() },
        { ro: 'Trage ușor de manșă (săgeata jos) – desprinde-te de pistă', en: 'Pull back gently (down arrow) – lift off', ok: () => !sim.onGround() && (sim.v().haglFeet || 0) > 30 },
        { ro: 'Ridică trenul (tasta G)', en: 'Raise the gear (key G)', ok: () => controls.gear.target === 1 },
        { ro: 'Urcă până la 1000 ft deasupra solului', en: 'Climb to 1000 ft above the ground', ok: () => (sim.v().haglFeet || 0) > 1000 },
      ] },
    { id: 'handling', icon: '🔄', ro: 'Zbor la orizontală și viraje', en: 'Straight & level and turns', xp: 50,
      setup: () => { const a = nearAptOrAny(); if (!a) return; const [la, lo] = destPoint(a.a.lat, a.a.lon, 180, 5 * NM); if (geofs.autopilot.on) geofs.autopilot.turnOff(); disengage(true); LES.st.base = Math.round((a.a.elevFt || 0) / 100) * 100 + 3000; geofs.flyTo([la, lo, LES.st.base * FT, 0, true, Math.round(suggestedVapp() * 1.5)]); },
      steps: [
        { ro: 'Autopilotul e oprit. Menține altitudinea (±200 ft) 20 de secunde', en: 'Autopilot is off. Hold altitude (±200 ft) for 20 seconds', ok: () => hold('a', Math.abs(sim.altFt() - LES.st.base) < 200, 20) },
        { ro: 'Virează la dreapta până la capul 090° (±5°), fără să pierzi altitudine', en: 'Turn right to heading 090° (±5°) without losing altitude', ok: () => Math.abs(norm180(sim.v().heading - 90)) < 5 && Math.abs(sim.altFt() - LES.st.base) < 300 },
        { ro: 'Menține capul 090° și altitudinea 15 secunde', en: 'Hold heading 090° and altitude for 15 seconds', ok: () => hold('b', Math.abs(norm180(sim.v().heading - 90)) < 6 && Math.abs(sim.altFt() - LES.st.base) < 250, 15) },
        { ro: () => L(`Urcă la ${LES.st.base + 1000} ft`, `Climb to ${LES.st.base + 1000} ft`), ok: () => Math.abs(sim.altFt() - (LES.st.base + 1000)) < 150 },
        { ro: 'Virează la stânga până la capul 360° (±5°)', en: 'Turn left to heading 360° (±5°)', ok: () => Math.abs(norm180(sim.v().heading - 0)) < 5 },
        { ro: () => L(`Coboară înapoi la ${LES.st.base} ft și menține 10 secunde`, `Descend back to ${LES.st.base} ft and hold for 10 seconds`), ok: () => hold('c', Math.abs(sim.altFt() - LES.st.base) < 150, 10) },
      ] },
    { id: 'landing', icon: '🛬', ro: 'Apropiere și aterizare', en: 'Approach and landing', xp: 50, setup: () => setupFinal(6),
      steps: [
        { ro: 'Coboară trenul (tasta G)', en: 'Lower the gear (key G)', ok: () => controls.gear.target === 0 },
        { ro: 'Pune flapsurile (tasta ] sau panoul Avion)', en: 'Set the flaps (key ] or the Aircraft panel)', ok: () => !sim.flapsSteps() || controls.flaps.target >= 1 },
        { ro: 'Urmează acele ILS din HUD: fii pe ax și pe pantă la 1000 ft', en: 'Follow the ILS needles in the HUD: be on centerline and glide path at 1000 ft', ok: () => { const s = approachState(); return s && s.hatFt < 1000 && Math.abs(s.locDots) < 1.2 && Math.abs(s.gsDots) < 1.2; } },
        { ro: 'Aterizează: redu motorul și fă flare-ul aproape de sol', en: 'Land: reduce power and flare close to the ground', ok: () => sim.onGround() },
        { ro: 'Frânează până te oprești', en: 'Brake to a stop', ok: () => (sim.v().groundSpeedKnt || 0) < 5 },
      ], pass: () => { const l = store.get(LS_LANDINGS, [])[0]; return !l || Date.now() - Date.parse(l.date) > 600000 ? true : l.score >= 45; } },
    { id: 'engine_out', icon: '🔥', ro: 'Motor defect după decolare', en: 'Engine failure after takeoff', xp: 50, setup: () => setupOnRunway(),
      steps: [
        { ro: 'Decolează (frână liberă, motor la maxim, rotire la Vr)', en: 'Take off (brake off, full power, rotate at Vr)', ok: () => !sim.onGround() && (sim.v().haglFeet || 0) > 600 },
        { ro: 'MOTOR DEFECT! Păstrează viteza peste Vr și aripile drepte', en: 'ENGINE FAILURE! Keep speed above Vr and wings level', ok: () => { if (!EMERG.active) triggerEmergency('engine'); return hold('e', (sim.v().kias || 0) > vrSpeed() && Math.abs(sim.v().aroll || 0) < 20, 10); } },
        { ro: 'Întoarce-te și aterizează în siguranță pe orice aeroport (folosește „Deviază”)', en: 'Turn back and land safely at any airport (use “Divert”)', ok: () => sim.onGround() && (sim.v().groundSpeedKnt || 0) < 5 },
      ] },
    { id: 'precision', icon: '🎯', ro: 'Aterizare de precizie', en: 'Precision landing', xp: 50, setup: () => setupFinal(5),
      steps: [
        { ro: 'Configurează avionul: tren jos, flapsuri', en: 'Configure: gear down, flaps', ok: () => controls.gear.target === 0 && (!sim.flapsSteps() || controls.flaps.target >= 1) },
        { ro: 'Aterizează la 150–600 m după prag, sub 5 m de ax și sub 250 ft/min', en: 'Touch down 150–600 m past the threshold, within 5 m of centerline, below 250 ft/min', ok: () => sim.onGround() && (sim.v().groundSpeedKnt || 0) < 40 },
      ], pass: () => { const l = store.get(LS_LANDINGS, [])[0]; return l && l.tdzM >= 150 && l.tdzM <= 600 && Math.abs(l.clM || 99) < 5 && Math.abs(l.vs) < 250; } },
  ];
  function startLesson(id) {
    const les = LESSONS.find((l) => l.id === id); if (!les) return;
    if (MISSION) { ui.toast(L('Termină sau anulează misiunea înainte de o lecție.', 'Finish or cancel your mission before a lesson.')); return; }
    LES.id = id; LES.i = 0; LES.t0 = Date.now(); LES.st = {};
    les.setup();
    ui.toast(`${les.icon} ${L('Lecție: ', 'Lesson: ')}${L(les.ro, les.en)}`, 5000);
    ui.renderTraining && ui.renderTraining();
  }
  function stopLesson(msg) { LES.id = null; if (msg) ui.toast(msg, 7000); ui.renderTraining && ui.renderTraining(); }
  function lessonTick() {
    if (!LES.id) return;
    const les = LESSONS.find((l) => l.id === LES.id); if (!les) return;
    if (Date.now() - LES.t0 < 6000) return; // lăsăm teleportarea să se termine
    const step = les.steps[LES.i];
    if (step && step.ok()) {
      LES.i++; say(LES.i < les.steps.length ? 'Good' : 'Lesson complete', 0);
      if (LES.i >= les.steps.length) {
        setTimeout(() => {
          const passed = !les.pass || les.pass();
          if (passed) {
            const first = !CAREER.lessons[les.id];
            CAREER.lessons[les.id] = Date.now(); saveCareer();
            if (first) addXp(les.xp);
            stopLesson(`🎓 ${L('Lecție terminată: ', 'Lesson complete: ')}${L(les.ro, les.en)}${first ? ` (+${les.xp} XP)` : ''}`);
            checkAchievements();
          } else stopLesson(L('Aproape! Lecția nu a fost trecută – mai încearcă.', 'Almost! Lesson not passed – try again.'));
          if (EMERG.active) resolveEmergency(null);
        }, 2500);
      }
      ui.renderTraining && ui.renderTraining();
    }
  }
  function lessonLines() {
    if (!LES.id) return [];
    const les = LESSONS.find((l) => l.id === LES.id); const step = les && les.steps[LES.i];
    if (!step) return [[`🎓 ${L(les.ro, les.en)} – ${L('se evaluează…', 'evaluating…')}`, 'h']];
    const txt = typeof step.ro === 'function' ? step.ro() : L(step.ro, step.en);
    return [[`🎓 ${L('Pasul', 'Step')} ${LES.i + 1}/${les.steps.length}: ${txt}`, 'h'], [`${L(les.ro, les.en)} · Shift+P = ${L('oprește lecția', 'stop lesson')}`, 'm']];
  }

  /* =====================================================================
   *  1.8 · PROVOCAREA ZILEI · SERIE DE ZILE · CONCURS DE ATERIZARE · PAȘAPORT
   *        MISIUNI SPECIALE (bush, tur, parașutiști, fotografie, căutare-salvare) · COMPANIE AERIANĂ
   * ===================================================================== */
  const utcDay = (t) => new Date(t || Date.now()).toISOString().slice(0, 10);
  const flagOf = (iso) => (iso && /^[A-Z]{2}$/.test(iso) ? String.fromCodePoint(...[...iso].map((c) => 127397 + c.charCodeAt(0))) : '🏳️');
  const money = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  const rid = () => Math.random().toString(36).slice(2, 8);
  function acName() {
    const ac = sim.ac(), id = ac.id, l = geofs.aircraftList && geofs.aircraftList[id];
    return String((l && l.name) || (ac.definition && ac.definition.name) || id || '?').slice(0, 40);
  }
  /** Aeroportul unde tocmai ai aterizat: din ultima aterizare evaluată, altfel cel mai apropiat (inclusiv piste scurte). */
  function landedApt(lat, lon) {
    const last = store.get(LS_LANDINGS, [])[0];
    if (last && last.apt && last.apt !== '?' && Date.now() - Date.parse(last.date) < 240000) return { apt: last.apt, d: 0 };
    return DB.loaded ? nearestAirports(lat, lon, 1, null, 0)[0] || null : null;
  }

  /* ---------------- Pașaport: aeroporturi și țări vizitate ---------------- */
  const PASS = Object.assign({ apts: {} }, store.get('geofsCopilotRO.passport', {}));
  const savePass = () => { store.set('geofsCopilotRO.passport', PASS); if (window.__gcrDirty) window.__gcrDirty(); };
  function passAdd(icao, t) {
    if (!icao || icao === '?') return null;
    const a = DB.info.get(icao);
    const cur = PASS.apts[icao];
    if (cur) { cur.n = (cur.n || 1) + 1; if (!cur.c && a) cur.c = a.country; return null; }
    const before = a && a.country ? Object.values(PASS.apts).some((x) => x.c === a.country) : true;
    PASS.apts[icao] = { c: a ? a.country : null, t: t || Date.now(), n: 1 };
    return { icao, newCountry: !before ? a.country : null };
  }
  function passStats() {
    const byC = {};
    const list = Object.entries(PASS.apts);
    list.forEach(([, v]) => { if (v.c) byC[v.c] = (byC[v.c] || 0) + 1; });
    return { airports: list.length, countries: Object.keys(byC).length, byC };
  }
  if (!PASS.init) { LOGB.list.slice().reverse().forEach((f) => { passAdd(f.dep, f.t); passAdd(f.arr, f.t); }); PASS.init = 1; store.set('geofsCopilotRO.passport', PASS); }
  let passFilled = false;
  function passFill() { // completează țara pentru intrările vechi, după ce se încarcă baza de aeroporturi
    if (passFilled || !DB.loaded) return; passFilled = true;
    let ch = false;
    Object.entries(PASS.apts).forEach(([k, v]) => { if (!v.c) { const a = DB.info.get(k); if (a && a.country) { v.c = a.country; ch = true; } } });
    if (ch) savePass();
  }

  /* ---------------- Serie de zile ---------------- */
  function streakNow() {
    const s = CAREER.streak; if (!s) return { n: 0, best: 0, today: false };
    const today = utcDay(), yest = utcDay(Date.now() - 86400000);
    return { n: s.day === today || s.day === yest ? s.n : 0, best: s.best || s.n || 0, today: s.day === today };
  }
  function streakOnResult(res) {
    if (res.streak == null) return;
    CAREER.streak = { n: res.streak, day: utcDay(), best: Math.max(res.best_streak || 0, res.streak) };
    saveCareer();
    if (res.streak_bonus) setTimeout(() => ui.toast(L(`🔥 Serie: ${res.streak} ${res.streak === 1 ? 'zi' : 'zile'} la rând! +${res.streak_bonus} XP (revino mâine pentru +${10 * Math.min(res.streak + 1, 7)} XP)`, `🔥 Streak: ${res.streak} day${res.streak === 1 ? '' : 's'} in a row! +${res.streak_bonus} XP (come back tomorrow for +${10 * Math.min(res.streak + 1, 7)} XP)`), 8000), 6500);
    if (CAREER.streak.best >= 7) unlock('streak7');
    if (CAREER.streak.best >= 30) unlock('streak30');
  }

  /* ---------------- Provocarea zilei ---------------- */
  const DAILY = { t: 0, data: null, err: null, mine: store.get('geofsCopilotRO.daily', null), busy: false };
  async function loadDaily(force) {
    if (!settings.onlineSync || DAILY.busy) return;
    const age = Date.now() - DAILY.t, fresh = DAILY.data && DAILY.data.day === utcDay();
    if (!force && (age < 60000 || (fresh && age < 300000))) return; // fără bucle de cereri când serverul nu răspunde
    DAILY.busy = true; DAILY.t = Date.now();
    try { const d = await rpc('get_daily', { p_limit: 10 }); DAILY.data = d && d.icao ? d : null; DAILY.err = d && d.icao ? null : 'bad response'; } catch (e) { DAILY.err = e.message; } finally { DAILY.busy = false; }
    ui.renderMissions && ui.tab === 'mis' && ui.renderMissions();
  }
  function dailyRunway() {
    const d = DAILY.data; if (!d || !DB.loaded) return null;
    const rws = DB.airports.get(d.icao) || [];
    return rws.find((r) => String(r.ident).toUpperCase() === String(d.rwy).toUpperCase()) || bestRunway(d.icao);
  }
  function flyDaily() {
    const d = DAILY.data;
    if (!d) { ui.toast(L('Provocarea zilei nu s-a încărcat încă.', 'The daily challenge has not loaded yet.')); return; }
    if (!DB.loaded) { ui.toast(L('Baza de aeroporturi se încarcă…', 'Airport database is loading…')); return; }
    if (MISSION && MISSION.state === 'flying') { ui.toast(L('Termină sau anulează misiunea înainte.', 'Finish or cancel your mission first.')); return; }
    if (LES.id) { ui.toast(L('Oprește lecția înainte.', 'Stop the lesson first.')); return; }
    const r = dailyRunway(); if (!r) { ui.toast(L('Nu găsesc pista provocării.', 'Challenge runway not found.')); return; }
    if (geofs.autopilot.on) geofs.autopilot.turnOff(); disengage(true);
    selectRunway(r);
    const dist = (isLight() ? 4 : 8) * NM;
    const [la, lo] = destPoint(r.lat, r.lon, norm360(r.hdg + 180), dist);
    geofs.flyTo([la, lo, gpAltM(dist), r.hdg, true, suggestedVapp() + 10]);
    setTimeout(() => { try { if (controls.gear.target === 0) controls.setters.setGearUp.set(); } catch (e) { /* */ } }, 1500);
    ui.toast(L(`🏆 Provocarea zilei: aterizează la ${aptName(d.icao)}, pista ${r.ident}. Ești pe finală – urmează caseta de instrucțiuni.`, `🏆 Daily challenge: land at ${aptName(d.icao)}, runway ${r.ident}. You are on final – follow the instruction box.`), 9000);
  }
  async function dailyAfterFlight(rec) {
    const d = DAILY.data;
    if (!settings.onlineSync || !d || !rec || rec.arr !== d.icao || rec.landing_score == null || rec.tdz_m == null || !CAREER.pilotId) return;
    if (d.day !== utcDay()) { await loadDaily(true); if (!DAILY.data || DAILY.data.icao !== rec.arr) return; }
    try {
      const res = await rpc('submit_daily', { p_key: CAREER.key, p_icao: rec.arr, p_score: rec.landing_score, p_vs: rec.landing_vs, p_g: rec.landing_g, p_cl: rec.cl_m, p_tdz: rec.tdz_m, p_aircraft: rec.aircraft });
      DAILY.mine = { day: utcDay(), pos: res.pos, players: res.players, score: res.best && res.best.score, vs: res.best && res.best.vs };
      store.set('geofsCopilotRO.daily', DAILY.mine);
      if (res.xp != null && res.xp > CAREER.xp) { CAREER.xp = res.xp; saveCareer(); }
      unlock('daily');
      if (res.pos <= 3 && res.players >= 3) unlock('daily_top3');
      setTimeout(() => ui.toast(L(`🏆 Provocarea zilei: cel mai bun scor ${DAILY.mine.score} · locul #${res.pos} din ${res.players}. Poți încerca de câte ori vrei azi!`, `🏆 Daily challenge: best score ${DAILY.mine.score} · #${res.pos} of ${res.players}. You can retry as often as you like today!`), 9000), 13000);
      loadDaily(true);
    } catch (e) { console.warn('[GeoFS Copilot] daily', e.message); }
  }
  function renderDailyBox(box) {
    box.innerHTML = '';
    if (!settings.onlineSync) return;
    loadDaily(false);
    const d = DAILY.data, st = streakNow();
    const card = el('div', { class: 'gcr-destcard', style: 'margin-top:0;border-color:#ffb300' });
    const streakTxt = st.n ? L(`🔥 Serie: ${st.n} ${st.n === 1 ? 'zi' : 'zile'}${st.today ? ' ✓ azi' : ' – zboară azi ca s-o păstrezi!'}`, `🔥 Streak: ${st.n} day${st.n === 1 ? '' : 's'}${st.today ? ' ✓ today' : ' – fly today to keep it!'}`)
      : L('🔥 Zboară azi ca să începi o serie (bonus XP zilnic, până la +70).', '🔥 Fly today to start a streak (daily XP bonus, up to +70).');
    if (!d) { card.append(el('div', { class: 'gcr-muted' }, DAILY.err ? L('Provocarea zilei nu s-a putut încărca.', 'The daily challenge could not be loaded.') : L('Se încarcă provocarea zilei…', 'Loading the daily challenge…')), el('div', {}, streakTxt)); box.append(card); return; }
    const mine = DAILY.mine && DAILY.mine.day === d.day ? DAILY.mine : null;
    const left = Math.max(0, Math.round((Date.parse(d.day + 'T00:00:00Z') + 86400000 - Date.now()) / 3600000));
    card.append(
      el('div', { class: 'gcr-muted', style: 'font-size:11px' }, `🏆 ${L('PROVOCAREA ZILEI', 'DAILY CHALLENGE')} · ${L('încă', 'ends in')} ~${left} h`),
      el('div', { style: 'font-size:14px;font-weight:700' }, `${L('Aterizează la', 'Land at')} ${DB.loaded ? aptName(d.icao) : d.icao} (${d.icao}) · ${L('pista', 'rwy')} ${d.rwy}`),
      el('div', { class: 'gcr-muted' }, (d.light_only ? L('Pistă scurtă – recomandat avion ușor. ', 'Short strip – light aircraft recommended. ') : '') +
        L(`${d.players} piloți azi`, `${d.players} pilots today`) + (mine ? L(` · scorul tău: ${mine.score} (#${mine.pos})`, ` · your score: ${mine.score} (#${mine.pos})`) : '')),
      el('div', { class: 'gcr-row' }, el('button', { class: 'gcr-btn sm ok', onclick: flyDaily }, '✈ ' + L('Zboară acum (pe finală)', 'Fly it now (on final)')),
        el('a', { href: ONLINE.site + '#/daily', target: '_blank', rel: 'noopener', class: 'gcr-link' }, L('clasamentul zilei →', 'today\'s leaderboard →'))));
    if (d.board && d.board.length) card.append(el('div', { class: 'gcr-muted', style: 'font-size:11px;margin-top:3px' }, d.board.slice(0, 3).map((x) => `${['🥇', '🥈', '🥉'][x.pos - 1] || '#' + x.pos} ${x.callsign} ${x.score}`).join('  ·  ')));
    card.append(el('div', { style: 'margin-top:4px' }, streakTxt));
    box.append(card);
  }

  /* ---------------- Concursul săptămânal de aterizare ---------------- */
  const CONTEST = { t: 0, data: null, err: null };
  async function loadContest() {
    if (!settings.onlineSync || Date.now() - CONTEST.t < 120000) return;
    CONTEST.t = Date.now();
    try { const c = await rpc('get_landing_contest', { p_limit: 10 }); CONTEST.data = c && Array.isArray(c.board) ? c : null; CONTEST.err = CONTEST.data ? null : 'bad response'; } catch (e) { CONTEST.err = e.message; }
    ui.renderCareer && ui.tab === 'car' && ui.renderCareer();
  }

  /* ---------------- Misiuni speciale ---------------- */
  const LANDMARKS = [
    ['Eiffel Tower', 48.8584, 2.2945], ['Notre-Dame de Paris', 48.853, 2.3499], ['Versailles', 48.8049, 2.1204], ['Mont-Saint-Michel', 48.6361, -1.5115],
    ['Big Ben', 51.5007, -0.1246], ['Tower Bridge', 51.5055, -0.0754], ['Stonehenge', 51.1789, -1.8262], ['Edinburgh Castle', 55.9486, -3.1999], ['Cliffs of Moher', 52.9715, -9.4309],
    ['Atomium', 50.8949, 4.3415], ['Amsterdam Centraal', 52.3791, 4.9003], ['Brandenburg Gate', 52.5163, 13.3777], ['Neuschwanstein', 47.5576, 10.7498], ['Zugspitze', 47.4211, 10.9853],
    ['Matterhorn', 45.9763, 7.6586], ['Mont Blanc', 45.8326, 6.8652], ['Jungfrau', 46.5368, 7.9626], ['Lake Como (Bellagio)', 45.9867, 9.2617],
    ['Colosseum', 41.8902, 12.4922], ['St. Peter\'s Basilica', 41.9022, 12.4539], ['Leaning Tower of Pisa', 43.723, 10.3966], ['St Mark\'s Square, Venice', 45.4342, 12.3388], ['Mount Vesuvius', 40.8214, 14.426], ['Mount Etna', 37.751, 14.9934],
    ['Sagrada Família', 41.4036, 2.1744], ['Rock of Gibraltar', 36.144, -5.3426], ['Alhambra', 37.1761, -3.5881], ['Belém Tower', 38.6916, -9.216], ['Teide', 28.2724, -16.6425],
    ['Acropolis', 37.9715, 23.7257], ['Santorini (Oia)', 36.4618, 25.3753], ['Hagia Sophia', 41.0086, 28.9802], ['Cappadocia', 38.6431, 34.8289],
    ['Palace of the Parliament', 44.4275, 26.0875], ['Peleș Castle', 45.3599, 25.5427], ['Bran Castle', 45.5149, 25.3672], ['Bâlea Lake (Transfăgărășan)', 45.6036, 24.6168], ['Danube Delta (Sulina)', 45.1556, 29.6531], ['Sighișoara Citadel', 46.2197, 24.7964], ['Iron Gates (Danube)', 44.6714, 22.5281],
    ['Prague Castle', 50.0909, 14.4005], ['Hungarian Parliament', 47.5071, 19.0457], ['Schönbrunn Palace', 48.1849, 16.3122], ['Wawel Castle', 50.054, 19.9354], ['Moscow Kremlin', 55.752, 37.6175],
    ['Pyramids of Giza', 29.9792, 31.1342], ['Burj Khalifa', 25.1972, 55.2744], ['Palm Jumeirah', 25.1124, 55.139], ['Sheikh Zayed Mosque', 24.4128, 54.4749], ['Petra', 30.3285, 35.4444],
    ['Taj Mahal', 27.1751, 78.0421], ['Mount Everest', 27.9881, 86.925], ['Marina Bay Sands', 1.2834, 103.8607], ['Petronas Towers', 3.1579, 101.7123], ['Victoria Peak', 22.2759, 114.1455],
    ['Great Wall (Badaling)', 40.3588, 116.02], ['Mount Fuji', 35.3606, 138.7274], ['Tokyo Tower', 35.6586, 139.7454], ['Sydney Opera House', -33.8568, 151.2153], ['Uluru', -25.3444, 131.0369], ['Milford Sound', -44.6414, 167.8974],
    ['Statue of Liberty', 40.6892, -74.0445], ['Empire State Building', 40.7484, -73.9857], ['Niagara Falls', 43.0828, -79.0742], ['CN Tower', 43.6426, -79.3871], ['Washington Monument', 38.8895, -77.0353],
    ['Golden Gate Bridge', 37.8199, -122.4783], ['Alcatraz', 37.8267, -122.423], ['Hollywood Sign', 34.1341, -118.3215], ['Grand Canyon', 36.0544, -112.1401], ['Hoover Dam', 36.016, -114.7377], ['Las Vegas Strip', 36.1147, -115.1728],
    ['Half Dome', 37.7459, -119.5332], ['Space Needle', 47.6205, -122.3493], ['Mount Rainier', 46.8523, -121.7603], ['Mount Rushmore', 43.8791, -103.4591], ['Kennedy Space Center', 28.6082, -80.6041], ['Willis Tower', 41.8789, -87.6359],
    ['Diamond Head', 21.262, -157.8056], ['Christ the Redeemer', -22.9519, -43.2105], ['Sugarloaf Mountain', -22.9486, -43.1566], ['Machu Picchu', -13.1631, -72.545], ['Table Mountain', -33.9628, 18.4098],
    ['Kilimanjaro', -3.0674, 37.3556], ['Victoria Falls', -17.9243, 25.8572], ['Iguazu Falls', -25.6953, -54.4367], ['Chichén Itzá', 20.6843, -88.5678],
  ];
  const SPECIAL_TYPES = [
    { k: 'bush', ro: 'Zbor bush (pistă scurtă)', en: 'Bush flight (short strip)', icon: '🛩️', rate: 1.8 },
    { k: 'tour', ro: 'Tur turistic', en: 'Sightseeing tour', icon: '📸', rate: 1.3 },
    { k: 'skydive', ro: 'Parașutiști', en: 'Skydivers', icon: '🪂', rate: 1.2 },
    { k: 'survey', ro: 'Fotografie aeriană', en: 'Aerial survey', icon: '🗺️', rate: 1.4 },
    { k: 'sar', ro: 'Căutare și salvare', en: 'Search & rescue', icon: '🔎', rate: 1.6 },
  ];
  SPECIAL_TYPES.forEach((t) => MTYPES.push(t));
  const MACH = { bush: 'bush_pilot', tour: 'tour_guide', sar: 'sar_hero', skydive: 'skydive', survey: 'surveyor' };

  function specialOffers(here, p, light) {
    const out = []; const a0 = DB.info.get(here.apt); if (!a0) return out;
    const ci = acClass(), cruise = Math.max(80, p.cruiseKt), locked = !classAllowed(ci);
    const r10 = (x) => Math.round((x * payMul()) / 10) * 10;
    const dl = (nm, k) => Math.round(((nm / cruise) * 60 + 20) * k);
    const mk = (o) => Object.assign({ id: rid(), from: here.apt, locked }, o);
    // bush: pistă scurtă (doar avioane ușoare)
    if (light) {
      const c = [];
      for (const s of DB.search) {
        const a = s.a; if (a.type !== 'small_airport' || !a.maxLen || a.maxLen < 700 || a.maxLen > 2700 || a.apt === here.apt) continue;
        const d = distM(a0.lat, a0.lon, a.lat, a.lon) / NM; if (d < 15 || d > 110) continue;
        c.push({ a, d });
      }
      if (c.length) {
        const pick = c[Math.floor(Math.random() * c.length)];
        out.push(mk({ type: 'bush', to: pick.a.apt, nm: Math.round(pick.d), isPax: true, load: Math.max(1, Math.round(p.seats * 0.6)), pay: r10((350 + pick.d * 10) * 1.8), deadlineMin: dl(pick.d, 1.7), stripFt: Math.round(pick.a.maxLen) }));
      }
    }
    // tur turistic: survolezi obiective celebre și te întorci
    const R = light ? 60 : 140;
    let lm = LANDMARKS.map(([n, la, lo]) => ({ n, la, lo, d: distM(a0.lat, a0.lon, la, lo) / NM })).filter((x) => x.d <= R && x.d > 2);
    if (lm.length) {
      lm = lm.sort(() => Math.random() - 0.5).slice(0, 3);
      const ord = []; let cur = { la: a0.lat, lo: a0.lon }, nm = 0;
      while (lm.length) { lm.sort((x, y) => distM(cur.la, cur.lo, x.la, x.lo) - distM(cur.la, cur.lo, y.la, y.lo)); const nx = lm.shift(); nm += distM(cur.la, cur.lo, nx.la, nx.lo) / NM; ord.push(nx); cur = nx; }
      nm += distM(cur.la, cur.lo, a0.lat, a0.lon) / NM;
      const maxAgl = light ? 3000 : 6000;
      out.push(mk({ type: 'tour', to: here.apt, nm: Math.round(nm), isPax: true, load: Math.max(1, Math.round(p.seats * 0.8)), pay: r10((300 + nm * (light ? 8 : 14) + 300 * ord.length) * 1.3), deadlineMin: dl(nm, 1.8),
        points: ord.map((x) => ({ kind: 'pass', name: x.n, lat: x.la, lon: x.lo, r: light ? 1.5 : 2.5, maxAgl })) }));
    }
    // parașutiști: urci deasupra aeroportului și lansezi
    if (ci <= 2) {
      const alt = Math.round(((a0.elevFt || 0) + (light ? 8000 : 10000)) / 500) * 500;
      out.push(mk({ type: 'skydive', to: here.apt, nm: 10, isPax: true, load: Math.max(1, Math.min(p.seats, 15)), pay: r10(450 + alt / 12), deadlineMin: light ? 55 : 40,
        points: [{ kind: 'drop', name: L('Zona de salt', 'Drop zone') + ' ' + here.apt, lat: a0.lat, lon: a0.lon, r: 1.5, minAlt: alt, maxKt: light ? 120 : 160 }] }));
    }
    // fotografie aeriană: trei puncte în linie, la altitudine exactă
    {
      const brg = Math.random() * 360, leg = light ? 10 : 25, start = light ? 8 : 20;
      const alt = Math.round(((a0.elevFt || 0) + (light ? 3000 : 9000)) / 500) * 500;
      const pts = [];
      for (let i = 0; i < 3; i++) { const [la, lo] = destPoint(a0.lat, a0.lon, brg, (start + leg * i) * NM); pts.push({ kind: 'survey', name: L('Fotografia', 'Photo') + ' ' + (i + 1) + '/3', lat: la, lon: lo, r: light ? 0.8 : 1.5, altFt: alt, tol: light ? 250 : 400 }); }
      const nm = (start + leg * 2) * 2;
      out.push(mk({ type: 'survey', to: here.apt, nm, isPax: false, load: light ? 60 : 400, pay: r10((400 + nm * (light ? 9 : 15)) * 1.4), deadlineMin: dl(nm, 1.9), points: pts }));
    }
    // căutare și salvare: găsește naufragiatul în zonă, apoi aterizează pe orice aeroport
    {
      const brg = Math.random() * 360, d = light ? 12 + Math.random() * 20 : 25 + Math.random() * 35;
      const [tla, tlo] = destPoint(a0.lat, a0.lon, brg, d * NM);
      const [zla, zlo] = destPoint(tla, tlo, Math.random() * 360, Math.random() * 3 * NM);
      const nm = Math.round(d * 2 + 10);
      out.push(mk({ type: 'sar', to: here.apt, anyApt: true, nm, isPax: false, load: light ? 50 : 300, pay: r10((700 + nm * (light ? 10 : 16)) * 1.6), deadlineMin: dl(nm, 2.2) + 10,
        points: [{ kind: 'search', name: L('Zona de căutare', 'Search zone'), lat: zla, lon: zlo, zoneNm: 5, tLat: tla, tLon: tlo, r: 0.7, maxAgl: light ? 2000 : 3500 }] }));
    }
    return out.sort(() => Math.random() - 0.5).slice(0, light ? 4 : 3);
  }

  const nextPoint = () => (MISSION && MISSION.points ? MISSION.points[MISSION.pIdx || 0] || null : null);
  function pointsTick() {
    const m = MISSION; const pt = nextPoint();
    if (!pt || m.state !== 'flying' || sim.onGround()) return;
    const [lat, lon, altM] = sim.lla(), v = sim.v();
    const tla = pt.kind === 'search' ? pt.tLat : pt.lat, tlo = pt.kind === 'search' ? pt.tLon : pt.lon;
    if (m.steer && geofs.autopilot.on && Date.now() - (m.steerT || 0) > 2000) { m.steerT = Date.now(); geofs.autopilot.setCourse(Math.round(norm360(bearing(lat, lon, pt.lat, pt.lon))), true); }
    const d = distM(lat, lon, tla, tlo) / NM;
    if (d > pt.r) return;
    const agl = v.haglFeet || 0, altFt = altM / FT, kias = v.kias || 0;
    const nag = (msg) => { if (Date.now() - (m.nagT || 0) > 12000) { m.nagT = Date.now(); ui.toast(msg, 6000); say(pt.kind === 'drop' ? 'Not yet' : 'Check altitude', 0); } };
    if (pt.maxAgl && agl > pt.maxAgl) return nag(L(`Prea sus pentru ${pt.name} – coboară sub ${pt.maxAgl} ft deasupra solului.`, `Too high for ${pt.name} – descend below ${pt.maxAgl} ft above ground.`));
    if (pt.minAlt && altFt < pt.minAlt - 100) return nag(L(`Urcă la ${pt.minAlt} ft (acum ${Math.round(altFt)} ft) pentru salt.`, `Climb to ${pt.minAlt} ft (now ${Math.round(altFt)} ft) for the jump.`));
    if (pt.maxKt && kias > pt.maxKt) return nag(L(`Redu viteza sub ${pt.maxKt} kt pentru salt.`, `Slow below ${pt.maxKt} kt for the jump.`));
    pt.done = Date.now();
    m.pIdx = (m.pIdx || 0) + 1;
    let msg;
    if (pt.kind === 'pass') { msg = L(`📸 ${pt.name} – pasagerii fac poze!`, `📸 ${pt.name} – the passengers are taking photos!`); say('Sightseeing point reached', 0); }
    else if (pt.kind === 'drop') { msg = L('🪂 Parașutiștii au sărit! Coboară și aterizează.', '🪂 Jumpers away! Descend and land.'); say('Jumpers away', 0); }
    else if (pt.kind === 'survey') {
      pt.dev = Math.round(Math.abs(altFt - pt.altFt));
      msg = pt.dev <= pt.tol ? L(`📷 ${pt.name} – fotografie bună (abatere ${pt.dev} ft).`, `📷 ${pt.name} – good photo (off by ${pt.dev} ft).`)
        : L(`📷 ${pt.name} – fotografie neclară: erai la ${pt.dev} ft de altitudinea cerută.`, `📷 ${pt.name} – blurry photo: you were ${pt.dev} ft off the required altitude.`);
      say('Photo taken', 0);
    } else { msg = L('🛟 L-ai găsit! Echipa de salvare e pe drum. Aterizează pe cel mai apropiat aeroport.', '🛟 Survivor found! The rescue team is on the way. Land at the nearest airport.'); say('Survivor found', 0); }
    if (m.pIdx >= m.points.length) {
      m.steer = false;
      if (!m.anyApt) setSingleDestination(m.to);
      else { const n = nearestAirports(lat, lon, 1)[0]; if (n) setSingleDestination(n.apt); }
      msg += ' ' + L('Toate sarcinile sunt gata – aterizează.', 'All tasks done – go and land.');
    }
    ui.toast(msg, 9000);
    saveMission(); drawMissionMarks(); ui.renderMissions && ui.renderMissions();
  }
  function pointLine() {
    const pt = nextPoint(); if (!pt || MISSION.state === 'boarding') return null;
    const [lat, lon, altM] = sim.lla(); const altFt = Math.round(altM / FT);
    const d = distM(lat, lon, pt.lat, pt.lon) / NM, brg = pad3(Math.round(norm360(bearing(lat, lon, pt.lat, pt.lon))));
    const k = `${MISSION.pIdx + 1}/${MISSION.points.length}`;
    if (pt.kind === 'search') {
      if (d > pt.zoneNm) return [L(`🔎 Zona de căutare: ${d.toFixed(1)} NM · ${brg}° · caută sub ${pt.maxAgl} ft AGL`, `🔎 Search zone: ${d.toFixed(1)} NM · ${brg}° · search below ${pt.maxAgl} ft AGL`), 'h'];
      const dt = distM(lat, lon, pt.tLat, pt.tLon) / NM;
      const bars = dt < 1.5 ? 5 : dt < 2.5 ? 4 : dt < 3.5 ? 3 : dt < 5 ? 2 : 1;
      return [L(`🔎 Semnal ${'▮'.repeat(bars)}${'▯'.repeat(5 - bars)} – zboară în cercuri; semnalul crește când te apropii`, `🔎 Signal ${'▮'.repeat(bars)}${'▯'.repeat(5 - bars)} – fly search patterns; the signal grows as you get closer`), 'h'];
    }
    if (pt.kind === 'drop') return [L(`🪂 Zona de salt: ${d.toFixed(1)} NM · ${brg}° · urcă la ${pt.minAlt} ft (acum ${altFt}) · sub ${pt.maxKt} kt`, `🪂 Drop zone: ${d.toFixed(1)} NM · ${brg}° · climb to ${pt.minAlt} ft (now ${altFt}) · below ${pt.maxKt} kt`), 'h'];
    if (pt.kind === 'survey') return [L(`📷 ${pt.name}: ${d.toFixed(1)} NM · ${brg}° · ține ${pt.altFt} ft ±${pt.tol} (acum ${altFt})`, `📷 ${pt.name}: ${d.toFixed(1)} NM · ${brg}° · hold ${pt.altFt} ft ±${pt.tol} (now ${altFt})`), 'h'];
    return [L(`📸 ${k} ${pt.name}: ${d.toFixed(1)} NM · ${brg}° · sub ${pt.maxAgl} ft AGL`, `📸 ${k} ${pt.name}: ${d.toFixed(1)} NM · ${brg}° · below ${pt.maxAgl} ft AGL`), 'h'];
  }
  /** Punctajul special al misiunilor noi (adăugat la plată). */
  function specialScoring(m, landing, notes) {
    let add = 0;
    if (m.type === 'survey' && m.points) {
      const devs = m.points.map((p) => p.dev || 0), avg = devs.reduce((s, x) => s + x, 0) / devs.length;
      const bad = m.points.filter((p) => (p.dev || 0) > p.tol).length;
      if (!bad && avg <= 100) { add += Math.round(m.pay * 0.25); notes.push(L(`+25% fotografii perfecte (abatere medie ${Math.round(avg)} ft)`, `+25% perfect photos (average ${Math.round(avg)} ft off)`)); }
      else if (!bad) { add += Math.round(m.pay * 0.1); notes.push(L('+10% toate fotografiile bune', '+10% all photos usable')); }
      if (bad) { add -= Math.round(m.pay * 0.15 * bad); notes.push(L(`−${15 * bad}% fotografii neclare (${bad})`, `−${15 * bad}% blurry photos (${bad})`)); }
    }
    if (m.type === 'bush' && landing && landing.score >= 70) { add += Math.round(m.pay * 0.2); notes.push(L('+20% aterizare precisă pe pistă scurtă', '+20% precise short-field landing')); }
    if (m.type === 'sar') { add += 300; notes.push(L('+$300 supraviețuitor salvat 🛟', '+$300 survivor rescued 🛟')); }
    if (m.type === 'tour' && (m.maxBank || 0) <= 30) { add += Math.round(m.pay * 0.1); notes.push(L('+10% zbor lin pentru turiști', '+10% smooth flight for the tourists')); }
    if (AIR && (m.from === AIR.hub || m.to === AIR.hub)) { add += Math.round(m.pay * 0.1); notes.push(L(`+10% bonus hub ${AIR.code || ''}`, `+10% ${AIR.code || ''} hub bonus`)); }
    return add;
  }
  // marcaje pe hartă (Cesium) pentru punctele misiunii
  const MENT = [];
  function drawMissionMarks() {
    try {
      const v = geofs.api.viewer; if (!v || !window.Cesium) return;
      MENT.splice(0).forEach((e) => { try { v.entities.remove(e); } catch (x) { /* */ } });
      if (!MISSION || !MISSION.points) return;
      MISSION.points.forEach((pt, i) => {
        if (pt.done) return;
        const next = i === (MISSION.pIdx || 0);
        const col = next ? Cesium.Color.GOLD : Cesium.Color.WHITE.withAlpha(0.7);
        if (pt.kind === 'search') {
          MENT.push(v.entities.add({ position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, 0), ellipse: { semiMajorAxis: pt.zoneNm * NM, semiMinorAxis: pt.zoneNm * NM, material: Cesium.Color.YELLOW.withAlpha(0.18), outline: true, outlineColor: Cesium.Color.YELLOW, height: 0 } }));
        }
        const h = (pt.altFt || pt.minAlt || 2500) * FT;
        MENT.push(v.entities.add({ position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, h), point: { pixelSize: next ? 14 : 9, color: col, outlineColor: Cesium.Color.BLACK, outlineWidth: 2 },
          label: { text: pt.name, font: '14px sans-serif', fillColor: col, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -20) } }));
        MENT.push(v.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights([pt.lon, pt.lat, 0, pt.lon, pt.lat, h]), width: 2, material: col } }));
      });
    } catch (e) { console.warn('[GeoFS Copilot] marks', e); }
  }
  /** Punctele misiunii pe harta mobilă. */
  function ndMissionMarks(x, toXY, sc) {
    if (!MISSION || !MISSION.points) return;
    MISSION.points.forEach((pt, i) => {
      if (pt.done) return;
      const [px, py] = toXY(pt.lat, pt.lon); const next = i === (MISSION.pIdx || 0);
      x.save();
      if (pt.kind === 'search') { x.strokeStyle = 'rgba(255,235,59,.8)'; x.setLineDash([5, 4]); x.lineWidth = 1.5; x.beginPath(); x.arc(px, py, pt.zoneNm * NM * sc, 0, 7); x.stroke(); x.setLineDash([]); }
      x.fillStyle = next ? '#ffd54f' : 'rgba(255,255,255,.6)'; x.strokeStyle = '#000'; x.lineWidth = 1.5;
      x.beginPath(); x.moveTo(px, py - 7); x.lineTo(px + 6, py); x.lineTo(px, py + 7); x.lineTo(px - 6, py); x.closePath(); x.fill(); x.stroke();
      x.font = '11px sans-serif'; x.fillText(pt.kind === 'search' ? '?' : pt.name.slice(0, 18), px + 9, py + 4);
      x.restore();
    });
  }

  /* ---------------- Compania aeriană ---------------- */
  const AC_PRICE = [25000, 80000, 250000, 650000, 1600000, 3800000];
  const AC_RANGE = [350, 800, 1600, 3200, 7500, 8000];
  const AIR_COST = 25000, AIR_MIN_RANK = 2, AIR_MAX_FLEET = 20;
  let AIR = store.get('geofsCopilotRO.airline', null);
  function airValue() { return AIR ? Math.round(AIR.fleet.reduce((s, a) => s + AC_PRICE[a.cls] * 0.8, 0) + AIR.fleet.filter((a) => a.route).length * 5000) : 0; }
  function saveAir() { if (AIR) AIR.value = airValue(); store.set('geofsCopilotRO.airline', AIR); if (window.__gcrDirty) window.__gcrDirty(); }
  function acRate(a) { // profit pe oră al unui avion
    const maint = AC_PRICE[a.cls] * 0.0006;
    if (!a.route) return -maint;
    const f = 0.75 + 0.5 * Math.min(1, (a.routeNm || 0) / (AC_RANGE[a.cls] * 0.45));
    const rep = 0.6 + (AIR.rep == null ? 50 : AIR.rep) / 125;
    return AC_PRICE[a.cls] * 0.0045 * f * rep - maint;
  }
  const airRate = () => (AIR ? AIR.fleet.reduce((s, a) => s + acRate(a), 0) : 0);
  const airHours = () => (AIR ? clamp((Date.now() - (AIR.lastCollect || Date.now())) / 3600000, 0, 24) : 0);
  const airPending = () => Math.round(airRate() * airHours());
  function airCollect(silent) {
    if (!AIR) return 0;
    const amt = airPending();
    ECON.balance += amt; AIR.earned = (AIR.earned || 0) + amt; AIR.lastCollect = Date.now();
    saveEcon(); saveAir();
    if (!silent && amt) ui.toast(amt >= 0 ? L(`🏢 Ai încasat ${money(amt)} de la compania ta.`, `🏢 You collected ${money(amt)} from your airline.`) : L(`🏢 Costuri de întreținere: ${money(amt)} (avioane fără rută).`, `🏢 Maintenance costs: ${money(amt)} (aircraft without a route).`), 6000);
    return amt;
  }
  function airPioneered() { // destinații zburate de la/spre hub
    if (!AIR) return [];
    const set = new Set(AIR.pioneer || []);
    LOGB.list.forEach((f) => { if (f.dep === AIR.hub && f.arr && f.arr !== AIR.hub) set.add(f.arr); if (f.arr === AIR.hub && f.dep && f.dep !== AIR.hub) set.add(f.dep); });
    return [...set];
  }
  function foundAirline(name, code) {
    name = String(name || '').replace(/[<>"'&]/g, '').trim().slice(0, 30); code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    if (rankIdx() < AIR_MIN_RANK) { ui.toast(L(`Ai nevoie de rangul ${rankName(AIR_MIN_RANK)} ca să înființezi o companie.`, `You need the rank ${rankName(AIR_MIN_RANK)} to found an airline.`)); return; }
    if (name.length < 3 || code.length < 2) { ui.toast(L('Alege un nume (min. 3 litere) și un cod de 2–3 litere.', 'Pick a name (at least 3 letters) and a 2–3 letter code.')); return; }
    if (ECON.balance < AIR_COST) { ui.toast(L(`Înființarea costă ${money(AIR_COST)}.`, `Founding costs ${money(AIR_COST)}.`)); return; }
    const [lat, lon] = sim.lla(); const here = DB.loaded ? nearestAirports(lat, lon, 1)[0] : null;
    if (!here || here.d > 4 * NM || !sim.onGround()) { ui.toast(L('Trebuie să fii la sol pe aeroportul care va fi hub-ul companiei.', 'You must be on the ground at the airport that will be your hub.')); return; }
    ECON.balance -= AIR_COST; saveEcon();
    AIR = { name, code, hub: here.apt, founded: utcDay(), fleet: [], rep: 60, earned: 0, lastCollect: Date.now(), pioneer: [] };
    AIR.pioneer = airPioneered();
    saveAir(); unlock('airline');
    ui.toast(L(`🏢 ${name} (${code}) a fost înființată, cu hub la ${aptName(here.apt)}! Cumpără primul avion.`, `🏢 ${name} (${code}) founded, hub at ${aptName(here.apt)}! Buy your first aircraft.`), 9000);
    ui.renderAirline && ui.renderAirline();
  }
  function buyAircraft(cls) {
    if (!AIR) return;
    if (AIR.fleet.length >= AIR_MAX_FLEET) { ui.toast(L('Flota a ajuns la maximum.', 'Your fleet is at the maximum size.')); return; }
    if (!classAllowed(cls)) { ui.toast(L('Ai nevoie de licența de tip pentru clasa asta (tab-ul Carieră).', 'You need the type rating for this class (Career tab).')); return; }
    if (ECON.balance < AC_PRICE[cls]) { ui.toast(L(`Costă ${money(AC_PRICE[cls])} – nu ai destui bani.`, `It costs ${money(AC_PRICE[cls])} – not enough money.`)); return; }
    airCollect(true);
    ECON.balance -= AC_PRICE[cls]; saveEcon();
    const type = acClass() === cls ? acName() : L(CLASSES[cls].ro, CLASSES[cls].en);
    AIR.fleet.push({ id: rid(), cls, type, reg: `${AIR.code}-${String(AIR.fleet.length + 1).padStart(2, '0')}`, t: Date.now(), route: null, routeNm: 0 });
    saveAir();
    if (AIR.fleet.length >= 5) unlock('fleet5');
    ui.toast(L(`✈ Avion nou în flotă: ${type}. Dă-i o rută ca să aducă bani.`, `✈ New aircraft in your fleet: ${type}. Give it a route so it earns money.`), 7000);
    ui.renderAirline && ui.renderAirline();
  }
  function sellAircraft(id) {
    const i = AIR ? AIR.fleet.findIndex((a) => a.id === id) : -1; if (i < 0) return;
    airCollect(true);
    const a = AIR.fleet[i], back = Math.round(AC_PRICE[a.cls] * 0.6);
    AIR.fleet.splice(i, 1); ECON.balance += back; saveEcon(); saveAir();
    ui.toast(L(`Avion vândut cu ${money(back)}.`, `Aircraft sold for ${money(back)}.`));
    ui.renderAirline && ui.renderAirline();
  }
  function setRoute(id, dest) {
    const a = AIR && AIR.fleet.find((x) => x.id === id); if (!a) return;
    airCollect(true);
    const h = DB.info.get(AIR.hub), d = dest && DB.info.get(dest);
    a.route = dest || null; a.routeNm = h && d ? Math.round(distM(h.lat, h.lon, d.lat, d.lon) / NM) : 0;
    saveAir(); ui.renderAirline && ui.renderAirline();
  }
  function airOnFlight(rec) {
    if (!AIR) return;
    let route = null;
    if (rec.dep === AIR.hub && rec.arr && rec.arr !== AIR.hub) route = rec.arr;
    if (rec.arr === AIR.hub && rec.dep && rec.dep !== AIR.hub) route = rec.dep;
    AIR.pioneer = AIR.pioneer || [];
    if (route && !AIR.pioneer.includes(route)) {
      AIR.pioneer.push(route); saveAir();
      setTimeout(() => ui.toast(L(`🏢 Rută nouă deblocată pentru ${AIR.name}: ${AIR.hub} ↔ ${route}. O poți da unui avion din tab-ul Companie.`, `🏢 New route unlocked for ${AIR.name}: ${AIR.hub} ↔ ${route}. Assign it to an aircraft in the Airline tab.`), 8000), 20000);
    }
  }
  function airOnMission(score, ok) {
    if (!AIR) return;
    AIR.rep = clamp(ok ? (AIR.rep == null ? 50 : AIR.rep) * 0.85 + (score == null ? 60 : score) * 0.15 : (AIR.rep || 50) - 5, 0, 100);
    saveAir();
  }
  setTimeout(() => {
    if (AIR && airHours() >= 1 && airPending() > 0) ui.toast(L(`🏢 ${AIR.name} a câștigat ${money(airPending())} cât ai lipsit. Încasează în tab-ul Companie${airHours() >= 24 ? ' – depozitul e plin, revino zilnic!' : '.'}`, `🏢 ${AIR.name} earned ${money(airPending())} while you were away. Collect it in the Airline tab${airHours() >= 24 ? ' – storage is full, come back daily!' : '.'}`), 10000);
  }, 25000);

  /** Apelată la sfârșitul fiecărui zbor: pașaport, companie, date pentru server. */
  function onFlightFinished(rec) {
    [['dep', rec.dep], ['arr', rec.arr]].forEach(([k, icao]) => {
      const a = icao && DB.info.get(icao);
      if (a) { rec[k + '_country'] = a.country || null; rec[k + '_lat'] = +a.lat.toFixed(4); rec[k + '_lon'] = +a.lon.toFixed(4); }
    });
    passAdd(rec.dep, rec.t);
    const st = rec.arr && passAdd(rec.arr, rec.t);
    savePass();
    if (st) setTimeout(() => ui.toast(st.newCountry ? L(`🛂 Țară nouă în pașaport: ${flagOf(st.newCountry)} ${countryName(st.newCountry)}! (${passStats().countries} țări)`, `🛂 New country in your passport: ${flagOf(st.newCountry)} ${countryName(st.newCountry)}! (${passStats().countries} countries)`)
      : L(`🛂 Aeroport nou în pașaport: ${aptName(rec.arr)} (${passStats().airports} aeroporturi)`, `🛂 New airport stamped: ${aptName(rec.arr)} (${passStats().airports} airports)`), 7000), 16000);
    airOnFlight(rec);
  }
  function checkAchievements18() {
    const ps = passStats();
    if (ps.airports >= 10) unlock('explorer10');
    if (ps.airports >= 25) unlock('explorer25');
    if (ps.airports >= 50) unlock('airports50');
    if (ps.countries >= 5) unlock('countries5');
    if (ps.countries >= 15) unlock('countries15');
    if (ps.countries >= 30) unlock('countries30');
    const s = streakNow(); if (s.best >= 7) unlock('streak7'); if (s.best >= 30) unlock('streak30');
    if (AIR) { unlock('airline'); if (AIR.fleet.length >= 5) unlock('fleet5'); }
  }

  /* ---------------- Interfață: secțiunile noi din Carieră și tab-ul Companie ---------------- */
  function careerExtras() {
    const out = [];
    const ps = passStats(), st = streakNow();
    // serie
    out.push(el('div', { class: 'gcr-item', style: 'margin-top:6px' }, el('span', {}, `🔥 ${L('Serie', 'Streak')}: `, el('b', {}, `${st.n} ${L(st.n === 1 ? 'zi' : 'zile', st.n === 1 ? 'day' : 'days')}`), el('span', { class: 'gcr-muted' }, ` · ${L('record', 'best')} ${st.best}`)),
      el('span', { class: 'gcr-muted' }, st.today ? L('✓ ai zburat azi', '✓ flown today') : L(`zboară azi: +${10 * Math.min(st.n + 1, 7)} XP`, `fly today: +${10 * Math.min(st.n + 1, 7)} XP`))));
    // pașaport
    const pass = el('div', { class: 'gcr-fuel', style: 'margin-top:8px' });
    const flags = Object.entries(ps.byC).sort((a, b) => b[1] - a[1]).map(([c, n]) => el('span', { title: `${countryName(c)}: ${n}`, style: 'font-size:18px;margin-right:2px;cursor:default' }, flagOf(c)));
    pass.append(el('div', { class: 'gcr-row', style: 'justify-content:space-between' }, el('b', {}, `🛂 ${L('Pașaport', 'Passport')}`),
        CAREER.pilotId ? el('a', { href: `${ONLINE.site}#/pilot/${CAREER.pilotId}`, target: '_blank', rel: 'noopener', class: 'gcr-link' }, L('harta ta pe site →', 'your map on the website →')) : null),
      el('div', {}, el('b', {}, String(ps.airports)), ` ${L('aeroporturi', 'airports')} · `, el('b', {}, String(ps.countries)), ` ${L('țări', 'countries')} `, el('span', { class: 'gcr-muted' }, `(${Math.round((ps.countries / 195) * 100)}% ${L('din lume', 'of the world')})`)),
      flags.length ? el('div', { style: 'margin-top:4px;line-height:1.5' }, ...flags) : el('div', { class: 'gcr-muted' }, L('Aterizează pe aeroporturi noi ca să-ți umpli pașaportul.', 'Land at new airports to fill your passport.')));
    out.push(pass);
    // concurs de aterizare
    if (settings.onlineSync) {
      loadContest();
      const c = CONTEST.data, lb = el('div', { class: 'gcr-list', style: 'max-height:none' });
      if (!c) lb.append(el('div', { class: 'gcr-item gcr-muted' }, CONTEST.err ? L('Concursul nu s-a putut încărca.', 'The contest could not be loaded.') : '…'));
      else if (!c.board.length) lb.append(el('div', { class: 'gcr-item gcr-muted' }, L('Nicio aterizare săptămâna asta – fii primul!', 'No landings this week yet – be the first!')));
      else c.board.slice(0, 5).forEach((x) => lb.append(el('div', { class: 'gcr-item' + (x.pilot_id === CAREER.pilotId ? ' sel' : '') },
        el('span', {}, el('b', {}, `${['🥇', '🥈', '🥉'][x.pos - 1] || '#' + x.pos} `), x.callsign), el('span', { class: 'gcr-muted' }, `${x.score} · ${x.vs} fpm · ${x.arr || ''}`))));
      const me = c && c.board.find((x) => x.pilot_id === CAREER.pilotId);
      const daysLeft = c ? Math.max(0, Math.ceil((Date.parse(c.week_end + 'T23:59:59Z') - Date.now()) / 86400000)) : null;
      out.push(el('div', { class: 'gcr-row', style: 'margin-top:8px;justify-content:space-between' }, el('b', {}, `🧈 ${L('Concursul de aterizare al săptămânii', 'Weekly landing contest')}`),
        el('a', { href: ONLINE.site + '#/contest', target: '_blank', rel: 'noopener', class: 'gcr-link' }, L('tot clasamentul →', 'full ranking →'))), lb,
      el('div', { class: 'gcr-muted' }, (me ? L(`Locul tău: #${me.pos} (scor ${me.score}). `, `Your place: #${me.pos} (score ${me.score}). `) : L('Cea mai bună aterizare a ta din săptămână intră automat. ', 'Your best landing of the week enters automatically. ')) +
        (daysLeft != null ? L(`Se termină în ${daysLeft} zile · primii 3 primesc insigna Podium.`, `Ends in ${daysLeft} days · top 3 earn the Podium badge.`) : '')));
    }
    return out;
  }
  function buildAirlinePage(p) {
    const box = el('div'); p.append(box); ui.airBox = box;
    ui.renderAirline = () => {
      box.innerHTML = '';
      if (!AIR) {
        const ok = rankIdx() >= AIR_MIN_RANK;
        const name = el('input', { placeholder: L('Numele companiei (ex. Carpatair Virtual)', 'Airline name (e.g. Alpine Virtual)'), style: 'flex:1;min-width:0', maxlength: 30 });
        const code = el('input', { placeholder: L('Cod', 'Code'), style: 'width:60px', maxlength: 3 });
        box.append(el('div', { class: 'gcr-destcard', style: 'margin-top:0' },
          el('div', { style: 'font-size:15px;font-weight:800' }, '🏢 ' + L('Înființează-ți compania aeriană', 'Found your own airline')),
          el('div', { class: 'gcr-muted', style: 'margin:4px 0' }, L('Cumperi avioane, le dai rute de la hub-ul tău, iar ele aduc bani și când nu zbori. Rutele se deblochează zburând tu primul pe ele. Câștigurile se adună până la 24 de ore – revino zilnic să le încasezi. Aterizările bune îți cresc reputația, iar reputația crește veniturile.',
            'Buy aircraft, give them routes from your hub, and they earn money even when you are not flying. You unlock routes by flying them yourself first. Earnings pile up for up to 24 hours – come back daily to collect. Good landings raise your reputation, and reputation raises income.')),
          el('div', {}, `${L('Cost', 'Cost')}: `, el('b', {}, money(AIR_COST)), ` · ${L('rang minim', 'minimum rank')}: `, el('b', { style: ok ? '' : 'color:#ff8a80' }, rankName(AIR_MIN_RANK)), ` · ${L('hub', 'hub')}: ${L('aeroportul pe care ești acum', 'the airport you are at now')}`),
          el('div', { class: 'gcr-row', style: 'margin-top:6px' }, name, code, el('button', { class: 'gcr-btn sm ok', onclick: () => foundAirline(name.value, code.value) }, L('Înființează', 'Found')))));
        box.append(airlinesBoard());
        return;
      }
      const pend = airPending(), rate = airRate(), hrs = airHours();
      box.append(el('div', { class: 'gcr-destcard', style: 'margin-top:0' },
        el('div', { class: 'gcr-muted', style: 'font-size:11px' }, `${L('COMPANIA TA', 'YOUR AIRLINE')} · ${L('înființată', 'founded')} ${AIR.founded}`),
        el('div', { style: 'font-size:16px;font-weight:800' }, `🏢 ${AIR.name} (${AIR.code})`),
        el('div', {}, `${L('Hub', 'Hub')}: ${aptName(AIR.hub)} (${AIR.hub}) · ${L('reputație', 'reputation')} `, el('b', {}, `${Math.round(AIR.rep == null ? 50 : AIR.rep)}/100`), ` · ${L('valoare', 'value')} ${money(airValue())}`),
        el('div', { class: 'gcr-bar', style: 'margin:6px 0 3px' }, el('div', { style: `width:${Math.round((hrs / 24) * 100)}%;background:${hrs >= 24 ? '#ff9100' : '#4cff8f'}` })),
        el('div', {}, `${L('De încasat', 'Ready to collect')}: `, el('b', { style: `color:${pend >= 0 ? '#4cff8f' : '#ff8a80'}` }, money(pend)), el('span', { class: 'gcr-muted' }, ` · ${money(rate)}/h · ${hrs.toFixed(1)}/24 h${hrs >= 24 ? L(' – PLIN', ' – FULL') : ''}`)),
        el('div', { class: 'gcr-row' }, el('button', { class: 'gcr-btn sm ok', onclick: () => { airCollect(); ui.renderAirline(); ui.renderMissions && ui.renderMissions(); } }, '💰 ' + L('Încasează', 'Collect')),
          el('span', { class: 'gcr-muted' }, `${L('Total câștigat', 'Total earned')}: ${money(AIR.earned || 0)} · ${L('sold', 'balance')} ${money(ECON.balance)}`))));
      // flota
      const dests = airPioneered();
      const fleet = el('div', { class: 'gcr-list', style: 'max-height:none' });
      if (!AIR.fleet.length) fleet.append(el('div', { class: 'gcr-item gcr-muted' }, L('Nu ai încă avioane. Cumpără unul mai jos.', 'No aircraft yet. Buy one below.')));
      AIR.fleet.forEach((a) => {
        const inRange = dests.filter((d) => { const h = DB.info.get(AIR.hub), x = DB.info.get(d); if (!h || !x) return true; const nm = distM(h.lat, h.lon, x.lat, x.lon) / NM; return nm >= 30 && nm <= AC_RANGE[a.cls]; });
        const sel = el('select', { style: 'max-width:150px' }, el('option', { value: '' }, L('— parcat —', '— parked —')), ...inRange.map((d) => el('option', { value: d }, `${d} · ${DB.loaded ? aptName(d) : ''}`)));
        sel.value = a.route || '';
        sel.addEventListener('change', () => setRoute(a.id, sel.value));
        const r = acRate(a);
        fleet.append(el('div', { class: 'gcr-item' },
          el('div', { style: 'flex:1;min-width:0' }, el('b', {}, `${a.reg} `), a.type, el('div', { class: 'gcr-muted', style: 'font-size:11px' },
            `${L(CLASSES[a.cls].ro, CLASSES[a.cls].en)} · ${L('rază', 'range')} ${AC_RANGE[a.cls]} NM` + (a.route ? ` · ${AIR.hub}↔${a.route} ${a.routeNm} NM` : '') + ` · ${money(r)}/h`)),
          el('div', { style: 'text-align:right' }, sel, el('br'), el('button', { class: 'gcr-btn sm warn', onclick: () => { if (confirmSell(a)) sellAircraft(a.id); } }, L('Vinde', 'Sell') + ' ' + money(AC_PRICE[a.cls] * 0.6)))));
      });
      box.append(el('b', { style: 'display:block;margin-top:8px' }, `✈ ${L('Flota', 'Fleet')} ${AIR.fleet.length}/${AIR_MAX_FLEET}`), fleet,
        el('div', { class: 'gcr-muted' }, dests.length ? L(`Rute deblocate de la hub: ${dests.join(', ')}`, `Routes unlocked from the hub: ${dests.join(', ')}`)
          : L(`Nicio rută încă: zboară de la ${AIR.hub} la alt aeroport (sau invers) ca s-o deblochezi.`, `No routes yet: fly from ${AIR.hub} to another airport (or back) to unlock it.`)));
      // cumpără
      const shop = el('div', { class: 'gcr-list', style: 'max-height:none' });
      CLASSES.forEach((c, k) => {
        const ok = classAllowed(k);
        shop.append(el('div', { class: 'gcr-item' }, el('span', {}, (ok ? '' : '🔒 ') + L(c.ro, c.en), el('span', { class: 'gcr-muted' }, ` · ${AC_RANGE[k]} NM · ~${money(AC_PRICE[k] * 0.0045 - AC_PRICE[k] * 0.0006)}/h`)),
          el('button', { class: 'gcr-btn sm' + (ok ? ' ok' : ''), onclick: () => buyAircraft(k) }, money(AC_PRICE[k]))));
      });
      box.append(el('b', { style: 'display:block;margin-top:8px' }, L('Cumpără avioane', 'Buy aircraft')), shop,
        el('div', { class: 'gcr-muted' }, L('Avioanele fără rută costă întreținere. Misiunile care pleacă sau ajung la hub primesc +10%.', 'Aircraft without a route cost maintenance. Missions to or from your hub pay +10%.')));
      box.append(airlinesBoard());
    };
    ui.renderAirline();
  }
  function confirmSell(a) { if (a._sellAsk && Date.now() - a._sellAsk < 4000) return true; a._sellAsk = Date.now(); ui.toast(L('Apasă din nou „Vinde” ca să confirmi.', 'Press “Sell” again to confirm.')); return false; }
  const AIRLB = { t: 0, list: [] };
  function airlinesBoard() {
    const wrap = el('div');
    if (!settings.onlineSync) return wrap;
    if (Date.now() - AIRLB.t > 120000) { AIRLB.t = Date.now(); rpc('get_airlines', { p_limit: 5 }).then((l) => { AIRLB.list = Array.isArray(l) ? l : []; ui.tab === 'air' && ui.renderAirline && ui.renderAirline(); }).catch(() => { /* */ }); }
    const lb = el('div', { class: 'gcr-list', style: 'max-height:none' });
    if (!AIRLB.list.length) lb.append(el('div', { class: 'gcr-item gcr-muted' }, L('Încă nicio companie – fii prima!', 'No airlines yet – be the first!')));
    AIRLB.list.forEach((x, i) => lb.append(el('div', { class: 'gcr-item' + (x.pilot_id === CAREER.pilotId ? ' sel' : '') },
      el('span', {}, el('b', {}, `#${i + 1} `), `${x.name} (${x.code})`, el('span', { class: 'gcr-muted' }, ` · ${x.callsign} · ${x.hub}`)), el('span', { class: 'gcr-muted' }, `${x.fleet} ✈ · ${money(x.value)}`))));
    wrap.append(el('div', { class: 'gcr-row', style: 'margin-top:8px;justify-content:space-between' }, el('b', {}, '🌐 ' + L('Top companii', 'Top airlines')),
      el('a', { href: ONLINE.site + '#/airlines', target: '_blank', rel: 'noopener', class: 'gcr-link' }, L('toate →', 'all →'))), lb);
    return wrap;
  }

  /* ---------------- Notificări de la administrator (pentru toți utilizatorii) ---------------- */
  const NOTICES = { last: store.get('geofsCopilotRO.noticeLast', null), busy: false, queue: [] };
  async function pollNotices() {
    if (!settings.onlineSync || NOTICES.busy) return;
    NOTICES.busy = true;
    try {
      const list = await rpc('get_notices', { p_key: CAREER.key, p_since: NOTICES.last || 0 });
      if (Array.isArray(list) && list.length) {
        const fresh = NOTICES.last == null ? list.slice(-3) : list; // prima pornire: doar ultimele 3
        NOTICES.last = list[list.length - 1].id; store.set('geofsCopilotRO.noticeLast', NOTICES.last);
        fresh.forEach((n) => NOTICES.queue.push(n));
        showNextNotice();
      } else if (NOTICES.last == null) { NOTICES.last = 0; store.set('geofsCopilotRO.noticeLast', 0); }
    } catch (e) { /* server indisponibil */ } finally { NOTICES.busy = false; }
  }
  function showNextNotice() {
    if (document.getElementById('gcr-notice') || !NOTICES.queue.length) return;
    const n = NOTICES.queue.shift();
    const msg = el('div', { style: 'white-space:pre-wrap;font-size:14px;line-height:1.4;margin:6px 0 8px' }); msg.textContent = n.message;
    const box = el('div', { id: 'gcr-notice', style: 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:100001;max-width:460px;width:calc(100% - 40px);background:rgba(28,14,48,.97);border:2px solid #e040fb;border-radius:12px;padding:12px 14px;color:#fff;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6)' },
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, el('b', { style: 'color:#f3b6ff' }, `📢 GeoFS Copilot${n.personal ? L(' · mesaj pentru tine', ' · message for you') : ''}`), el('span', { class: 'gcr-muted', style: 'font-size:11px' }, new Date(n.at).toLocaleString())),
      msg, el('button', { class: 'gcr-btn sm ok', onclick: () => { box.remove(); showNextNotice(); } }, 'OK'));
    ['mousedown', 'pointerdown', 'wheel', 'keydown'].forEach((t) => box.addEventListener(t, (e) => e.stopPropagation()));
    document.body.append(box); say('New message', 0);
  }

  /* ---------------- Administrator ---------------- */
  async function adminCheck() {
    if (!settings.onlineSync) return;
    try {
      const r = await rpc('admin_status', { p_key: CAREER.key });
      const was = ADMIN.on; ADMIN.on = !!(r && r.admin); ADMIN.hidden = !!(r && r.hidden);
      store.set('geofsCopilotRO.admin', ADMIN.on);
      if (ADMIN.on !== was) { OFFERS.t = 0; ui.renderCareer && ui.renderCareer(); ui.renderMissions && ui.renderMissions(); }
      if (ADMIN.on && !was) ui.toast(L('🛡️ Mod administrator activ.', '🛡️ Administrator mode active.'), 6000);
    } catch (e) { /* */ }
    ui.showAdminTab && ui.showAdminTab(ADMIN.on);
    ui.renderAdminLogin && ui.renderAdminLogin();
  }
  const adminCheats = () => ADMIN.on && settings.adminCheats !== false;
  async function adminLogin(pass) {
    if (!pass) { ui.toast(L('Scrie parola.', 'Enter the password.')); return false; }
    try {
      await rpc('admin_login', { p_key: CAREER.key, p_password: pass, p_callsign: myCallsign() });
      await adminCheck();
      ui.toast(L('🛡️ Autentificat ca administrator pe acest calculator.', '🛡️ Logged in as administrator on this computer.'), 7000);
      ui.renderAdminLogin && ui.renderAdminLogin();
      return true;
    } catch (e) {
      ui.toast(L('Autentificare eșuată: ', 'Login failed: ') + (e.message === 'wrong password' ? L('parolă greșită.', 'wrong password.') : e.message), 7000);
      return false;
    }
  }
  async function adminLogout() {
    try { await rpc('admin_logout', { p_key: CAREER.key }); } catch (e) { /* */ }
    ADMIN.on = false; store.set('geofsCopilotRO.admin', false);
    ui.showAdminTab && ui.showAdminTab(false); ui.renderAdminLogin && ui.renderAdminLogin();
    OFFERS.t = 0; ui.renderCareer && ui.renderCareer();
    ui.toast(L('Ai ieșit din contul de administrator pe acest calculator.', 'Logged out of the administrator account on this computer.'));
  }
  /** Caseta discretă din Setări: autentificare de administrator cu parolă, pe orice calculator. */
  function adminLoginBox() {
    const wrap = el('div', { style: 'margin-top:10px' });
    ui.renderAdminLogin = () => {
      wrap.innerHTML = '';
      if (ADMIN.on) { wrap.append(el('div', { class: 'gcr-muted' }, '🛡️ ' + L('Administrator pe acest calculator · ', 'Administrator on this computer · '), el('a', { href: '#', class: 'gcr-link', onclick: (e) => { e.preventDefault(); adminLogout(); } }, L('ieși', 'log out')))); return; }
      const link = el('a', { href: '#', class: 'gcr-link', style: 'font-size:11px;opacity:.6' }, '🛡️ ' + L('Autentificare administrator', 'Administrator login'));
      const pass = el('input', { type: 'password', placeholder: L('Parola de administrator', 'Administrator password'), autocomplete: 'current-password', style: 'flex:1;min-width:0' });
      const row = el('div', { class: 'gcr-row', style: 'display:none' }, pass, el('button', { class: 'gcr-btn sm ok', onclick: () => adminLogin(pass.value).then((ok) => { if (ok) pass.value = ''; }) }, L('Intră', 'Log in')));
      pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') adminLogin(pass.value).then((ok) => { if (ok) pass.value = ''; }); });
      link.onclick = (e) => { e.preventDefault(); row.style.display = row.style.display === 'none' ? '' : 'none'; if (row.style.display === '') pass.focus(); };
      wrap.append(link, row);
    };
    ui.renderAdminLogin();
    return wrap;
  }
  function adminTick() {
    if (!adminCheats()) return;
    if (ECON.balance < 5e6) { ECON.balance = 1e7; saveEcon(); }
  }
  function buildAdminPage(p) {
    const box = el('div'); p.append(box);
    const A = { pilots: [], sent: [], q: '', to: '' };
    const loadPilots = async () => { try { A.pilots = await rpc('admin_pilots', { p_key: CAREER.key, p_q: A.q }) || []; } catch (e) { ui.toast('Admin: ' + e.message); } render(); };
    const loadSent = async () => { try { A.sent = await rpc('admin_list_notices', { p_key: CAREER.key }) || []; } catch (e) { /* */ } render(); };
    const msg = el('textarea', { rows: 3, maxlength: 400, placeholder: L('Mesajul tău (max. 400 caractere)…', 'Your message (max 400 characters)…'), style: 'width:100%;box-sizing:border-box;resize:vertical' });
    const search = el('input', { placeholder: L('Caută pilot după indicativ', 'Search pilot by callsign'), style: 'flex:1;min-width:0' });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { A.q = search.value.trim(); loadPilots(); } });
    const target = el('select', { style: 'flex:1;min-width:0' });
    target.addEventListener('change', () => { A.to = target.value; });
    const sentBox = el('div', { class: 'gcr-list', style: 'max-height:none' });
    const send = async () => {
      const text = msg.value.trim(); if (!text) { ui.toast(L('Scrie un mesaj.', 'Write a message.')); return; }
      const who = A.to ? (A.pilots.find((x) => x.id === A.to) || {}).callsign : L('toți jucătorii', 'all players');
      try {
        await rpc('admin_send_notice', { p_key: CAREER.key, p_to: A.to || null, p_msg: text });
        msg.value = ''; ui.toast(L(`📢 Trimis către ${who}.`, `📢 Sent to ${who}.`)); loadSent();
      } catch (e) { ui.toast(L('Nu s-a trimis: ', 'Not sent: ') + e.message, 8000); }
    };
    const pw1 = el('input', { type: 'password', placeholder: L('Parolă nouă', 'New password'), autocomplete: 'new-password', style: 'flex:1;min-width:0' });
    const pw2 = el('input', { type: 'password', placeholder: L('Repetă parola', 'Repeat password'), autocomplete: 'new-password', style: 'flex:1;min-width:0' });
    const setPw = async () => {
      if (pw1.value.length < 10) { ui.toast(L('Parola trebuie să aibă minim 10 caractere.', 'The password must be at least 10 characters.')); return; }
      if (pw1.value !== pw2.value) { ui.toast(L('Parolele nu coincid.', 'The passwords do not match.')); return; }
      try { await rpc('admin_set_password', { p_key: CAREER.key, p_new: pw1.value }); pw1.value = ''; pw2.value = ''; ui.toast(L('🔑 Parola de administrator a fost salvată.', '🔑 Administrator password saved.'), 6000); }
      catch (e) { ui.toast(L('Nu s-a salvat: ', 'Not saved: ') + e.message, 7000); }
    };
    const cheats = el('input', { type: 'checkbox' });
    cheats.addEventListener('change', () => { settings.adminCheats = cheats.checked; saveSettings(); OFFERS.t = 0; adminTick(); ui.renderCareer && ui.renderCareer(); ui.renderMissions && ui.renderMissions(); });
    function render() {
      cheats.checked = settings.adminCheats !== false;
      const cur = target.value;
      target.innerHTML = '';
      target.append(el('option', { value: '' }, '📣 ' + L('Toți jucătorii', 'All players')), ...A.pilots.filter((x) => !x.hidden).map((x) => el('option', { value: x.id }, `👤 ${x.callsign} · ${x.xp} XP · ${x.flights} ${L('zboruri', 'flights')}`)));
      target.value = A.pilots.some((x) => x.id === cur) ? cur : ''; A.to = target.value;
      sentBox.innerHTML = '';
      if (!A.sent.length) sentBox.append(el('div', { class: 'gcr-item gcr-muted' }, L('Niciun mesaj trimis.', 'No messages sent yet.')));
      A.sent.forEach((n) => {
        const t = el('span', { style: 'flex:1;min-width:0;white-space:pre-wrap' }); t.textContent = n.message;
        sentBox.append(el('div', { class: 'gcr-item' }, el('div', { style: 'flex:1;min-width:0' }, el('div', { class: 'gcr-muted', style: 'font-size:11px' }, `${new Date(n.created_at).toLocaleString()} → ${n.to_pilot ? n.to_callsign : L('toți', 'everyone')}`), t),
          el('button', { class: 'gcr-btn sm warn', title: L('Șterge (nu mai apare la cei care nu l-au văzut)', 'Delete (players who have not seen it will not get it)'), onclick: async () => { try { await rpc('admin_delete_notice', { p_key: CAREER.key, p_id: n.id }); loadSent(); } catch (e) { ui.toast(e.message); } } }, '✕')));
      });
    }
    box.append(
      el('div', { class: 'gcr-destcard', style: 'margin-top:0;border-color:#e040fb' },
        el('div', { style: 'font-size:15px;font-weight:800' }, '🛡️ ' + L('Administrator', 'Administrator')),
        el('div', { class: 'gcr-muted', style: 'margin:3px 0' }, L('Profilul tău e ascuns: nu apare în clasamente, statistici, provocarea zilei, concurs sau lista de companii.', 'Your profile is hidden: it does not appear in leaderboards, stats, the daily challenge, the contest or the airline list.')),
        el('label', {}, cheats, ' ', L('Bani nelimitați, rang maxim și toate avioanele deblocate', 'Unlimited money, top rank and every aircraft unlocked'))),
      el('b', { style: 'display:block;margin-top:10px' }, '📢 ' + L('Trimite o notificare', 'Send a notification')),
      el('div', { class: 'gcr-muted' }, L('Apare ca o fereastră în GeoFS la jucătorii cu pluginul (în cel mult un minut, sau la următoarea pornire, timp de 7 zile).', 'It pops up in GeoFS for players with the plugin (within a minute, or next time they start it, for 7 days).')),
      el('div', { class: 'gcr-row' }, search, el('button', { class: 'gcr-btn sm', onclick: () => { A.q = search.value.trim(); loadPilots(); } }, L('Caută', 'Search'))),
      el('div', { class: 'gcr-row' }, el('span', {}, L('Către:', 'To:')), target),
      msg,
      el('div', { class: 'gcr-row' }, el('button', { class: 'gcr-btn sm ok', onclick: send }, '📢 ' + L('Trimite', 'Send'))),
      el('b', { style: 'display:block;margin-top:10px' }, L('Mesaje trimise', 'Sent messages')), sentBox,
      el('b', { style: 'display:block;margin-top:12px' }, '🔑 ' + L('Parola de administrator', 'Administrator password')),
      el('div', { class: 'gcr-muted' }, L('Cu parola te poți autentifica ca admin pe orice calculator sau browser: Setări → „Autentificare administrator” (jos). Minim 10 caractere.', 'With the password you can log in as admin on any computer or browser: Settings → “Administrator login” (at the bottom). At least 10 characters.')),
      el('div', { class: 'gcr-row' }, pw1, pw2, el('button', { class: 'gcr-btn sm ok', onclick: setPw }, L('Salvează', 'Save'))),
      el('div', { class: 'gcr-row' }, el('button', { class: 'gcr-btn sm warn', onclick: adminLogout }, L('Ieși din admin pe acest calculator', 'Log out of admin on this computer'))));
    ui.renderAdmin = () => { loadPilots(); loadSent(); };
    render();
  }

  /* ---------------- Anunț de versiune nouă ---------------- */
  const UPD = { latest: null, notes: null, t: 0, src: document.documentElement.dataset.gcrSrc || 'tm' };
  const verNum = (v) => String(v || '0').split('.').map((x) => parseInt(x, 10) || 0).reduce((a, x) => a * 1000 + x, 0);
  async function checkUpdate() {
    try {
      const r = await fetch('https://raw.githubusercontent.com/razvan999x/geofs-copilot/main/version.json?t=' + Math.floor(Date.now() / 600000), { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.version || verNum(j.version) <= verNum(VERSION)) { UPD.latest = null; return; }
      UPD.latest = j.version; UPD.notes = j;
      ui.markUpdate && ui.markUpdate();
      const seen = store.get('geofsCopilotRO.updSeen', null);
      if (!seen || seen.v !== j.version || Date.now() - seen.t > 12 * 3600000) showUpdate();
    } catch (e) { /* fără rețea */ }
  }
  function showUpdate() {
    if (!UPD.latest || document.getElementById('gcr-update')) return;
    const j = UPD.notes;
    const notes = (settings.lang === 'ro' ? j.notes_ro : j.notes_en) || j.notes_en || [];
    const list = el('ul', { style: 'margin:6px 0 8px 18px;padding:0' }, ...notes.slice(0, 6).map((n) => { const li = el('li'); li.textContent = n; return li; }));
    const close = () => { store.set('geofsCopilotRO.updSeen', { v: UPD.latest, t: Date.now() }); box.remove(); };
    const how = UPD.src === 'bm'
      ? L('Ai pornit pluginul din semnul de carte: reîncarcă GeoFS (F5) și apasă din nou pe semnul de carte – se încarcă automat versiunea nouă.', 'You started the plugin from the bookmark: reload GeoFS (F5) and click the bookmark again – it loads the new version automatically.')
      : L('Tampermonkey: apasă „Actualizează acum”, confirmă cu Update/Reinstall în pagina care se deschide, apoi reîncarcă GeoFS (F5).', 'Tampermonkey: press “Update now”, confirm with Update/Reinstall on the page that opens, then reload GeoFS (F5).');
    const box = el('div', { id: 'gcr-update', style: 'position:fixed;bottom:70px;right:20px;z-index:100001;width:340px;max-width:calc(100% - 40px);background:rgba(10,30,22,.97);border:2px solid #4cff8f;border-radius:12px;padding:12px 14px;color:#fff;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6)' },
      el('b', { style: 'color:#4cff8f;font-size:14px' }, `⬆️ GeoFS Copilot ${UPD.latest} ${L('este disponibil!', 'is available!')}`),
      el('div', { class: 'gcr-muted', style: 'font-size:11px' }, L(`Ai versiunea ${VERSION}.`, `You have version ${VERSION}.`)),
      notes.length ? list : null,
      el('div', { style: 'margin-bottom:8px' }, how),
      el('div', { class: 'gcr-row' },
        UPD.src === 'bm' ? el('button', { class: 'gcr-btn sm ok', onclick: () => { close(); location.reload(); } }, L('Reîncarcă GeoFS', 'Reload GeoFS'))
          : el('a', { class: 'gcr-btn sm ok', href: 'https://github.com/razvan999x/geofs-copilot/raw/main/geofs-copilot.user.js', target: '_blank', rel: 'noopener', style: 'text-decoration:none', onclick: () => close() }, L('Actualizează acum', 'Update now')),
        el('a', { class: 'gcr-link', href: ONLINE.site + '#/install', target: '_blank', rel: 'noopener' }, L('ajutor', 'help')),
        el('button', { class: 'gcr-btn sm', onclick: close }, L('Mai târziu', 'Later'))));
    ['mousedown', 'pointerdown', 'wheel', 'keydown'].forEach((t) => box.addEventListener(t, (e) => e.stopPropagation()));
    document.body.append(box);
  }

  /* ---------------- Interfață: Carieră, Școală, Jurnal ---------------- */
  function buildCareerPage(p) {
    const box = el('div'); p.append(box);
    ui.renderCareer = () => {
      const ri = rankIdx(), r = RANKS[ri], nx = RANKS[ri + 1];
      const prog = nx ? clamp((CAREER.xp - r.xp) / (nx.xp - r.xp), 0, 1) : 1;
      const ci = acClass();
      box.innerHTML = '';
      box.append(el('div', { class: 'gcr-destcard', style: 'margin-top:0' },
        el('div', { class: 'gcr-muted', style: 'font-size:11px' }, L('RANGUL TĂU', 'YOUR RANK')),
        el('div', { style: 'font-size:17px;font-weight:800' }, `👨‍✈️ ${rankName(ri)}`),
        el('div', { class: 'gcr-bar', style: 'margin:6px 0 3px' }, el('div', { style: `width:${Math.round(prog * 100)}%;background:#e040fb` })),
        el('div', { class: 'gcr-muted' }, `${CAREER.xp.toLocaleString('en-US')} XP` + (nx ? ` · ${L('următorul rang', 'next rank')}: ${L(nx.ro, nx.en)} ${L('la', 'at')} ${nx.xp.toLocaleString('en-US')} XP` : ' · MAX')),
        el('div', { class: 'gcr-muted' }, `${L('Bonus de plată la misiuni', 'Mission pay bonus')}: +${Math.round((payMul() - 1) * 100)}%`)));
      try { box.append(...careerExtras()); } catch (e) { console.warn('[GeoFS Copilot] career extras', e); }
      // licențe
      const lic = el('div', { class: 'gcr-list', style: 'max-height:none;margin-top:6px' });
      CLASSES.forEach((c, k) => {
        const ok = classAllowed(k), byRank = k <= r.cls;
        lic.append(el('div', { class: 'gcr-item' + (k === ci ? ' sel' : '') },
          el('span', {}, (ok ? '✅ ' : '🔒 ') + L(c.ro, c.en) + (k === ci ? L(' (avionul tău)', ' (your aircraft)') : '')),
          ok ? el('span', { class: 'gcr-muted' }, byRank ? L('prin rang', 'by rank') : L('licență cumpărată', 'type rating')) :
            el('button', { class: 'gcr-btn sm', onclick: () => buyRating(k) }, `${L('Cumpără', 'Buy')} $${c.price.toLocaleString('en-US')}`)));
      });
      box.append(el('b', { style: 'display:block;margin-top:8px' }, L('Licențe de tip (ce avioane poți folosi în misiuni)', 'Type ratings (aircraft you may fly on missions)')), lic);
      // realizări
      const achBox = el('div', { class: 'gcr-ach' });
      ACH.forEach((a) => achBox.append(el('div', { class: 'a' + (CAREER.ach[a.k] ? ' on' : ''), title: L(a.dro, a.den) }, el('span', { class: 'i' }, a.icon), el('span', {}, L(a.ro, a.en)))));
      box.append(el('b', { style: 'display:block;margin-top:8px' }, `${L('Realizări', 'Achievements')} ${Object.keys(CAREER.ach).length}/${ACH.length}`), achBox);
      // clasament online
      const lb = el('div', { class: 'gcr-list', style: 'max-height:none' });
      if (!settings.onlineSync) lb.append(el('div', { class: 'gcr-item gcr-muted' }, L('Publicarea online e oprită (Setări).', 'Online publishing is off (Settings).')));
      else if (LB.err) lb.append(el('div', { class: 'gcr-item gcr-muted' }, L('Clasamentul nu s-a putut încărca.', 'The leaderboard could not be loaded.')));
      else if (!LB.list.length) lb.append(el('div', { class: 'gcr-item gcr-muted' }, L('Încă nimeni în clasament – fii primul!', 'Nobody on the leaderboard yet – be the first!')));
      LB.list.forEach((x) => lb.append(el('div', { class: 'gcr-item' + (x.id === CAREER.pilotId ? ' sel' : '') },
        el('span', {}, el('b', {}, `#${x.pos} `), x.callsign, el('span', { class: 'gcr-muted' }, ` · ${rankName(rankIdx(x.xp))}`)),
        el('span', { class: 'gcr-muted' }, `${x.xp.toLocaleString('en-US')} XP · ${x.flights} ${L('zboruri', 'flights')}`))));
      box.append(el('div', { class: 'gcr-row', style: 'margin-top:8px;justify-content:space-between' }, el('b', {}, '🌐 ' + L('Clasament online', 'Online leaderboard')),
        el('a', { href: ONLINE.site, target: '_blank', rel: 'noopener', class: 'gcr-link' }, L('vezi site-ul →', 'open the website →'))), lb,
        CAREER.rankPos ? el('div', { class: 'gcr-muted' }, L(`Locul tău: #${CAREER.rankPos}`, `Your position: #${CAREER.rankPos}`)) : null);
      // mai multe calculatoare
      const dev = el('div', { class: 'gcr-fuel', style: 'margin-top:10px' });
      dev.append(el('b', {}, '💻 ' + L('Joci pe mai multe calculatoare?', 'Playing on several computers?')),
        el('div', { class: 'gcr-muted', style: 'margin:3px 0 6px' }, L('Copiază codul de pilot de aici și lipește-l pe celălalt calculator (tab-ul Carieră). Profilurile se unesc, iar banii, rangul, licențele și realizările se sincronizează. Codul e secret, ca o parolă – nu-l da nimănui.', 'Copy your pilot code from here and paste it on the other computer (Career tab). The profiles merge, and money, rank, type ratings and achievements stay in sync. The code is secret, like a password – do not share it.')));
      if (CLOUD.other) dev.append(el('div', { style: 'color:#ffd54f;margin-bottom:6px' }, L(`⚠ Contul tău GeoFS are și profilul „${CLOUD.other.callsign}” (${CLOUD.other.xp} XP, ${CLOUD.other.flights} zboruri) pe alt calculator. Lipește aici codul de pe acel calculator ca să le unești.`, `⚠ Your GeoFS account also has the profile “${CLOUD.other.callsign}” (${CLOUD.other.xp} XP, ${CLOUD.other.flights} flights) on another computer. Paste that computer's code here to merge them.`),
        ' ', el('a', { href: '#', class: 'gcr-link', onclick: (ev) => { ev.preventDefault(); CLOUD.dismissed = CLOUD.other.callsign + CLOUD.other.flights; store.set('geofsCopilotRO.cloudDismiss', CLOUD.dismissed); CLOUD.other = null; ui.renderCareer(); } }, L('(ignoră)', '(dismiss)'))));
      const codeShown = CAREER.key.match(/.{1,6}/g).join('-');
      const codeEl = el('code', { class: 'gcr-code' }, '••••••-••••••-••••••-••••••-••••••-••••••-••••••-••••••');
      let shown = false;
      dev.append(el('div', { class: 'gcr-row' }, el('span', {}, L('Codul tău:', 'Your code:')), codeEl),
        el('div', { class: 'gcr-row' },
          el('button', { class: 'gcr-btn sm', onclick: () => { shown = !shown; codeEl.textContent = shown ? codeShown : '••••••-••••••-••••••-••••••-••••••-••••••-••••••-••••••'; } }, L('Arată / ascunde', 'Show / hide')),
          el('button', { class: 'gcr-btn sm', onclick: () => { (navigator.clipboard ? navigator.clipboard.writeText(codeShown) : Promise.reject()).then(() => ui.toast(L('Cod copiat ✓', 'Code copied ✓'))).catch(() => { shown = true; codeEl.textContent = codeShown; ui.toast(L('Copiază manual codul afișat.', 'Copy the code shown manually.')); }); } }, L('Copiază', 'Copy'))));
      const inp = el('input', { placeholder: L('Lipește codul de pe celălalt calculator', 'Paste the code from your other computer'), style: 'flex:1;min-width:0' });
      dev.append(el('div', { class: 'gcr-row' }, inp, el('button', { class: 'gcr-btn sm ok', onclick: () => linkWithCode(inp.value) }, L('Leagă', 'Link'))));
      box.append(dev);
      if (settings.onlineSync) loadLeaderboard();
    };
    ui.renderCareer();
  }
  function buildTrainingPage(p) {
    const box = el('div'); p.append(box);
    ui.renderTraining = () => {
      box.innerHTML = '';
      box.append(el('div', { class: 'gcr-muted', style: 'margin-bottom:6px' }, L('Fiecare lecție te pune în situație (pe pistă sau pe finală) și îți dă pașii în caseta de instrucțiuni. Autopilotul e oprit – zbori tu.', 'Each lesson sets you up (on the runway or on final) and shows the steps in the instruction box. The autopilot is off – you fly.')));
      LESSONS.forEach((l) => {
        const done = CAREER.lessons[l.id], running = LES.id === l.id;
        box.append(el('div', { class: 'gcr-item' + (running ? ' sel' : '') },
          el('span', {}, `${done ? '✅' : l.icon} `, el('b', {}, L(l.ro, l.en)), el('span', { class: 'gcr-muted' }, ` · ${l.steps.length} ${L('pași', 'steps')} · +${l.xp} XP`)),
          running ? el('button', { class: 'gcr-btn sm warn', onclick: () => stopLesson(L('Lecție oprită.', 'Lesson stopped.')) }, L('Oprește', 'Stop'))
            : el('button', { class: 'gcr-btn sm ok', onclick: () => startLesson(l.id) }, done ? L('Reia', 'Retry') : L('Începe', 'Start'))));
      });
      box.append(el('b', { style: 'display:block;margin-top:10px' }, L('Urgențe de antrenament', 'Emergency training')),
        el('div', { class: 'gcr-muted' }, L('Declanșează o defecțiune acum (doar în zbor):', 'Trigger a failure now (in flight only):')),
        el('div', { class: 'gcr-row' }, ...Object.keys(ETYPES).filter((k) => k !== 'medical' || (MISSION && MISSION.isPax)).map((k) =>
          el('button', { class: 'gcr-btn sm', onclick: () => { if (sim.onGround()) { ui.toast(L('Doar în zbor.', 'In flight only.')); return; } triggerEmergency(k); } }, `${ETYPES[k].icon} ${L(ETYPES[k].ro, ETYPES[k].en)}`))));
    };
    ui.renderTraining();
  }
  function buildLogPage(p) {
    const box = el('div'); p.append(box);
    ui.renderLog = () => {
      box.innerHTML = '';
      const tot = LOGB.list.reduce((s, f) => ({ h: s.h + f.duration_min / 60, nm: s.nm + f.dist_nm }), { h: 0, nm: 0 });
      box.append(el('div', { class: 'gcr-row', style: 'justify-content:space-between' },
        el('span', {}, `📒 ${LOGB.list.length} ${L('zboruri', 'flights')} · ${tot.h.toFixed(1)} h · ${Math.round(tot.nm).toLocaleString('en-US')} NM`),
        el('button', { class: 'gcr-btn sm', onclick: exportCsv }, L('Export CSV', 'Export CSV'))));
      const list = el('div', { class: 'gcr-list', style: 'max-height:360px' });
      if (!LOGB.list.length) list.append(el('div', { class: 'gcr-item gcr-muted' }, L('Zborurile apar aici automat după aterizare.', 'Flights appear here automatically after landing.')));
      LOGB.list.forEach((f) => {
        const d = new Date(f.t);
        list.append(el('div', { class: 'gcr-item', style: 'display:block' },
          el('div', { style: 'display:flex;justify-content:space-between;gap:6px' },
            el('b', {}, `${f.dep ? aptName(f.dep) : '?'} → ${f.arr ? aptName(f.arr) : '?'}`),
            el('span', { class: 'gcr-muted' }, `${d.toLocaleDateString()} ${d.toTimeString().slice(0, 5)}`)),
          el('div', { class: 'gcr-muted', style: 'font-size:11px' },
            `${f.aircraft} · ${f.dist_nm} NM · ${Math.round(f.duration_min)} min` + (f.fuel_kg != null ? ` · ⛽ ${f.fuel_kg} kg` : '') +
            (f.landing_vs != null ? ` · ${f.landing_vs} fpm (${f.landing_score})` : '') + (f.mission_pay ? ` · $${f.mission_pay}` : '') +
            (f.emergency ? ` · ⚠ ${L(ETYPES[f.emergency].ro, ETYPES[f.emergency].en)}` : '') + ` · +${f.xp} XP` + (f.online ? ' · 🌐' : '')),
          el('div', { class: 'gcr-row', style: 'margin:3px 0 0' },
            el('button', { class: 'gcr-btn sm', onclick: () => exportKml(f) }, 'Google Earth (KML)'),
            el('button', { class: 'gcr-btn sm', onclick: () => exportGpx(f) }, 'GPX'))));
      });
      box.append(list);
    };
    ui.renderLog();
  }

  /* ---------------- Taste rapide ---------------- */
  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) return;
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const actions = {
        N: () => ui.togglePanel(),
        M: () => toggleNd(),
        Y: () => atcAccept(),
        U: () => atcRefuse(),
        P: () => LES.id ? stopLesson(L('Lecție oprită.', 'Lesson stopped.')) : (AP.phase === 'STOPOVER' ? departStopover() : AP.phase === 'WAITTO' ? (AP.phase = 'MAN', AP.active = false, ui.renderNav()) : (AP.active ? disengage() : engageFull())),
        H: () => { settings.hudVisible = !settings.hudVisible; saveSettings(); ui.hud.style.display = settings.hudVisible ? '' : 'none'; },
        L: () => (AP.active ? disengage() : engage()),
        R: teleportFinal,
        A: () => apx.apply(Object.assign(apx.sync(), { vs: 0 })),
        ArrowUp: () => apx.nudge('alt', 1000), ArrowDown: () => apx.nudge('alt', -1000),
        ArrowLeft: () => apx.nudge('hdg', -5), ArrowRight: () => apx.nudge('hdg', 5),
        PageUp: () => apx.nudge('spd', 10), PageDown: () => apx.nudge('spd', -10),
        G: () => controls.setters.setGear.set(),
        F: () => setFlaps(controls.flaps.target > 0 ? 0 : sim.flapsSteps()),
        S: () => controls.setters.setAirbrakes.set(),
        E: () => controls.setters.toggleEngines.set(),
        C: () => geofs.camera.cycle(),
        X: () => { const h = store.get(LS_LANDINGS, []); if (h[0]) ui.showLanding(h[0], []); else ui.toast(L('Încă nicio aterizare.', 'No landings yet.')); },
      };
      const fn = actions[k];
      if (!fn) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      try { fn(); } catch (err) { console.error('[GeoFS Copilot] key', err); }
    }, true);
  }
}

  // De unde a fost pornit pluginul (semn de carte = jsDelivr), pentru instrucțiunile de actualizare.
  try { const cs = document.currentScript; if (cs && /jsdelivr/.test(cs.src || '')) document.documentElement.dataset.gcrSrc = 'bm'; } catch (e) { /* */ }
  // Injectăm codul ca <script> în pagină: funcționează și când Tampermonkey rulează scriptul izolat.
  try {
    const el = document.createElement('script');
    el.textContent = '(' + gcrMain.toString() + ')();';
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  } catch (e) { /* ignorat */ }
  // Rezervă: dacă injectarea a fost blocată și suntem deja în pagină, pornim direct.
  setTimeout(() => { if (!document.documentElement.dataset.gcrLoaded) { try { gcrMain(); } catch (e) { console.error('[GeoFS Copilot]', e); } } }, 1500);
})();
