// ==UserScript==
// @name         GeoFS Copilot – auto takeoff, navigation, ILS approach & autoland
// @name:ro      GeoFS Copilot – decolare automată, navigație, apropiere ILS și aterizare
// @namespace    geofs-copilot-ro
// @version      1.3.0
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
  const VERSION = '1.3.0';
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
      ui.setStatus(L(`Bază de date gata: ${DB.info.size} aeroporturi. Caută după oraș sau nume.`, `Database ready: ${DB.info.size} airports. Search by city or name.`));
      ui.refreshNearest();
      TRIP.stops = TRIP.stops.filter((x) => DB.airports.has(x.apt));
      if (TRIP.stops.length) applyTripTarget();
    } catch (e) {
      DB.error = e; console.error('[GeoFS Copilot]', e);
      ui.setStatus(L('Nu am putut descărca baza de date (' + e.message + '). Reîncearcă din butonul „Reîncarcă baza”.', 'Could not download the database (' + e.message + '). Try again with “Reload database”.'));
    } finally { DB.loading = false; }
  }

  function nearestAirports(lat, lon, n = 12, filter) {
    const arr = [];
    for (const [apt, rws] of DB.airports) {
      const a = DB.info.get(apt);
      const maxLen = a ? a.maxLen : Math.max(...rws.map((r) => r.lenFt));
      if (maxLen < 2000) continue;
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
    AP.full = true; AP.flapsUp = false; AP.vapp = suggestedVapp();
    buildRoute(); planCruise(); drawApproach();
    if (geofs.autopilot.definition) geofs.autopilot.definition.maxBankAngle = settings.bankMax;
    if (sim.onGround() && settings.autoTakeoff && sim.hasAP()) {
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
      geofs.autopilot.setSpeed(Math.min(AP.cruiseSpd, sim.altFt() < 10000 ? 250 : 999));
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
      geofs.autopilot.setSpeed(Math.min(AP.cruiseSpd, 250));
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
    if (AP.phase === 'AUTOTO' || AP.phase === 'STOPOVER') return;
    if (!AP.active) return;
    if (!ap.on && AP.phase !== 'ROLLOUT') { AP.active = false; AP.phase = 'MAN'; releaseVS(); ui.toast(L('Autopilotul a fost decuplat – ghidare automată oprită (instrucțiunile rămân în HUD).', 'Autopilot disconnected – automatic guidance stopped (instructions remain on the HUD).')); ui.renderNav(); return; }

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
    const nearApp = st.distBefore < AP.ifD + 3 * NM && st.distBefore > -1 * NM && AP.legIdx >= AP.legs.findIndex((l) => l.name === 'IF');
    if (AP.phase === 'GS' || (onFinal && st.distBefore < AP.fafD)) {
      if (ap.values.speed > vapp) ap.setSpeed(vapp);
    } else if (nearApp) {
      if (ap.values.speed > vapp + 30) ap.setSpeed(vapp + 30);
    } else if (AP.full) {
      const want = altFt < 10000 ? Math.min(AP.cruiseSpd, 250) : AP.cruiseSpd;
      const slow = pathRemain < 25 * NM ? Math.min(want, isLight() ? want : 210) : want;
      if (Math.abs(ap.values.speed - slow) > 2) ap.setSpeed(slow);
      if (!AP.flapsUp && v.kias > vapp + 25 && v.haglFeet > 1000) { setFlaps(0); AP.flapsUp = true; }
    } else if (altFt < 10000 && ap.values.speed > 250) ap.setSpeed(250);
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
      geofs.autopilot.setSpeed(Math.min(TO.vr + (isLight() ? 20 : 40), 250));
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
    for (const a of nearestAirports(lat, lon, 3)) {
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
  #gcr-panel{position:fixed;z-index:100000;top:70px;right:12px;width:340px;max-height:calc(100vh - 100px);overflow:auto;background:rgba(14,20,30,.93);color:#e8eef7;font:12px/1.4 system-ui,Segoe UI,Roboto,sans-serif;border:1px solid #2b3a52;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45)}
  #gcr-panel *{box-sizing:border-box}
  #gcr-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#18243a;border-radius:10px 10px 0 0;cursor:move;user-select:none}
  #gcr-head b{flex:1;font-size:13px}
  #gcr-head button{background:none;border:0;color:#9fb3cf;font-size:16px;cursor:pointer}
  .gcr-tabs{display:flex;border-bottom:1px solid #2b3a52}
  .gcr-tabs button{flex:1;padding:7px 2px;background:none;border:0;color:#9fb3cf;cursor:pointer;font-size:12px;border-bottom:2px solid transparent}
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
  #gcr-hud{position:fixed;z-index:99999;left:50%;top:8px;transform:translateX(-50%);display:flex;gap:10px;align-items:stretch;background:rgba(0,10,0,.55);color:#5cff7a;font:600 13px/1.25 ui-monospace,Consolas,monospace;padding:6px 10px;border-radius:8px;border:1px solid rgba(92,255,122,.35);pointer-events:none;text-shadow:0 0 3px #000}
  #gcr-hud .c{display:flex;flex-direction:column;min-width:78px;white-space:nowrap}
  #gcr-hud .k{font-size:10px;color:#9be7a8;opacity:.8}
  #gcr-hud .warn{color:#ff4d4d;font-size:15px}
  #gcr-hud canvas{display:block}
  #gcr-warn{position:fixed;z-index:99999;left:50%;top:215px;transform:translateX(-50%);color:#fff;background:rgba(200,20,20,.85);font:700 18px system-ui;padding:6px 16px;border-radius:6px;display:none;pointer-events:none;letter-spacing:1px}
  #gcr-toast{position:fixed;z-index:100001;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(20,30,48,.95);color:#fff;font:13px system-ui;padding:8px 14px;border-radius:8px;border:1px solid #3d5679;display:none;max-width:70vw;text-align:center}
  #gcr-landing{position:fixed;z-index:100001;left:50%;top:30%;transform:translateX(-50%);background:rgba(14,20,30,.96);color:#fff;font:13px system-ui;padding:14px 18px;border-radius:12px;border:1px solid #8e24aa;display:none;min-width:280px;text-align:center}
  #gcr-landing .score{font-size:40px;font-weight:800;color:#e040fb}
  #gcr-fab{position:fixed;z-index:100000;right:12px;top:70px;background:#8e24aa;color:#fff;border:0;border-radius:20px;padding:6px 12px;font:600 12px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)}
  .gcr-here{background:#101a2a;border:1px solid #26354b;border-radius:8px;padding:6px 8px;margin-bottom:6px}
  .gcr-destcard{background:linear-gradient(135deg,#2a1636,#16233a);border:1px solid #6a2c86;border-radius:9px;padding:8px 10px;margin-top:10px}
  .gcr-btn.big{width:100%;padding:9px;font-size:13px;font-weight:600}
  #gcr-guide{position:fixed;z-index:99999;left:50%;top:116px;transform:translateX(-50%);background:rgba(10,14,22,.78);color:#fff;font:13px/1.45 system-ui,Segoe UI,sans-serif;padding:7px 14px;border-radius:9px;border:1px solid rgba(224,64,251,.45);display:none;pointer-events:none;text-align:center;max-width:80vw;text-shadow:0 1px 2px #000}
  #gcr-guide .gh{font-size:16px;font-weight:700;color:#ffe082}
  #gcr-guide .gm{color:#d59ce6;font-size:12px}
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
  .gcr-kbd{display:inline-block;background:#0c1320;border:1px solid #33465f;border-radius:4px;padding:0 5px;font-family:monospace;color:#fff}
  `;

  /** Reconstruiește interfața (de ex. după schimbarea limbii), fără a opri zborul. */
  function rebuildUI() {
    ['gcr-panel', 'gcr-fab', 'gcr-hud', 'gcr-nd', 'gcr-guide'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
    initRegionNames();
    if (DB.loaded) buildSearchIndex();
    buildPanel(); buildHud(); buildNd();
    const tab = 'set';
    const b = document.querySelector('#gcr-panel .gcr-tabs button[data-k="' + tab + '"]'); if (b) b.click();
    if (DB.loaded) { ui.refreshNearest(); if (TRIP.stops.length) applyTripTarget(); }
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
    setInterval(() => {
      if (!geofsReady() || sim.paused()) return;
      try { updateTrack(); guidanceTick(); autoTakeoffTick(); tripTick(); } catch (e) { console.error('[GeoFS Copilot] guidance', e); }
    }, 100);
    setInterval(() => {
      if (!geofsReady() || sim.paused()) return;
      try { assistantTick(); } catch (e) { console.error('[GeoFS Copilot] assistant', e); }
    }, 100);
    setInterval(() => { if (geofsReady()) { try { updateHud(); ui.updateLive(); } catch (e) { console.error('[GeoFS Copilot] HUD', e); } } }, 200);
    setInterval(() => { if (geofsReady()) { try { updateGuide(); drawNd(); } catch (e) { console.error('[GeoFS Copilot] map', e); } } }, 250);
    setInterval(() => { if (geofsReady() && DB.loaded && ui.tab === 'nav' && settings.panelVisible) { try { ui.refreshNearestHere(); if (AP.rwy) ui.renderNav(); } catch (e) { /* */ } } }, 15000);
    // Când avionul e schimbat sau zborul resetat, pistele trebuie redesenate
    try { $(document).on('flyto', () => setTimeout(() => { if (AP.rwy) { buildRoute(); drawApproach(); } }, 1500)); } catch (e) { /* */ }
    loadRunways();
    ui.toast(L('GeoFS Copilot RO încărcat – Shift+N deschide/închide panoul.', 'GeoFS Copilot loaded – Shift+N opens/closes the panel.'));
  }

  /* ---------------- Panou principal ---------------- */
  function buildPanel() {
    const fab = el('button', { id: 'gcr-fab', title: 'Shift+N', onclick: () => togglePanel(true) }, '✈ Copilot');
    const panel = el('div', { id: 'gcr-panel' });
    const head = el('div', { id: 'gcr-head' }, el('span', {}, '✈'), el('b', {}, 'GeoFS Copilot'),
      el('button', { title: L('Ascunde (Shift+N)', 'Hide (Shift+N)'), onclick: () => togglePanel(false) }, '–'));
    const tabsBar = el('div', { class: 'gcr-tabs' });
    const body = el('div', { class: 'gcr-body' });
    const tabs = { nav: L('Navigație', 'Navigation'), ap: 'Autopilot', sys: L('Avion', 'Aircraft'), set: L('Setări', 'Settings') };
    const pages = {};
    Object.keys(tabs).forEach((k) => {
      const b = el('button', { onclick: () => showTab(k) }, tabs[k]); b.dataset.k = k; tabsBar.append(b);
      pages[k] = el('div', { style: 'display:none' }); body.append(pages[k]);
    });
    function showTab(k) {
      [...tabsBar.children].forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      Object.keys(pages).forEach((p) => { pages[p].style.display = p === k ? '' : 'none'; });
      ui.tab = k;
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
    buildSetPage(pages.set);
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
    const m = { AUTOTO: L('decolare automată', 'automatic takeoff'), STOPOVER: L('escală', 'stopover'), TAKEOFF: L('urcare inițială', 'initial climb'), NAV: L('în drum spre destinație', 'en route to destination'), LOC: L('aliniat cu pista', 'aligned with the runway'), GS: L('pe panta de coborâre', 'on the glide path'), FLARE: 'flare', ROLLOUT: L('rulare și frânare', 'rollout and braking'), MAN: 'manual', OFF: '—' };
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
      el('div', { style: 'font-size:14px;font-weight:700' }, '✈ GeoFS Copilot ', el('span', { class: 'gcr-muted', style: 'font-weight:400' }, 'v' + VERSION)),
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
      chk('autoland', L('Aterizare automată (flare + frânare) – altfel AP se decuplează la minime', 'Automatic landing (flare + braking) – otherwise the AP disconnects at minimums')),
      chk('drawTunnel', L('Desenează culoarul 3D', 'Draw the 3D approach corridor'), () => (settings.drawTunnel ? drawApproach() : clearEntities())),
      el('b', { style: 'display:block;margin-top:8px' }, L('Afișare și sunet', 'Display and sound')),
      chk('hudVisible', L('Afișează HUD-ul (Shift+H)', 'Show the HUD (Shift+H)'), () => { ui.hud.style.display = settings.hudVisible ? '' : 'none'; }),
      chk('voice', L('Anunțuri vocale (callouts / avertizări)', 'Voice callouts and warnings')),
      el('b', { style: 'display:block;margin-top:8px' }, L('Taste rapide', 'Keyboard shortcuts')),
      el('div', { html: [
        ['Shift+N', L('arată/ascunde panoul', 'show/hide the panel')], ['Shift+M', L('arată/ascunde harta', 'show/hide the map')], ['Shift+P', L('zbor complet / oprește / pleacă din escală', 'full flight / stop / leave stopover')], ['Shift+H', L('arată/ascunde HUD-ul', 'show/hide the HUD')], ['Shift+L', L('activează/oprește apropierea', 'start/stop approach')],
        ['Shift+R', L('teleportare pe finală', 'teleport to final')], ['Shift+A', L('cuplează AP și ține valorile actuale', 'engage AP and hold current values')], ['Shift+↑/↓', L('AP altitudine ±1000 ft', 'AP altitude ±1000 ft')],
        ['Shift+←/→', L('AP cap ±5°', 'AP heading ±5°')], ['Shift+PgUp/PgDn', L('AP viteză ±10 kt', 'AP speed ±10 kt')], ['Shift+G', L('tren jos/sus', 'gear down/up')], ['Shift+F', L('flaps complet / retrase', 'flaps full / up')],
        ['Shift+S', L('spoilere', 'spoilers')], ['Shift+E', L('motoare pornit/oprit', 'engines on/off')], ['Shift+C', L('cameră următoare', 'next camera')], ['Shift+X', L('ultima aterizare', 'last landing')],
      ].map(([k, d]) => `<div><span class="gcr-kbd">${k}</span> ${d}</div>`).join('') }),
      el('b', { style: 'display:block;margin-top:8px' }, L('Ultimele aterizări', 'Recent landings')), hist,
      about,
    );
    ui.renderHist = () => {
      const h = store.get(LS_LANDINGS, []);
      hist.innerHTML = h.length ? h.slice(0, 8).map((r) => `<div>${r.apt} ${r.rwy} · <b>${r.score}</b> (${r.grade}) · ${r.vs} fpm · ${r.g} G</div>`).join('') : L('Încă nicio aterizare înregistrată.', 'No landings recorded yet.');
    };
    ui.renderHist();
  }

  /* ---------------- HUD ---------------- */
  function buildHud() {
    const hud = el('div', { id: 'gcr-hud' });
    const cols = {};
    const col = (k, label) => { const v = el('div', {}, '—'); cols[k] = v; hud.append(el('div', { class: 'c' }, el('span', { class: 'k' }, label), v)); };
    col('ias', 'IAS / GS kt'); col('alt', 'ALT / AGL ft'); col('vs', 'V/S ft/min'); col('hdg', 'HDG / TRK');
    col('g', 'G / AoA'); col('apr', L('APROPIERE', 'APPROACH'));
    const cv = el('canvas', { width: 92, height: 92 });
    hud.append(cv);
    document.body.append(hud);
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
  function guideLines() {
    if (!AP.rwy) return [];
    const g = AP.guide, v = sim.v(), lines = [];
    const dest = aptName(AP.rwy.apt);
    if (AP.phase === 'STOPOVER') {
      const left = Math.max(0, Math.ceil((TRIP.departAt - Date.now()) / 1000));
      return [[L(`ESCALĂ la ${aptName(TRIP.lastApt || AP.rwy.apt)} · plecăm spre ${dest} în ${left} s`, `STOPOVER at ${aptName(TRIP.lastApt || AP.rwy.apt)} · departing for ${dest} in ${left} s`), 'h'],
        [L(`Următoarea etapă: ${g ? fmt(g.pathNm) + ' NM' : ''} · Shift+P = pleacă acum`, `Next leg: ${g ? fmt(g.pathNm) + ' NM' : ''} · Shift+P = leave now`)], [L('Avionul va fi mutat la începutul pistei și decolează automat.', 'The aircraft will be moved to the start of the runway and take off automatically.'), 'm']];
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
    document.body.append(guide); ui.guide = guide;
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
    const html = lines.map(([t, c]) => `<div class="${c === 'h' ? 'gh' : c === 'm' ? 'gm' : ''}">${t}</div>`).join('');
    if (g._h !== html) { g.innerHTML = html; g._h = html; }
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

  /* ---------------- Taste rapide ---------------- */
  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) return;
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const actions = {
        N: () => ui.togglePanel(),
        M: () => toggleNd(),
        P: () => (AP.phase === 'STOPOVER' ? departStopover() : (AP.active ? disengage() : engageFull())),
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
