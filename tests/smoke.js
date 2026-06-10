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

  await page.click('#lobby-lang-toggle');
  const englishLabels = await page.evaluate(async () => {
    const saved=await S._languageSave;
    return {
      language:document.documentElement.lang,
      difficulty:document.querySelector('#difficulty-label')?.textContent,
      playBot:document.querySelector('#btn-vs-bot')?.textContent,
      hasToken:Boolean(S.token),
      savedLanguage:saved?.language,
      saveError:saved?.error,
    };
  });
  if (!englishLabels.hasToken || englishLabels.savedLanguage !== 'en' ||
      englishLabels.language !== 'en' || englishLabels.difficulty !== 'Bot difficulty' ||
      !englishLabels.playBot.includes('Play vs Bot')) {
    throw new Error(`English lobby translation was not applied: ${JSON.stringify(englishLabels)}`);
  }

  await page.click('label[for="bot-hard"]');
  await page.click('#btn-vs-bot');
  await page.waitForSelector('.deal-card-ghost', { timeout: 5000 });
  const dealMidflight = await page.evaluate(() => ({
    ghosts: document.querySelectorAll('.deal-card-ghost').length,
    hiddenSlots: [...document.querySelectorAll('#my-hand .card-3d,.seat .mini-card')]
      .filter(card => getComputedStyle(card).visibility === 'hidden').length,
    enabledActions: [...document.querySelectorAll('#btn-draw,#btn-knock,#btn-attack,#btn-discard-drawn')]
      .filter(button => !button.disabled).length,
    turnText: document.querySelector('#turn-bar-text')?.textContent || '',
  }));
  if (
    dealMidflight.ghosts < 1 ||
    dealMidflight.hiddenSlots < 1 ||
    dealMidflight.enabledActions !== 0 ||
    !/Dealing|Distribuzione/.test(dealMidflight.turnText)
  ) {
    throw new Error(`Opening deal exposed cards before landing: ${JSON.stringify(dealMidflight)}`);
  }
  await capture(page, 'opening-deal-midflight');
  await page.waitForFunction(() =>
    document.querySelectorAll('.deal-card-ghost').length === 0 &&
    S._dealLanded?.size === S.gameState?.players.reduce((sum, player) => sum + player.cardCount, 0),
    null,
    { timeout: 8000 }
  );
  await page.waitForFunction(() => typeof S !== 'undefined' && S.gameState?.phase === 'draw', null, { timeout: 10000 });
  await page.waitForFunction(() => typeof S !== 'undefined' && S.gameState?.currentPlayerUserId === S.userId, null, { timeout: 10000 });
  await page.waitForFunction(() => typeof _dealBusy !== 'undefined' && !_dealBusy, null, { timeout: 5000 });
  await assertVersionBadge(page, 'game');
  const difficulty = await page.evaluate(() => S.gameState?.botDifficulty);
  if (difficulty !== 'hard') throw new Error(`Bot difficulty was not applied: ${difficulty}`);
}

async function drawCard(page) {
  await page.click('#btn-draw');
  await page.waitForFunction(() =>
    !document.querySelector('#btn-discard-drawn')?.disabled &&
    Boolean(document.querySelector('#drawn-card-display .card-3d')),
    null,
    { timeout: 7000 }
  );
  await page.waitForFunction(() =>
    document.querySelector('#drawn-card-display .card-3d')?.classList.contains('card-turn-in'),
    null,
    { timeout: 3000 }
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

async function assertDecodedCardFronts(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.card-front')].every(card =>
    card.classList.contains('image-ready') || card.classList.contains('image-error')
  ), null, { timeout: 5000 });
  const blank = await page.evaluate(() => [...document.querySelectorAll('.card-front')].some(card => {
    const bg = getComputedStyle(card).backgroundColor;
    return !card.classList.contains('image-ready') && (bg === 'rgb(255, 255, 255)' || bg === 'rgb(245, 240, 232)');
  }));
  if (blank) throw new Error('A card front exposed a white loading frame');
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
  try {
    await page.waitForSelector('.opp-discard-ghost', { timeout: 15000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      phase: S.gameState?.phase,
      currentPlayerUserId: S.gameState?.currentPlayerUserId,
      selfUserId: S.userId,
      attackOverlay: Boolean(document.querySelector('.atk-reveal-overlay')),
      attackAnnouncer: S._attackAnnouncer,
      opponentMotions: S._oppMotions,
      log: S.gameLog?.slice(0, 8),
    }));
    throw new Error(`Opponent never discarded: ${JSON.stringify(diagnostic)}`);
  }
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

async function assertPenaltyAfterPopup(page) {
  const botId = await page.evaluate(() =>
    S.gameState?.players.find(player => String(player.userId) !== String(S.userId))?.userId
  );
  await page.evaluate(userId => {
    buioTest.testReveal(false);
    setTimeout(() => buioTest.testPenalty(userId), 5500);
  }, botId);
  await page.waitForSelector('.atk-reveal-overlay');
  await page.waitForSelector('.penalty-draw-ghost', { timeout: 7000 });
  const state = await page.evaluate(() => ({
    attackOverlay: Boolean(document.querySelector('.atk-reveal-overlay')),
    penaltyGhosts: document.querySelectorAll('.penalty-draw-ghost').length,
  }));
  if (state.attackOverlay || state.penaltyGhosts !== 1) {
    throw new Error(`Penalty draw overlapped the attack popup: ${JSON.stringify(state)}`);
  }
  await page.waitForFunction(() => document.querySelectorAll('.penalty-draw-ghost').length === 0, null, { timeout: 3000 });
}

