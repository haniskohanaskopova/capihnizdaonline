const fs = require('fs');
const nodemailer = require('nodemailer');

const YT_API_KEY = process.env.YT_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY;

async function main() {
  const data = JSON.parse(fs.readFileSync('nests.json', 'utf8'));
  const nests = data.youtube || [];
  
  console.log(`Kontroluji ${nests.length} YouTube hnízd...`);

  const results = {};
  for (let i = 0; i < nests.length; i += 50) {
    const batch = nests.slice(i, i + 50);
    const ids = batch.map(n => n.id).join(',');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,liveStreamingDetails&id=${ids}&key=${YT_API_KEY}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.error) { console.error('YouTube API chyba:', json.error.message); process.exit(1); }
    if (json.items) json.items.forEach(item => { results[item.id] = item; });
  }

  const live = [], ended = [], dead = [], ok = [];

  for (const nest of nests) {
    const item = results[nest.id];
    if (!item) {
      dead.push({ ...nest, reason: 'Video neexistuje nebo bylo smazáno' });
    } else {
      const status = item.status || {};
      const snippet = item.snippet || {};
      const liveDetails = item.liveStreamingDetails || {};
      if (status.uploadStatus === 'rejected' || status.privacyStatus === 'private') {
        dead.push({ ...nest, reason: 'Video je soukromé nebo odmítnuto', channelId: snippet.channelId, channelTitle: snippet.channelTitle });
      } else if (snippet.liveBroadcastContent === 'live') {
        live.push({ ...nest, channelTitle: snippet.channelTitle });
      } else if (liveDetails.actualEndTime || snippet.liveBroadcastContent === 'none') {
        ended.push({ ...nest, channelId: snippet.channelId, channelTitle: snippet.channelTitle });
      } else {
        ok.push({ ...nest, channelTitle: snippet.channelTitle });
      }
    }
  }

  console.log(`🟢 Živě: ${live.length}`);
  console.log(`🟡 Ukončeno/záznam: ${ended.length + ok.length}`);
  console.log(`🔴 Nefunguje: ${dead.length}`);

  // Search for new live streams
  const suggestions = [];
  const checkedChannels = new Set();
  const problemNests = [...ended, ...dead].filter(n => n.channelId);
  
  for (const nest of problemNests) {
    if (checkedChannels.has(nest.channelId)) continue;
    checkedChannels.add(nest.channelId);
    try {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${nest.channelId}&eventType=live&type=video&key=${YT_API_KEY}`;
      const searchResp = await fetch(searchUrl);
      const searchJson = await searchResp.json();
      if (searchJson.items && searchJson.items.length > 0) {
        for (const item of searchJson.items) {
          const newId = item.id.videoId;
          const alreadyUsed = nests.some(n => n.id === newId);
          if (!alreadyUsed) {
            suggestions.push({ nestName: nest.name, oldId: nest.id, newId, newTitle: item.snippet.title, channelTitle: nest.channelTitle });
          }
        }
      }
    } catch (e) { console.error(`Chyba kanálu ${nest.channelTitle}:`, e.message); }
    await new Promise(r => setTimeout(r, 200));
  }

  if (dead.length === 0 && ended.length === 0) {
    console.log('✅ Všechna hnízda v pořádku, email se neposílá.');
    return;
  }

  // Build email
  const now = new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
  
  let html = `<div style="font-family:Tahoma,sans-serif;max-width:700px;margin:0 auto;padding:20px;">
    <h2 style="color:#1a3a5c;">🐣 Denní kontrola čapích hnízd</h2>
    <p style="color:#5a6a7a;">${now}</p>
    <div style="background:#e8f4fd;padding:12px 16px;border-radius:8px;margin:16px 0;">
      <strong>Shrnutí:</strong> ${nests.length} hnízd ·
      <span style="color:#27ae60;">🟢 Živě: ${live.length}</span> ·
      <span style="color:#e67e22;">🟡 Existuje: ${ended.length + ok.length}</span> ·
      <span style="color:#c0392b;">🔴 Nefunguje: ${dead.length}</span>
    </div>`;

  if (dead.length > 0) {
    html += `<h3 style="color:#c0392b;">🔴 Nefunkční (${dead.length})</h3><table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#fdecea;"><th style="padding:8px;text-align:left;">Hnízdo</th><th style="padding:8px;text-align:left;">Důvod</th></tr>`;
    for (const n of dead) html += `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;"><strong>${n.name}</strong><br><span style="color:#999;font-size:12px;">${n.id}</span></td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${n.reason}</td></tr>`;
    html += '</table>';
  }

  if (ended.length > 0) {
    html += `<h3 style="color:#e67e22;">🟡 Vysílání ukončeno (${ended.length})</h3><table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#fef5e7;"><th style="padding:8px;text-align:left;">Hnízdo</th><th style="padding:8px;text-align:left;">Kanál</th></tr>`;
    for (const n of ended) html += `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;"><strong>${n.name}</strong><br><span style="color:#999;font-size:12px;">${n.id}</span></td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${n.channelTitle || '—'}</td></tr>`;
    html += '</table>';
  }

  if (suggestions.length > 0) {
    html += `<h3 style="color:#3a7ebf;">💡 Nové live streamy (${suggestions.length})</h3><table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#e8f4fd;"><th style="padding:8px;text-align:left;">Hnízdo</th><th style="padding:8px;text-align:left;">Nový stream</th><th style="padding:8px;text-align:left;">Link</th></tr>`;
    for (const s of suggestions) html += `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;"><strong>${s.nestName}</strong></td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${s.newTitle}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;"><a href="https://www.youtube.com/watch?v=${s.newId}">${s.newId}</a></td></tr>`;
    html += '</table>';
  }

  html += `<p style="color:#999;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
    Změny proveď v <a href="https://capihnizdaonline.cz">admin panelu</a> na webu.</p></div>`;

  // Send email via Gmail
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  try {
    await transporter.sendMail({
      from: `Čapí hnízda <${SMTP_USER}>`,
      to: NOTIFY_EMAIL,
      subject: `🐣 Kontrola: ${dead.length} nefunkčních, ${ended.length} ukončených, ${suggestions.length} návrhů`,
      html: html
    });
    console.log('✅ Email odeslán!');
  } catch (e) {
    console.error('❌ Chyba emailu:', e.message);
  }

  // Also create GitHub Issue
  try {
    let body = `## 🐣 Kontrola – ${now}\n\n**Shrnutí:** ${nests.length} hnízd · 🟢 ${live.length} · 🟡 ${ended.length + ok.length} · 🔴 ${dead.length}\n\n`;
    if (dead.length > 0) { body += `### 🔴 Nefunkční\n`; for (const n of dead) body += `- **${n.name}** (\`${n.id}\`) — ${n.reason}\n`; body += '\n'; }
    if (ended.length > 0) { body += `### 🟡 Ukončeno\n`; for (const n of ended) body += `- **${n.name}** (\`${n.id}\`) — ${n.channelTitle || ''}\n`; body += '\n'; }
    if (suggestions.length > 0) { body += `### 💡 Návrhy\n`; for (const s of suggestions) body += `- **${s.nestName}**: [${s.newId}](https://www.youtube.com/watch?v=${s.newId}) — ${s.newTitle}\n`; }

    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `🐣 Kontrola ${now}: ${dead.length} nefunkčních, ${ended.length} ukončených`, body, labels: ['kontrola'] })
    });
    console.log('✅ GitHub Issue vytvořeno.');
  } catch (e) { console.error('Issue chyba:', e.message); }
}

main().catch(err => { console.error('Fatální chyba:', err); process.exit(1); });
