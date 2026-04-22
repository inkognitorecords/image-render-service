const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '10mb' }));

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
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

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
