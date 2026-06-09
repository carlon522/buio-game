'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT) || 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `buio-smoke-${Date.now()}.db`);

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

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="register"]');

    const username = `smoke${Date.now().toString().slice(-8)}`;
    await page.fill('#reg-username', username);
    await page.fill('#reg-password', 'password123');
    await page.click('#form-register button[type="submit"]');
    await page.waitForSelector('#screen-lobby.active', { timeout: 5000 });

    await page.click('#btn-vs-bot');
    await page.waitForFunction(() => typeof S !== 'undefined' && S.gameState?.phase === 'draw', null, { timeout: 8000 });
    await page.waitForFunction(() => typeof S !== 'undefined' && S.gameState?.currentPlayerUserId === S.userId, null, { timeout: 8000 });

    await page.click('#btn-draw');
    await page.waitForFunction(() =>
      !document.querySelector('#btn-discard-drawn')?.disabled &&
      Boolean(document.querySelector('#drawn-card-display .card-3d')),
      null,
      { timeout: 5000 }
    );
    await page.click('#btn-discard-drawn');
    await page.waitForFunction(() =>
      document.querySelectorAll('.card-ghost').length === 0 &&
      Boolean(document.querySelector('#discard-pile img')) &&
      (typeof S === 'undefined' || (!S._skipDiscard && S._animSlot === null)),
      null,
      { timeout: 5000 }
    );

    if (browserIssues.length) {
      throw new Error(`Browser issues:\n${browserIssues.join('\n')}`);
    }
    if (resourceIssues.length) {
      throw new Error(`Resource issues:\n${resourceIssues.join('\n')}`);
    }

    console.log('Smoke test passed: register, quick bot game, draw, discard.');
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
