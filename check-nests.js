const fs = require('fs');

const YT_API_KEY = process.env.YT_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

async function main() {
  // Load nests.json
  const data = JSON.parse(fs.readFileSync('nests.json', 'utf8'));
  const nests = data.youtube || [];
  
  console.log(`Kontroluji ${nests.length} YouTube hnízd...`);

  // Batch check videos (max 50 per request)
  const results = {};
  for (let i = 0; i < nests.length; i += 50) {
    const batch = nests.slice(i, i + 50);
    const ids = batch.map(n => n.id).join(',');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,liveStreamingDetails&id=${ids}&key=${YT_API_KEY}`;
    
    const resp = await fetch(url);
    const json = await resp.json();
    
    if (json.error) {
      console.error('YouTube API chyba:', json.error.message);
      process.exit(1);
    }
    
    if (json.items) {
      json.items.forEach(item => {
        results[item.id] = item;
      });
    }
  }

  // Analyze results
  const live = [];
  const ended = [];
  const dead = [];
  const ok = [];

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

  // For ended/dead streams, search for new live streams on the same channel
  const suggestions = [];
  const checkedChannels = new Set();

  const problemNests = [...ended, ...dead].filter(n => n.channelId);
  
  for (const nest of problemNests) {
    if (checkedChannels.has(nest.channelId)) continue;
    checkedChannels.add(nest.channelId);

    try {
      // Search for live streams on this channel
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${nest.channelId}&eventType=live&type=video&key=${YT_API_KEY}`;
      const searchResp = await fetch(searchUrl);
      const searchJson = await searchResp.json();

      if (searchJson.items && searchJson.items.length > 0) {
        for (const item of searchJson.items) {
          const newId = item.id.videoId;
          const title = item.snippet.title;
          // Check if this ID is already in our nests
          const alreadyUsed = nests.some(n => n.id === newId);
          if (!alreadyUsed) {
            suggestions.push({
              nestName: nest.name,
              oldId: nest.id,
              newId: newId,
              newTitle: title,
              channelTitle: nest.channelTitle
            });
          }
        }
      }
    } catch (e) {
      console.error(`Chyba při hledání na kanálu ${nest.channelTitle}:`, e.message);
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  // Build email report
  const now = new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
  
  let hasProblems = ended.length > 0 || dead.length > 0;
  
  // Only send email if there are problems
  if (!hasProblems) {
    console.log('✅ Všechna hnízda v pořádku, email se neposílá.');
    return;
  }

  let html = `
    <div style="font-family:Tahoma,sans-serif;max-width:700px;margin:0 auto;padding:20px;">
      <h2 style="color:#1a3a5c;">🐣 Denní kontrola čapích hnízd</h2>
      <p style="color:#5a6a7a;font-size:14px;">${now}</p>
      
      <div style="background:#e8f4fd;padding:12px 16px;border-radius:8px;margin:16px 0;font-size:14px;">
        <strong>Shrnutí:</strong> ${nests.length} hnízd celkem · 
        <span style="color:#27ae60;">🟢 Živě: ${live.length}</span> · 
        <span style="color:#e67e22;">🟡 Existuje: ${ended.length + ok.length}</span> · 
        <span style="color:#c0392b;">🔴 Nefunguje: ${dead.length}</span>
      </div>`;

  if (dead.length > 0) {
    html += `
      <h3 style="color:#c0392b;">🔴 Nefunkční hnízda (${dead.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="background:#fdecea;"><th style="padding:8px;text-align:left;border-bottom:2px solid #f5c6cb;">Hnízdo</th><th style="padding:8px;text-align:left;border-bottom:2px solid #f5c6cb;">Důvod</th></tr>`;
    for (const n of dead) {
      html += `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;"><strong>${n.name}</strong><br><span style="color:#999;font-size:12px;">${n.id}</span></td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${n.reason}</td></tr>`;
    }
    html += '</table>';
  }

  if (ended.length > 0) {
    html += `
      <h3 style="color:#e67e22;">🟡 Vysílání ukončeno (${ended.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="background:#fef5e7;"><th style="padding:8px;text-align:left;border-bottom:2px solid #fdebd0;">Hnízdo</th><th style="padding:8px;text-align:left;border-bottom:2px solid #fdebd0;">Kanál</th></tr>`;
    for (const n of ended) {
      html += `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;"><strong>${n.name}</strong><br><span style="color:#999;font-size:12px;">${n.id}</span></td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${n.channelTitle || '—'}</td></tr>`;
    }
    html += '</table>';
  }

  if (suggestions.length > 0) {
    html += `
      <h3 style="color:#3a7ebf;">💡 Nalezeny nové live streamy (${suggestions.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="background:#e8f4fd;"><th style="padding:8px;text-align:left;border-bottom:2px solid #d5e3f0;">Hnízdo</th><th style="padding:8px;text-align:left;border-bottom:2px solid #d5e3f0;">Nový stream</th><th style="padding:8px;text-align:left;border-bottom:2px solid #d5e3f0;">Link</th></tr>`;
    for (const s of suggestions) {
      html += `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;"><strong>${s.nestName}</strong><br><span style="color:#999;font-size:12px;">starý: ${s.oldId}</span></td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${s.newTitle}<br><span style="color:#999;font-size:12px;">${s.channelTitle}</span></td><td style="padding:6px 8px;border-bottom:1px solid #eee;"><a href="https://www.youtube.com/watch?v=${s.newId}" style="color:#3a7ebf;">${s.newId}</a></td></tr>`;
    }
    html += '</table>';
  }

  html += `
      <p style="color:#999;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
        Tento email byl vygenerován automaticky.<br>
        Změny proveď v admin panelu na <a href="https://capihnizdaonline.cz" style="color:#3a7ebf;">capihnizdaonline.cz</a>
      </p>
    </div>`;

  // Send email via FormSubmit
  const formData = new URLSearchParams();
  formData.append('email', NOTIFY_EMAIL);
  formData.append('_subject', `🐣 Kontrola hnízd: ${dead.length} nefunkčních, ${ended.length} ukončených, ${suggestions.length} návrhů`);
  formData.append('message', html);
  formData.append('_captcha', 'false');

  try {
    const emailResp = await fetch(`https://formsubmit.co/ajax/${NOTIFY_EMAIL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: `🐣 Kontrola hnízd: ${dead.length} nefunkčních, ${ended.length} ukončených, ${suggestions.length} návrhů`,
        message: html,
        _captcha: 'false'
      })
    });
    const emailResult = await emailResp.json();
    console.log('Email odeslán:', emailResult.success ? '✅' : '❌');
  } catch (e) {
    console.error('Chyba odesílání emailu:', e.message);
    // Fallback - save report to file
    fs.writeFileSync('report.html', html);
    console.log('Report uložen do report.html');
  }
}

main().catch(err => {
  console.error('Fatální chyba:', err);
  process.exit(1);
});
