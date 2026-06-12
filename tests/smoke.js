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
  await page.waitForFunction(() =>
    !S.gameState?.turnReadyAt || Date.now() >= S.gameState.turnReadyAt,
    null,
    { timeout: 5000 }
  );
  await page.waitForFunction(() => !document.querySelector('#btn-draw')?.disabled, null, { timeout: 5000 });
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

async function assertSingleCardFlipStability(page) {
  const setup = await page.evaluate(() => {
    const cards=[...document.querySelectorAll('#my-hand .card-3d[data-card-key]')];
    const target=cards.find(card => {
      const serverIndex=Number(card.dataset.serverIndex);
      return Boolean(S.privateState?.hand?.[serverIndex]?.known);
    });
    if(!target) return null;
    window.__smokeHandNodes=cards.map(card=>[card.dataset.cardKey,card]);
    S._tempRevealServerIdx=Number(target.dataset.serverIndex);
    renderMyHand();
    return target.dataset.cardKey;
  });
  if (!setup) throw new Error('No known card was available for the flip stability check');

  await assertDecodedCardFronts(page);
  const result = await page.evaluate(targetKey => {
    const current=new Map(
      [...document.querySelectorAll('#my-hand .card-3d[data-card-key]')]
        .map(card=>[card.dataset.cardKey,card])
    );
    const stable=window.__smokeHandNodes.every(([key,node]) =>
      key===targetKey || current.get(key)===node
    );
    const target=current.get(targetKey);
    const ready=Boolean(target?.classList.contains('card-front') && target.classList.contains('image-ready'));
    S._tempRevealServerIdx=null;
    renderMyHand();
    delete window.__smokeHandNodes;
    return {stable,ready,count:current.size};
  }, setup);
  if (!result.stable || !result.ready) {
    throw new Error(`Flipping one card disturbed the rest of the hand: ${JSON.stringify(result)}`);
  }
}

async function assertTurnHandoff(page) {
  await page.waitForFunction(() => S.gameState?.turnReadyAt > Date.now(), null, { timeout: 5000 });
  const initial = await page.evaluate(() => ({
    remaining:S.gameState.turnReadyAt-Date.now(),
    drawDisabled:document.querySelector('#btn-draw')?.disabled,
    knockDisabled:document.querySelector('#btn-knock')?.disabled,
    discardDisabled:document.querySelector('#btn-discard-drawn')?.disabled,
    banner:document.querySelector('#turn-bar-text')?.textContent || '',
  }));
  if (
    initial.remaining < 1800 ||
    !initial.drawDisabled ||
    !initial.knockDisabled ||
    !initial.discardDisabled ||
    !/Attack window|Finestra attacco/.test(initial.banner)
  ) {
    throw new Error(`Turn handoff was not stable or long enough: ${JSON.stringify(initial)}`);
  }

  await page.waitForFunction(() => !S._handCompacting, null, { timeout: 5000 });
  const attackWindow = await page.evaluate(() => ({
    remaining:S.gameState.turnReadyAt-Date.now(),
    attackDisabled:document.querySelector('#btn-attack')?.disabled,
  }));
  if (attackWindow.remaining > 100 && attackWindow.attackDisabled) {
    throw new Error(`Attack stayed disabled during the handoff: ${JSON.stringify(attackWindow)}`);
  }
}

