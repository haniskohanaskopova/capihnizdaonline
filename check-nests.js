const fs = require('fs');
const nodemailer = require('nodemailer');

const YT_API_KEY = process.env.YT_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY;

// ---------- pomocné funkce ----------
function norm(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
// generická slova, která NErozlišují konkrétní hnízdo (loučka/jezírko schválně NEjsou – rozlišují Makov)
const GENERIC = new Set([
  'hnizdo', 'hnizda', 'hnizdem', 'hnizde', 'cap', 'capi', 'capa', 'capci',
  'kamera', 'kamery', 'cam', 'live', 'stream', 'webkamera', 'webcam',
  'komin', 'komina', 'nest', 'stork', 'storks', 'online', 'cesko', 'cz', 'sk'
]);
function keywords(name) {
  return norm(name).split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !GENERIC.has(t));
}
function scoreTitle(kw, title) {
  const t = norm(title);
  let s = 0;
  for (const k of kw) if (t.includes(k)) s++;
  return s;
}

// Greedy jedinečné přiřazení problémových hnízd ke kandidátům (živým videím) na jednom kanálu.
function assignChannel(problems, candidates) {
  const P = problems.map(p => ({ ref: p, kw: keywords(p.name) }));
  const remP = [...P];
  const remC = [...candidates];
  const applied = [], flagged = [];

  // 1 hnízdo + 1 živé video = jednoznačně to naše
  if (remP.length === 1 && remC.length === 1) {
    applied.push({ nest: remP[0].ref, cand: remC[0] });
    return { applied, flagged };
  }

  while (remP.length && remC.length) {
    let best = null;
    for (const p of remP) for (const c of remC) {
      const s = scoreTitle(p.kw, c.title);
      if (!best || s > best.s) best = { p, c, s };
    }
    if (!best || best.s === 0) break; // zbytek nelze spolehlivě určit
    const tiedC = remC.filter(c => scoreTitle(best.p.kw, c.title) === best.s);
    const tiedP = remP.filter(p => scoreTitle(p.kw, best.c.title) === best.s);
    if (tiedC.length > 1 || tiedP.length > 1) {
      flagged.push({ nest: best.p.ref, reason: 'nejednoznačná shoda názvů' });
      remP.splice(remP.indexOf(best.p), 1);
      continue;
    }
    applied.push({ nest: best.p.ref, cand: best.c });
    remP.splice(remP.indexOf(best.p), 1);
    remC.splice(remC.indexOf(best.c), 1);
  }
  for (const p of remP) flagged.push({ nest: p.ref, reason: 'žádná spolehlivá shoda' });
  return { applied, flagged };
}

