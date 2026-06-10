const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Shared browser launch options
const LAUNCH_OPTS = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
};

// POST /measure-handles
// Body: { "handles": ["umay_music", "captainjuniordj", "vifak"] }
// Returns: { "widths": { "umay_music": 678, "captainjuniordj": 894, "vifak": 377 } }
app.post('/measure-handles', async (req, res) => {
  const { handles } = req.body;

  if (!handles || !Array.isArray(handles) || handles.length === 0) {
    return res.status(400).json({ error: 'Missing or empty handles array' });
  }

  // Build HTML with one <insta-mention> per handle, all unscaled at left:0
  // Wrapped in a hidden off-screen container so they render but aren't visible
  const mentionElements = handles.map((handle, i) =>
    `<insta-mention id="handle-${i}" username="${handle}" design="default" style="position:absolute;left:0;top:${i * 300}px;transform:scale(1);"></insta-mention>`
  ).join('\n');

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8" />
    <script src="https://9c0cdf09-f578-45d9-9b30-8e6129de367a.storrito.com/js/insta-components.js"></script>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: transparent;
      }
      insta-story {
        display: block;
        width: 1080px;
        height: 1920px;
        position: relative;
        overflow: visible;
      }
    </style>
  </head>
  <body>
    <insta-story>
      ${mentionElements}
    </insta-story>
  </body>
  </html>
  `;

  let browser;
  try {
    browser = await puppeteer.launch(LAUNCH_OPTS);
    const page = await browser.newPage();

    await page.setViewport({
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1
    });

    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Wait for web components to fully render by polling until first element has non-zero width
    await page.waitForFunction(() => {
      const el = document.getElementById('handle-0');
      if (!el) return false;
      // Check the element itself and its shadow root children
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) return true;
      // Some web components render inside shadow DOM
      if (el.shadowRoot) {
        const inner = el.shadowRoot.firstElementChild;
        if (inner && inner.getBoundingClientRect().width > 0) return true;
      }
      return false;
    }, { timeout: 15000 });

    // Extra buffer for all elements to finish rendering
    await new Promise(r => setTimeout(r, 500));

    // Measure each handle's bounding rect
    const widths = {};
    for (let i = 0; i < handles.length; i++) {
      const width = await page.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        // Try the element itself first
        let rect = el.getBoundingClientRect();
        if (rect.width > 0) return Math.round(rect.width);
        // Fall back to shadow root
        if (el.shadowRoot) {
          const inner = el.shadowRoot.firstElementChild;
          if (inner) {
            rect = inner.getBoundingClientRect();
            if (rect.width > 0) return Math.round(rect.width);
          }
        }
        // Fall back to offsetWidth
        return el.offsetWidth || null;
      }, `handle-${i}`);

      widths[handles[i]] = width;
    }

    res.json({ widths });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    if (browser) await browser.close();
  }
});

// POST /render
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
        margin: 0;
        padding: 0;
        width: 2335px;
        height: 2651px;
        background: transparent;
        overflow: hidden;
      }

      .canvas {
        position: relative;
        width: 2335px;
        height: 2651px;
      }

      .bg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;

        -webkit-mask-image: url('${maskUrl}');
        -webkit-mask-repeat: no-repeat;
        -webkit-mask-position: center;
        -webkit-mask-size: 100% 100%;

        mask-image: url('${maskUrl}');
        mask-repeat: no-repeat;
        mask-position: center;
        mask-size: 100% 100%;
      }

      .outline {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
        pointer-events: none;
      }
    </style>
  </head>
  <body>
    <div class="canvas">
      <img class="bg" src="${backgroundUrl}" />
      <img class="outline" src="${outlineUrl}" />
    </div>
  </body>
  </html>
  `;

  let browser;
  try {
    browser = await puppeteer.launch(LAUNCH_OPTS);

    const page = await browser.newPage();
    await page.setViewport({
      width: 2335,
      height: 2651,
      deviceScaleFactor: 1
    });

    await page.setContent(html, { waitUntil: 'networkidle0' });

    const buffer = await page.screenshot({
      type: 'png',
      omitBackground: true
    });

    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(3000, () => {
  console.log('Render server running on port 3000');
});