async function assertDiscardPileLanding(page, previousTopId) {
  await page.waitForFunction(() =>
    Boolean(S._skipDiscard && document.querySelector('.card-ghost')),
    null,
    { timeout: 2500 }
  );
  const inFlight = await page.evaluate(() => ({
    top:document.querySelector('#discard-pile .discard-card-top')?.dataset.cardId || null,
    layers:document.querySelectorAll('#discard-pile .discard-card-layer').length,
  }));
  if (inFlight.top !== previousTopId || inFlight.layers < 1) {
    throw new Error(`Discard pile changed before the moving card landed: ${JSON.stringify(inFlight)}`);
  }

  await waitForCardMotion(page);
  await page.waitForFunction(oldTop => {
    const top=document.querySelector('#discard-pile .discard-card-top');
    const under=document.querySelector('#discard-pile .discard-card-under');
    return Boolean(top && under && top.dataset.cardId!==oldTop && under.dataset.cardId===oldTop);
  }, previousTopId, { timeout: 3000 });
  const landed = await page.evaluate(() => ({
    layers:document.querySelectorAll('#discard-pile .discard-card-layer').length,
    topReady:document.querySelector('#discard-pile .discard-card-top')?.classList.contains('image-ready'),
    underReady:document.querySelector('#discard-pile .discard-card-under')?.classList.contains('image-ready'),
  }));
  if (landed.layers !== 2 || !landed.topReady || !landed.underReady) {
    throw new Error(`Discard pile did not settle as a decoded two-card stack: ${JSON.stringify(landed)}`);
  }
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
    gapSources: document.querySelectorAll('.seat .mini-gap').length,
    motionCount: typeof S === 'undefined' || !S._oppMotions ? 0 : Object.keys(S._oppMotions).length,
    motionKind: typeof S === 'undefined' || !S._oppMotions ? null : Object.values(S._oppMotions)[0]?.kind,
  }));
  if (during.discardGhosts !== 1 || during.hiddenSources+during.gapSources < 1 || during.motionCount !== 1) {
    throw new Error(`Opponent motion duplicated its source: ${JSON.stringify(during)}`);
  }
  await capture(page, 'opponent-discard-midflight');
  if (during.motionKind !== 'discard-drawn') {
    await page.waitForFunction(() =>
      typeof S !== 'undefined' &&
      S._oppMotions &&
      Object.values(S._oppMotions).some(motion => motion.stage === 'shift'),
      null,
      { timeout: 2500 }
    );
    const shifting = await page.evaluate(() => ({
      gaps:document.querySelectorAll('.seat .mini-gap').length,
      moving:[...document.querySelectorAll('.seat .mini-card')]
        .filter(card=>getComputedStyle(card).transform!=='none').length,
      stages:typeof S==='undefined'||!S._oppMotions?[]:Object.values(S._oppMotions).map(m=>m.stage),
    }));
    if(shifting.gaps!==0||shifting.moving<1||!shifting.stages.includes('shift')){
      throw new Error(`Opponent hand did not visibly compact: ${JSON.stringify(shifting)}`);
    }
    await capture(page, 'opponent-hand-compaction');
  }

  await page.waitForFunction(() =>
    document.querySelectorAll('.opp-discard-ghost,.opp-keep-ghost').length === 0 &&
    document.querySelectorAll('.seat .motion-hidden,.seat .mini-gap').length === 0 &&
    (typeof S === 'undefined' || !S._oppMotions),
    null,
    { timeout: 8000 }
  );
  await assertStableTurnBar(page, turnBarHeight);
}

