// api/_lib/driveBot.js
//
// Server-side port of the browser's Drive Bot (public/index.html →
// processDriveClient). Runs headless from api/cron/drive-bot.js so it no
// longer depends on someone having the app open and clicking "Run Now".
//
// Simplifications vs. the browser version (kept deliberately, to stay
// robust unattended):
//   - If a Drive file can't be made public, that file is skipped for this
//     run (no download+re-upload fallback) — it'll be retried next run.
//   - No dual-daily image/video pairing edge cases beyond what's below;
//     the core scheduling model (frequency days / specific dates / random
//     time window / dual-daily) is ported faithfully.

const { getCollection } = require('./db');
const { getValidAccessToken } = require('./googleOAuth');
const { getStatusForClient: getYtStatusForClient } = require('./youtubeOAuth');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

function extractDriveFolderId(url) {
  const m = (url || '').match(/\/folders\/([a-zA-Z0-9_-]{10,})/) || (url || '').match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  return m ? m[1] : null;
}

async function fetchDriveFolderFiles(token, folderId) {
  const acceptedExts = ['jpg','jpeg','png','webp','gif','mp4','mov','avi','webm'];
  const mimeMap = {
    jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',
    mp4:'video/mp4',mov:'video/quicktime',avi:'video/x-msvideo',webm:'video/webm'
  };
  const mimeTypes = acceptedExts.map(e => `mimeType='${mimeMap[e]}'`).join(' or ');
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and (${mimeTypes})`);
  const fields = encodeURIComponent('files(id,name,mimeType,size)');
  const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=${fields}&pageSize=100`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 401) throw new Error('Google token expired/invalid — reconnect in Settings → Google Drive.');
  if (res.status === 403) throw new Error('Permission denied — make sure the folder is shared with the connected account.');
  if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(`Drive API error ${res.status}: ${e?.error?.message || res.statusText}`); }
  const data = await res.json();
  return (data.files || []).map(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return { id: f.id, name: f.name, isVideo: ['mp4','mov','avi','webm'].includes(ext), mimeType: f.mimeType };
  });
}

// Same pairing convention as the browser version — see public/index.html's
// pairDriveThumbnails() for the full rationale.
function pairDriveThumbnails(files) {
  const baseKeys = (name, stripLetter) => {
    const noExt = name.replace(/\.[^/.]+$/, '').trim().toLowerCase();
    const keys = new Set([noExt]);
    if (stripLetter && noExt.length > 1 && noExt.endsWith(stripLetter)) keys.add(noExt.slice(0, -1).trim());
    return keys;
  };
  const images = files.filter(f => !f.isVideo);
  const videos = files.filter(f => f.isVideo);
  const thumbByVideoId = {};
  const claimedImageIds = new Set();
  for (const v of videos) {
    const vKeys = baseKeys(v.name, 'v');
    const match = images.find(img => {
      if (claimedImageIds.has(img.id)) return false;
      const iKeys = baseKeys(img.name, 't');
      for (const k of iKeys) if (vKeys.has(k)) return true;
      return false;
    });
    if (match) { thumbByVideoId[v.id] = match; claimedImageIds.add(match.id); }
  }
  const schedulable = files.filter(f => f.isVideo || !claimedImageIds.has(f.id));
  return { schedulable, thumbByVideoId };
}

