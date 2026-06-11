const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── STORRITO CONFIG ──────────────────────────────────────────────────────────

const STORRITO_BASE_URL = 'https://9c0cdf09-f578-45d9-9b30-8e6129de367a.storrito.com/api/v1';
const STORRITO_TOKEN = process.env.STORRITO_TOKEN;
const INSTAGRAM_USERNAME = 'inkognitorecords';

// ─── MENTION STICKER POSITIONING ─────────────────────────────────────────────

const CHAR_WIDTHS = {
  _: 43.86, a: 58.38, b: 61.14, c: 55.84, d: 68.83, e: 65.64, f: 48.31,
  g: 38.39, h: 54.36, i: 26.87, j: 30.84, k: 60.43, l: 37.86, m: 72.81,
  n: 63.54, o: 65.03, p: 68.26, r: 39.73, s: 53.63, t: 46.01, u: 62.01,
  v: 54.01, y: 40.79, z: 22.05
};
const CHAR_FALLBACK = 55;
const PADDING = 129;
const STICKER_NATURAL_HEIGHT = 175;
const MENTION_MIDLINE_X = 247;
const MENTION_FIRST_TOP = 1006;
const MENTION_BOTTOM_LIMIT = 1293;
const MENTION_GAP = 20;

function naturalWidth(username) {
  const chars = username.toLowerCase().split('');
  const charSum = chars.reduce((sum, c) => sum + (CHAR_WIDTHS[c] || CHAR_FALLBACK), 0);
  return charSum + PADDING;
}

function buildMentionStickers(handles) {
  // handles are like ["@tomnoize", "@diggitall"] — strip @ for the component
  const usernames = handles.map(h => h.replace(/^@/, ''));

  // Scale based on longest handle to fit within left half (0–495px, 60px margin each side)
  const maxWidth = usernames.reduce((max, u) => Math.max(max, naturalWidth(u)), 0);
  const targetWidth = 375;
  let scale = targetWidth / maxWidth;
  scale = Math.min(scale, 1); // never upscale

  // Check if all stickers fit vertically without compression
  const totalRequired = usernames.length * STICKER_NATURAL_HEIGHT * scale
    + (usernames.length - 1) * MENTION_GAP;
  const available = MENTION_BOTTOM_LIMIT - MENTION_FIRST_TOP;

  let compressionFactor = 1;
  if (totalRequired > available) {
    compressionFactor = available / totalRequired;
    scale = scale * compressionFactor;
  }

  const stickers = [];
  let currentTop = MENTION_FIRST_TOP;

  for (const username of usernames) {
    const w = naturalWidth(username) * scale;
    const left = Math.round(MENTION_MIDLINE_X - w / 2);
    stickers.push(
      `<insta-mention username="${username}" design="default" ` +
      `style="position:absolute;left:${left}px;top:${Math.round(currentTop)}px;` +
      `transform:scale(${scale.toFixed(4)});transform-origin:top left;"></insta-mention>`
    );
    currentTop += STICKER_NATURAL_HEIGHT * scale + MENTION_GAP;
  }

  return stickers.join('\n');
}

// ─── HTML BUILDER ─────────────────────────────────────────────────────────────

function buildStoryHtml({ videoUrl, smartLink, handles, hashtags, storyType }) {
  const linkText = storyType === 'BR' ? 'PRE-SAVE' : 'LISTEN NOW!';
  const linkLeft = storyType === 'BR' ? 348 : 312;

  const linkSticker =
    `<insta-link url="${smartLink}" text="${linkText}" design="black" ` +
    `style="position:absolute;left:${linkLeft}px;top:360px;` +
    `transform:scale(0.67);transform-origin:top left;"></insta-link>`;

  const mentionStickers = buildMentionStickers(handles);

  // All hashtags placed off-screen to the right — invisible but registered by Instagram
  const hashtagStickers = hashtags.map(tag =>
    `<insta-hashtag hashtag="${tag}" design="gray" ` +
    `style="position:absolute;left:1200px;top:500px;"></insta-hashtag>`
  ).join('\n');

  return `<insta-story src="${videoUrl}">
${linkSticker}
${mentionStickers}
${hashtagStickers}
</insta-story>`;
}

// ─── SCHEDULE TIMES (UTC) ────────────────────────────────────────────────────
// Dubai = UTC+4, no DST. All times below are Dubai times converted to UTC.
//
// BR stories:
//   R-4 18:00 Dubai = R-4 14:00 UTC
//   R-3 20:00 Dubai = R-3 16:00 UTC
//   R-2 22:00 Dubai = R-2 18:00 UTC
//
// AR stories:
//   R+0 14:00 Dubai = R+0 10:00 UTC
//   R+1 15:00 Dubai = R+1 11:00 UTC
//   R+2 18:00 Dubai = R+2 14:00 UTC
//   R+4 20:00 Dubai = R+4 16:00 UTC
//   R+6 22:00 Dubai = R+6 18:00 UTC

function buildSchedule(releaseDateStr) {
  function toUtc(dateStr, hourUtc) {
    return `${dateStr}T${String(hourUtc).padStart(2, '0')}:00:00Z`;
  }

  function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  const R = releaseDateStr;

  return [
    { label: 'BR-1', type: 'BR', date: toUtc(addDays(R, -4), 14) },
    { label: 'BR-2', type: 'BR', date: toUtc(addDays(R, -3), 16) },
    { label: 'BR-3', type: 'BR', date: toUtc(addDays(R, -2), 18) },
    { label: 'AR-1', type: 'AR', date: toUtc(addDays(R,  0), 10) },
    { label: 'AR-2', type: 'AR', date: toUtc(addDays(R,  1), 11) },
    { label: 'AR-3', type: 'AR', date: toUtc(addDays(R,  2), 14) },
    { label: 'AR-4', type: 'AR', date: toUtc(addDays(R,  4), 16) },
    { label: 'AR-5', type: 'AR', date: toUtc(addDays(R,  6), 18) },
  ];
}