async function assertRoundEndSequence(page) {
  await page.evaluate(() => buioTest.testRoundEnd());
  await page.waitForSelector('#panel-count-cards:not(.hidden)');
  const countState = await page.evaluate(() => ({
    scoringHidden: document.querySelector('#panel-scoring')?.classList.contains('hidden'),
    countText: document.querySelector('#count-cards-title')?.textContent,
  }));
  if (!countState.scoringHidden || !countState.countText) {
    throw new Error(`Count-cards transition was skipped: ${JSON.stringify(countState)}`);
  }
  await capture(page, 'count-cards-transition');
  await page.waitForSelector('#panel-scoring:not(.hidden)', { timeout: 4000 });
  await page.waitForTimeout(1300);
  const scores = await page.evaluate(() => [...document.querySelectorAll('#scoring-list .score-val')].map(el => ({
    shown: Number(el.textContent),
    target: Number(el.dataset.score),
  })));
  if (!scores.length || scores.some(score => score.shown !== score.target)) {
    throw new Error(`Score count-up did not finish: ${JSON.stringify(scores)}`);
  }
  await capture(page, 'score-count-complete');
}

async function assertSoundDeduplication(page) {
  const plays = await page.evaluate(() => {
    const RealAudio = window.Audio;
    let count = 0;
    window.Audio = class {
      constructor(){ count++; this.volume=1; this.currentTime=0; this.loop=false; }
      play(){ return Promise.resolve(); }
      pause(){}
    };
    SFX._last.SoundProbe = 0;
    SFX.play('SoundProbe', 0.5, { cooldown: 500 });
    SFX.play('SoundProbe', 0.5, { cooldown: 500 });
    window.Audio = RealAudio;
    return count;
  });
  if (plays !== 1) throw new Error(`Sound cooldown allowed ${plays} duplicate plays`);
}

async function main() {
  for (const file of ['Drumlooppostknock.mp3', 'Matchend.mp3']) {
    if (!fs.existsSync(path.join(ROOT, 'public', 'SFX', file))) {
      throw new Error(`Missing finale sound: ${file}`);
    }
  }
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
    await assertDecodedCardFronts(page);
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
    const opponentMotion = assertOpponentDiscardMotion(page, turnBarHeight);
    await waitForCardMotion(page);
    const landingReveal = await page.evaluate(() => ({
      keptIndex: S._keptRevealServerIdx,
      rightFaceUp: document.querySelector('#my-hand .card-3d:last-child')?.classList.contains('card-front'),
    }));
    if (landingReveal.keptIndex === null || !landingReveal.rightFaceUp) {
      throw new Error(`Kept card did not land face-up at the right edge: ${JSON.stringify(landingReveal)}`);
    }
    await page.waitForTimeout(1100);
    const stillRevealed = await page.locator('#my-hand .card-3d:last-child').evaluate(el => el.classList.contains('card-front'));
    if (!stillRevealed) throw new Error('Kept card face-up beat was too short');
    await opponentMotion;
    await page.waitForFunction(() =>
      S._keptRevealServerIdx === null &&
      document.querySelector('#my-hand .card-3d:last-child')?.classList.contains('card-back'),
      null,
      { timeout: 4000 }
    );
    const afterKeep = await page.evaluate(() => ({
      handCount: document.querySelectorAll('#my-hand .card-3d').length,
      drawnVisible: !document.querySelector('#drawn-slot')?.classList.contains('hidden'),
      rightHidden: [...document.querySelectorAll('#my-hand .card-3d')].at(-1)?.style.visibility === 'hidden',
      discardHasImg: Boolean(document.querySelector('#discard-pile img')),
    }));
    if (beforeKeep.handCount !== afterKeep.handCount || afterKeep.drawnVisible || afterKeep.rightHidden || !afterKeep.discardHasImg) {
      throw new Error(`Keep-drawn animation ended in invalid state: ${JSON.stringify({ beforeKeep, afterKeep })}`);
    }
    await assertAttackOverlayLayout(page);
    await page.evaluate(() => buioTest.testSwap());
    await page.waitForSelector('.swap-selected-source');
    const swapSlots = await page.evaluate(() => ({
      source: [...document.querySelectorAll('#spl-l .swap-mini-back')].indexOf(document.querySelector('.swap-selected-source')),
      target: [...document.querySelectorAll('#spl-r .swap-mini-back')].indexOf(document.querySelector('.swap-selected-target')),
    }));
    if (swapSlots.source !== 0 || swapSlots.target !== 3) {
      throw new Error(`Swap animation selected wrong slots: ${JSON.stringify(swapSlots)}`);
    }
    await page.evaluate(() => document.querySelector('.swap-overlay')?.remove());
    await assertPenaltyAfterPopup(page);
    await assertSoundDeduplication(page);
    await assertRoundEndSequence(page);


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

    console.log('Smoke test passed: deal, card flows, opponent state, attacks, penalty timing, finale, audio, and responsive overlays.');
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