async function ytSearchLive(channelId) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&maxResults=10&key=${YT_API_KEY}`;
  const r = await fetch(url); const j = await r.json();
  if (j.error) { console.error('Search chyba:', j.error.message); return []; }
  return (j.items || []).map(it => ({ videoId: it.id.videoId, title: it.snippet.title, channelId: it.snippet.channelId, channelTitle: it.snippet.channelTitle }));
}
async function ytSearchByName(name) {
  const q = encodeURIComponent(name + ' čáp hnízdo');
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&eventType=live&type=video&maxResults=5&key=${YT_API_KEY}`;
  const r = await fetch(url); const j = await r.json();
  if (j.error) { console.error('Name-search chyba:', j.error.message); return []; }
  return (j.items || []).map(it => ({ videoId: it.id.videoId, title: it.snippet.title, channelId: it.snippet.channelId, channelTitle: it.snippet.channelTitle }));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const data = JSON.parse(fs.readFileSync('nests.json', 'utf8'));
  const nests = data.youtube || [];
  console.log(`Kontroluji ${nests.length} YouTube hnízd...`);

  // 1) Dávková kontrola video ID (levné: 1 jednotka / dávka 50)
  const results = {};
  for (let i = 0; i < nests.length; i += 50) {
    const ids = nests.slice(i, i + 50).map(n => n.id).join(',');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,liveStreamingDetails&id=${ids}&key=${YT_API_KEY}`;
    const resp = await fetch(url); const json = await resp.json();
    if (json.error) { console.error('YouTube API chyba:', json.error.message); process.exit(1); }
    if (json.items) json.items.forEach(item => { results[item.id] = item; });
  }

  let changed = false;

  // 2) Kategorizace + cachování channelId
  const live = [], ended = [], dead = [], ok = [];
  for (const nest of nests) {
    const item = results[nest.id];
    if (!item) {
      dead.push({ nest, reason: 'Video neexistuje nebo bylo smazáno' });
    } else {
      const status = item.status || {}, snippet = item.snippet || {}, ld = item.liveStreamingDetails || {};
      if (snippet.channelId && nest.channelId !== snippet.channelId) { nest.channelId = snippet.channelId; changed = true; }
      if (status.privacyStatus === 'private' || status.uploadStatus === 'rejected') {
        dead.push({ nest, reason: 'Video je soukromé nebo odmítnuto' });
      } else if (snippet.liveBroadcastContent === 'live') {
        live.push({ nest });
      } else if (ld.actualEndTime || snippet.liveBroadcastContent === 'none') {
        ended.push({ nest });
      } else {
        ok.push({ nest }); // typicky 'upcoming' = naplánováno
      }
    }
  }
  console.log(`🟢 Živě: ${live.length} · 🟡 Ukončeno: ${ended.length} · 🔵 Naplánováno/jiné: ${ok.length} · 🔴 Nefunguje: ${dead.length}`);

  const usedIds = new Set(nests.map(n => n.id));
  const problemList = [...ended, ...dead].map(x => x.nest);
  const byChannel = {};
  const noChannel = [];
  for (const nest of problemList) {
    if (nest.channelId) (byChannel[nest.channelId] = byChannel[nest.channelId] || []).push(nest);
    else noChannel.push(nest);
  }

  const appliedAll = [];
  const flaggedAll = [];

  // 4) Per kanál: najdi živé streamy a přiřaď
  for (const channelId of Object.keys(byChannel)) {
    const problems = byChannel[channelId];
    let candidates = (await ytSearchLive(channelId)).filter(c => !usedIds.has(c.videoId));
    if (candidates.length === 0) {
      for (const nest of problems) flaggedAll.push({ name: nest.name, reason: 'kanál nevysílá živě (mimo sezónu / jen záznam)', candidates: [] });
      await sleep(150); continue;
    }
    const { applied, flagged } = assignChannel(problems, candidates);
    for (const a of applied) {
      const old = a.nest.id;
      a.nest.id = a.cand.videoId;
      a.nest.channelId = a.cand.channelId || a.nest.channelId;
      usedIds.delete(old); usedIds.add(a.cand.videoId);
      changed = true;
      appliedAll.push({ name: a.nest.name, oldId: old, newId: a.cand.videoId, title: a.cand.title });
    }
    for (const f of flagged) flaggedAll.push({ name: f.nest.name, reason: f.reason, candidates: candidates.map(c => ({ videoId: c.videoId, title: c.title })) });
    await sleep(150);
  }

  // 5) Smazaná videa bez channelId – fallback podle názvu, jen NÁVRH
  for (const nest of noChannel) {
    const cands = (await ytSearchByName(nest.name)).filter(c => !usedIds.has(c.videoId));
    flaggedAll.push({
      name: nest.name,
      reason: 'video smazáno, kotva chybí – ověř ručně',
      candidates: cands.slice(0, 3).map(c => ({ videoId: c.videoId, title: c.title }))
    });
    await sleep(150);
  }

  // 6) Zápis nests.json (diakritika zůstává)
  if (changed) {
    fs.writeFileSync('nests.json', JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`💾 nests.json zapsán. Auto-opraveno: ${appliedAll.length}, ke kontrole: ${flaggedAll.length}.`);
  } else {
    console.log('✅ Žádné změny v nests.json.');
  }

  if (appliedAll.length === 0 && flaggedAll.length === 0) {
    console.log('✅ Vše v pořádku, report se neposílá.');
    return;
  }

  // 7) Report
  const now = new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
  let html = `<div style="font-family:Tahoma,Arial,sans-serif;max-width:700px;margin:0 auto;padding:20px;">
    <h2 style="color:#1a3a5c;">🐣 Kontrola čapích hnízd</h2>
    <p style="color:#5a6a7a;">${now}</p>
    <div style="background:#e8f4fd;padding:12px 16px;border-radius:8px;margin:16px 0;">
      ${nests.length} hnízd · <span style="color:#27ae60;">🟢 ${live.length} živě</span> ·
      <span style="color:#2e86de;">🤖 ${appliedAll.length} auto-opraveno</span> ·
      <span style="color:#e67e22;">⚠️ ${flaggedAll.length} ke kontrole</span>
    </div>`;

  if (appliedAll.length > 0) {
    html += `<h3 style="color:#2e86de;">🤖 Automaticky opraveno (${appliedAll.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#eaf3fc;"><th style="padding:8px;text-align:left;">Hnízdo</th><th style="padding:8px;text-align:left;">Nový stream</th></tr>`;
    for (const a of appliedAll) html += `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;"><strong>${a.name}</strong><br><span style="color:#999;font-size:11px;">${a.oldId} → ${a.newId}</span></td><td style="padding:6px 8px;border-bottom:1px solid #eee;"><a href="https://www.youtube.com/watch?v=${a.newId}">${a.title}</a></td></tr>`;
    html += '</table><p style="color:#888;font-size:12px;">Tyto změny už jsou na webu. Pokud některá nesedí, přepiš ji v admin panelu.</p>';
  }

  if (flaggedAll.length > 0) {
    html += `<h3 style="color:#e67e22;">⚠️ Vyžaduje tvoji kontrolu (${flaggedAll.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#fef5e7;"><th style="padding:8px;text-align:left;">Hnízdo</th><th style="padding:8px;text-align:left;">Důvod / kandidáti</th></tr>`;
    for (const f of flaggedAll) {
      const c = (f.candidates && f.candidates.length)
        ? f.candidates.map(x => `<a href="https://www.youtube.com/watch?v=${x.videoId}">${x.title}</a>`).join('<br>')
        : '<span style="color:#999;">žádný kandidát</span>';
      html += `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;"><strong>${f.name}</strong></td><td style="padding:6px 8px;border-bottom:1px solid #eee;"><span style="color:#999;font-size:12px;">${f.reason}</span><br>${c}</td></tr>`;
    }
    html += '</table>';
  }
  html += `<p style="color:#999;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
    Ruční úpravy v <a href="https://capihnizdaonline.cz">admin panelu</a>.</p></div>`;

  if (SMTP_USER && SMTP_PASS && NOTIFY_EMAIL) {
    try {
      const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } });
      await transporter.sendMail({
        from: `Čapí hnízda <${SMTP_USER}>`, to: NOTIFY_EMAIL,
        subject: `🐣 ${appliedAll.length} auto-opraveno, ${flaggedAll.length} ke kontrole`, html
      });
      console.log('✅ Email odeslán.');
    } catch (e) { console.error('❌ Email chyba:', e.message); }
  }

  if (GITHUB_TOKEN && GITHUB_REPO) {
    try {
      let body = `## 🐣 Kontrola – ${now}\n\n🤖 Auto-opraveno: ${appliedAll.length} · ⚠️ Ke kontrole: ${flaggedAll.length}\n\n`;
      if (appliedAll.length) { body += `### 🤖 Automaticky opraveno\n`; for (const a of appliedAll) body += `- **${a.name}**: \`${a.oldId}\` → [${a.newId}](https://www.youtube.com/watch?v=${a.newId}) — ${a.title}\n`; body += '\n'; }
      if (flaggedAll.length) { body += `### ⚠️ Ke kontrole\n`; for (const f of flaggedAll) { body += `- **${f.name}** — ${f.reason}\n`; for (const c of (f.candidates || [])) body += `  - [${c.videoId}](https://www.youtube.com/watch?v=${c.videoId}) ${c.title}\n`; } }
      await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
        method: 'POST',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `🐣 ${now}: ${appliedAll.length} opraveno, ${flaggedAll.length} ke kontrole`, body, labels: ['kontrola'] })
      });
      console.log('✅ GitHub Issue vytvořeno.');
    } catch (e) { console.error('Issue chyba:', e.message); }
  }
}

main().catch(err => { console.error('Fatální chyba:', err); process.exit(1); });
