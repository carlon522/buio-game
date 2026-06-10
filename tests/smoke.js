'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const PORT = Number(process.env.SMOKE_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `buio-smoke-${Date.now()}.db`);
const SCREENSHOT_DIR = process.env.SMOKE_SCREENSHOT_DIR || '';

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function waitForServer(timeoutMs = 15000) {
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
  const options = { headless: true };
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
    options.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  } else if (process.platform === 'win32' && fs.existsSync(edgePath)) {
    options.executablePath = edgePath;
  }
  return chromium.launch(options);
}

async function capture(page, name) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

async function assertVersionBadge(page, label) {
  const expected = `v${PKG.version}`;
  await page.waitForFunction(version =>
    document.querySelector('#app-version')?.textContent?.trim() === version,
    expected,
    { timeout: 5000 }
  );
  const visible = await page.locator('#app-version').isVisible();
  if (!visible) throw new Error(`Version badge hidden on ${label}`);
}

async function registerAndStartBotGame(page, suffix) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await assertVersionBadge(page, 'auth');
  await page.click('[data-tab="register"]');

  const username = `smoke${suffix}${Date.now().toString().slice(-6)}`;
  await page.fill('#reg-username', username);
  await page.fill('#reg-password', 'password123');
  await page.click('#form-register button[type="submit"]');
  await page.waitForSelector('#screen-lobby.active', { timeout: 5000 });
  await assertVersionBadge(page, 'lobby');

  await page.click('#btn-vs-bot');
  await page.waitForFunction(() => typeof S !== 'undefined' && S.gameState?.phase === 'draw', null, { timeout: 10000 });
  await page.waitForFunction(() => typeof S !== 'undefined' && S.gameState?.currentPlayerUserId === S.userId, null, { timeout: 10000 });
  await assertVersionBadge(page, 'game');
}

async function drawCard(page) {
  await page.click('#btn-draw');
  await page.waitForFunction(() =>
    !document.querySelector('#btn-discard-drawn')?.disabled &&
    Boolean(document.querySelector('#drawn-card-display .card-3d')),
    null,
    { timeout: 7000 }
  );
}

async function waitForCardMotion(page) {
  await page.waitForFunction(() =>
    document.querySelectorAll('.card-ghost').length === 0 &&
    Boolean(document.querySelector('#discard-pile img')) &&
    (typeof S === 'undefined' || (!S._skipDiscard && S._animSlot === null && !S._animHidden)),
    null,
    { timeout: 8000 }
  );
}

async function assertStableTurnBar(page, expectedHeight = null) {
  const state = await page.evaluate(() => {
    const bar = document.querySelector('#turn-bar');
    const rect = bar?.getBoundingClientRect();
    return {
      visible: Boolean(bar) && getComputedStyle(bar).display !== 'none' && getComputedStyle(bar).visibility !== 'hidden',
      height: rect?.height || 0,
      text: bar?.textContent?.trim() || '',
    };
  });
  if (!state.visible || !state.text) throw new Error(`Turn bar is not persistently visible: ${JSON.stringify(state)}`);
  if (expectedHeight !== null && Math.abs(state.height - expectedHeight) > 0.5) {
    throw new Error(`Turn bar height changed: expected ${expectedHeight}, got ${state.height}`);
  }
  return state.height;
}

async function assertOpponentDiscardMotion(page, turnBarHeight) {
  await page.waitForSelector('.opp-discard-ghost', { timeout: 15000 });
  const during = await page.evaluate(() => ({
    discardGhosts: document.querySelectorAll('.opp-discard-ghost').length,
    keepGhosts: document.querySelectorAll('.opp-keep-ghost').length,
    hiddenSources: document.querySelectorAll('.seat .motion-hidden').length,
    motionCount: typeof S === 'undefined' || !S._oppMotions ? 0 : Object.keys(S._oppMotions).length,
  }));
  if (during.discardGhosts !== 1 || during.hiddenSources < 1 || during.motionCount !== 1) {
    throw new Error(`Opponent motion duplicated its source: ${JSON.stringify(during)}`);
  }
  await capture(page, 'opponent-discard-midflight');

  await page.waitForFunction(() =>
    document.querySelectorAll('.opp-discard-ghost,.opp-keep-ghost').length === 0 &&
    document.querySelectorAll('.seat .motion-hidden').length === 0 &&
    (typeof S === 'undefined' || !S._oppMotions),
    null,
    { timeout: 8000 }
  );
  await assertStableTurnBar(page, turnBarHeight);
}

async function assertAttackOverlayLayout(page) {
  await page.evaluate(() => buioTest.testReveal(true));
  await page.waitForSelector('.atk-reveal-overlay');
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => {
    const overlay = document.querySelector('.atk-reveal-overlay');
    const box = document.querySelector('.ar-box');
    return {
      z: Number(getComputedStyle(overlay).zIndex),
      height: box.getBoundingClientRect().height,
    };
  });
  await capture(page, 'attack-overlay-suspense');
  await page.waitForTimeout(2400);
  const after = await page.evaluate(() => ({
    height: document.querySelector('.ar-box').getBoundingClientRect().height,
  }));
  if (before.z <= 9999 || Math.abs(before.height - after.height) > 1) {
    throw new Error(`Attack overlay is not stable/above cards: ${JSON.stringify({ before, after })}`);
  }
  await capture(page, 'attack-overlay-revealed');
  await page.evaluate(() => document.querySelector('.atk-reveal-overlay')?.remove());
}

