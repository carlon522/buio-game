'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const config = require('../../playwright.config');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.PLAYWRIGHT_PORT || config.webServer.port || 3105);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;
const SCREENSHOT_DIR = config.use.screenshotDir;

function waitForServer(timeoutMs = config.webServer.timeout) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(BASE_URL, res => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`Server did not start at ${BASE_URL}`));
        else setTimeout(tick, 250);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    tick();
  });
}

async function launchBrowser() {
  const options = { headless: config.use.headless !== false };
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) options.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  return chromium.launch(options);
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const server = spawn(config.webServer.command, {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT) },
  });
  let serverLog = '';
  server.stdout.on('data', chunk => { serverLog += chunk.toString(); });
  server.stderr.on('data', chunk => { serverLog += chunk.toString(); });

  let browser;
  try {
    await waitForServer();
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleErrors = [];
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Cards && window.S));

    const assets = await page.evaluate(async () => ({
      hasV3Css: [...document.styleSheets].some(sheet => sheet.href && sheet.href.includes('buio-v3-animation-overhaul.css')),
      hasV3Script: [...document.scripts].some(script => script.src.includes('buio-v3-animation-overhaul.js')),
      oppDrawSource: String(Cards.oppDraw),
      oppDiscardSource: String(Cards.oppDiscard),
      appSource: await fetch('/js/app.js?v=61').then(response => response.text()),
    }));
    const appSource = assets.appSource;
    assert.equal(assets.hasV3Css, true, 'v3 animation CSS should be loaded');
    assert.equal(assets.hasV3Script, true, 'v3 animation script should be loaded');
    assert.match(assets.oppDrawSource, /linear:true/, 'opponent draw should request linear flight');
    assert.match(assets.oppDiscardSource, /linear:true/, 'opponent discard should request linear flight');
    assert.match(appSource, /primeCardImage\(card\)\.finally/, 'look-card reveal should wait for image decode');

    const animationProbe = await page.evaluate(async () => {
      document.body.insertAdjacentHTML('beforeend', `
        <div id="deck-pile" style="position:fixed;left:40px;top:40px;width:68px;height:104px"></div>
        <div class="seat" style="position:fixed;left:420px;top:180px"><div class="seat-cards"><div class="mini-card" id="target-mini"></div></div></div>
      `);
      const deckRect = Cards.rect(document.getElementById('deck-pile'));
      const targetRect = Cards.rect(document.getElementById('target-mini'));
      const flight = Cards.oppDraw(deckRect, targetRect);
      await new Promise(resolve => setTimeout(resolve, 160));
      const ghost = document.querySelector('.card-ghost');
      const mid = ghost ? {
        width: ghost.getBoundingClientRect().width,
        height: ghost.getBoundingClientRect().height,
        transition: getComputedStyle(ghost).transitionTimingFunction,
        transform: getComputedStyle(ghost).transform,
      } : null;
      await flight;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        mid,
        finalGhosts: document.querySelectorAll('.card-ghost').length,
        targetWidth: targetRect.width,
        targetHeight: targetRect.height,
      };
    });
    assert(animationProbe.mid, 'opponent draw ghost should exist mid-flight');
    assert.notEqual(animationProbe.mid.transform, 'none', 'opponent ghost should be moving via transform');
    assert.equal(animationProbe.finalGhosts, 0, 'opponent draw ghost should be removed after landing');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'opponent-animation-probe.png'), fullPage: true });
    assert.deepEqual(consoleErrors, [], `Browser console/page errors: ${consoleErrors.join('\n')}`);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    if (serverLog && process.env.PLAYWRIGHT_DEBUG_LOG) process.stdout.write(serverLog);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
