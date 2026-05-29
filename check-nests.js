const fs = require('fs');

const YT_API_KEY = process.env.YT_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY;

async function main() {
  const data = JSON.parse(fs.readFileSync('nests.json', 'utf8'));
  const nests = data.youtube || [];
  
  console.log(`Kontroluji ${nests.length} YouTube hnízd...`);

  // Batch check videos
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
      json.items.forEach(item => { results[item.id] = item; });
    }
  }

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

  // Search for new live streams on channels with problems
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
          const title = item.snippet.title;
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
    await new Promise(r => setTimeout(r, 200));
  }

  // Only create issue if there are problems
  if (dead.length === 0 && ended.length === 0) {
    console.log('✅ Všechna hnízda v pořádku.');
    return;
  }

  // Build issue body
  const now = new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
  let body = `## 🐣 Denní kontrola – ${now}\n\n`;
  body += `**Shrnutí:** ${nests.length} hnízd · 🟢 Živě: ${live.length} · 🟡 Existuje: ${ended.length + ok.length} · 🔴 Nefunguje: ${dead.length}\n\n`;

  if (dead.length > 0) {
    body += `### 🔴 Nefunkční hnízda (${dead.length})\n\n`;
    body += `| Hnízdo | ID | Důvod |\n|---|---|---|\n`;
    for (const n of dead) {
      body += `| **${n.name}** | \`${n.id}\` | ${n.reason} |\n`;
    }
    body += '\n';
  }

  if (ended.length > 0) {
    body += `### 🟡 Vysílání ukončeno (${ended.length})\n\n`;
    body += `| Hnízdo | ID | Kanál |\n|---|---|---|\n`;
    for (const n of ended) {
      body += `| **${n.name}** | \`${n.id}\` | ${n.channelTitle || '—'} |\n`;
    }
    body += '\n';
  }

  if (suggestions.length > 0) {
    body += `### 💡 Nalezeny nové live streamy (${suggestions.length})\n\n`;
    body += `| Hnízdo | Nový stream | Link |\n|---|---|---|\n`;
    for (const s of suggestions) {
      body += `| **${s.nestName}** (starý: \`${s.oldId}\`) | ${s.newTitle} | [${s.newId}](https://www.youtube.com/watch?v=${s.newId}) |\n`;
    }
    body += '\n';
  }

  body += `---\n*Změny proveď v [admin panelu](https://capihnizdaonline.cz) na webu.*`;

  // Create GitHub Issue
  const issueResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: `🐣 Kontrola ${now}: ${dead.length} nefunkčních, ${ended.length} ukončených`,
      body: body,
      labels: ['kontrola']
    })
  });

  if (issueResp.ok) {
    const issue = await issueResp.json();
    console.log(`✅ Issue vytvořeno: ${issue.html_url}`);
  } else {
    const err = await issueResp.json();
    console.error('❌ Chyba vytváření issue:', err.message);
  }
}

main().catch(err => { console.error('Fatální chyba:', err); process.exit(1); });