async function assertMobileAttackOverlay(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => buioTest.testReveal(false));
    await page.waitForSelector('.atk-reveal-overlay');
    await page.waitForTimeout(300);
    const layout = await page.evaluate(() => {
      const box = document.querySelector('.ar-box').getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    if (layout.left < 0 || layout.top < 0 || layout.right > layout.viewportWidth || layout.bottom > layout.viewportHeight) {
      throw new Error(`Attack overlay overflows mobile viewport: ${JSON.stringify(layout)}`);
    }
    await capture(page, 'attack-overlay-mobile');
  } finally {
    await page.close();
  }
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      JWT_SECRET: 'buio-smoke-secret',
      PEEK_DURATION_MS: '600',
      TURN_TIMER_MS: '8000',
      ATTACK_WINDOW_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  server.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

  let browser;
  try {
    await waitForServer();
    browser = await launchBrowser();
    const page = await browser.newPage();
    const browserIssues = [];
    const resourceIssues = [];
    page.on('console', msg => {
      if (msg.type() === 'warning') browserIssues.push(`${msg.type()}: ${msg.text()}`);
      if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
        browserIssues.push(`${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('response', response => {
      if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
        resourceIssues.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on('pageerror', err => browserIssues.push(`pageerror: ${err.message}`));

    await registerAndStartBotGame(page, 'keep');
    const stalePeekVisible = await page.locator('#peek-inline').isVisible();
    if (stalePeekVisible) throw new Error('Peek status remained visible after the peek phase ended');
    const turnBarHeight = await assertStableTurnBar(page);
    await drawCard(page);
    await assertStableTurnBar(page, turnBarHeight);
    const beforeKeep = await page.evaluate(() => ({
      handCount: document.querySelectorAll('#my-hand .card-3d').length,
      drawnAlt: document.querySelector('#drawn-card-display img')?.alt || '',
    }));
    const discardVisualIndex = await page.evaluate(() => {
      const order = S.handOrder || S.privateState.hand.map((_, i) => i);
      const visual = order.findIndex(serverIndex => {
        const card = S.privateState.hand[serverIndex];
        return card?.known && ![8, 9].includes(card.value);
      });
      return visual >= 0 ? visual : 0;
    });
    await page.locator('#my-hand .card-3d').nth(discardVisualIndex).click();
    await waitForCardMotion(page);
    const afterKeep = await page.evaluate(() => ({
      handCount: document.querySelectorAll('#my-hand .card-3d').length,
      drawnVisible: !document.querySelector('#drawn-slot')?.classList.contains('hidden'),
      rightHidden: [...document.querySelectorAll('#my-hand .card-3d')].at(-1)?.style.visibility === 'hidden',
      discardHasImg: Boolean(document.querySelector('#discard-pile img')),
    }));
    if (beforeKeep.handCount !== afterKeep.handCount || afterKeep.drawnVisible || afterKeep.rightHidden || !afterKeep.discardHasImg) {
      throw new Error(`Keep-drawn animation ended in invalid state: ${JSON.stringify({ beforeKeep, afterKeep })}`);
    }
    await assertOpponentDiscardMotion(page, turnBarHeight);
    await assertAttackOverlayLayout(page);

    const page2 = await browser.newPage();
    page2.on('console', msg => {
      if (msg.type() === 'warning') browserIssues.push(`${msg.type()}: ${msg.text()}`);
      if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
        browserIssues.push(`${msg.type()}: ${msg.text()}`);
      }
    });
    page2.on('response', response => {
      if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
        resourceIssues.push(`${response.status()} ${response.url()}`);
      }
    });
    page2.on('pageerror', err => browserIssues.push(`pageerror: ${err.message}`));

    await registerAndStartBotGame(page2, 'drop');
    await drawCard(page2);
    await page2.click('#btn-discard-drawn');
    await waitForCardMotion(page2);
    await page2.close();
    await assertMobileAttackOverlay(browser);

    if (browserIssues.length) {
      throw new Error(`Browser issues:\n${browserIssues.join('\n')}`);
    }
    if (resourceIssues.length) {
      throw new Error(`Resource issues:\n${resourceIssues.join('\n')}`);
    }

    console.log('Smoke test passed: card flows, opponent motion state, stable turn bar, and attack overlay.');
  } catch (err) {
    console.error(err.message);
    if (serverOutput.trim()) console.error('\nServer output:\n' + serverOutput.trim());
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
    try { fs.rmSync(DB_PATH, { force: true }); } catch {}
  }
}

main();