async function assertFieldAttackLayout(page) {
  const before = await page.evaluate(() => {
    const rect = selector => {
      const value=document.querySelector(selector)?.getBoundingClientRect();
      return value ? {left:value.left,top:value.top,width:value.width,height:value.height} : null;
    };
    return {
      table:rect('#poker-table'),
      turn:rect('#turn-bar'),
      hand:rect('.my-area'),
      action:rect('#action-bar'),
      discardTop:document.querySelector('#discard-pile .discard-card-top')?.dataset.cardId||null,
    };
  });
  await page.evaluate(() => {
    window.__fieldPileLandings=[];
    window.__fieldPileObserver?.disconnect();
    window.__fieldPileObserver=new MutationObserver(()=>{
      const field=document.querySelector('.attack-field-card')?.getBoundingClientRect();
      const pile=document.querySelector('#discard-pile')?.getBoundingClientRect();
      const top=document.querySelector('#discard-pile .discard-card-top')?.dataset.cardId||null;
      const under=document.querySelector('#discard-pile .discard-card-under')?.dataset.cardId||null;
      if(field&&pile) window.__fieldPileLandings.push({
        top,under,
        deltaLeft:Math.abs(field.left-pile.left),
        deltaTop:Math.abs(field.top-pile.top),
        deltaWidth:Math.abs(field.width-pile.width),
        deltaHeight:Math.abs(field.height-pile.height),
      });
    });
    window.__fieldPileObserver.observe(document.querySelector('#discard-pile'),{childList:true,subtree:true});
  });
  await page.evaluate(() => { void buioTest.testReveal(true); });
  await page.waitForSelector('.attack-field-card');
  if (await page.locator('.atk-reveal-overlay').count()) {
    throw new Error('Legacy attack popup was rendered');
  }
  await page.waitForSelector('.attack-field-card.face-up', { timeout: 6000 });
  await page.waitForSelector('.attack-field-status.success', { timeout: 6000 });
  const during = await page.evaluate(() => {
    const rect = selector => {
      const value=document.querySelector(selector)?.getBoundingClientRect();
      return value ? {left:value.left,top:value.top,width:value.width,height:value.height,right:value.right,bottom:value.bottom} : null;
    };
    const image=document.querySelector('.attack-field-front img');
    return {
      table:rect('#poker-table'),
      turn:rect('#turn-bar'),
      hand:rect('.my-area'),
      action:rect('#action-bar'),
      card:rect('.attack-field-card'),
      status:rect('.attack-field-status'),
      pile:rect('#discard-pile'),
      decoded:Boolean(image?.complete&&image.naturalWidth),
      faceUp:document.querySelector('.attack-field-card')?.classList.contains('face-up'),
      viewportWidth:innerWidth,
      sourceGaps:document.querySelectorAll('#my-hand .attack-source-gap').length,
      discardTop:document.querySelector('#discard-pile .discard-card-top')?.dataset.cardId||null,
    };
  });
  for (const key of ['table','turn','hand','action']) {
    const a=before[key],b=during[key];
    if(!a||!b||Math.abs(a.top-b.top)>.5||Math.abs(a.height-b.height)>.5) {
      throw new Error(`Attack animation shifted ${key}: ${JSON.stringify({before:a,during:b})}`);
    }
  }
  if (
    !during.decoded ||
    !during.faceUp ||
    during.sourceGaps!==1 ||
    during.discardTop!==before.discardTop ||
    during.status.left<0 ||
    during.status.right>during.viewportWidth ||
    during.card.left<during.table.left ||
    during.card.right>during.table.left+during.table.width
  ) {
    throw new Error(`Field attack layout was invalid: ${JSON.stringify(during)}`);
  }
  await capture(page, 'field-attack-revealed');
  await page.waitForFunction(oldTop => {
    const top=document.querySelector('#discard-pile .discard-card-top');
    const under=document.querySelector('#discard-pile .discard-card-under');
    return Boolean(top&&under&&top.dataset.cardId!==oldTop&&under.dataset.cardId===oldTop);
  }, before.discardTop, { timeout: 6500 });
  const landing = await page.evaluate(() => ({
    layers:document.querySelectorAll('#discard-pile .discard-card-layer').length,
    samples:window.__fieldPileLandings||[],
  }));
  const covered=landing.samples.some(sample =>
    sample.deltaLeft<1&&sample.deltaTop<1&&sample.deltaWidth<1&&sample.deltaHeight<1
  );
  if(landing.layers!==2||!covered){
    throw new Error(`Attack card did not cover the existing pile exactly: ${JSON.stringify(landing)}`);
  }
  await page.waitForFunction(() => !document.querySelector('.attack-field-layer'), null, { timeout: 7500 });
  await page.evaluate(() => window.__fieldPileObserver?.disconnect());
}