// ─── STORRITO API HELPERS ─────────────────────────────────────────────────────

async function storritoRpc(procedure, params, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${STORRITO_BASE_URL}/${procedure}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STORRITO_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    if ([429, 502, 503, 504].includes(res.status)) {
      if (attempt === retries) throw new Error(`${procedure} failed after ${retries} attempts (HTTP ${res.status})`);
      const delay = 2000 + Math.random() * 1000;
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const text = await res.text();
    if (!res.ok) throw new Error(`${procedure} failed (HTTP ${res.status}): ${text}`);
    return JSON.parse(text);
  }
}

async function generateUuid() {
  const result = await storritoRpc('generate-uuid', {});
  return result.uuid;
}

async function scheduleStory({ html, date, uuid }) {
  return storritoRpc('schedule-instagram-story', {
    instagramUsername: INSTAGRAM_USERNAME,
    storyPostUuid: uuid,
    html,
    date,
  });
}

// ─── /schedule-stories ENDPOINT ──────────────────────────────────────────────

app.post('/schedule-stories', async (req, res) => {
  const {
    releaseDate,      // "YYYY-MM-DD"
    smartLink,        // "https://music.inkognitorecords.vip/..."
    artistHandles,    // "@tomnoize, @anatemusic" or ["@tomnoize"] — string or array
    brVideoUrl,       // "https://drive.google.com/uc?id=...&export=download"
    arVideoUrl,       // "https://drive.google.com/uc?id=...&export=download"
    hashtags,         // "goinkognito, deephouse, organichouse" or array
    airtableRecordId, // for logging only
  } = req.body;

  // Normalise: accept comma-separated strings or arrays for both fields
  const handlesArray = Array.isArray(artistHandles)
    ? artistHandles
    : (artistHandles || '').split(',').map(h => h.trim()).filter(Boolean);

  const hashtagsArray = Array.isArray(hashtags)
    ? hashtags
    : (hashtags || '').split(',').map(h => h.trim()).filter(Boolean);

  // Validate
  const missing = [];
  if (!releaseDate) missing.push('releaseDate');
  if (!smartLink) missing.push('smartLink');
  if (!handlesArray.length) missing.push('artistHandles');
  if (!brVideoUrl) missing.push('brVideoUrl');
  if (!arVideoUrl) missing.push('arVideoUrl');
  if (!hashtagsArray.length) missing.push('hashtags');

  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  if (!STORRITO_TOKEN) {
    return res.status(500).json({ error: 'STORRITO_TOKEN env var not set' });
  }

  const schedule = buildSchedule(releaseDate);
  const results = [];
  let allSucceeded = true;

  for (const slot of schedule) {
    const videoUrl = slot.type === 'BR' ? brVideoUrl : arVideoUrl;
    const html = buildStoryHtml({
      videoUrl,
      smartLink,
      handles: handlesArray,
      hashtags: hashtagsArray,
      storyType: slot.type,
    });

    let uuid, status, errorMessage;

    try {
      uuid = await generateUuid();
      const result = await scheduleStory({ html, date: slot.date, uuid });
      status = result.status;
      console.log(`[${airtableRecordId}] ${slot.label} scheduled: ${uuid} @ ${slot.date}`);
    } catch (err) {
      status = 'failed';
      errorMessage = err.message;
      allSucceeded = false;
      console.error(`[${airtableRecordId}] ${slot.label} failed: ${err.message}`);
    }

    results.push({
      label: slot.label,
      type: slot.type,
      date: slot.date,
      uuid: uuid || null,
      status,
      error: errorMessage || null,
    });
  }

  // Build debug string for Airtable long text field
  const debugNotes = results.map(r => {
    const base = `${r.label} | ${r.date} | ${r.status}`;
    return r.status === 'failed'
      ? `${base} | ERROR: ${r.error}`
      : `${base} | ${r.uuid}`;
  }).join('\n');

  res.json({
    allSucceeded,
    scheduledCount: results.filter(r => r.status === 'scheduled').length,
    failedCount: results.filter(r => r.status === 'failed').length,
    debugNotes,
    results,
  });
});

// ─── /render ENDPOINT (existing) ─────────────────────────────────────────────

app.post('/render', async (req, res) => {
  const { backgroundUrl, maskUrl, outlineUrl } = req.body;

  if (!backgroundUrl || !maskUrl || !outlineUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body {
        margin: 0; padding: 0;
        width: 2335px; height: 2651px;
        background: transparent; overflow: hidden;
      }
      .canvas { position: relative; width: 2335px; height: 2651px; }
      .bg {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; object-position: center;
        -webkit-mask-image: url('${maskUrl}');
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-position: center;
        -webkit-mask-size: 100% 100%;
        mask-image: url('${maskUrl}');
        mask-repeat: no-repeat; mask-position: center; mask-size: 100% 100%;
      }
      .outline {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: contain; pointer-events: none;
      }
    </style>
  </head>
  <body>
    <div class="canvas">
      <img class="bg" src="${backgroundUrl}" />
      <img class="outline" src="${outlineUrl}" />
    </div>
  </body>
  </html>`;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 2335, height: 2651, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.screenshot({ type: 'png', omitBackground: true });
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Render server running on port ${PORT}`);
});