async function makeFilePublic(token, fileId) {
  const res = await fetch(`${DRIVE_API}/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });
  if (!res.ok) { const t = await res.text().catch(()=> ''); throw new Error(`Drive permissions API ${res.status}: ${t.slice(0,200)}`); }
  return `https://drive.google.com/uc?id=${fileId}&export=download`;
}

async function deleteDriveFile(token, fileId) {
  // Moves to Trash (recoverable for 30 days) instead of a hard DELETE —
  // a hard DELETE bypasses Drive's trash entirely and is not recoverable
  // through the normal Drive UI. This is a deliberate safety margin: if a
  // file gets flagged for cleanup incorrectly, you have a month to notice
  // and restore it from Drive's own Trash folder.
  try {
    await fetch(`${DRIVE_API}/files/${fileId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });
  } catch (e) { /* best-effort */ }
}

// Facebook Pages support native scheduled publishing (published:false +
// scheduled_publish_time), so — unlike Instagram, which has no such native
// concept and needs our own igQueue + cron to fire at the right minute —
// we just make ONE Graph API call right now, passing the future timestamp,
// and Meta itself publishes it later. No queue, no separate cron needed.
async function postToFacebookAuto(target, caption, mediaUrl, isVideo, scheduledUnix) {
  const { accountId, token } = target;
  if (isVideo) {
    const body = new URLSearchParams({
      description: caption, published: 'false', scheduled_publish_time: String(scheduledUnix),
      file_url: mediaUrl, access_token: token
    });
    const res = await fetch(`https://graph.facebook.com/v19.0/${accountId}/videos`, { method: 'POST', body });
    const data = await res.json();
    if (data.error) throw new Error(`[${data.error.code}] ${data.error.message}`);
    return data.id;
  }
  const up = new URLSearchParams({ url: mediaUrl, published: 'false', access_token: token });
  const upRes = await fetch(`https://graph.facebook.com/v19.0/${accountId}/photos`, { method: 'POST', body: up });
  const upData = await upRes.json();
  if (upData.error) throw new Error(`Photo upload: [${upData.error.code}] ${upData.error.message}`);

  const feed = new URLSearchParams({
    message: caption, published: 'false', scheduled_publish_time: String(scheduledUnix),
    'attached_media[0]': JSON.stringify({ media_fbid: upData.id }), access_token: token
  });
  const feedRes = await fetch(`https://graph.facebook.com/v19.0/${accountId}/feed`, { method: 'POST', body: feed });
  const feedData = await feedRes.json();
  if (!feedData.error && (feedData.id || feedData.post_id)) return feedData.id || feedData.post_id;

  // Fallback: some Pages reject the two-step attached_media flow — post the
  // photo directly with a caption + schedule instead (mirrors the browser's
  // fallback path).
  const fb2 = new URLSearchParams({
    url: mediaUrl, caption, published: 'false', scheduled_publish_time: String(scheduledUnix), access_token: token
  });
  const fb2Res = await fetch(`https://graph.facebook.com/v19.0/${accountId}/photos`, { method: 'POST', body: fb2 });
  const fb2Data = await fb2Res.json();
  if (fb2Data.error) throw new Error(`[${fb2Data.error.code}] ${fb2Data.error.message}`);
  return fb2Data.id;
}

async function generateCaption(cfg, client, brandDoc, fileName, mediaType) {
  if (!cfg.aiServerUrl) throw new Error('No ChatGPT server URL configured (Settings → ChatGPT server).');
  const topic = fileName.replace(/\.[^/.]+$/,'').replace(/[-_]+/g,' ').replace(/\b\w/g,x=>x.toUpperCase());
  const brand = brandDoc ? brandDoc.content : `Brand: ${client.name}. Type: ${client.businessType||'Business'}.`;
  const contactParts = [];
  if (client.website) contactParts.push(`🌐 ${client.website}`);
  if (client.phone)   contactParts.push(`📞 ${client.phone}`);
  if (client.email)   contactParts.push(`✉️ ${client.email}`);
  const contactNote = contactParts.length
    ? `\n\nMANDATORY CONTACT BLOCK — copy this EXACTLY at the end of the caption (on its own lines):\n${contactParts.join('\n')}\n\nDO NOT paraphrase, abbreviate, or omit any of these. The caption is INVALID without them.`
    : '';
  const prompt = `You are an expert social media strategist for Meta (Facebook & Instagram).

BRAND INFORMATION:
${brand}

POST TOPIC (from filename): "${topic}"
MEDIA TYPE: ${mediaType}${contactNote}

WRITING REQUIREMENTS:
- Caption MUST be 4-6 sentences (not 2-3). Aim for 80-180 words of body content BEFORE the contact block.
- Start with a strong hook (question, statistic, bold statement, vivid scenario).
- Develop the value: why it matters to the reader, what problem it solves, what benefit they get.
- Use 2-4 well-placed emojis throughout.
- End with a clear, specific call-to-action (book now, DM us, visit website, etc.).
${contactParts.length ? '- After the CTA, on new lines, paste the MANDATORY CONTACT BLOCK exactly as given above. This is non-negotiable.\n' : ''}- Match the brand voice from BRAND INFORMATION above.

Return ONLY valid JSON, no markdown fences:
{"title":"Short punchy title (max 10 words)","caption":"Full 4-6 sentence caption with hook + value + CTA${contactParts.length?' + contact block on new lines at end':''}","tags":["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8"],"hashtags":"#tag1 #tag2 #tag3 #tag4 #tag5 #tag6 #tag7 #tag8"}`;

  const res = await fetch(cfg.aiServerUrl.replace(/\/+$/,'') + '/api/generate', {
    method: 'POST',
    headers: { 'x-gen-token': cfg.aiServerToken || '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, chatLink: client.chatLink || undefined })
  });
  if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || `ChatGPT server HTTP ${res.status}`); }
  const data = await res.json();
  let txt = (data.result||'').trim().replace(/```json|```/g,'').trim();
  txt = txt.replace(/[\x00-\x1F\x7F]/g, c => c==='\n'||c==='\t'?c:' ');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Invalid ChatGPT JSON');
  const jsonStr = m[0].replace(/(?<=":[\s]*"[^"\\]*)(\n)(?=[^"]*")/g, '\\n');
  const parsed = JSON.parse(jsonStr);
  if (!parsed.title || !parsed.caption) throw new Error('ChatGPT response missing title/caption');
  parsed.tags = parsed.tags || [];
  return parsed;
}

function freshPageEntryForAccount(cfg, acct) {
  const pages = cfg.metaPages || [];
  if (acct.accountType === 'facebook_page') return pages.find(p => p.pageId === acct.accountId) || null;
  return pages.find(p => p.igId === acct.accountId || (acct.pageId && p.pageId === acct.pageId)) || null;
}

async function ensureIgTargetsForClient(cfg, client, targets, metaAccountsCol) {
  const existingIgIds = new Set(targets.filter(t => t.accountType === 'instagram_business').map(t => t.accountId));
  const fbPages = targets.filter(t => t.accountType === 'facebook_page');
  const now = new Date().toISOString();
  for (const fb of fbPages) {
    const pg = (cfg.metaPages || []).find(p => p.pageId === fb.accountId);
    let igId = pg?.igId || null, igName = pg?.igName || null, igToken = pg?.pageToken || fb.token;
    if (!igId && fb.token) {
      try {
        const r = await fetch(`https://graph.facebook.com/v19.0/${fb.accountId}?fields=instagram_business_account{id,username,name}&access_token=${fb.token}`);
        const d = await r.json();
        if (d.instagram_business_account?.id) { igId = d.instagram_business_account.id; igName = d.instagram_business_account.username || d.instagram_business_account.name || null; }
      } catch (_) {}
    }
    if (igId && !existingIgIds.has(igId)) {
      const existing = await metaAccountsCol.findOne({ clientId: client.id, accountId: igId });
      if (!existing) {
        await metaAccountsCol.insertOne({
          clientId: client.id, accountId: igId, accountName: igName || 'Instagram', accountType: 'instagram_business',
          pageId: fb.accountId, accessToken: igToken, isActive: true, createdAt: now, updatedAt: now
        });
      }
      targets.push({ accountId: igId, accountName: igName || 'Instagram', token: igToken, accountType: 'instagram_business', pageId: fb.accountId });
      existingIgIds.add(igId);
    }
  }
  return targets;
}

const ALL_DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// Runs the full pipeline for one client. Returns { scheduled, log[] }.
async function runForClient(client, ctx) {
  const log = [];
  const push = (msg, type='info') => log.push({ ts: new Date().toISOString(), msg, type });

  const folderId = extractDriveFolderId(client.driveLink);
  if (!folderId) { push(`✗ invalid Drive link`, 'err'); return { scheduled: 0, log }; }

  const { cfg, driveToken, metaAccountsCol, scheduledPostsCol, igQueueCol, ytQueueCol, clientsCol, brandDetailsCol } = ctx;

  let targets = (await metaAccountsCol.find({ clientId: client.id, isActive: true }).toArray()).map(m => {
    const pg = freshPageEntryForAccount(cfg, m);
    const freshToken = pg?.pageToken || null;
    return { accountId: m.accountId, accountName: m.accountName, token: freshToken || m.accessToken, accountType: m.accountType, pageId: m.pageId };
  });
  targets = await ensureIgTargetsForClient(cfg, client, targets, metaAccountsCol);
  const seen = new Set();
  const uniqueTargets = targets.filter(t => { if (seen.has(t.accountId)) return false; seen.add(t.accountId); return true; });

  const wantsYoutube = !!client.ytChannelId;
  let ytConnected = false;
  if (wantsYoutube) { try { ytConnected = (await getYtStatusForClient(client.id)).connected; } catch (_) {} }

  if (!uniqueTargets.length && !(wantsYoutube && ytConnected)) {
    push(`⚠ no Meta accounts linked and no connected auto-YouTube — nothing to do`, 'warn');
    return { scheduled: 0, log };
  }

  const fetchFmt = client.driveDualDaily ? 'both' : (client.driveFmt || 'image');
  let driveFiles, thumbByVideoId = {};
  try {
    const allFiles = await fetchDriveFolderFiles(driveToken, folderId);
    const paired = pairDriveThumbnails(allFiles);
    thumbByVideoId = paired.thumbByVideoId;
    driveFiles = paired.schedulable.filter(f => fetchFmt === 'both' ? true : (fetchFmt === 'reel' ? f.isVideo : !f.isVideo));
    push(`📁 ${driveFiles.length} file(s) found (${Object.keys(thumbByVideoId).length} thumbnail-paired)`, 'ok');
  } catch (e) { push(`✗ ${e.message}`, 'err'); return { scheduled: 0, log }; }

  if (!driveFiles.length) { push(`ℹ no matching files`, 'info'); return { scheduled: 0, log }; }

  const doneDocs = await scheduledPostsCol.find({ clientId: client.id, status: { $ne: 'failed' } }).toArray();
  const alreadyDoneNames = new Set(doneDocs.map(s => s.fileName));
  const alreadyDoneIds = new Set(doneDocs.filter(s => s.driveFileId).map(s => s.driveFileId));
  const newFiles = driveFiles.filter(f => !alreadyDoneNames.has(f.name) && !alreadyDoneIds.has(f.id));
  push(`🆕 ${newFiles.length} new file(s) to schedule (${driveFiles.length - newFiles.length} already done)`, 'ok');
  if (!newFiles.length) return { scheduled: 0, log };

  let freqDays;
  if (client.driveFreq === 'custom') freqDays = (client.driveCustomDays?.length) ? client.driveCustomDays : ['Mon','Wed','Fri'];
  else if (client.driveFreq === '6x') freqDays = ['Mon','Tue','Wed','Thu','Fri','Sat'];
  else freqDays = ['Mon','Wed','Fri'];

  const randomInRange = (startTime, endTime) => {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const startMin = sh*60+sm; let endMin = eh*60+em;
    if (endMin <= startMin) endMin = startMin;
    const picked = startMin === endMin ? startMin : startMin + Math.floor(Math.random()*(endMin-startMin+1));
    return { hh: Math.floor(picked/60), mm: picked%60 };
  };

  const today = new Date();
  function qualifyingDays(count) {
    const days = [];
    if (client.driveFreq === 'dates') {
      return (client.driveDates || [])
        .map(ds => new Date(ds + 'T00:00:00'))
        .filter(d => !isNaN(d) && d >= new Date(today.getFullYear(), today.getMonth(), today.getDate()))
        .sort((a,b) => a-b).slice(0, count);
    }
    const cursor = new Date(today); cursor.setHours(0,0,0,0); cursor.setDate(cursor.getDate()+1);
    while (days.length < count) {
      const dayName = ALL_DAYS[cursor.getDay()===0?6:cursor.getDay()-1];
      if (freqDays.includes(dayName)) days.push(new Date(cursor));
      cursor.setDate(cursor.getDate()+1);
      if (cursor - today > 1000*60*60*24*90) break;
    }
    return days;
  }

  const pairs = [];
  if (client.driveDualDaily) {
    const images = newFiles.filter(f => !f.isVideo);
    const videos = newFiles.filter(f => f.isVideo);
    const mStart = client.driveMorningStart || '08:00', mEnd = client.driveMorningEnd || mStart;
    const eStart = client.driveEveningStart || '18:00', eEnd = client.driveEveningEnd || eStart;
    const days = qualifyingDays(Math.max(images.length, videos.length));
    let ii=0, vi=0;
    for (const day of days) {
      if (ii < images.length) { const slot = new Date(day); const {hh,mm}=randomInRange(mStart,mEnd); slot.setHours(hh,mm,0,0); pairs.push({file:images[ii++],date:slot}); }
      if (vi < videos.length) { const slot = new Date(day); const {hh,mm}=randomInRange(eStart,eEnd); slot.setHours(hh,mm,0,0); pairs.push({file:videos[vi++],date:slot}); }
    }
  } else {
    const startTime = client.driveTime || '18:00', endTime = client.driveTimeEnd || startTime;
    const days = qualifyingDays(newFiles.length);
    for (let i=0; i<newFiles.length && i<days.length; i++) {
      const slot = new Date(days[i]); const {hh,mm}=randomInRange(startTime,endTime); slot.setHours(hh,mm,0,0);
      pairs.push({file:newFiles[i], date:slot});
    }
  }

  const brandDoc = await brandDetailsCol.findOne({ clientId: client.id });
  let scheduled = 0;

  for (const { file: df, date: schedDate } of pairs) {
    if (!schedDate) { push(`⚠ ran out of schedule dates`, 'warn'); break; }

    let generated;
    try { generated = await generateCaption(cfg, client, brandDoc, df.name, df.isVideo?'video':'image'); }
    catch (e) { push(`✗ ChatGPT error for ${df.name}: ${e.message}`, 'err'); continue; }

    let drivePublicUrl = null;
    try { drivePublicUrl = await makeFilePublic(driveToken, df.id); }
    catch (e) { push(`✗ could not make ${df.name} public: ${e.message} — skipping`, 'err'); continue; }

    const pairedThumb = df.isVideo ? thumbByVideoId[df.id] : null;
    if (df.isVideo) {
      push(pairedThumb
        ? `🔎 ${df.name}: matched thumbnail "${pairedThumb.name}"`
        : `🔎 ${df.name}: no matching thumbnail found (expected same base name, e.g. "...V.mp4" + "...T.png")`, 'info');
    }
    let thumbPublicUrl = null;
    if (pairedThumb) {
      try { thumbPublicUrl = await makeFilePublic(driveToken, pairedThumb.id); push(`🖼 ${pairedThumb.name} → cover for ${df.name}`, 'ok'); }
      catch (e) { push(`⚠ thumbnail ${pairedThumb.name} public failed: ${e.message} — posting without custom cover`, 'warn'); }
    }

    const fullCaption = `${generated.caption}\n\n${generated.hashtags || generated.tags.join(' ')}`;
    const publishAs = client.drivePublishAs === 'story' ? 'story' : 'post';
    const postTime = schedDate < new Date(Date.now()+11*60*1000) ? new Date(Date.now()+11*60*1000) : schedDate;
    const scheduledUnix = Math.floor(postTime.getTime()/1000);
    const now = new Date().toISOString();

    const postId = await nextIdFor(ctx, 'scheduledPosts');
    const postEntry = {
      id: postId, clientId: client.id, metaAccountId: null,
      fileName: df.name, title: generated.title, caption: generated.caption,
      tags: generated.tags.join(','), hashtags: generated.hashtags || generated.tags.join(' '),
      mediaType: df.isVideo ? 'video' : 'image', scheduledDates: [postTime.toISOString()],
      status: 'draft', metaPostIds: [], errorMessage: null, createdAt: now, updatedAt: now, driveFileId: df.id,
      thumbnailFileName: pairedThumb ? pairedThumb.name : null,
      thumbnailDriveFileId: pairedThumb ? pairedThumb.id : null,
      driveDeleteAfter: new Date(postTime.getTime() + 7*24*60*60*1000).toISOString(),
      driveDeleted: false
    };

    let queuedAny = false;

    for (const target of uniqueTargets) {
      if (target.accountType === 'facebook_page') {
        try {
          const fbCaption = publishAs === 'story' ? '' : fullCaption; // FB has no native "story" scheduling via this endpoint — treat as a normal feed post
          const fbPostId = await postToFacebookAuto(target, fbCaption, drivePublicUrl, df.isVideo, scheduledUnix);
          postEntry.metaPostIds.push(fbPostId);
          queuedAny = true;
          push(`📘 ${df.name} → Facebook Page "${target.accountName}" scheduled (Meta will publish it natively)`, 'ok');
        } catch (e) {
          push(`✗ Facebook post failed for ${target.accountName}: ${e.message}`, 'err');
        }
        continue;
      }
      if (target.accountType !== 'instagram_business') continue;
      const jobId = `ig_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const job = {
        jobId, igId: target.accountId, fbToken: target.token,
        caption: (publishAs==='story' ? '' : fullCaption), mediaUrl: drivePublicUrl,
        mediaType: df.isVideo ? 'video' : 'image', publishAs, scheduledUnix,
        accountName: target.accountName, clientId: client.id, scheduledPostId: postEntry.id, status: 'pending'
      };
      if (df.isVideo && thumbPublicUrl) job.thumbnailUrl = thumbPublicUrl;
      if (df.isVideo) push(pairedThumb ? (thumbPublicUrl ? `📎 cover attached to IG job: ${thumbPublicUrl}` : `📎 cover NOT attached (thumbnail found but making it public failed — see warning above)`) : `📎 no cover (no matching thumbnail image in this Drive folder)`, thumbPublicUrl ? 'ok' : 'warn');
      await igQueueCol.insertOne({ ...job, id: await nextIdFor(ctx,'igQueue'), attempts:0, lastError:null, metaPostId:null, createdAt: now, updatedAt: now });
      postEntry.metaPostIds.push(jobId);
      queuedAny = true;
    }

    if (df.isVideo && wantsYoutube && ytConnected) {
      await ytQueueCol.insertOne({
        id: await nextIdFor(ctx,'ytQueue'), clientId: client.id, driveFileId: df.id, fileName: df.name,
        title: generated.title, description: generated.caption, tags: generated.tags.map(t=>t.replace(/^#/,'')),
        scheduledPostId: postEntry.id, scheduledUnix, status: 'pending', attempts: 0, lastError: null,
        youtubeVideoId: null, createdAt: now, updatedAt: now
      });
      queuedAny = true;
      push(`📺 ${df.name} queued for YouTube`, 'ok');
    }

    if (!queuedAny) { push(`⚠ ${df.name}: nothing to queue it to (no IG targets, no connected auto-YouTube) — skipped`, 'warn'); continue; }

    await scheduledPostsCol.insertOne(postEntry);
    scheduled++;
    push(`✓ ${df.name} scheduled @ ${postTime.toISOString()}`, 'ok');
  }

  return { scheduled, log };
}

async function nextIdFor(ctx, kind) {
  const counters = ctx.configCol;
  const res = await counters.findOneAndUpdate(
    { _id: `counter_${kind}` }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' }
  );
  const doc = (res && res.value && typeof res.value === 'object') ? res.value : res;
  if (doc && typeof doc.value === 'number') return doc.value;
  const d = await counters.findOne({ _id: `counter_${kind}` });
  return (d && typeof d.value === 'number') ? d.value : 1;
}

// Deletes Drive files (and their paired thumbnail) whose 1-week-after-
// schedule window has passed. Mirrors the browser's purgeDueDriveFiles().
//
// IMPORTANT: driveDeleteAfter must be checked with $type + $lte, NOT
// $ne: null. In MongoDB, a MISSING field satisfies {$ne: null} (it's not
// equal to null, it's just absent) and also sorts as less than any date
// string for {$lte} — so a loose $ne/$lte combo matches every record that
// never had driveDeleteAfter set at all, i.e. your entire pre-existing
// history. That bug caused a mass deletion; this explicit $type guard
// is what prevents it from ever happening again.
async function purgeDueDriveFiles(ctx) {
  const { scheduledPostsCol, driveToken } = ctx;
  const now = Date.now();
  const due = await scheduledPostsCol.find({
    driveFileId: { $ne: null },
    driveDeleted: { $ne: true },
    driveDeleteAfter: { $type: 'string', $lte: new Date(now).toISOString() }
  }).toArray();
  let removed = 0;
  const seen = new Set();
  for (const p of due) {
    if (!seen.has(p.driveFileId)) { await deleteDriveFile(driveToken, p.driveFileId); seen.add(p.driveFileId); }
    if (p.thumbnailDriveFileId && !seen.has(p.thumbnailDriveFileId)) { await deleteDriveFile(driveToken, p.thumbnailDriveFileId); seen.add(p.thumbnailDriveFileId); }
    await scheduledPostsCol.updateOne({ id: p.id }, { $set: { driveDeleted: true, updatedAt: new Date().toISOString() } });
    removed++;
  }
  return removed;
}

module.exports = { runForClient, purgeDueDriveFiles, extractDriveFolderId };