async function assertMobileFieldAttack(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await registerAndStartBotGame(page, 'mobile-attack-field');
    await page.evaluate(() => { void buioTest.testReveal(false); });
    await page.waitForSelector('.attack-field-card.face-up', { timeout: 3500 });
    await page.waitForSelector('.attack-field-status.fail', { timeout: 4000 });
    const layout = await page.evaluate(() => {
      const card = document.querySelector('.attack-field-card').getBoundingClientRect();
      const status = document.querySelector('.attack-field-status').getBoundingClientRect();
      return {
        card:{left:card.left,top:card.top,right:card.right,bottom:card.bottom},
        status:{left:status.left,top:status.top,right:status.right,bottom:status.bottom},
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    if (
      layout.card.left<0||layout.card.top<0||
      layout.card.right>layout.viewportWidth||layout.card.bottom>layout.viewportHeight||
      layout.status.left<0||layout.status.top<0||
      layout.status.right>layout.viewportWidth||layout.status.bottom>layout.viewportHeight
    ) {
      throw new Error(`Field attack overflows mobile viewport: ${JSON.stringify(layout)}`);
    }
    await capture(page, 'field-attack-mobile');
  } finally {
    await page.close();
  }
}

async function assertMobileHandCompaction(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await registerAndStartBotGame(page, 'mobile-shift');
    await drawCard(page);
    const cards=page.locator('#my-hand .card-3d');
    const count=await cards.count();
    if(count<2) throw new Error(`Mobile hand had only ${count} cards`);
    await cards.nth(0).click();
    await page.waitForTimeout(150);
    const gap=await page.evaluate(() => {
      const el=document.querySelector('#my-hand .removal-gap');
      const rect=el?.getBoundingClientRect();
      return {count:document.querySelectorAll('#my-hand .removal-gap').length,left:rect?.left,right:rect?.right,width:innerWidth};
    });
    if(gap.count!==1||gap.left<0||gap.right>gap.width) {
      throw new Error(`Mobile removal gap overflowed: ${JSON.stringify(gap)}`);
    }
    await page.waitForTimeout(520);
    const moving=await page.evaluate(() => [...document.querySelectorAll('#my-hand .card-3d')]
      .filter(card=>getComputedStyle(card).transform!=='none').length);
    if(moving<1) throw new Error('Mobile hand cards did not visibly slide');
    await capture(page,'hand-compaction-mobile');
  } finally {
    await page.close();
  }
}

async function assertPenaltyAfterFieldReturn(page) {
  const botId = await page.evaluate(() =>
    S.gameState?.players.find(player => String(player.userId) !== String(S.userId))?.userId
  );
  await page.evaluate(userId => {
    void buioTest.testReveal(false);
    setTimeout(() => buioTest.testPenalty(userId), 5600);
  }, botId);
  await page.waitForSelector('.attack-field-card');
  await page.waitForSelector('.penalty-draw-ghost', { timeout: 7500 });
  const state = await page.evaluate(() => ({
    fieldCard: Boolean(document.querySelector('.attack-field-card')),
    penaltyGhosts: document.querySelectorAll('.penalty-draw-ghost').length,
  }));
  if (state.fieldCard || state.penaltyGhosts !== 1) {
    throw new Error(`Penalty draw overlapped the returning attack card: ${JSON.stringify(state)}`);
  }
  await page.waitForFunction(() => document.querySelectorAll('.penalty-draw-ghost').length === 0, null, { timeout: 3000 });
}

async function assertBotResumesAfterHumanAttack(browser) {
  const page = await browser.newPage();
  try {
    await registerAndStartBotGame(page, 'attack-resume');
    const botId = await page.evaluate(() =>
      S.gameState.players.find(player => String(player.userId) !== String(S.userId))?.userId
    );
    await page.evaluate(id => {
      window.__smokeBotAttackReveals=0;
      socket.on('game:attack-reveal', payload => {
        if(String(payload.attackerUserId)===String(id)) window.__smokeBotAttackReveals++;
      });
    }, botId);

    await drawCard(page);
    const discardVisualIndex = await page.evaluate(async () => {
      const debug=await fetch(`/api/debug/room/${S.currentRoomId}`).then(response=>response.json());
      const self=debug.players.find(player=>String(player.userId)===String(S.userId));
      const discard=self.hand.find(card=>![8,9].includes(card.value));
      return discard ? S.handOrder.indexOf(discard.pos) : -1;
    });
    if (discardVisualIndex < 0) throw new Error('Could not find a deterministic non-special discard');
    await page.locator('#my-hand .card-3d').nth(discardVisualIndex).click();
    await assertTurnHandoff(page);

    const mismatchVisualIndex = await page.evaluate(async () => {
      const debug=await fetch(`/api/debug/room/${S.currentRoomId}`).then(response=>response.json());
      const self=debug.players.find(player=>String(player.userId)===String(S.userId));
      const mismatch=self.hand.find(card=>card.value!==debug.discardTop.value);
      return mismatch ? S.handOrder.indexOf(mismatch.pos) : -1;
    });
    if (mismatchVisualIndex < 0) throw new Error('Could not find a deterministic wrong attack card');
    const sourceBefore = await page.evaluate(index => {
      const card=[...document.querySelectorAll('#my-hand .card-3d')][index];
      const rect=card.getBoundingClientRect();
      return {key:card.dataset.cardKey,left:rect.left,top:rect.top,width:rect.width,height:rect.height};
    }, mismatchVisualIndex);

    await page.evaluate(() => document.querySelector('#btn-attack').click());
    await page.locator('#my-hand .card-3d').nth(mismatchVisualIndex).click();
    await page.waitForSelector('.attack-field-card');
    await page.waitForSelector('#my-hand .attack-source-gap');
    const gapState = await page.evaluate(() => {
      const gap=document.querySelector('#my-hand .attack-source-gap');
      return {
        gaps:document.querySelectorAll('#my-hand .attack-source-gap').length,
        clickable:gap?.classList.contains('clickable'),
        selected:gap?.classList.contains('selected'),
        target:gap?.classList.contains('atk-tgt'),
        legacyPopup:Boolean(document.querySelector('.atk-reveal-overlay')),
      };
    });
    if(gapState.gaps!==1||gapState.clickable||gapState.selected||gapState.target||gapState.legacyPopup){
      throw new Error(`Wrong attack source was still usable: ${JSON.stringify(gapState)}`);
    }
    await page.waitForSelector('.attack-field-card.face-up', { timeout: 3500 });
    await page.waitForFunction(() =>
      /wrong|sbagliato/i.test(document.querySelector('.attack-field-status.fail')?.textContent || ''),
      null,
      { timeout: 4500 }
    );
    const revealed = await page.evaluate(() => ({
      gap:document.querySelectorAll('#my-hand .attack-source-gap').length,
      pileTop:document.querySelector('#discard-pile .discard-card-top')?.dataset.cardId,
      status:document.querySelector('.attack-field-status')?.textContent,
    }));
    if(revealed.gap!==1) throw new Error(`Attack gap disappeared during reveal: ${JSON.stringify(revealed)}`);
    await page.waitForFunction(() => !document.querySelector('.attack-field-layer'), null, { timeout: 6500 });
    const returned = await page.evaluate(source => {
      const card=document.querySelector(`#my-hand .card-3d[data-card-key="${source.key}"]`);
      const rect=card?.getBoundingClientRect();
      return {
        found:Boolean(card),
        left:rect?.left,
        top:rect?.top,
        gap:document.querySelectorAll('#my-hand .attack-source-gap').length,
        clickable:card?.classList.contains('clickable'),
        selected:card?.classList.contains('selected'),
        target:card?.classList.contains('atk-tgt'),
        attackActive:S._attackRevealActive,
      };
    }, sourceBefore);
    if(
      !returned.found||
      Math.abs(returned.left-sourceBefore.left)>1||
      Math.abs(returned.top-sourceBefore.top)>1||
      returned.gap!==0||
      returned.clickable||
      returned.selected||
      returned.target||
      !returned.attackActive
    ){
      throw new Error(`Wrong attack card did not return cleanly: ${JSON.stringify({sourceBefore,returned})}`);
    }
    await page.waitForFunction(() =>
      !S._attackRevealActive && !S.gameState?.presentationActive,
      null,
      { timeout: 9000 }
    );
    await page.waitForFunction(id =>
      String(S.gameState?.currentPlayerUserId)!==String(id) ||
      S.gameState?.phase==='discard' ||
      Boolean(S._oppDrawn?.[id]) ||
      window.__smokeBotAttackReveals>0,
      botId,
      { timeout: 12000 }
    );
  } finally {
    await page.close();
  }
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
    await assertSingleCardFlipStability(page);
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
      return visual >= 0 && visual < order.length - 1 ? visual : 0;
    });
    const trackedShift = await page.evaluate(discardIndex => {
      const cards=[...document.querySelectorAll('#my-hand .card-3d')];
      const tracked=cards[discardIndex+1];
      const rect=tracked.getBoundingClientRect();
      return {key:tracked.dataset.cardKey,left:rect.left,width:rect.width};
    }, discardVisualIndex);
    const previousDiscardTop = await page.locator('#discard-pile .discard-card-top').getAttribute('data-card-id');
    await page.locator('#my-hand .card-3d').nth(discardVisualIndex).click();
    const handoff = assertTurnHandoff(page);
    const pileLanding = assertDiscardPileLanding(page, previousDiscardTop);
    const opponentMotion = assertOpponentDiscardMotion(page, turnBarHeight);
    await page.waitForTimeout(150);
    const gapBeat = await page.evaluate(({key,left}) => {
      const tracked=document.querySelector(`#my-hand .card-3d[data-card-key="${key}"]`);
      return {
        gaps:document.querySelectorAll('#my-hand .removal-gap').length,
        trackedLeft:tracked?.getBoundingClientRect().left,
        compacting:S._handCompacting,
        delta:Math.abs((tracked?.getBoundingClientRect().left||0)-left),
      };
    }, trackedShift);
    if(gapBeat.gaps!==1||!gapBeat.compacting||gapBeat.delta>1){
      throw new Error(`Hand did not hold a stable removal gap: ${JSON.stringify(gapBeat)}`);
    }
    await capture(page, 'hand-removal-gap');
    await page.waitForTimeout(520);
    const shiftBeat = await page.evaluate(({key,left,width}) => {
      const tracked=document.querySelector(`#my-hand .card-3d[data-card-key="${key}"]`);
      const current=tracked?.getBoundingClientRect().left;
      return {
        gaps:document.querySelectorAll('#my-hand .removal-gap').length,
        current,
        moved:left-current,
        width,
        compacting:S._handCompacting,
      };
    }, trackedShift);
    if(
      shiftBeat.gaps!==0||
      !shiftBeat.compacting||
      shiftBeat.moved<2||
      shiftBeat.moved>shiftBeat.width+18
    ){
      throw new Error(`Hand cards did not slide through an intermediate position: ${JSON.stringify(shiftBeat)}`);
    }
    await capture(page, 'hand-compaction-midshift');
    await handoff;
    await pileLanding;
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
    const deterministicOpponentMotion = assertOpponentDiscardMotion(page, turnBarHeight);
    const opponentTestStarted = await page.evaluate(() => buioTest.testOpponentKeepDiscard(1));
    if (!opponentTestStarted) throw new Error('Could not start deterministic opponent hand compaction');
    await deterministicOpponentMotion;
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
    await assertFieldAttackLayout(page);
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
    await assertPenaltyAfterFieldReturn(page);
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
    const previousDropTop = await page2.locator('#discard-pile .discard-card-top').getAttribute('data-card-id');
    await page2.click('#btn-discard-drawn');
    await Promise.all([
      assertTurnHandoff(page2),
      assertDiscardPileLanding(page2, previousDropTop),
    ]);
    await page2.close();
    await assertBotResumesAfterHumanAttack(browser);
    await assertMobileFieldAttack(browser);
    await assertMobileHandCompaction(browser);

    if (browserIssues.length) {
      throw new Error(`Browser issues:\n${browserIssues.join('\n')}`);
    }
    if (resourceIssues.length) {
      throw new Error(`Resource issues:\n${resourceIssues.join('\n')}`);
    }

    console.log('Smoke test passed: deal, card flows, opponent state, attacks, penalty timing, finale, audio, and responsive overlays.');
  } catch (err) {
    console.error(err.stack || err.message);
    if (serverOutput.trim()) console.error('\nServer output:\n' + serverOutput.trim());
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
    try { fs.rmSync(DB_PATH, { force: true }); } catch {}
  }
}

main();
