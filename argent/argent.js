/* Mon Vrai Argent — Calendrier & Budget + L'Établi (session 8, 05/11/2026). Reprend le site de Yanis (Netlify : auth.js +
   dashboard.js + etabli.js) en UNE page à 2 boutons, et le relie à Jarvis.
   - Données : TON navigateur (localStorage, une case par compte Google) + TON Google Drive (Espace_Unifie_Sauvegarde.json, même
     format que l'ancien site : il reste compatible). Fusion SANS PERTE : union par identifiant, la version la plus récente
     (`maj`) gagne, une suppression laisse une « pierre tombale » (même algorithme que core/app/argent.py).
   - Yanis sur SON Jarvis (/api/argent/moi répond) : la page se synchronise avec Jarvis (chat, paiements du téléphone) et
     Jarvis s'occupe lui-même du Drive. Tout autre visiteur : rien de Yanis, seulement ses données à lui.
   - Fixes : identifiant déterministe auto_<fixe>_<AAAA-MM> (zéro doublon entre appareils), mois manqués rattrapés. */
'use strict';
(() => {
  const CLIENT_ID = window.ARGENT_CLIENT_ID || '153576340669-lmseu50ve3ru8qdaitr27gsdcjecacrn.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.file';
  const NOM_DRIVE = 'Espace_Unifie_Sauvegarde.json';
  // Session 9 : la même page tourne sur Jarvis (/argent/, via Funnel) ET en ligne H24 (GitHub Pages / Netlify, PC éteint).
  // Hors Jarvis, l'assistant appelle le PC de Yanis par son adresse publique (CORS ouvert seulement pour /ping et /analyser).
  const SUR_JARVIS = /(^|\.)ts\.net$|^localhost$|^127\.0\.0\.1$/.test(location.hostname);
  const API = `${window.ARGENT_JARVIS || (SUR_JARVIS ? '' : 'https://jarvis-304.mellori-egret.ts.net')}/api/argent`;

  // ============================================================ petits outils
  const $ = (s, r = document) => r.querySelector(s);
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 11)}`;
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const moisDe = (d = new Date()) => iso(d).slice(0, 7);
  const dernierJour = (m) => new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
  const moisSuivant = (m) => { const a = +m.slice(0, 4), x = +m.slice(5, 7); return x === 12 ? `${a + 1}-01` : `${a}-${pad(x + 1)}`; };
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const nomMois = (m) => `${MOIS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
  // module 1/7 : « aujourd'hui » = la date À PARIS (comme le serveur), même si le téléphone est réglé ailleurs
  const aujIso = () => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { return iso(); } };
  const dateParis = () => { const [a, m, j] = aujIso().split('-').map(Number); return new Date(a, m - 1, j); };
  const dateFr = (d) => { const [a, m, j] = d.split('-'); return `${j}/${m}${a !== aujIso().slice(0, 4) ? `/${a}` : ''}`; };
  const eur = (x, signe = false) => {
    const s = Math.abs(x).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    return signe ? (x >= 0 ? '+ ' : '− ') + s : (x < 0 ? '− ' : '') + s;
  };
  function nombre(x) {   // '18,50' · '1 200 €' · 18.5 → 18.5 (comme argent.nombre)
    if (typeof x === 'number') return x;
    const m = String(x ?? '').match(/-?\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|-?\d+(?:[.,]\d+)?/);
    if (!m) return 0;
    let s = m[0];
    if (/^-?\d{1,3}(?:[   .]\d{3})+(?:,\d+)?$/.test(s)) s = s.replace(/[   .]/g, '');
    return parseFloat(s.replace(',', '.')) || 0;
  }
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage plein / bloqué : la page marche quand même */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
  };
  let minuteurToast = null;
  function toast(texte, ms = 3800) {
    const t = $('#ar-toast'); t.textContent = texte; t.hidden = false;
    clearTimeout(minuteurToast); minuteurToast = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ============================================================ le modèle (= core/app/argent.py)
  function normOp(o) {
    if (!o || typeof o !== 'object') return null;
    const d = String(o.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const type = o.type === 'revenu' ? 'revenu' : 'depense';
    return { ...o, id: String(o.id || uid('op')), date: d, type, method: String(o.method || 'CB'),
      desc: String(o.desc || (type === 'revenu' ? 'Revenu' : 'Dépense')).slice(0, 120),
      amount: Math.round(Math.abs(nombre(o.amount)) * 100) / 100, maj: +o.maj || 0 };
  }
  function normFixe(f) {
    if (!f || typeof f !== 'object') return null;
    return { ...f, id: String(f.id || uid('fix')), type: f.type === 'revenu' ? 'revenu' : 'depense',
      day: Math.max(1, Math.min(31, Math.trunc(nombre(f.day)) || 1)), desc: String(f.desc || 'Fixe').slice(0, 120),
      amount: Math.round(Math.abs(nombre(f.amount)) * 100) / 100, maj: +f.maj || 0 };
  }
  function lireJson(v, def) { if (typeof v !== 'string') return v ?? def; try { return JSON.parse(v); } catch { return def; } }
  function normaliser(doc) {
    doc = doc || {};
    const ops = (lireJson(doc.op, []) || []).map(normOp).filter(Boolean);
    const fix = (lireJson(doc.fix, []) || []).map(normFixe).filter(Boolean);
    const et = lireJson(doc.etabli, {}) || {};
    const cats = [];
    (et.categories || []).forEach((c, ci) => {
      if (!c || typeof c !== 'object') return;
      const cat = { ...c, id: String(c.id || `c_${ci}`), title: String(c.title ?? 'Dossier'), icon: c.icon || '📁', color: c.color || '#888',
        maj: +c.maj || 0, ordre: typeof c.ordre === 'number' ? c.ordre : ci };
      cat.items = (c.items || []).filter((i) => i && typeof i === 'object').map((it, ii) => ({ ...it, id: String(it.id || uid('i')),
        name: String(it.name ?? 'Nouveau'), price: String(it.price ?? '0 €'), checked: it.checked === true || it.checked === 'true' || it.checked === 'True',
        date: String(it.date || ''), cat: cat.id, maj: +it.maj || 0, ordre: typeof it.ordre === 'number' ? it.ordre : ii }));
      cats.push(cat);
    });
    const s = lireJson(doc.supprimes, {}) || {};
    const supp = {}; for (const [k, v] of Object.entries(s)) supp[k] = +v || 0;
    const cpt = lireJson(doc.comptes, {}) || {}, comptes = {};
    for (const k of COMPTES) { const c = normCompte(cpt[k]); if (c) comptes[k] = c; }
    const mvts = (lireJson(doc.mvts, []) || []).map(normMvt).filter(Boolean);
    return { version: 3, op: ops, fix, etabli: { categories: cats }, supprimes: supp, comptes, mvts, maj: +doc.maj || 0 };
  }
  // module 1/7 : comptes À PART du solde réel (= argent.py) : base déclarée + mouvements après elle
  const COMPTES = ['livret_a', 'jarvis', 'liquide'];
  const NOMS_COMPTES = { livret_a: '🏦 Livret A', jarvis: '🤖 Argent de Jarvis', liquide: '💵 Argent liquide' };
  const CATEGORIES_COMPTES = { livret_a: 'Épargne', jarvis: 'Jarvis', liquide: 'Liquide' };
  // 11/11 : case « 💵 Argent liquide » (= argent.py est_liquide / interne) : les espèces payées APRÈS l'ouverture de la case
  // bougent le liquide, pas la banque ; un retrait / dépôt d'espèces change de poche (ni dépense ni revenu)
  function estLiquide(doc, o) {
    const c = (doc.comptes || {}).liquide;
    if (!c || o.method !== 'Espèces' || o.vers || o.depuis) return false;
    const cree = +o.cree || +o.maj || 0, od = c.ouvert_date || c.base_date, oms = +c.ouvert_ms || c.base_ms;
    return o.date > od || (o.date === od && cree > oms);
  }
  const interne = (o) => o.vers === 'liquide' || o.depuis === 'liquide';
  const soldeBanque = (doc, a = aujIso()) => Math.round(doc.op.reduce((s, o) => (o.date <= a && !estLiquide(doc, o) ? s + (o.type === 'revenu' ? o.amount : -o.amount) : s), 0) * 100) / 100;
  function normCompte(c) {
    if (!c || typeof c !== 'object' || c.base === undefined || c.base === null) return null;
    const d = String(c.base_date || '').slice(0, 10);
    return { ...c, base: Math.round(nombre(c.base) * 100) / 100, base_date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '2000-01-01',
      base_ms: +c.base_ms || 0, maj: +c.maj || 0, source: String(c.source || 'manuel') };
  }
  function normMvt(m) {
    if (!m || typeof m !== 'object' || !COMPTES.includes(m.compte)) return null;
    const d = String(m.date || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    return { ...m, id: String(m.id || uid('mv')), date: d, montant: Math.round(nombre(m.montant) * 100) / 100,
      desc: String(m.desc || 'Mouvement').slice(0, 120), maj: +m.maj || 0, cree: +m.cree || +m.maj || 0 };
  }
  const apresBase = (c, jour, cree) => !c || jour > c.base_date || (jour === c.base_date && cree > c.base_ms);
  function soldeCompte(doc, nom, a = aujIso()) {
    const c = (doc.comptes || {})[nom]; let solde = c ? c.base : 0, prevu = 0, n = 0;
    const lignes = [];
    for (const o of doc.op) {
      const s = o.vers === nom ? 1 : o.depuis === nom ? -1 : 0;
      if (s && apresBase(c, o.date, +o.cree || +o.maj || 0)) { n++; lignes.push([o.date, s * o.amount, o.desc]); }
      else if (nom === 'liquide' && estLiquide(doc, o) && apresBase(c, o.date, +o.cree || +o.maj || 0)) { n++; lignes.push([o.date, (o.type === 'revenu' ? 1 : -1) * o.amount, o.desc]); }
    }
    for (const m of doc.mvts || []) if (m.compte === nom && apresBase(c, m.date, m.cree)) { n++; lignes.push([m.date, m.montant, m.desc]); }
    for (const [j, m] of lignes) { if (j <= a) solde += m; else prevu += m; }
    return { solde: Math.round(solde * 100) / 100, prevu: Math.round(prevu * 100) / 100, connu: !!c || n > 0, source: c?.source || '', maj: c?.maj || 0 };
  }
  function definirCompte(doc, nom, montant, source = 'page') {
    const t = now(); doc.comptes = doc.comptes || {};
    const av = doc.comptes[nom] || {};   // « ouvert » = la toute première base : ne bouge plus (case liquide)
    doc.comptes[nom] = { base: Math.round(montant * 100) / 100, base_date: aujIso(), base_ms: t,
      ouvert_date: av.ouvert_date || av.base_date || aujIso(), ouvert_ms: +av.ouvert_ms || +av.base_ms || t, maj: t, source };
  }
  function virement(doc, nom, montant, sens = 'vers', date = aujIso(), source = 'page') {
    const t = now(), vers = sens !== 'depuis', court = NOMS_COMPTES[nom].split(' ').slice(1).join(' ');
    const liq = nom === 'liquide';
    const o = { id: uid('op'), date, type: vers ? 'depense' : 'revenu', method: liq ? (vers ? 'CB' : 'Espèces') : 'Virement',
      desc: liq ? (vers ? `Retrait d'espèces → ${court}` : `Dépôt d'espèces ← ${court}`) : (vers ? `Virement → ${court}` : `Retrait ← ${court}`),
      amount: Math.round(Math.abs(montant) * 100) / 100, categorie: CATEGORIES_COMPTES[nom], [vers ? 'vers' : 'depuis']: nom,
      source, ajoute: new Date().toISOString(), cree: t, maj: t };
    doc.op.push(o); return o;
  }
  function mouvement(doc, nom, montant, desc, date = aujIso(), source = 'page') {
    const t = now(), m = { id: uid('mv'), compte: nom, date, montant: Math.round(montant * 100) / 100, desc, source, cree: t, maj: t };
    (doc.mvts = doc.mvts || []).push(m); return m;
  }
  const plusRecent = (a, b) => ((a.maj || 0) > (b.maj || 0) ? a : b);   // b gagne à égalité (= ce qui arrive)
  function union(xa, xb, supp) {
    const m = new Map();
    for (const x of [...xa, ...xb]) m.set(x.id, m.has(x.id) ? plusRecent(m.get(x.id), x) : x);
    return [...m.values()].filter((x) => !(x.id in supp && supp[x.id] >= (x.maj || 0)));
  }
  function dedoublonnerAuto(ops) {
    const vus = new Set(), out = [];
    const tri = [...ops].sort((a, b) => {
      const da = !String(a.id).startsWith(`auto_${a.fixedId}_`), db = !String(b.id).startsWith(`auto_${b.fixedId}_`);
      return da === db ? (a.id < b.id ? -1 : a.id > b.id) : (da ? 1 : -1);
    });
    for (const o of tri) {
      if (o.isAuto && o.fixedId) { const c = `${o.fixedId}|${o.date.slice(0, 7)}`; if (vus.has(c)) continue; vus.add(c); }
      out.push(o);
    }
    return out;
  }
  function fusionner(a, b) {
    a = normaliser(a); b = normaliser(b);
    const supp = { ...a.supprimes };
    for (const [k, v] of Object.entries(b.supprimes)) supp[k] = Math.max(supp[k] || 0, v);
    const op = dedoublonnerAuto(union(a.op, b.op, supp)).sort((x, y) => (x.date + x.id < y.date + y.id ? -1 : 1));
    const fix = union(a.fix, b.fix, supp);
    const sans = (c) => { const { items, ...r } = c; return r; };
    const catsA = a.etabli.categories.map(sans), catsB = b.etabli.categories.map(sans);
    const pos = {}; catsA.forEach((c, i) => { pos[c.id] = i; }); catsB.forEach((c, i) => { pos[c.id] = i; });
    const cats = union(catsA, catsB, supp).sort((x, y) => ((x.ordre ?? pos[x.id] ?? 99) - (y.ordre ?? pos[y.id] ?? 99)) || ((pos[x.id] ?? 99) - (pos[y.id] ?? 99)));
    const items = union(a.etabli.categories.flatMap((c) => c.items), b.etabli.categories.flatMap((c) => c.items), supp);
    const parCat = new Map(cats.map((c) => [c.id, []]));
    for (const it of items) {
      const cible = parCat.has(it.cat) ? it.cat : cats[0]?.id;
      if (cible) parCat.get(cible).push({ ...it, cat: cible });
    }
    for (const c of cats) c.items = parCat.get(c.id).sort((x, y) => ((x.ordre ?? 0) - (y.ordre ?? 0)) || (x.id < y.id ? -1 : 1));
    const comptes = {};
    for (const k of COMPTES) {
      const ca = a.comptes[k], cb = b.comptes[k];
      if (!ca && !cb) continue;
      const c = ca && cb ? plusRecent(ca, cb) : (ca || cb);
      if ((supp[`compte:${k}`] ?? -1) < c.maj) comptes[k] = c;
    }
    const mvts = union(a.mvts, b.mvts, supp).sort((x, y) => (x.date + x.id < y.date + y.id ? -1 : 1));
    return { version: 3, op, fix, etabli: { categories: cats }, supprimes: supp, comptes, mvts, maj: Math.max(a.maj, b.maj) };
  }
  const empreinte = (d) => JSON.stringify([d.op, d.fix, d.etabli, d.supprimes, d.comptes, d.mvts]);
  function appliquerFixes(doc, auj = dateParis()) {
    const courant = moisDe(auj); let change = false;
    for (const f of doc.fix) {
      if (!f.debut) {
        const m = doc.op.filter((o) => o.isAuto && o.fixedId === f.id).map((o) => o.date.slice(0, 7)).sort();
        f.debut = m[0] || courant; change = true;
      }
      for (let m = f.debut, g = 0; m <= courant && g < 120; m = moisSuivant(m), g++) {
        const jour = Math.min(f.day, dernierJour(m)), id = `auto_${f.id}_${m}`;
        if (m === courant && auj.getDate() < jour) continue;
        if (id in doc.supprimes || doc.op.some((o) => o.isAuto && o.fixedId === f.id && o.date.slice(0, 7) === m)) continue;
        doc.op.push({ id, date: `${m}-${pad(jour)}`, type: f.type, method: 'Auto', desc: `🔄 ${f.desc}`, amount: f.amount, isAuto: true, fixedId: f.id, maj: 0 });
        change = true;
      }
    }
    if (change) doc.op.sort((x, y) => (x.date + x.id < y.date + y.id ? -1 : 1));
    return change;
  }
  function versDrive(doc) {   // même format que l'ancien site : il continue de lire op / fix / etabli
    const d = normaliser(doc);
    const net = (xs) => xs.map(({ cat, ...r }) => r);
    const et = { categories: d.etabli.categories.map(({ items, ...c }) => ({ ...c, items: net(items) })) };
    return { etabli: JSON.stringify(et), op: JSON.stringify(d.op), fix: JSON.stringify(d.fix), supprimes: JSON.stringify(d.supprimes),
      comptes: JSON.stringify(d.comptes), mvts: JSON.stringify(d.mvts), version: 3, maj: d.maj };
  }

  // ============================================================ état + stockage local
  const etat = { ns: 'local', doc: normaliser({}), proprio: false, nom: '', jeton: null, compte: null, vue: 'calendrier', mois: moisDe(),
    histoOuvert: true };
  const cle = () => `argent3:${etat.ns}`;
  function charger(ns) {
    etat.ns = ns;
    etat.doc = normaliser(lireJson(ls.get(cle()), {}));
    if (!ls.get('argent3:ancien-importe') && (ls.get('budget-op-v2') || ls.get('etabli-data-v1'))) {   // ancien site sur la même adresse
      etat.doc = fusionner(etat.doc, { op: ls.get('budget-op-v2'), fix: ls.get('budget-fix-v2'), etabli: ls.get('etabli-data-v1') });
      ls.set('argent3:ancien-importe', '1');
    }
    if (appliquerFixes(etat.doc)) ls.set(cle(), JSON.stringify(etat.doc));
  }
  function enregistrer({ synchro = true } = {}) {
    etat.doc.maj = Math.max(etat.doc.maj || 0, now());
    ls.set(cle(), JSON.stringify(etat.doc));
    rendre();
    if (synchro) planifierSynchro();
  }
  function remplacer(doc) {   // une version fusionnée arrive (Jarvis ou Drive)
    const avant = empreinte(etat.doc);
    etat.doc = normaliser(doc); appliquerFixes(etat.doc);
    if (empreinte(etat.doc) !== avant) { ls.set(cle(), JSON.stringify(etat.doc)); rendre(); return true; }
    return false;
  }

  // ============================================================ JARVIS (Yanis seulement)
  let minuteurJarvis = null, envoiEnCours = false, premierTirage = true;
  async function detecterJarvis() {
    if (!SUR_JARVIS) return false;   // GitHub Pages / Netlify : jamais les données de Yanis
    try {
      const r = await fetch(`${API}/moi`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) return false;
      const d = await r.json();
      if (!d.proprietaire) return false;
      etat.proprio = true; etat.nom = d.nom || 'Yanis';
      return true;
    } catch { return false; }
  }
  async function tirerJarvis() {
    if (!etat.proprio || envoiEnCours) return;
    try {
      const r = await fetch(`${API}/donnees`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(r.status);
      const serveur = await r.json();
      const fus = fusionner(etat.doc, serveur);
      const nouveau = remplacer(fus);
      if (empreinte(normaliser(serveur)) !== empreinte(etat.doc)) pousserJarvis();
      pastilleJarvis(true, nouveau && !premierTirage);
      premierTirage = false;
    } catch { pastilleJarvis(false); }
  }
  async function pousserJarvis() {
    if (!etat.proprio) return;
    envoiEnCours = true;
    try {
      const r = await fetch(`${API}/donnees`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(etat.doc) });
      if (!r.ok) throw new Error(r.status);
      remplacer(fusionner(etat.doc, await r.json()));
      pastilleJarvis(true);
      majDrivePastille('☁️ Drive : Jarvis s\'en occupe', 'ar-ok');
    } catch { pastilleJarvis(false); } finally { envoiEnCours = false; }
  }
  function pastilleJarvis(ok, nouveau = false) {
    const p = $('#ar-etat-jarvis'); p.hidden = false;
    p.textContent = ok ? '🧠 Jarvis relié' : '🧠 Jarvis injoignable';
    p.className = `ar-pastille ${ok ? 'ar-ok' : 'ar-attention'}`;
    if (nouveau) toast('🧠 Nouvelles opérations reçues de Jarvis (chat ou téléphone).');
  }

  // ============================================================ GOOGLE DRIVE (chaque personne : SON Drive)
  let clientJeton = null, minuteurDrive = null;
  const jetonValide = () => etat.jeton && etat.jeton.exp > now() + 60000;
  function majDrivePastille(texte, cls = '') { const p = $('#ar-etat-drive'); p.textContent = texte; p.className = `ar-pastille ${cls}`; }
  function initGoogle(essai = 0) {
    if (!window.google?.accounts?.oauth2) { if (essai < 40) setTimeout(() => initGoogle(essai + 1), 250); return; }
    clientJeton = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPES,
      callback: (rep) => { if (rep?.access_token) apresJeton(rep); },
      error_callback: (e) => toast(`Connexion Google annulée (${e?.type || 'erreur'}).`),
    });
  }
  function connecterGoogle(choisir = false) {
    if (!clientJeton) { toast('Google n\'est pas encore chargé : réessaie dans 2 secondes.'); initGoogle(); return; }
    clientJeton.requestAccessToken({ prompt: choisir ? 'select_account' : '' });
  }
  async function gfetch(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${etat.jeton.t}` } });
    if (r.status === 401) { etat.jeton = null; ls.del('argent3:jeton'); majCompte(); throw new Error('jeton expiré'); }
    return r;
  }
  async function apresJeton(rep) {
    etat.jeton = { t: rep.access_token, exp: now() + (rep.expires_in || 3600) * 1000 };
    try {
      const r = await gfetch('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId)');
      const u = (await r.json()).user || {};
      etat.compte = { nom: u.displayName || u.emailAddress || 'Compte Google', mail: u.emailAddress || '', id: u.permissionId || 'inconnu' };
    } catch { etat.compte = { nom: 'Compte Google', mail: '', id: 'inconnu' }; }
    ls.set('argent3:jeton', JSON.stringify({ ...etat.jeton, compte: etat.compte }));
    if (!etat.proprio) {
      const local = etat.ns === 'local' ? etat.doc : null;
      charger(`g:${etat.compte.id}`);
      if (local && (local.op.length || local.fix.length || local.etabli.categories.length)) {   // ce qui a été saisi avant la connexion
        etat.doc = fusionner(etat.doc, local); ls.del('argent3:local');
      }
      ls.set(cle(), JSON.stringify(etat.doc));
      rendre();
    }
    majCompte();
    await synchroDrive();
  }
  async function trouverFichier() {
    const c = `argent3:fichier:${etat.compte?.id}`;
    let id = ls.get(c);
    if (id) return id;
    const q = encodeURIComponent(`name='${NOM_DRIVE}' and trashed=false`);
    const r = await gfetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&orderBy=modifiedTime%20desc&fields=files(id)`);
    id = (await r.json()).files?.[0]?.id || null;
    if (id) ls.set(c, id);
    return id;
  }
  async function synchroDrive() {
    if (etat.proprio) return;   // Yanis : Jarvis synchronise lui-même SON Drive (même page fermée)
    if (!jetonValide()) { if (etat.compte) majDrivePastille('☁️ Reconnecte Google', 'ar-attention'); return; }
    majDrivePastille('☁️ Synchro…');
    try {
      let id = await trouverFichier(), distant = {};
      if (id) {
        const r = await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
        if (r.status === 404) { ls.del(`argent3:fichier:${etat.compte?.id}`); id = null; } else distant = await r.json().catch(() => ({}));
      }
      const fus = fusionner(etat.doc, distant);
      appliquerFixes(fus);
      remplacer(fus);
      const corps = JSON.stringify(versDrive(etat.doc));
      if (!id) {
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify({ name: NOM_DRIVE, mimeType: 'application/json' })], { type: 'application/json' }));
        form.append('file', new Blob([corps], { type: 'application/json' }));
        const r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form });
        const d = await r.json(); if (d.id) ls.set(`argent3:fichier:${etat.compte?.id}`, d.id);
      } else if (empreinte(normaliser(distant)) !== empreinte(etat.doc)) {
        await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: corps });
      }
      majDrivePastille(`☁️ Drive à jour ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`, 'ar-ok');
    } catch (e) {
      majDrivePastille(jetonValide() ? '☁️ Drive : erreur, je réessaie' : '☁️ Reconnecte Google', 'ar-attention');
      console.warn('Drive', e);
    }
  }
  function planifierSynchro() {
    if (etat.proprio) { clearTimeout(minuteurJarvis); minuteurJarvis = setTimeout(pousserJarvis, 700); return; }
    clearTimeout(minuteurDrive); minuteurDrive = setTimeout(synchroDrive, 2500);
  }
  function majCompte() {
    const g = $('#ar-google'), moi = $('#ar-moi');
    if (etat.proprio) {
      g.hidden = true; moi.hidden = false; $('#ar-moi-nom').textContent = `👋 ${etat.nom}`; $('#ar-deco').hidden = true;
      return;
    }
    if (etat.compte && jetonValide()) {
      g.hidden = true; moi.hidden = false; $('#ar-moi-nom').textContent = `👋 ${etat.compte.nom}`; $('#ar-deco').hidden = false;
      $('#ar-bandeau').hidden = true;
    } else {
      g.hidden = false; moi.hidden = !etat.compte;
      g.querySelector('span').textContent = etat.compte ? 'Reconnecter Google' : 'Connexion Google';
      if (etat.compte) { $('#ar-moi-nom').textContent = `👋 ${etat.compte.nom}`; $('#ar-deco').hidden = false; }
      const b = $('#ar-bandeau');
      if (!etat.compte) {
        b.innerHTML = '🔐 <b>Connecte-toi avec Google</b> pour sauvegarder automatiquement sur <b>TON</b> Google Drive (privé : personne d\'autre ne voit tes chiffres). '
          + 'Sans connexion, tout reste dans ce navigateur.';
        b.hidden = false;
      }
    }
  }
  function deconnecter() {
    const oublier = confirm('Se déconnecter.\n\nOK = oublier aussi tes chiffres sur CET appareil (ils restent sur ton Google Drive).\nAnnuler = les garder ici.');
    if (etat.jeton?.t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(etat.jeton.t, () => {});
    if (oublier) { ls.del(cle()); ls.del(`argent3:fichier:${etat.compte?.id}`); }
    etat.jeton = null; etat.compte = null; ls.del('argent3:jeton');
    charger('local'); majCompte(); majDrivePastille('☁️ Local'); rendre();
  }

  // ============================================================ calculs
  const typeSigne = (o) => (o.type === 'revenu' ? 1 : -1);
  function totaux(ops) {
    const t = { entrees: 0, sorties: 0, fixRev: 0, fixDep: 0, varRev: 0, varDep: 0 };
    for (const o of ops) {
      if (interne(o)) continue;   // retrait / dépôt d'espèces : ni entrée ni sortie
      if (o.type === 'revenu') { t.entrees += o.amount; if (o.isAuto) t.fixRev += o.amount; else t.varRev += o.amount; }
      else { t.sorties += o.amount; if (o.isAuto) t.fixDep += o.amount; else t.varDep += o.amount; }
    }
    t.solde = t.entrees - t.sorties;
    return t;
  }
  const items = () => etat.doc.etabli.categories.flatMap((c) => c.items.map((i) => ({ ...i, dossier: c })));
  const prixPaye = (i) => (i.prix_reel !== undefined && i.prix_reel !== null ? nombre(i.prix_reel) : nombre(i.price));

  // ============================================================ rendu : CALENDRIER & BUDGET
  let calendrier = null;
  // module 1/7 : SOLDE RÉEL = seulement les opérations dont la date est arrivée ; le futur est « ⏳ prévu »
  const estPrevu = (o, a = aujIso()) => o.date > a;
  function previsionnelFinMois(doc, a = aujIso()) {
    const m = a.slice(0, 7), fin = `${m}-${pad(dernierJour(m))}`;
    let s = soldeBanque(doc, a);
    for (const o of doc.op) if (o.date > a && o.date <= fin && !estLiquide(doc, o)) s += typeSigne(o) * o.amount;
    for (const f of doc.fix) {
      const j = `${m}-${pad(Math.min(f.day, dernierJour(m)))}`;
      if (j > a && (f.debut || '0000-00') <= m && !(`auto_${f.id}_${m}` in doc.supprimes) && !doc.op.some((o) => o.fixedId === f.id && o.date.startsWith(m))) s += f.type === 'revenu' ? f.amount : -f.amount;
    }
    return Math.round(s * 100) / 100;
  }
  function rendreBudget() {
    const doc = etat.doc, m = etat.mois, a = aujIso(), aujD = dateParis();
    const duMois = doc.op.filter((o) => o.date.startsWith(m));
    const tm = totaux(duMois.filter((o) => o.date <= a)), tp = totaux(duMois.filter((o) => o.date > a)), tout = totaux(doc.op.filter((o) => o.date <= a));
    const titre = m === moisDe(aujD) ? 'du mois' : `de ${nomMois(m).split(' ')[0]}`;
    const futur = m > a.slice(0, 7);
    $('#w-in-titre').textContent = `Entrées ${titre}${futur ? ' (prévues)' : ''}`; $('#w-out-titre').textContent = `Sorties ${titre}${futur ? ' (prévues)' : ''}`;
    $('#w-mois-titre').textContent = `Résultat ${titre}`;
    const vin = futur ? tp.entrees : tm.entrees, vout = futur ? tp.sorties : tm.sorties;
    $('#w-in').textContent = eur(vin, true); $('#w-out').textContent = `− ${eur(vout)}`;
    $('#w-in-det').textContent = `fixes ${eur(futur ? tp.fixRev : tm.fixRev)} · variables ${eur(futur ? tp.varRev : tm.varRev)}` + (!futur && tp.entrees ? ` · ⏳ +${eur(tp.entrees)} prévus` : '');
    $('#w-out-det').textContent = `fixes ${eur(futur ? tp.fixDep : tm.fixDep)} · variables ${eur(futur ? tp.varDep : tm.varDep)}` + (!futur && tp.sorties ? ` · ⏳ −${eur(tp.sorties)} prévus` : '');
    const res = futur ? tp.solde : tm.solde;
    const wm = $('#w-mois'); wm.textContent = eur(res, true); wm.classList.toggle('ar-negatif', res < 0);
    $('#w-mois-det').textContent = futur ? `${nomMois(m)} — tout est encore prévu` : (tp.entrees || tp.sorties ? `déjà passé · ${nomMois(m)}` : nomMois(m));
    const banque = soldeBanque(doc, a);
    $('#w-rav').textContent = eur(banque);
    $('.ar-w-rav').classList.toggle('ar-negatif', banque < 0);
    const pf = previsionnelFinMois(doc, a);
    $('#w-rav-det').textContent = `Prévisionnel fin de mois : ${eur(pf)}`;
    $('#w-rav-det').title = 'Ce qu\'il restera une fois passées les opérations prévues et les fixes à venir de ce mois (indicatif).';
    rendreComptes();

    // fixes
    const fr = doc.fix.filter((f) => f.type === 'revenu').reduce((s, f) => s + f.amount, 0), fd = doc.fix.filter((f) => f.type !== 'revenu').reduce((s, f) => s + f.amount, 0);
    $('#fixes-net').textContent = `+${eur(fr)} / −${eur(fd)} = ${eur(fr - fd, true)} par mois`;
    const auj = aujD;
    $('#fixes-liste').innerHTML = doc.fix.length ? [...doc.fix].sort((a, b) => a.day - b.day).map((f) => {
      const j = Math.min(f.day, dernierJour(moisDe(auj))), passe = doc.op.some((o) => o.fixedId === f.id && o.date.startsWith(moisDe(auj)));
      const dans = j - auj.getDate();
      const statut = passe ? `✅ passé le ${j}` : dans > 0 ? `⏳ dans ${dans} j` : '⏳ aujourd\'hui';
      return `<li><span class="ar-jour">${f.day}<small>du mois</small></span><span><b>${E(f.desc)}</b><br><span class="ar-statut">${statut}</span></span>
        <span class="${f.type === 'revenu' ? 'ar-montant-v' : 'ar-montant-r'}">${f.type === 'revenu' ? '+' : '−'}${eur(f.amount)}</span>
        <button class="ar-x" type="button" data-suppr-fixe="${E(f.id)}" title="Arrêter ce fixe (les mois passés restent)">✕</button></li>`;
    }).join('') : '<li class="ar-petit">Aucun fixe : ajoute ton alternance, ton assurance, tes abonnements…</li>';
    $('#var-net').textContent = `${nomMois(m)} : +${eur(tm.varRev)} / −${eur(tm.varDep)}`;
    rendreHisto();
    if (calendrier) { calendrier.removeAllEvents(); calendrier.addEventSource(evenements()); }
  }
  const SOURCES = { chat: '💬', telephone: '📱', 'page-texte': '💬', jarvis: '🧠' };
  function rendreHisto() {
    const mot = $('#histo-mot').value.trim().toLowerCase(), mois = $('#histo-mois').value;
    const ops = etat.doc.op.filter((o) => (!mois || o.date.startsWith(mois)) && (!mot || `${o.desc} ${o.amount} ${o.method}`.toLowerCase().includes(mot)))
      .sort((a, b) => (a.date + a.id < b.date + b.id ? 1 : -1));
    const t = ops.reduce((s, o) => s + typeSigne(o) * o.amount, 0);
    $('#histo-total').textContent = `${ops.length} opération(s) · total ${eur(t, true)}`;
    const a = aujIso();
    $('#histo-lignes').innerHTML = ops.slice(0, 400).map((o) => `<tr class="${estPrevu(o, a) ? 'ar-ligne-prevue' : ''}"><td>${E(o.date.split('-').reverse().join('/'))}<br>${
      estPrevu(o, a) ? '<span class="ar-statut-op ar-prevu" title="Date pas encore arrivée : ne compte pas dans ton solde réel">⏳ Prévu</span>'
        : `<span class="ar-statut-op ar-passe">✅ ${o.type === 'revenu' ? 'Encaissé' : 'Débité'}</span>`}</td>
      <td><b>${E(o.desc)}</b>${SOURCES[o.source] ? `<span class="ar-src" title="Ajouté par Jarvis (${E(o.source)})">${SOURCES[o.source]}</span>` : ''}</td>
      <td><span class="ar-badge">${E(o.method)}</span></td>
      <td class="${o.type === 'revenu' ? 'ar-montant-v' : 'ar-montant-r'}">${o.type === 'revenu' ? '+' : '−'}${eur(o.amount)}</td>
      <td><button class="ar-x" type="button" data-suppr-op="${E(o.id)}" title="Supprimer">✕</button></td></tr>`).join('');
  }
  function evenements() {
    const a = aujIso();
    const ev = etat.doc.op.map((o) => {
      const prevu = estPrevu(o, a);
      return { id: o.id, title: `${prevu ? '⏳ ' : ''}${o.type === 'revenu' ? '+' : '−'}${o.amount.toLocaleString('fr-FR')}€ ${o.desc}`, start: o.date,
        color: prevu ? (o.type === 'revenu' ? '#2c6f67' : '#8a4a52') : o.isAuto ? (o.type === 'revenu' ? '#1f8f80' : '#b8505a') : (o.type === 'revenu' ? '#2fb6a5' : '#ff6b6b'),
        classNames: prevu ? ['ar-ev-prevu'] : [], extendedProps: { genre: 'op', prevu } };
    });
    const auj = dateParis(), m = moisDe(auj), ms = moisSuivant(m);
    for (const f of etat.doc.fix) {
      for (const mm of [m, ms]) {
        const j = Math.min(f.day, dernierJour(mm));
        if (mm === m && (j <= auj.getDate() || etat.doc.op.some((o) => o.fixedId === f.id && o.date.startsWith(mm)))) continue;
        ev.push({ id: `prev_${f.id}_${mm}`, title: `⏳ ${f.type === 'revenu' ? '+' : '−'}${f.amount.toLocaleString('fr-FR')}€ ${f.desc}`, start: `${mm}-${pad(j)}`, color: '#5b616d', extendedProps: { genre: 'prevu' } });
      }
    }
    for (const i of items()) if (i.date && !i.checked) ev.push({ id: `eta_${i.id}`, title: `📌 ${i.name.trim()} (${i.price || 'prix ?'})`, start: i.date, color: '#9b6bff', extendedProps: { genre: 'etabli' } });
    return ev;
  }
  const FR = { code: 'fr', week: { dow: 1, doy: 4 }, buttonText: { prev: '‹', next: '›', today: "Aujourd'hui", month: 'Mois', week: 'Semaine', day: 'Jour', list: 'Liste' },
    weekText: 'Sem.', allDayText: 'Journée', moreLinkText: (n) => `+ ${n} autres`, noEventsText: 'Rien ce jour-là' };
  function initCalendrier(essai = 0) {
    if (!window.FullCalendar) { if (essai < 40) setTimeout(() => initCalendrier(essai + 1), 250); else $('#cal-repli').hidden = false; return; }
    calendrier = new FullCalendar.Calendar($('#calendrier'), {
      initialView: 'dayGridMonth', locales: [FR], locale: 'fr', height: 'auto', fixedWeekCount: false, dayMaxEvents: 4,
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,listMonth' }, buttonText: { listMonth: 'Liste' },
      events: evenements(),
      datesSet: (info) => { const m = moisDe(new Date(info.view.currentStart)); if (m !== etat.mois) { etat.mois = m; rendreBudget(); } },
      dateClick: (info) => { $('#op-date').value = info.dateStr; $('#op-desc').focus(); toast(`📅 ${info.dateStr.split('-').reverse().join('/')} : écris l'opération dans « Variables ».`, 2500); },
      eventClick: (info) => clicEvenement(info.event, info.jsEvent),
    });
    calendrier.render();
  }
  function clicEvenement(ev, e) {
    const g = ev.extendedProps.genre;
    if (g === 'etabli') { basculer('etabli'); return; }
    if (g === 'prevu') { toast('⏳ Fixe à venir : il sera inscrit tout seul le jour venu.'); return; }
    const o = etat.doc.op.find((x) => x.id === ev.id); if (!o) return;
    const st = estPrevu(o) ? `⏳ Prévu le ${dateFr(o.date)} (pas encore dans ton solde réel)` : `✅ ${o.type === 'revenu' ? 'Encaissé' : 'Débité'} le ${dateFr(o.date)}`;
    menu(e, [[st, () => {}], [`🗑️ Supprimer « ${o.desc} » (${eur(o.amount)})`, () => supprimerOp(o.id)], ['✕ Fermer', () => {}]]);
  }

  // ============================================================ actions : budget
  function ajouterOp(e) {
    e.preventDefault();
    const montant = nombre($('#op-montant').value), desc = $('#op-desc').value.trim(), date = $('#op-date').value;
    if (!date || !desc || !(montant > 0)) { toast('Remplis la date, la description et un montant.'); return; }
    etat.doc.op.push({ id: uid('op'), date, type: $('#op-type').value, method: $('#op-methode').value, desc, amount: Math.round(montant * 100) / 100, maj: now() });
    $('#op-desc').value = ''; $('#op-montant').value = '';
    enregistrer(); toast(`✅ ${$('#op-type').value === 'revenu' ? '+' : '−'}${eur(montant)} « ${desc} » ajouté.`);
  }
  function ajouterFixe(e) {
    e.preventDefault();
    const jour = parseInt($('#fix-jour').value, 10), desc = $('#fix-desc').value.trim(), montant = nombre($('#fix-montant').value);
    if (!(jour >= 1 && jour <= 31) || !desc || !(montant > 0)) { toast('Jour (1-31), description et montant valides.'); return; }
    etat.doc.fix.push({ id: uid('fix'), type: $('#fix-type').value, day: jour, desc, amount: Math.round(montant * 100) / 100, debut: moisDe(), maj: now() });
    $('#fix-desc').value = ''; $('#fix-montant').value = ''; $('#fix-jour').value = '';
    appliquerFixes(etat.doc); enregistrer(); toast(`🔁 « ${desc} » ajouté : chaque mois le ${jour}.`);
  }
  function supprimerOp(id) {
    const o = etat.doc.op.find((x) => x.id === id); if (!o) return;
    if (!confirm(`Supprimer « ${o.desc} » (${eur(o.amount)}, ${o.date}) ?`)) return;
    const t = now(); etat.doc.supprimes[id] = t;
    if (o.isAuto && o.fixedId) etat.doc.supprimes[`auto_${o.fixedId}_${o.date.slice(0, 7)}`] = t;
    etat.doc.op = etat.doc.op.filter((x) => x.id !== id); enregistrer();
  }
  function supprimerFixe(id) {
    const f = etat.doc.fix.find((x) => x.id === id); if (!f) return;
    if (!confirm(`Arrêter le fixe « ${f.desc} » ? (les mois déjà passés restent dans l'historique)`)) return;
    etat.doc.supprimes[id] = now(); etat.doc.fix = etat.doc.fix.filter((x) => x.id !== id); enregistrer();
  }
  // ============================================================ ASSISTANT JARVIS (session 9 : Yanis ET les visiteurs, ex. Ambre)
  // PC de Yanis allumé → /ping répond → 🟢 ; la phrase part à Jarvis qui COMPREND seulement (/analyser : rien chez Yanis) et
  // renvoie des actions appliquées ICI, dans les données du visiteur (son navigateur + SON Drive). PC éteint → 🌙, saisie à la main.
  // Yanis sur son Jarvis : /texte (chat complet, ses données à lui, comme avant).
  const assistant = { enLigne: null };
  const md = (t) => E(t || '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  const cleDerniers = () => `argent3:assist:${etat.ns}`;
  function majAssistant(ok) {
    if (assistant.enLigne === ok) return;
    assistant.enLigne = ok;
    const p = $('#as-etat'), champ = $('#as-texte');
    p.textContent = ok ? '🟢 Assistant Jarvis connecté' : '🌙 Jarvis se repose (PC éteint) — je comprends les phrases simples';
    p.className = `ar-pastille ${ok ? 'ar-ok' : 'ar-repos'}`;
    champ.disabled = false; $('#form-assistant button').disabled = false;   // module 1/7 : hors ligne, le moteur local répond
    champ.placeholder = ok ? '🧠 Demander à Jarvis… « Supprime tout le budget sauf L\'Établi », « Combien il me restera le 10 décembre ? »'
      : '🌙 Phrases simples : « 45 € d\'essence », « je paierai 50 € le 5 décembre », « j\'ai 500 € sur mon Livret A »';
  }
  async function pingJarvis() {
    if (etat.proprio) { majAssistant(true); return; }
    const ctl = new AbortController(), minu = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(`${API}/ping`, { signal: ctl.signal, cache: 'no-store' });
      majAssistant(r.ok && (await r.json()).ok === true);
    } catch { majAssistant(false); } finally { clearTimeout(minu); }
  }
  function appliquerActions(actions) {
    const derniers = lireJson(ls.get(cleDerniers()), []);
    let n = 0, vue = null, texte = '';
    for (const a of actions) {
      if (a.type === 'op') {
        const o = normOp({ ...a.op, id: uid('op'), source: 'jarvis', ajoute: new Date().toISOString(), maj: now() });
        if (o) { etat.doc.op.push(o); derniers.push(o.id); n++; vue = 'calendrier'; }
      } else if (a.type === 'etabli') {
        const cats = etat.doc.etabli.categories, voulu = String(a.dossier || '').toLowerCase().trim();
        let c = (voulu && cats.find((x) => x.title.toLowerCase().includes(voulu))) || (!voulu && cats[0]) || null;
        if (!c) {
          c = { id: uid('cat'), title: (a.dossier || 'Achats').slice(0, 40), icon: voulu ? '📁' : '🛒', color: '#f2a93b', items: [], maj: now(), ordre: cats.length };
          cats.push(c);
        }
        c.items.push({ id: uid('i'), name: String(a.nom || 'Nouveau').slice(0, 80), price: a.prix || '0 €', checked: false, date: '', cat: c.id, maj: now(), ordre: c.items.length });
        n++; vue = 'etabli';
      } else if (a.type === 'annuler' || a.type === 'methode') {
        const id = [...derniers].reverse().find((x) => etat.doc.op.some((o) => o.id === x));
        const o = id && etat.doc.op.find((x) => x.id === id);
        if (!o) { texte = 'Je ne trouve pas d\'opération récente ajoutée par Jarvis sur cette page.'; continue; }
        if (a.type === 'annuler') { etat.doc.supprimes[o.id] = now(); etat.doc.op = etat.doc.op.filter((x) => x.id !== o.id); derniers.splice(derniers.indexOf(o.id), 1); }
        else { o.method = a.methode; o.maj = now(); }
        n++;
      } else if (a.type === 'fixe') {   // session 10 : revenu / charge FIXE compris par Jarvis
        const f = a.fixe || {};
        etat.doc.fix.push({ id: uid('fix'), type: f.type === 'revenu' ? 'revenu' : 'depense', day: Math.max(1, Math.min(31, parseInt(f.day, 10) || 1)), desc: String(f.desc || 'Fixe').slice(0, 120), amount: Math.round(nombre(f.amount) * 100) / 100, debut: moisDe(), maj: now() });
        n++; vue = 'calendrier';
      } else if (a.type === 'archiver') {   // session 10 : « j'ai enfin acheté le casque » → archivé
        const voulu = String(a.nom || '').toLowerCase().trim();
        let trouve = null;
        for (const c of etat.doc.etabli.categories) for (const i of c.items) if (!trouve && !i.checked && voulu && (i.name.toLowerCase().includes(voulu) || voulu.includes(i.name.toLowerCase().trim()))) trouve = i;
        if (!trouve) { texte = `Je ne trouve pas « ${a.nom} » dans ton Établi.`; continue; }
        const prix = a.prix != null ? nombre(a.prix) : nombre(trouve.price);
        Object.assign(trouve, { checked: true, achat: iso(), prix_reel: prix, maj: now() });
        if (prix > 0) etat.doc.op.push({ id: uid('op'), date: iso(), type: 'depense', method: 'CB', desc: trouve.name.trim(), amount: prix, etabliId: trouve.id, source: 'jarvis', maj: now() });
        n++; vue = 'etabli';
      } else if (a.type === 'resume') {
        texte = `💰 Reste à vivre : **${$('#w-rav').textContent}** · résultat du mois : ${$('#w-mois').textContent}.`;
      }
    }
    ls.set(cleDerniers(), JSON.stringify(derniers.slice(-20)));
    if (n) enregistrer();
    if (vue && vue !== etat.vue) basculer(vue);
    return texte;
  }
  // ------------------------------------------------------------ module 1/7 : le VRAI cerveau (PC allumé) + moteur local (éteint)
  // Yanis : /texte (SES données, le Core exécute) ; visiteur : /analyser avec SON budget (le Core le renvoie modifié,
  // rien n'est gardé sur le PC). Plan avec ≥ 3 suppressions → bouton « ✅ Confirmer la suppression de X éléments ».
  let derniereAnnulation = null, minuteurReflexion = null, annulLocal = null;
  function boutons(ret, liste) {
    const zone = document.createElement('span'); zone.className = 'ar-as-boutons';
    for (const [t, f, cls] of liste) {
      const b = document.createElement('button'); b.type = 'button'; b.className = `ar-btn ${cls || ''}`; b.textContent = t;
      b.addEventListener('click', async () => { zone.querySelectorAll('button').forEach((x) => { x.disabled = true; }); try { await f(); } catch { finReflexion(); $('#as-retour').textContent = 'Jarvis ne répond pas.'; } });
      zone.append(b);
    }
    ret.append(zone);
  }
  function reflechit(ret) {
    let s = 0; clearInterval(minuteurReflexion);
    ret.innerHTML = '<span class="ar-reflechit">🧠 Jarvis réfléchit…</span>';
    minuteurReflexion = setInterval(() => { s++; ret.innerHTML = `<span class="ar-reflechit">🧠 Jarvis réfléchit… ${s} s</span>`; }, 1000);
  }
  function finReflexion() { clearInterval(minuteurReflexion); }
  async function envoyer(corps) {
    const ctl = new AbortController(), minu = setTimeout(() => ctl.abort(), 180000);
    try {
      if (etat.proprio) {
        const r = await fetch(`${API}/texte`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps), signal: ctl.signal });
        return await r.json();
      }
      const r = await fetch(`${API}/analyser`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...corps, jeton: etat.jeton.t, doc: etat.doc }), signal: ctl.signal });
      return await r.json();
    } finally { clearTimeout(minu); }
  }
  async function afficherReponse(d, ret, champ) {
    finReflexion();
    ret.innerHTML = md((d.texte || d.erreur || 'Jarvis n\'a rien répondu.').replace(/\n\n\[[^\]]+\]\([^)]+\)/g, ''));
    if (d.doc && !etat.proprio) { remplacer(fusionner(etat.doc, d.doc)); enregistrer(); }
    else if (Array.isArray(d.actions) && d.actions.length) appliquerActions(d.actions);   // ancien format (serveur pas à jour)
    if (d.ok && etat.proprio) await tirerJarvis();
    if (d.confirmer && typeof d.confirmer === 'object') {
      boutons(ret, [[d.confirmer.bouton || '✅ Oui, fais-le', async () => { reflechit(ret); await afficherReponse(await envoyer({ plan_id: d.confirmer.plan_id }), ret, champ); }, 'ar-btn-or'],
        ['Non, laisse', async () => { ret.textContent = 'D\'accord : je ne touche à rien.'; }]]);
      return;
    }
    if (d.ok && d.annulable) {
      derniereAnnulation = d.annulation || null;
      boutons(ret, [['↩️ Annuler', async () => { reflechit(ret); await afficherReponse(await envoyer(etat.proprio ? { annuler: true } : { annulation: derniereAnnulation }), ret, champ); }]]);
    }
    if (d.ok) champ.value = '';
  }
  async function demanderJarvis(e) {
    e.preventDefault();
    const champ = $('#as-texte'), ret = $('#as-retour'), t = champ.value.trim(); if (!t) return;
    const local = (pourquoi) => {
      const x = moteurLocal(t);
      if (!x) { ret.innerHTML = md(`${pourquoi}\nJe ne comprends que les phrases simples : « 45 € d'essence », « j'ai reçu 150 € », « je paierai 50 € le 5 décembre », « j'ai 500 € sur mon Livret A ».`); return; }
      const lignes = x.faire(); enregistrer(); champ.value = '';
      ret.innerHTML = md(`${pourquoi}\n${lignes.join('\n')}`);
      boutons(ret, [['↩️ Annuler', async () => { annulerLocal(); ret.textContent = '↩️ Annulé.'; }]]);
    };
    if (!etat.proprio && !assistant.enLigne) { local('🌙 Jarvis se repose (PC éteint) : compris sur ta page.'); return; }
    if (!etat.proprio && !jetonValide()) { local('🔐 Connecte ton compte **Google** (en haut) pour le vrai cerveau de Jarvis. En attendant, compris sur ta page :'); return; }
    reflechit(ret);
    try { await afficherReponse(await envoyer({ texte: t }), ret, champ); }
    catch { finReflexion(); if (!etat.proprio) { majAssistant(false); local('Jarvis ne répond plus (PC éteint ?) : compris sur ta page.'); } else ret.textContent = 'Jarvis ne répond pas.'; }
  }

  // ------------------------------------------------------------ moteur LOCAL (PC éteint) : mêmes règles de dates que le serveur
  const sansAcc = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/’/g, "'");
  const MOIS_RE = '(janv(?:ier)?|fev(?:r(?:ier)?)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|aout|sept(?:embre)?|oct(?:obre)?|nov(?:embre)?|dec(?:embre)?)\\b\\.?';
  const JOURS_SEM = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  const NOMBRES = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, quinze: 15, vingt: 20, trente: 30 };
  const nMois = (m) => (m.startsWith('juin') ? 6 : m.startsWith('juil') ? 7 : { jan: 1, fev: 2, mar: 3, avr: 4, mai: 5, aou: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[m.slice(0, 3)]);
  const jourOk = (a, m, j) => new Date(a, m - 1, Math.min(Math.max(1, j), new Date(a, m, 0).getDate()));
  const plusMois = (d, n) => { const t = d.getMonth() + n; return jourOk(d.getFullYear() + Math.floor(t / 12), ((t % 12) + 12) % 12 + 1, d.getDate()); };
  const plusJours = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const ecart = (x, y) => Math.round((x - y) / 86400000);
  const isoD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function tempsDe(b) {
    const f = /\b(je vais|vais|devrai[st]?|dois|doit|faudra|faut que|il faut|prevue?s?|planifi\w*|programm\w*|a payer|a regler|paierai|payerai|reglerai|verserai|recevrai|toucherai|prochain|prochaine|demain|apres.demain|dans \w+ (jours?|semaines?|mois)|bientot|echeance|a venir)\b/.test(b);
    const p = /\b(hier|avant.hier|dernier|derniere|il y a|deja|ce matin|ce midi|j'?\s?ai (paye|depense|achete|regle|recu|touche|vire|verse|mis|donne|rembourse|eu))\b/.test(b);
    if (f && !p) return 'futur'; if (p && !f) return 'passe'; if (f && p) return 'auto';
    return /\b(j'?\s?ai|j ai|jai|on a)\b/.test(b) ? 'passe' : 'auto';
  }
  function choisir(c, auj, t, ref) {
    if (ref) return c.reduce((x, y) => (Math.abs(ecart(y, ref)) < Math.abs(ecart(x, ref)) ? y : x));
    if (t === 'futur') { const a = c.filter((d) => d >= auj); return a.length ? a[0] : c[c.length - 1]; }
    if (t === 'passe') { const a = c.filter((d) => d <= auj); return a.length ? a[a.length - 1] : c[0]; }
    return c.reduce((x, y) => { const dx = Math.abs(ecart(x, auj)), dy = Math.abs(ecart(y, auj)); return dy < dx || (dy === dx && y > x) ? y : x; });
  }
  function resoudreDate(texte, auj = dateParis(), temps = null, ref = null) {
    const b = sansAcc(texte), t = temps || tempsDe(b); let m;
    if ((m = b.match(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/))) return new Date(+m[1], +m[2] - 1, +m[3]);
    if ((m = b.match(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(20\d\d|\d\d)\b/))) return new Date(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1]);
    if ((m = b.match(new RegExp(`\\b(\\d{1,2})(?:er|e|eme)?\\s+(?:du mois (?:de |d')?|de )?${MOIS_RE}\\s+(20\\d\\d)\\b`)))) return new Date(+m[3], nMois(m[2]) - 1, +m[1]);
    if ((m = b.match(new RegExp(`\\b(\\d{1,2})(?:er|e|eme)?\\s+(?:du mois (?:de |d')?|de )?${MOIS_RE}(?:\\s+(prochain|dernier))?`)))) {
      const tt = m[3] === 'prochain' ? 'futur' : m[3] === 'dernier' ? 'passe' : t, base = ref || auj;
      return choisir([-1, 0, 1].map((k) => jourOk(base.getFullYear() + k, nMois(m[2]), +m[1])), auj, tt, ref);
    }
    if ((m = b.match(/(?:\ble |\bdu |\bau |\bpour le |^)\s*(\d{1,2})\s*\/\s*(\d{1,2})\b(?!\s*\/)/)) && +m[2] >= 1 && +m[2] <= 12) {
      const base = ref || auj; return choisir([-1, 0, 1].map((k) => jourOk(base.getFullYear() + k, +m[2], +m[1])), auj, t, ref);
    }
    if ((m = b.match(/\b(debut|fin)\s+(?:du mois\s+)?(prochain|dernier)\b|\b(debut|fin)\s+(?:du |de )?mois\b/))) {
      const x = plusMois(new Date(auj.getFullYear(), auj.getMonth(), 1), m[2] === 'prochain' ? 1 : m[2] === 'dernier' ? -1 : 0);
      return (m[1] || m[3]) === 'debut' ? x : jourOk(x.getFullYear(), x.getMonth() + 1, 31);
    }
    if ((m = b.match(new RegExp(`\\b(debut|fin|mi)[- ](?:de |d')?${MOIS_RE}`)))) {
      const j = { debut: 1, mi: 15, fin: 31 }[m[1]];
      return choisir([-1, 0, 1].map((k) => jourOk(auj.getFullYear() + k, nMois(m[2]), j)), auj, t, ref);
    }
    if ((m = b.match(/\b(?:le |du |au )?(\d{1,2})(?:er|e|eme)?\s+du mois\s+(prochain|dernier|suivant|precedent)\b/))) {
      const x = plusMois(new Date(auj.getFullYear(), auj.getMonth(), 1), /prochain|suivant/.test(m[2]) ? 1 : -1); return jourOk(x.getFullYear(), x.getMonth() + 1, +m[1]);
    }
    if ((m = b.match(/\b(?:le |au |du )?mois (prochain|suivant|dernier|precedent)\b/))) return plusMois(new Date(auj.getFullYear(), auj.getMonth(), 1), /prochain|suivant/.test(m[1]) ? 1 : -1);
    if (/\bavant.hier\b/.test(b)) return plusJours(auj, -2);
    if (/\bapres.demain\b/.test(b)) return plusJours(auj, 2);
    if (/\bhier\b/.test(b)) return plusJours(auj, -1);
    if (/\bdemain\b/.test(b)) return plusJours(auj, 1);
    if ((m = b.match(new RegExp(`\\b(il y a|dans|d'ici)\\s+(\\d{1,3}|${Object.keys(NOMBRES).join('|')})\\s+(jours?|semaines?|mois|ans?)\\b`)))) {
      const n = Math.min(/^\d+$/.test(m[2]) ? +m[2] : NOMBRES[m[2]], 400), s = m[1] === 'il y a' ? -1 : 1, u = m[3][0];
      return u === 'm' ? plusMois(auj, s * n) : u === 'a' ? plusMois(auj, s * 12 * n) : plusJours(auj, s * n * (u === 's' ? 7 : 1));
    }
    if ((m = b.match(/\b(?:la |cette )?semaine (prochaine|derniere|passee)\b/))) return plusJours(auj, m[1] === 'prochaine' ? 7 : -7);
    if (/\b(aujourd'?\s?hui|ce matin|ce midi|ce soir|maintenant)\b/.test(b)) return auj;
    for (let i = 0; i < 7; i++) {
      m = b.match(new RegExp(`\\b${JOURS_SEM[i]}(?:\\s+(prochain|dernier|passe))?\\b`)); if (!m) continue;
      const w = (auj.getDay() + 6) % 7;
      if (m[1] === 'prochain' || (t === 'futur' && !m[1])) return plusJours(auj, ((i - w + 7) % 7) || 7);
      const e = (w - i + 7) % 7; return plusJours(auj, -(e || (m[1] ? 7 : 0)));
    }
    if ((m = b.match(/(?:\ble |\bdu |\bau |\bpour le )(\d{1,2})(?:er|e|eme)?\b(?!\s*(?:€|euros?\b|eur\b|balles|h\b|heures?|min|%|ans?\b|fois))(?!\s*[/.,]\d)/))) {
      if (ref) return jourOk(ref.getFullYear(), ref.getMonth() + 1, +m[1]);
      return choisir([-1, 0, 1].map((k) => { const x = plusMois(new Date(auj.getFullYear(), auj.getMonth(), 1), k); return jourOk(x.getFullYear(), x.getMonth() + 1, +m[1]); }), auj, t, null);
    }
    return null;
  }
  const RE_MONTANT = /([+-]\s*)?(\d{1,3}(?:[\s  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(€|euros?\b|eur\b|balles\b)(?:\s*(\d{1,2})\b(?!\s*(?:€|euros?|h\b|heures?|min|jours?|mois|ans?|%)))?/;
  const montantDe = (m) => Math.round((+m[2].replace(/[\s  ]/g, '') + (m[3] ? +`0.${m[3].padEnd(2, '0')}` : m[5] ? +`0.${m[5].padEnd(2, '0')}` : 0)) * 100) / 100;
  function moteurLocal(texte) {
    const b = sansAcc(texte), aujD = dateParis(), t = tempsDe(b);
    const nb = (x) => nombre(x);
    let m;
    const garder = (ids, compte) => { annulLocal = { ids, compte }; };
    if ((m = b.match(/(?:j'?\s?ai|il y a|il me reste)\s*(?:sur|dans)\s*(?:mon|le)\s*livret\s*a\s*,?\s*(\d[\d\s.,]*)\s*(?:€|euros?)|(?:j'?\s?ai|il y a|il me reste)\s*(\d[\d\s.,]*)\s*(?:€|euros?)\s*(?:sur|dans)\s*(?:mon|le)\s*livret\s*a\b/))) {
      const v = nb(m[1] || m[2]);
      return { faire: () => { garder([], { nom: 'livret_a', avant: etat.doc.comptes?.livret_a || null }); definirCompte(etat.doc, 'livret_a', v); return [`🏦 Livret A : **${eur(v)}** (à part de ton solde réel).`]; } };
    }
    const date = isoD(resoudreDate(b, aujD, t) || aujD);
    if ((m = b.match(/(?:retire|sorti|sors|recupere|repris|reprends)\s*(\d[\d\s.,]*)\s*(?:€|euros?)\s*(?:de|du|depuis)\s*(?:mon|le)\s*livret/))) {
      const v = nb(m[1]); return { faire: () => { const o = virement(etat.doc, 'livret_a', v, 'depuis', date, 'jarvis'); garder([o.id]); return [`✅ +${eur(v)} du Livret A vers ton compte courant (${dateFr(date)}).`]; } };
    }
    if ((m = b.match(/(?:mis|verse|place|vire|transfere|mets|met|envoie|depose|epargne)\s*(\d[\d\s.,]*)\s*(?:€|euros?).{0,40}?(?:sur|dans|vers|a)\s*(?:mon|le)\s*livret/))) {
      const v = nb(m[1]); return { faire: () => { const o = virement(etat.doc, 'livret_a', v, 'vers', date, 'jarvis'); garder([o.id]); return [`${date > aujIso() ? '⏳ Prévu' : '✅'} −${eur(v)} → Livret A (${dateFr(date)}).`]; } };
    }
    if (!/livret/.test(b)) {   // 11/11 : case « 💵 Argent liquide »
      if ((m = b.match(/(?:depose|remis|remets|verse|mis)\s*(\d[\d\s.,]*)\s*(?:€|euros?)\s*(?:en|d'|de)\s*(?:argent\s*)?(?:liquide|especes?|cash)\s*(?:a|sur|dans)\s*(?:la|ma|mon|le)\s*(?:banque|compte)/))) {
        const v = nb(m[1]); return { faire: () => { const o = virement(etat.doc, 'liquide', v, 'depuis', date, 'jarvis'); garder([o.id]); return [`✅ ${eur(v)} d'espèces déposés à la banque (${dateFr(date)}) → 💵 liquide : **${eur(soldeCompte(etat.doc, 'liquide').solde)}**.`]; } };
      }
      if ((m = b.match(/(?:retire|tire|sorti|sors|pris|preleve)\s*(\d[\d\s.,]*)\s*(?:€|euros?)\s*(?:(?:en|d')\s*(?:argent\s*)?(?:liquide|especes?|cash)|(?:au|a un|a la|du|dans un)\s*(?:distributeur|dab|guichet|banque|tirette))/))) {
        const v = nb(m[1]); return { faire: () => { const o = virement(etat.doc, 'liquide', v, 'vers', date, 'jarvis'); garder([o.id]); return [`${date > aujIso() ? '⏳ Prévu' : '✅'} ${eur(v)} retirés au distributeur (${dateFr(date)}) : −${eur(v)} sur le compte, +${eur(v)} en liquide → 💵 **${eur(soldeCompte(etat.doc, 'liquide').solde)}**.`]; } };
      }
      if (!/\?\s*$/.test(b) && (m = b.match(/(?:j'?\s?ai|il y a|il me reste)\s*(?:en tout\s*)?(\d[\d\s.,]*)\s*(?:€|euros?)\s*(?:en|d'|de)\s*(?:argent\s*)?(?:liquide|especes?|cash|billets?)\b(?!\s*(?:a|au|aux|chez|pour|de|du|d')\b)|(?:j'?\s?ai|il y a|il me reste)\s*(?:en\s*)?(?:argent\s*)?(?:liquide|especes?|cash)\s*,?\s*(\d[\d\s.,]*)\s*(?:€|euros?)/))) {
        const v = nb(m[1] || m[2]);
        return { faire: () => { garder([], { nom: 'liquide', avant: etat.doc.comptes?.liquide || null }); definirCompte(etat.doc, 'liquide', v); return [`💵 Argent liquide : **${eur(v)}** (à part du compte bancaire ; ce que tu paies en espèces sortira de cette case).`]; } };
      }
    }
    if ((m = b.match(/(?:je t'?\s?ai|je te)\s*(?:envoye|envoie|vire|verse|mis|donne|transfere)\s*(\d[\d\s.,]*)\s*(?:€|euros?)/))) {
      const v = nb(m[1]); return { faire: () => { const o = virement(etat.doc, 'jarvis', v, 'vers', date, 'jarvis'); garder([o.id]); return [`🤖 −${eur(v)} → Argent de Jarvis (${dateFr(date)}).`]; } };
    }
    if (/^\s*(annule|annuler|efface)\b/.test(b) && annulLocal) return { faire: () => { annulerLocal(); return ['↩️ Annulé.']; } };
    if (/combien|\?|bitcoin|crypto|bourse|\betf\b|aimerais|voudrais|\bil a\b|\belle a\b|devis/.test(b)) return null;
    const mt = b.match(RE_MONTANT); if (!mt) return null;
    const futurVerbe = /\b(vais|dois|compte|veux|pense)\s+(\w+\s+)?(payer|regler|verser|depenser|acheter)\b|paierai|payerai|reglerai|a payer|prelevement/.test(b);
    if (futurVerbe && date <= aujIso()) return null;   // un projet sans date : je ne devine pas
    const revenu = /\b(recu|touche|gagne|encaisse|vendu|rembourse|salaire|paie\b|virement recu|rentree|recevrai|toucherai)/.test(b) || (mt[1] || '').trim() === '+';
    const v = montantDe(mt);
    if (!(v > 0 && v < 50000)) return null;
    let desc = '';
    const apres = b.slice(mt.index + mt[0].length).replace(/^\s*(?:en (?:liquide|especes?|cash)|par (?:carte|cb|virement|cheque))\b/, '').match(/^\s*(?:d'|de |du |des |pour (?:le |la |les |l')?|chez |au |aux |a la |en (?!liquide|especes|cash|cb|carte))([^,;.!?]{2,40}?)(?=\s+(?:le|la|hier|avant|demain|dans|en|par|avec|et|ce|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b|[,;.!?]|$)/);
    if (apres) desc = apres[1].trim();
    if (!desc) { const av = b.slice(0, mt.index).match(/(?:achete|paye|commande|vendu|regle)\s+(?:un |une |le |la |les |l'|des |du |mon |ma |mes )?(.{2,40}?)\s*(?:a|pour|de)?\s*$/); if (av) desc = av[1].trim(); }
    desc = desc ? desc[0].toUpperCase() + desc.slice(1) : (revenu ? 'Revenu' : 'Dépense');
    const methode = /liquide|espece|cash|billet/.test(b) ? 'Espèces' : /virement|\bvire\b|paypal|lydia|wero/.test(b) ? 'Virement' : /cheque/.test(b) ? 'Chèque' : (revenu ? 'Virement' : 'CB');
    return { faire: () => {
      const tt = now(), o = { id: uid('op'), date, type: revenu ? 'revenu' : 'depense', method: methode, desc, amount: v, source: 'jarvis', ajoute: new Date().toISOString(), cree: tt, maj: tt };
      etat.doc.op.push(o); garder([o.id]);
      return [`${date > aujIso() ? '⏳ Prévu' : '✅'} ${revenu ? '+' : '−'}${eur(v)} « ${desc} » (${methode}) le ${dateFr(date)}${date > aujIso() ? ' — ton solde réel ne bougera qu\'à cette date' : ''}.`];
    } };
  }
  function annulerLocal() {
    if (!annulLocal) return;
    const t = now();
    for (const id of annulLocal.ids || []) { etat.doc.supprimes[id] = t; etat.doc.op = etat.doc.op.filter((o) => o.id !== id); }
    if (annulLocal.compte) {
      const { nom, avant } = annulLocal.compte;
      if (avant) etat.doc.comptes[nom] = { ...avant, maj: t }; else { delete etat.doc.comptes[nom]; etat.doc.supprimes[`compte:${nom}`] = t; }
    }
    annulLocal = null; enregistrer();
  }

  // ------------------------------------------------------------ cases Livret A + Argent de Jarvis
  function rendreComptes() {
    const a = aujIso(), lv = soldeCompte(etat.doc, 'livret_a', a), jv = soldeCompte(etat.doc, 'jarvis', a), lq = soldeCompte(etat.doc, 'liquide', a);
    $('#liquide-solde').textContent = lq.connu ? eur(lq.solde) : '— €';
    $('#carte-liquide').classList.toggle('ar-negatif', lq.connu && lq.solde < 0);
    $('#liquide-det').textContent = !lq.connu ? 'Dis « j\'ai 40 € en liquide » ou ✏️ Solde'
      : lq.solde < 0 ? '⚠️ Négatif : tu as payé plus d\'espèces que noté. Corrige avec ✏️ Solde.'
        : `${lq.prevu ? `⏳ ${eur(lq.prevu, true)} prévus · ` : ''}compte + liquide = ${eur(soldeBanque(etat.doc, a) + lq.solde)} disponibles`;
    $('#livret-solde').textContent = lv.connu ? eur(lv.solde) : '— €';
    $('#livret-det').textContent = lv.connu ? `${lv.prevu ? `⏳ ${eur(lv.prevu, true)} prévus · ` : ''}≈ ${eur(Math.max(0, lv.solde) * 0.017)} d'intérêts par an (taux 1,7 %)`
      : 'Dis « j\'ai 500 € sur mon Livret A » ou ✏️ Solde';
    $('#carte-jarvis').hidden = !(etat.proprio || jv.connu);
    $('#jarvis-solde').textContent = eur(jv.connu ? jv.solde : 0);
    $('#jarvis-det').textContent = jv.source === 'revolut' ? `🔗 Revolut · synchro ${new Date(jv.maj).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      : `${jv.prevu ? `⏳ ${eur(jv.prevu, true)} prévus · ` : ''}géré par Jarvis (OMNIS) · Revolut bientôt`;
  }
  async function gesteCompte(nom, geste) {
    const titres = nom === 'liquide' ? { vers: '💵 Retrait au distributeur', depuis: '💵 Dépôt d\'espèces à la banque', definir: '✏️ Solde : 💵 Argent liquide' }
      : { vers: nom === 'livret_a' ? '🏦 Verser sur le Livret A' : '🤖 Envoyer à Jarvis', depuis: '🏦 Retirer du Livret A',
      definir: `✏️ Solde : ${NOMS_COMPTES[nom]}`, ajuster: '🤖 Gain ou perte de Jarvis' };
    const textes = { vers: 'Le montant sort de ton compte courant (solde réel) et entre dans cette case.', depuis: 'Le montant revient sur ton compte courant.',
      definir: 'Le solde exact aujourd\'hui. Ton solde réel ne change pas.', ajuster: 'Positif = gain, négatif = perte (ex. -3). Ton solde réel ne change pas.' };
    const s = soldeCompte(etat.doc, nom);
    const d = await dialogue(titres[geste], textes[geste], `<label>Montant (€)<input id="dlg-montant" type="text" inputmode="decimal" value="${geste === 'definir' && s.connu ? E(s.solde) : ''}"></label>`
      + (geste === 'vers' || geste === 'depuis' ? `<label>Date<input id="dlg-date" type="date" value="${aujIso()}"></label>` : '')
      + (geste === 'ajuster' ? '<label>D\'où ça vient<input id="dlg-desc" type="text" placeholder="OMNIS : ETF monde"></label>' : ''));
    if (!d) return;
    const val = d.valeurs || {}, brut = String(val['dlg-montant'] ?? ''), v = Math.abs(nombre(brut)) * (/^\s*[-−]/.test(brut) ? -1 : 1);
    if (!(Math.abs(v) > 0) && geste !== 'definir') { toast('Montant illisible.'); return; }
    if (geste === 'definir') definirCompte(etat.doc, nom, Math.max(0, v));
    else if (geste === 'ajuster') mouvement(etat.doc, 'jarvis', v, String(val['dlg-desc'] || '').trim() || (v >= 0 ? 'Gain' : 'Perte'));
    else virement(etat.doc, nom, Math.abs(v), geste, val['dlg-date'] || aujIso());
    enregistrer();
    toast(`${NOMS_COMPTES[nom]} : ${eur(soldeCompte(etat.doc, nom).solde)}`);
  }

  // ============================================================ rendu + actions : L'ÉTABLI
  function rendreEtabli() {
    const tous = items();
    $('#eta-restant').textContent = eur(tous.filter((i) => !i.checked).reduce((s, i) => s + nombre(i.price), 0));
    $('#eta-achete').textContent = eur(tous.filter((i) => i.checked).reduce((s, i) => s + prixPaye(i), 0));
    const tab = $('#eta-tableau'); tab.innerHTML = '';
    etat.doc.etabli.categories.forEach((c) => {
      const actifs = c.items.filter((i) => !i.checked);
      const t = document.createElement('section'); t.className = 'ar-tiroir'; t.style.setProperty('--accent', c.color || '#888');
      t.innerHTML = `<div class="ar-tiroir-tete"><button type="button" class="ar-tiroir-ico" data-icone="${E(c.id)}" title="Changer l'icône">${E(c.icon || '📁')}</button>
        <h3 class="ar-tiroir-titre" contenteditable="true" spellcheck="false" data-titre="${E(c.id)}">${E(c.title)}</h3>
        <span class="ar-tiroir-total">${eur(actifs.reduce((s, i) => s + nombre(i.price), 0))}</span>
        <button type="button" class="ar-x" data-suppr-dossier="${E(c.id)}" title="Supprimer le dossier">✕</button></div>
        <div class="ar-postits" data-cat="${E(c.id)}"></div>
        <button type="button" class="ar-ajouter" data-ajouter="${E(c.id)}">+ Ajouter un achat prévu</button>`;
      const zone = t.querySelector('.ar-postits');
      actifs.forEach((it, idx) => zone.append(postit(it, c, idx)));
      brancherDepot(zone);
      tab.append(t);
    });
    if (!etat.doc.etabli.categories.length) tab.innerHTML = '<p class="ar-petit">Crée ton premier dossier (Tech, Vélo / VTT, Hygiène…).</p>';
    // archives (achats réalisés)
    const arch = tous.filter((i) => i.checked).sort((a, b) => ((b.achat || '') < (a.achat || '') ? -1 : 1));
    $('#eta-archives-resume').textContent = `${arch.length} achat(s) · ${eur(arch.reduce((s, i) => s + prixPaye(i), 0))}`;
    let mois = null, html = '';
    for (const i of arch) {
      const m = (i.achat || '').slice(0, 7) || 'avant';
      if (m !== mois) { mois = m; html += `<div class="ar-arch-mois">${m === 'avant' ? 'Achetés avant' : E(nomMois(m))}</div>`; }
      html += `<div class="ar-arch"><span><b>${E(i.name)}</b> <span class="ar-petit">· ${E(i.dossier.icon)} ${E(i.dossier.title)}${i.achat ? ` · ${E(i.achat.split('-').reverse().join('/'))}` : ''}</span></span>
        <span class="ar-montant-v">${eur(prixPaye(i))}</span>
        <button type="button" class="ar-mini" data-restaurer="${E(i.id)}" title="Remettre dans le tableau (pas encore acheté)">↩️</button>
        <button type="button" class="ar-x" data-suppr-item="${E(i.id)}" title="Effacer définitivement">✕</button></div>`;
    }
    $('#eta-archives-liste').innerHTML = html || '<p class="ar-petit">Rien encore. Quand tu cliques « ✅ Acheté » sur une carte, elle arrive ici.</p>';
  }
  function postit(it, c, idx) {
    const p = document.createElement('div');
    p.className = 'ar-postit'; p.draggable = true; p.dataset.id = it.id;
    p.style.setProperty('--accent', c.color || '#888');
    p.style.setProperty('--rot', `${(idx % 2 ? 1 : -1) * (0.6 + (idx % 3) * 0.5)}deg`);
    p.innerHTML = `<div class="ar-postit-haut"><span class="ar-postit-nom" contenteditable="true" spellcheck="false" data-nom="${E(it.id)}">${E(it.name)}</span>
        <button type="button" class="ar-x" data-suppr-item="${E(it.id)}" title="Supprimer : je ne l'achèterai jamais">🗑️</button></div>
      <span class="ar-postit-prix" contenteditable="true" spellcheck="false" data-prix="${E(it.id)}">${E(it.price || '0 €')}</span>
      <div class="ar-postit-bas"><button type="button" class="ar-mini ar-mini-ok" data-acheter="${E(it.id)}" title="Je l'ai VRAIMENT acheté : archiver">✅ Acheté</button>
        <input type="date" value="${E(it.date)}" data-date="${E(it.id)}" title="Date prévue (apparaît dans le calendrier)" aria-label="Date prévue">
        <button type="button" class="ar-mini" data-deplacer="${E(it.id)}" title="Déplacer vers un autre dossier">📂</button></div>`;
    p.addEventListener('dragstart', (e) => { p.classList.add('ar-glisse'); e.dataTransfer.setData('text/plain', it.id); e.dataTransfer.effectAllowed = 'move'; });
    p.addEventListener('dragend', () => p.classList.remove('ar-glisse'));
    return p;
  }
  function trouverItem(id) {
    for (const c of etat.doc.etabli.categories) { const i = c.items.find((x) => x.id === id); if (i) return { c, i }; }
    return {};
  }
  function apresGlisser(zone) {   // ordre + dossier lus dans le DOM, `maj` seulement pour ce qui a bougé
    const catId = zone.dataset.cat, cat = etat.doc.etabli.categories.find((c) => c.id === catId);
    const ids = [...zone.querySelectorAll('.ar-postit')].map((p) => p.dataset.id);
    ids.forEach((id, k) => {
      const { c, i } = trouverItem(id); if (!i) return;
      if (c.id !== catId) { c.items = c.items.filter((x) => x.id !== id); cat.items.push(i); i.cat = catId; i.maj = now(); }
      if (i.ordre !== k) { i.ordre = k; i.maj = now(); }
    });
    cat.items.sort((a, b) => (a.ordre ?? 0) - (b.ordre ?? 0));
    enregistrer();
  }
  function brancherDepot(zone) {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault(); zone.classList.add('ar-survol');
      const glisse = $('.ar-glisse'); if (!glisse) return;
      const apres = [...zone.querySelectorAll('.ar-postit:not(.ar-glisse)')].reduce((best, el) => {
        const b = el.getBoundingClientRect(), off = e.clientY - b.top - b.height / 2;
        return off < 0 && off > best.off ? { off, el } : best;
      }, { off: -Infinity }).el;
      if (apres) zone.insertBefore(glisse, apres); else zone.append(glisse);
    });
    zone.addEventListener('dragleave', (e) => { if (e.target === zone) zone.classList.remove('ar-survol'); });
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('ar-survol'); apresGlisser(zone); });
  }
  function dialogue(titre, texte, champs) {
    return new Promise((ok) => {
      const d = $('#ar-dialogue');
      $('#dlg-titre').textContent = titre; $('#dlg-texte').textContent = texte; $('#dlg-champs').innerHTML = champs;
      d.returnValue = '';
      // module 1/7 : réponse donnée AU CLIC (valeurs figées), sans attendre l'événement « close » (parfois en retard)
      const f = $('#dlg-form');
      const lire = () => Object.fromEntries([...d.querySelectorAll('#dlg-champs input, #dlg-champs select')].map((i) => [i.id, i.type === 'checkbox' ? i.checked : i.value]));
      let fini = false;
      const finir = (oui) => { if (fini) return; fini = true; f.removeEventListener('submit', surEnvoi); ok(oui ? Object.assign(d, { valeurs: lire() }) : null); };
      const surEnvoi = (e) => finir((e.submitter?.value ?? d.returnValue) === 'oui');
      f.addEventListener('submit', surEnvoi);
      d.addEventListener('close', () => finir(d.returnValue === 'oui'), { once: true });   // Échap = non
      d.showModal();
    });
  }
  async function acheter(id) {
    const { c, i } = trouverItem(id); if (!i) return;
    const d = await dialogue('🎉 Acheté !', `« ${i.name.trim()} » part dans tes achats réalisés (il ne compte plus dans « Estimé restant »).`,
      `<label>Prix payé<input id="dlg-prix" type="text" inputmode="decimal" value="${E(nombre(i.price) || '')}"></label>
       <label>Date d'achat<input id="dlg-date" type="date" value="${iso()}"></label>
       <label class="ar-case"><input id="dlg-budget" type="checkbox" checked> Inscrire aussi la dépense dans mon budget</label>
       <label>Payé avec<select id="dlg-moyen"><option>CB</option><option>Espèces</option><option>Virement</option><option>Chèque</option></select></label>`);
    if (!d) return;
    const v = d.valeurs || {}, prix = nombre(v['dlg-prix']), date = v['dlg-date'] || aujIso();
    Object.assign(i, { checked: true, achat: date, prix_reel: prix, maj: now() });
    if (v['dlg-budget'] && prix > 0) etat.doc.op.push({ id: uid('op'), date, type: 'depense', method: v['dlg-moyen'] || 'CB', desc: i.name.trim(), amount: prix, etabliId: i.id, cree: now(), maj: now() });
    enregistrer(); toast(`✅ « ${i.name.trim()} » archivé dans « Achats réalisés »${v['dlg-budget'] ? ' et inscrit au budget' : ''}.`);
    void c;
  }
  function supprimerItem(id) {
    const { c, i } = trouverItem(id); if (!i) return;
    const msg = i.checked ? `Effacer définitivement « ${i.name.trim()} » des achats réalisés ?`
      : `Supprimer « ${i.name.trim()} » ?\n\nSupprimer = tu ne l'achèteras JAMAIS.\nSi tu l'as acheté, clique plutôt « ✅ Acheté » (il sera archivé et compté).`;
    if (!confirm(msg)) return;
    etat.doc.supprimes[id] = now(); c.items = c.items.filter((x) => x.id !== id); enregistrer();
  }
  function restaurer(id) { const { i } = trouverItem(id); if (!i) return; Object.assign(i, { checked: false, maj: now() }); enregistrer(); toast(`↩️ « ${i.name.trim()} » remis dans le tableau.`); }
  function ajouterItem(catId) {
    const c = etat.doc.etabli.categories.find((x) => x.id === catId); if (!c) return;
    const it = { id: uid('i'), name: 'Nouveau', price: '0 €', checked: false, date: '', cat: catId, maj: now(), ordre: c.items.length };
    c.items.push(it); enregistrer();
    const el = document.querySelector(`[data-nom="${CSS.escape(it.id)}"]`);
    if (el) { el.focus(); document.getSelection().selectAllChildren(el); }
  }
  function ajouterDossier() {
    const titre = prompt('Nom du nouveau dossier ?'); if (!titre?.trim()) return;
    const couleurs = ['#ff6b6b', '#f2a93b', '#2fb6a5', '#8fbf5c', '#9b6bff', '#4fa3e3'];
    etat.doc.etabli.categories.push({ id: uid('cat'), title: titre.trim(), icon: '📁', color: couleurs[etat.doc.etabli.categories.length % couleurs.length], items: [], maj: now(), ordre: etat.doc.etabli.categories.length });
    enregistrer();
  }
  function supprimerDossier(id) {
    const c = etat.doc.etabli.categories.find((x) => x.id === id); if (!c) return;
    if (!confirm(`Supprimer le dossier « ${c.title} » et ses ${c.items.length} carte(s) (achats réalisés compris) ?`)) return;
    const t = now(); etat.doc.supprimes[id] = t; c.items.forEach((i) => { etat.doc.supprimes[i.id] = t; });
    etat.doc.etabli.categories = etat.doc.etabli.categories.filter((x) => x.id !== id); enregistrer();
  }
  function menu(e, choix) {
    const m = $('#ar-menu'); m.innerHTML = '';
    for (const [t, f] of choix) { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.onclick = () => { m.hidden = true; f(); }; m.append(b); }
    m.hidden = false;
    const x = Math.min(e.clientX, innerWidth - 230), y = Math.min(e.clientY, innerHeight - 40 * choix.length - 20);
    Object.assign(m.style, { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` });
    setTimeout(() => document.addEventListener('click', () => { m.hidden = true; }, { once: true }), 0);
  }

  // ============================================================ bilan + téléphone (Yanis)
  function mdVersHtml(md) {
    const lignes = E(md).split('\n'); let html = '', liste = null;
    const fermer = () => { if (liste) { html += `</${liste}>`; liste = null; } };
    for (const l of lignes) {
      const t = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/_(.+?)_/g, '<i>$1</i>');
      if (/^# /.test(l)) { fermer(); html += `<h1>${t.slice(2)}</h1>`; } else if (/^## /.test(l)) { fermer(); html += `<h2>${t.slice(3)}</h2>`; } else if (/^- /.test(l)) { if (liste !== 'ul') { fermer(); html += '<ul>'; liste = 'ul'; } html += `<li>${t.slice(2)}</li>`; } else if (/^\d+\. /.test(l)) { if (liste !== 'ol') { fermer(); html += '<ol>'; liste = 'ol'; } html += `<li>${t.replace(/^\d+\. /, '')}</li>`; } else if (l.trim()) { fermer(); html += `<p>${t}</p>`; } else fermer();
    }
    fermer(); return html;
  }
  async function faireBilan() {
    const m = $('#bilan-mois').value || moisDe();
    $('#bilan-corps').innerHTML = '<p class="ar-petit">📊 Jarvis analyse ton mois…</p>';
    try {
      const r = await fetch(`${API}/bilan?mois=${encodeURIComponent(m)}`, { credentials: 'same-origin' });
      const b = await r.json(); if (!r.ok) throw new Error(b.erreur || r.status);
      $('#bilan-corps').innerHTML = mdVersHtml(b.texte);
    } catch (e) { $('#bilan-corps').innerHTML = `<p class="ar-petit">Bilan impossible : ${E(e.message)}</p>`; }
  }
  async function chargerTelephone() {
    try {
      const r = await fetch(`${API}/telephone`, { credentials: 'same-origin' }); if (!r.ok) return;
      const t = await r.json();
      $('#tel-url').value = t.url; $('#tel-cle').value = t.cle;
      $('#tel-etat').textContent = t.derniere ? `✅ ${t.nb} notification(s) reçue(s), dernière le ${new Date(t.derniere * 1000).toLocaleString('fr-FR')}` : '⏸️ pas encore branché';
    } catch { /* */ }
  }

  // ============================================================ vues + événements
  function basculer(vue) {
    etat.vue = vue === 'etabli' ? 'etabli' : 'calendrier';
    for (const b of document.querySelectorAll('.ar-bascule button')) b.setAttribute('aria-selected', String(b.dataset.vue === etat.vue));
    $('#vue-calendrier').hidden = etat.vue !== 'calendrier'; $('#vue-etabli').hidden = etat.vue !== 'etabli';
    try { history.replaceState(null, '', `?vue=${etat.vue}`); } catch { /* */ }
    ls.set('argent3:vue', etat.vue);
    if (etat.vue === 'calendrier' && calendrier) setTimeout(() => calendrier.updateSize(), 30);
  }
  function rendre() { rendreBudget(); rendreEtabli(); }
  function brancher() {
    document.querySelectorAll('.ar-bascule button').forEach((b) => b.addEventListener('click', () => basculer(b.dataset.vue)));
    $('#form-op').addEventListener('submit', ajouterOp);
    $('#form-fixe').addEventListener('submit', ajouterFixe);
    $('#form-assistant').addEventListener('submit', demanderJarvis);
    $('#histo-mot').addEventListener('input', rendreHisto);
    $('#histo-mois').addEventListener('change', rendreHisto);
    const plier = () => { etat.histoOuvert = !etat.histoOuvert; $('#histo-corps').hidden = !etat.histoOuvert; $('#histo-fleche').textContent = etat.histoOuvert ? '▼ Cacher' : '▶ Afficher'; $('#histo-entete').setAttribute('aria-expanded', String(etat.histoOuvert)); };
    $('#histo-entete').addEventListener('click', plier);
    $('#histo-entete').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); plier(); } });
    $('#ar-google').addEventListener('click', () => connecterGoogle(!etat.compte));
    $('#ar-deco').addEventListener('click', deconnecter);
    $('#eta-dossier').addEventListener('click', ajouterDossier);
    $('#bilan-faire').addEventListener('click', faireBilan);
    $('#tel-voir').addEventListener('click', () => { const c = $('#tel-cle'); c.type = c.type === 'password' ? 'text' : 'password'; });
    document.querySelectorAll('[data-copier]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($(`#${b.dataset.copier}`).value); toast('📋 Copié.'); } catch { $(`#${b.dataset.copier}`).select(); }
    }));
    document.addEventListener('click', (e) => {   // délégation : boutons des listes
      const b = e.target.closest('[data-suppr-op],[data-suppr-fixe],[data-acheter],[data-suppr-item],[data-restaurer],[data-ajouter],[data-suppr-dossier],[data-icone],[data-deplacer],[data-compte]');
      if (!b) return;
      const d = b.dataset;
      if (d.compte) { gesteCompte(d.compte, d.geste); return; }
      if (d.supprOp) supprimerOp(d.supprOp); else if (d.supprFixe) supprimerFixe(d.supprFixe); else if (d.acheter) acheter(d.acheter);
      else if (d.supprItem) supprimerItem(d.supprItem); else if (d.restaurer) restaurer(d.restaurer); else if (d.ajouter) ajouterItem(d.ajouter);
      else if (d.supprDossier) supprimerDossier(d.supprDossier);
      else if (d.icone) { const c = etat.doc.etabli.categories.find((x) => x.id === d.icone); const ic = prompt('Un émoji pour ce dossier :', c?.icon || '📁'); if (c && ic?.trim()) { c.icon = ic.trim().slice(0, 4); c.maj = now(); enregistrer(); } }
      else if (d.deplacer) {
        e.stopPropagation();
        const { c, i } = trouverItem(d.deplacer);
        menu(e, etat.doc.etabli.categories.filter((x) => x.id !== c.id).map((x) => [`${x.icon} ${x.title}`, () => {
          c.items = c.items.filter((y) => y.id !== i.id); i.cat = x.id; i.ordre = x.items.length; i.maj = now(); x.items.push(i); enregistrer();
        }]));
      }
    });
    document.addEventListener('focusout', (e) => {   // textes modifiables (contenteditable) → enregistrés en quittant le champ
      const el = e.target, d = el.dataset || {};
      const val = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (d.nom || d.prix) {
        const { i } = trouverItem(d.nom || d.prix); if (!i) return;
        const champ = d.nom ? 'name' : 'price';
        if (i[champ] !== val) { i[champ] = val || (d.nom ? 'Sans nom' : '0 €'); i.maj = now(); enregistrer(); }
      } else if (d.titre) {
        const c = etat.doc.etabli.categories.find((x) => x.id === d.titre);
        if (c && c.title !== val) { c.title = val || 'Dossier'; c.maj = now(); enregistrer(); }
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.isContentEditable) { e.preventDefault(); e.target.blur(); } });
    document.addEventListener('change', (e) => {
      const id = e.target.dataset?.date; if (!id) return;
      const { i } = trouverItem(id); if (i) { i.date = e.target.value; i.maj = now(); enregistrer(); }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (etat.proprio) tirerJarvis(); else if (jetonValide()) synchroDrive(); } });
    window.addEventListener('storage', (e) => { if (e.key === cle()) { remplacer(fusionner(etat.doc, lireJson(e.newValue, {}))); } });   // autre onglet
  }

  async function demarrer() {
    brancher();
    $('#op-date').value = iso(); $('#bilan-mois').value = moisDe();
    const p = new URLSearchParams(location.search);
    const vue = p.get('vue') || ls.get('argent3:vue') || 'calendrier';
    basculer(vue === 'bilan' ? 'calendrier' : vue);
    const sauve = lireJson(ls.get('argent3:jeton'), null);
    if (sauve?.t) { etat.compte = sauve.compte || null; if (sauve.exp > now() + 60000) etat.jeton = { t: sauve.t, exp: sauve.exp }; }
    if (await detecterJarvis()) {
      charger('yanis');
      document.body.classList.add('ar-proprio');
      $('#ar-bilan').hidden = false; $('#ar-tel').hidden = false;
      majDrivePastille('☁️ Drive : Jarvis s\'en occupe', 'ar-ok');
      await tirerJarvis();
      chargerTelephone();
      setInterval(() => { if (!document.hidden) tirerJarvis(); }, 20000);
    } else {
      charger(etat.compte?.id ? `g:${etat.compte.id}` : 'local');
      initGoogle();
      if (jetonValide()) synchroDrive(); else if (etat.compte) majDrivePastille('☁️ Reconnecte Google', 'ar-attention');
      setInterval(() => { if (!document.hidden && jetonValide()) synchroDrive(); }, 120000);
    }
    majCompte(); rendre(); initCalendrier();
    pingJarvis(); setInterval(() => { if (!document.hidden) pingJarvis(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pingJarvis(); });
    if (vue === 'bilan' && etat.proprio) { $('#ar-bilan').scrollIntoView({ behavior: 'smooth' }); faireBilan(); }
  }
  // pour les essais (console) : l'algorithme de fusion, le même que le serveur
  window.argentModele = { normaliser, fusionner, appliquerFixes, versDrive, empreinte, appliquerActions, majAssistant, doc: () => etat.doc,
    resoudreDate: (t, a, tp, r) => { const d = resoudreDate(t, a ? new Date(a + 'T00:00:00') : dateParis(), tp, r ? new Date(r + 'T00:00:00') : null); return d && isoD(d); },
    moteurLocal, soldeCompte, previsionnelFinMois, aujIso };
  demarrer();
})();
