'use strict';
// ── State ─────────────────────────────────────────────────────────────────
const S = {
  token:null, userId:null, username:null,
  currentRoomId:null,
  gameState:null, privateState:null,
  drawnCard:null,
  attackWindowActive:false, attackWindowCard:null,
  _attackMode:false,        // true = I pressed ⚔, my hand cards are clickable
  specialPrompt:null, peekCountdown:null,
  peekCards:null,
  handOrder:null,           // visual index → server index (for drag reordering)
  cardRaise:null,           // visual index → raise level 0-3 (float cards up)
  _animSlot:null,           // visual slot currently receiving an animation (stay hidden during re-renders)
  _animHidden:null,         // Set of visual slots hidden while ghosts travel
  _skipDiscard:false,       // true while a card is flying TO the discard pile
  _pendingDiscardCard:null, // card to show in pile once animation completes
  _attackRevealActive:false,// true during the 5s attack reveal overlay — ALL actions paused
  _attackAnnouncer:null,    // userId of player currently in announce phase (blocks others' ⚔ button)
  _peekRevealed:null,       // Set of visual indices currently flipped face-up for peek
  _peekDuration:0,          // ms of peek timer
  _nove9Mode:false,         // true when card 9 is active and user must tap a hand card
  _tempRevealServerIdx:null,// server card index temporarily shown face-up (card 9)
  _keptRevealServerIdx:null,// kept drawn card stays face-up briefly after landing
  _keptRevealTimer:null,
  gameLog:[], _selIdx:-1,
  _atkCdInt:null,
  _oppDrawn:null,           // opponent userId -> true while they hold a drawn card
  _oppMotions:null,         // opponent userId -> in-flight source/destination state
  _dealLanded:null,         // card slot keys that have received their opening deal card
  _penaltyAnimating:false,
  _roundEndBusy:false,
  _peekServerEnded:false,
};

const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);
const show = el => { if(el) el.classList.remove('hidden'); };
const hide = el => { if(el) el.classList.add('hidden'); };
let _dragIdx = null; // index being dragged

function showScreen(n) {
  document.querySelectorAll('.screen').forEach(s=>{ s.classList.remove('active'); s.classList.add('hidden'); });
  const sc=$('screen-'+n); if(sc){ sc.classList.remove('hidden'); sc.classList.add('active'); }
  document.body.classList.remove('screen-auth-active','screen-lobby-active','screen-game-active');
  document.body.classList.add(`screen-${n}-active`);
}

async function hydrateAppVersion() {
  try {
    const res = await fetch('/api/version');
    if (!res.ok) return;
    const data = await res.json();
    if (data?.version) $('app-version').textContent = `v${data.version}`;
  } catch (_) {}
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, type='', ms=3400) {
  const t=document.createElement('div'); t.className='toast'+(type?' '+type:''); t.textContent=msg;
  $('toast-area').appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(),300); },ms);
}

// ── Log ───────────────────────────────────────────────────────────────────
function addLog(text, type='info') {
  S.gameLog.unshift({text,type}); if(S.gameLog.length>30)S.gameLog.pop(); renderLog();
}
function renderLog() {
  const el=$('game-log'); if(!el)return;
  // Horizontal strip: newest event at left, older entries to the right
  el.innerHTML=S.gameLog.slice(0,15).map((e,i)=>`<span class="log-entry ${e.type}"${i>0?' style="opacity:.55"':''}>${esc(e.text)}</span>`).join('<span style="color:rgba(255,255,255,.15);flex-shrink:0">·</span>');
  el.scrollLeft=0;
}

// ── Card HTML ─────────────────────────────────────────────────────────────
// Two simple classes: card-back (face-down) or card-front (face-up).
// No CSS 3D / backface-visibility — reliable across all browsers.
function cardHTML(card, { cls='', index='' }={}) {
  const isUp = card && card.known;
  const attrs = `data-index="${index}" data-id="${card?.id||''}"`;

  if (!isUp) {
    return `<div class="card-3d card-back ${cls}" ${attrs}></div>`;
  }

  const sp  = card.isSpecial ? ' is-special' : '';
  const fb  = card.color==='red' ? 'red' : 'black';
  return `<div class="card-3d card-front${sp} ${cls}" ${attrs}>
    <img src="/cards/${card.suit}_${card.value}.jpg" class="card-img" alt="${card.label}"
      onload="cardImageLoaded(this)"
      onerror="cardImageFailed(this,'${card.label}','${card.symbol}','${fb}')">
  </div>`;
}
function cardImageLoaded(img) {
  const reveal = () => img.parentElement?.classList.add('image-ready');
  if (typeof img.decode === 'function') img.decode().then(reveal).catch(reveal);
  else reveal();
}
function cardImageFailed(img,label,sym,color) {
  img.style.display='none';
  img.parentElement?.classList.add('image-error');
  makeFB(img.parentElement,label,sym,color);
}
function preloadCardImages() {
  ['denari','coppe','spade','bastoni'].forEach(suit => {
    for(let value=1;value<=10;value++){
      const img=new Image();
      img.decoding='async';
      img.src=`/cards/${suit}_${value}.jpg`;
    }
  });
}
window.cardImageLoaded=cardImageLoaded;
window.cardImageFailed=cardImageFailed;
function makeFB(el,label,sym,color) {
  if(el.querySelector('.card-fb'))return;
  const d=document.createElement('div'); d.className=`card-fb ${color}`;
  d.innerHTML=`<span>${label}</span><span>${sym}</span>`; el.appendChild(d);
}
function livesHTML(n, max=3) {
  return Array(max).fill(0).map((_,i)=>`<div class="life-pip${i>=n?' lost':''}"></div>`).join('');
}

// ── Card string helper (Italian names, no poker suits) ────────────────────
function cardStr(c) {
  if (!c) return '?';
  const sv = { denari:'Den', coppe:'Cop', spade:'Spa', bastoni:'Bas' };
  return `${c.label}/${sv[c.suit]||c.suit}`;
}

// ── Deck & discard ────────────────────────────────────────────────────────
function renderDeck(count) {
  const el=$('deck-pile'); if(!el)return;
  el.className='deck-wrap'+(count===0?' empty':'');
  $('deck-count').textContent=count;
}
function renderDiscardPile(c) {
  // Defer while a card is flying toward the pile — prevents "already there" glitch
  if(S._skipDiscard){ if(c) S._pendingDiscardCard=c; return; }
  const el=$('discard-pile'); if(!el)return;
  el.classList.remove('discard-image-ready');
  if(!c){el.innerHTML='<div class="discard-empty">—</div>';return;}
  const fb=c.color==='red'?'red':'black';
  el.innerHTML=`<img src="/cards/${c.suit}_${c.value}.jpg" alt="${c.label}"
    onload="this.parentElement.classList.add('discard-image-ready')"
    onerror="this.style.display='none';makeFB(this.parentElement,'${c.label}','${c.symbol}','${fb}')">`;
}

function settleDiscardPile(card) {
  clearTimeout(S._skipDiscardFallback);
  S._skipDiscard=false;
  const c=card||S._pendingDiscardCard||S.gameState?.discardTop;
  S._pendingDiscardCard=null;
  if(c) renderDiscardPile(c);
}

function resetMotionState() {
  clearTimeout(S._skipDiscardFallback);
  S._skipDiscard=false;
  S._pendingDiscardCard=null;
  S._animSlot=null;
  S._animHidden=null;
  if(S._oppMotions) Object.values(S._oppMotions).forEach(m=>clearTimeout(m.timeout));
  S._oppMotions=null;
  S._attackMode=false;
  S._attackAnnouncer=null;
  $('discard-pile')?.classList.remove('atk-target');
}

function knownHandCardAtVisual(visualIdx) {
  const serverIdx=S.handOrder?S.handOrder[visualIdx]:visualIdx;
  const card=S.privateState?.hand?.[serverIdx];
  return card?.known ? {...card,known:true} : null;
}

function appendDrawnOrderAfterDiscard(visualIdx, serverIdx, drawnCard) {
  const hand=S.privateState?.hand;
  if(!hand?.length) return;
  const oldCount=hand.length;
  const nextHand=hand.filter((_,idx)=>idx!==serverIdx);
  nextHand.push(drawnCard?.known ? {...drawnCard,known:true,index:oldCount-1} : {id:'__kept_hidden__',known:false,index:oldCount-1});
  S.privateState.hand=nextHand.map((card,idx)=>({...card,index:idx}));
  S.privateState.seenIndices=nextHand.map((card,idx)=>card?.known?idx:null).filter(idx=>idx!==null);

  const oldOrder=S.handOrder||Array.from({length:oldCount},(_,i)=>i);
  S.handOrder=oldOrder
    .filter((_,idx)=>idx!==visualIdx)
    .map(idx=>idx>serverIdx?idx-1:idx);
  S.handOrder.push(oldCount-1);

  if(S.cardRaise?.length===oldCount){
    const raise=S.cardRaise.filter((_,idx)=>idx!==visualIdx);
    raise.push(0);
    S.cardRaise=raise;
  }
  return S.handOrder.length-1;
}

// ── Seat positions (trigonometry) ─────────────────────────────────────────
function getOppPosition(idx, total) {
  const rx=43, ry=37;
  const presets={
    1:[270], 2:[240,300], 3:[220,270,320], 4:[205,248,292,335],
    5:[200,232,265,298,330], 6:[195,222,249,276,303,330],
    7:[190,215,240,265,290,315,340],
  };
  const angles=presets[Math.min(total,7)]||Array.from({length:total},(_,i)=>190+i*(150/(total-1)));
  const deg=angles[Math.min(idx,angles.length-1)]*Math.PI/180;
  return {x:50+rx*Math.cos(deg), y:50+ry*Math.sin(deg)};
}

// ── Auth ──────────────────────────────────────────────────────────────────
function tryRestore(){const t=localStorage.getItem('buio_token'),u=localStorage.getItem('buio_username'),id=localStorage.getItem('buio_userId');if(t&&u&&id){S.token=t;S.username=u;S.userId=id;return true;}return false;}
function saveSession(tk,un,id){S.token=tk;S.username=un;S.userId=String(id);localStorage.setItem('buio_token',tk);localStorage.setItem('buio_username',un);localStorage.setItem('buio_userId',String(id));}
function clearSession(){S.token=S.username=S.userId=null;['buio_token','buio_username','buio_userId'].forEach(k=>localStorage.removeItem(k));}
async function apiPost(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}

document.querySelectorAll('.auth-tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active')); tab.classList.add('active');
    const w=tab.dataset.tab;$('form-login').classList.toggle('hidden',w!=='login');$('form-register').classList.toggle('hidden',w!=='register');
  });
});
$('form-login').addEventListener('submit',async e=>{
  e.preventDefault();$('login-error').textContent='';
  const d=await apiPost('/api/login',{username:$('login-username').value.trim(),password:$('login-password').value});
  if(d.error){$('login-error').textContent=d.error;return;}
  if(d.language){_lang=d.language;localStorage.setItem('buio_lang',_lang);applyLang();}
  saveSession(d.token,d.username,d.userId);connectSocket();
});
$('form-register').addEventListener('submit',async e=>{
  e.preventDefault();$('reg-error').textContent='';
  const d=await apiPost('/api/register',{username:$('reg-username').value.trim(),password:$('reg-password').value,language:_lang});
  if(d.error){$('reg-error').textContent=d.error;return;}
  saveSession(d.token,d.username,d.userId);connectSocket();
});
$('btn-logout').addEventListener('click',()=>{clearSession();socket.disconnect();showScreen('auth');});

// ── Socket ────────────────────────────────────────────────────────────────
function connectSocket(){socket.connect();}
socket.on('connect',()=>{if(S.token)socket.emit('authenticate',S.token);});
socket.on('authenticated',({username,language})=>{
  S.username=username;
  if(language){_lang=language;localStorage.setItem('buio_lang',_lang);applyLang();}
  $('lobby-username').textContent=username;
  showScreen('lobby');
});
socket.on('auth:error',({message})=>{clearSession();showScreen('auth');toast(message,'error');});
socket.on('disconnect',()=>{if(S.currentRoomId)toast('Connessione persa…','error');});

// ── Lobby ─────────────────────────────────────────────────────────────────
$('btn-refresh').addEventListener('click',()=>socket.emit('lobby:get-list'));
$('btn-create-room').addEventListener('click',()=>{socket.emit('lobby:create',{name:$('room-name').value.trim()||undefined,maxPlayers:parseInt($('room-max-players').value)});});
$('btn-vs-bot').addEventListener('click',()=>socket.emit('lobby:vs-bot',{
  name:$('room-name').value.trim()||undefined,
  difficulty:document.querySelector('input[name="bot-difficulty"]:checked')?.value||'medium',
}));
socket.on('lobby:list',rooms=>{
  const list=$('room-list');
  if(!rooms.length){list.innerHTML='<div class="empty-state">Nessuna partita.<br>Creane una!</div>';return;}
  list.innerHTML=rooms.map(r=>`<div class="room-item"><div><div class="room-name">${esc(r.name)}</div><div class="room-meta">Host: ${esc(r.host)} · ${r.playerCount}/${r.maxPlayers}</div></div><button class="btn-primary room-join" data-id="${r.id}">Entra</button></div>`).join('');
  list.querySelectorAll('.room-join').forEach(btn=>btn.addEventListener('click',()=>socket.emit('lobby:join',{roomId:btn.dataset.id})));
});
socket.on('lobby:joined',({roomId,room})=>{S.currentRoomId=roomId;showScreen('game');showWaiting(room);});
socket.on('lobby:error',({message})=>toast(message,'error'));

// ── Waiting room ──────────────────────────────────────────────────────────
// isBot must be defined BEFORE showWaiting uses it (no temporal dead zone)
const _isBot = id => typeof id === 'string' && id.startsWith('bot_');

function showWaiting(gs) {
  gs=gs||S.gameState;if(!gs)return;
  ['panel-peek','panel-special','panel-scoring','panel-gameover'].forEach(id=>hide($(id)));
  show($('panel-waiting'));
  $('waiting-room-name').textContent=gs.name;
  $('waiting-player-list').innerHTML=gs.players.map(p=>{
    const botP=_isBot(p.userId);
    return `<div class="waiting-player">
      <span>${botP?'🤖 ':''}${esc(p.username)}${!p.connected&&!botP?' 📴':''}</span>
      <div style="display:flex;gap:.35rem">
        ${botP?'<span class="host-badge" style="background:#2d5a2d;color:#7ec87e">BOT</span>':''}
        ${p.userId===gs.hostUserId?'<span class="host-badge">HOST</span>':''}
        ${p.userId===S.userId?'<span class="you-badge">Tu</span>':''}
      </div>
    </div>`;
  }).join('');
  const isHost=gs.hostUserId===S.userId,canStart=gs.players.filter(p=>p.connected||_isBot(p.userId)).length>=2;
  if(isHost){
    show($('btn-start-game'));$('btn-start-game').disabled=!canStart;
    // Show Add-bot only if room has space and no bot yet
    // Allow adding multiple bots as long as there's space
    const hasSpace=gs.players.length<gs.maxPlayers;
    if(hasSpace) show($('btn-add-bot'));
    else hide($('btn-add-bot'));
    $('waiting-hint').textContent=canStart?'Premi Inizia!':'Serve almeno un altro giocatore…';
  } else {
    hide($('btn-start-game'));hide($('btn-add-bot'));
    $('waiting-hint').textContent="In attesa che l'host avvii…";
  }
}
$('btn-start-game').addEventListener('click',()=>socket.emit('lobby:start'));
$('btn-add-bot').addEventListener('click',()=>socket.emit('game:add-bot'));
$('btn-leave-room').addEventListener('click',()=>{
  socket.emit('lobby:leave');S.currentRoomId=null;S.gameState=null;S.privateState=null;S.drawnCard=null;
  hide($('panel-waiting'));showScreen('lobby');socket.emit('lobby:get-list');
});

// ── Game state ────────────────────────────────────────────────────────────
socket.on('game:state',state=>{
  if (state.status==='playing') checkOppCardChanges(state);
  reconcileOpponentMotions(state);
  // If state arrives while attack reveal is active, unblock game immediately
  if(S._attackRevealActive){ S._attackRevealActive=false; resetMotionState(); }
  S.gameState=state;
  // Sync hand order if card count changed (prevents index desync after network gaps)
  const _me=state.players?.find(p=>String(p.userId)===String(S.userId));
  if(_me && (!S.handOrder || S.handOrder.length!==_me.cardCount)){
    S.handOrder=Array.from({length:_me.cardCount},(_,i)=>i);
  }
  if(state.status==='waiting'){showWaiting(state);return;}
  hide($('panel-waiting'));

  // Trigger deal animation when a new peek phase starts
  if(state.phase==='peek' && _dealBusy){
    renderBoard(); renderTurnBanner();
    // DO NOT clear _pendingPeek here — game:peek may have already buffered it
    runDealAnimation(()=>{
      clearTimeout(window._dealBusyFallback);
      _dealBusy=false;
      renderBoard();
      renderTurnBanner();
      if(_pendingPeek&&!S._peekServerEnded){ const d=_pendingPeek; _pendingPeek=null; showPeekOverlay(d); }
      else _pendingPeek=null;
    });
    return;
  }

  renderBoard();renderTurnBanner();
});
socket.on('game:private',priv=>{
  S.privateState=priv;
  // Always sync drawn card from authoritative server state.
  // priv.drawnCard is non-null only when you are current player with a drawn card.
  // This restores the drawn card if an attack interrupted the discard phase.
  if(S._animSlot===null) S.drawnCard = priv?.drawnCard || null;
  renderMyHand();renderScore();renderActions();renderTurnBanner();
  priv?.penalized?show($('penalized-pill')):hide($('penalized-pill'));
});
socket.on('game:turn-start',({userId,username})=>{
  renderTurnBanner();
  if(userId===S.userId) SFX.play('Card',0.3);
  addLog(`Turno di ${username}`,'info');
});
socket.on('game:starting',()=>{
  _dealBusy=true; _pendingPeek=null;
  _dealAnimationRunning=false;
  S._dealLanded=new Set();
  S._peekServerEnded=false;
  if(S._oppMotions) Object.values(S._oppMotions).forEach(m=>clearTimeout(m.timeout));
  // Safety: if game:state/peek never arrives, unlock after 20s
  clearTimeout(window._dealBusyFallback);
  window._dealBusyFallback=setTimeout(()=>{
    if(!_dealBusy) return;
    _dealBusy=false;
    renderBoard();
    renderTurnBanner();
    if(_pendingPeek&&!S._peekServerEnded){
      const d=_pendingPeek;_pendingPeek=null;showPeekOverlay(d);
    } else _pendingPeek=null;
  },20000);
  hide($('panel-waiting'));hide($('panel-scoring'));hide($('panel-gameover'));hide($('panel-count-cards'));
  clearTimeout(S._keptRevealTimer);
  S.drawnCard=null;S.privateState=null;S._attackMode=false;S.handOrder=null;S.cardRaise=null;S._animSlot=null;S._skipDiscard=false;S._pendingDiscardCard=null;S._attackRevealActive=false;S._peekRevealed=null;S._nove9Mode=false;S._tempRevealServerIdx=null;S._keptRevealServerIdx=null;S._attackAnnouncer=null;
  S._animHidden=null;S._oppDrawn=null;S._oppMotions=null;S._penaltyAnimating=false;S._roundEndBusy=false;
  S.gameLog=[];S._selIdx=-1;
  SFX.play('Cardshuffle',0.7);
  hide($('attack-window'));hide($('attack-announce-bar'));
  hide($('drawn-slot'));hide($('panel-special'));
  clearInterval(S._atkCdInt);
  document.querySelector('.atk-reveal-overlay')?.remove();
  renderLog();
});

// ── Deal animation + peek buffering ──────────────────────────────────────
let _pendingPeek = null;
let _dealBusy    = false;
let _dealAnimationRunning = false;

function runDealAnimation(cb) {
  if (_dealAnimationRunning) return;
  const gs = S.gameState;
  if (!gs) { cb?.(); return; }
  const deck = $('deck-pile');
  if (!deck) { cb?.(); return; }
  const deckRect = Cards.rect(deck);
  if (!deckRect) { cb?.(); return; }
  _dealAnimationRunning = true;

  const players = gs.players;
  const rounds = Math.max(0, ...players.map(player => player.cardCount || 4));
  const totalCards = players.reduce((sum, player) => sum + Math.min(rounds, player.cardCount || 4), 0);
  let count = 0;

  // Deal in round-robin: card 0 to each player, then card 1, etc.
  for (let round = 0; round < rounds; round++) {
    players.forEach(p => {
      if (round >= (p.cardCount || 4)) return;
      const delay = count * 160;
      count++;
      setTimeout(() => {
        const isMe = String(p.userId) === String(S.userId);
        const target = isMe
          ? document.querySelector(`#my-hand .card-3d[data-index="${round}"]`)
          : document.querySelector(`.seat[data-user-id="${p.userId}"] .mini-card[data-card-index="${round}"]`);
        const targetRect = Cards.rect(target);
        const key = `${p.userId}:${round}`;
        Cards.dealCard(deckRect, targetRect, () => {
          S._dealLanded?.add(key);
          if (isMe) renderMyHand();
          else renderSeats();
          SFX.play('Card', 0.18, { cooldown: 70 });
        }, !isMe, round);
      }, delay);
    });
  }

  // Callback after all cards dealt
  setTimeout(()=>{
    _dealAnimationRunning=false;
    cb?.();
  }, totalCards * 160 + Cards.durations.deal + 180);
}

// ── Peek — cards flip face-up IN THE HAND (no popup) ─────────────────────
function showPeekOverlay({cards,duration}){
  // Called after deal animation completes
  S.peekCards = cards;
  S._peekDuration = duration;
  S._peekRevealed = new Set([0, 1]); // first two visual positions flip up

  renderMyHand(); // renders cards 0,1 as face-up (they have actual card data in privateState)
  requestAnimationFrame(() => {
    $('my-hand')?.querySelectorAll('.card-front').forEach(card => card.classList.add('card-turn-in'));
  });

  // Inline countdown bar in my-area
  show($('peek-inline'));
  $('btn-ready').disabled=false;$('btn-ready').textContent=_lang==='en'?'I memorised them':'Ho memorizzato';
  const prog=$('peek-prog-inline');
  if(prog){ prog.style.transition='none';prog.style.width='100%';
    requestAnimationFrame(()=>requestAnimationFrame(()=>{prog.style.transition=`width ${duration}ms linear`;prog.style.width='0%';})); }
  let secs=Math.ceil(duration/1000);
  $('peek-secs-inline').textContent=secs;
  clearInterval(S.peekCountdown);
  S.peekCountdown=setInterval(()=>{secs--;$('peek-secs-inline').textContent=Math.max(0,secs);if(secs<=0)clearInterval(S.peekCountdown);},1000);
}

function closePeekInline(){
  clearInterval(S.peekCountdown);
  S._peekRevealed=null; // clears peek state; renderMyHand will show all cards face-down
  hide($('peek-inline'));
  // renderMyHand() is called by game:peek-ended → renderBoard() right after,
  // so no need for individual DOM flips which would be interrupted anyway.
  renderMyHand();
}

socket.on('game:peek',data=>{
  if(S._peekServerEnded) return;
  if(_dealBusy){ _pendingPeek=data; return; }
  showPeekOverlay(data);
});

socket.on('game:peek-ended',()=>{
  S._peekServerEnded=true;
  _pendingPeek=null;
  closePeekInline();
  S.handOrder=null;
  renderBoard();renderTurnBanner();
  SFX.play('Cardshuffle',0.5);
  addLog('Carte coperte — il gioco inizia!','gold');
});

$('btn-ready').addEventListener('click',()=>{
  closePeekInline();
  socket.emit('game:ready');$('btn-ready').disabled=true;$('btn-ready').textContent=_lang==='en'?'Waiting for the others...':'In attesa degli altri...';
});


// ── Board ─────────────────────────────────────────────────────────────────
function renderBoard() {
  const gs=S.gameState;if(!gs)return;
  if(gs.phase!=='peek') hide($('peek-inline'));
  $('info-round').textContent=gs.roundNumber||1;
  gs.lastRound?show($('last-round-pill')):hide($('last-round-pill'));
  renderDeck(gs.deckCount);renderDiscardPile(gs.discardTop);
  renderSeats();renderMyInfo();renderMyHand();renderScore();renderActions();renderLog();
}

// ── Turn banner ───────────────────────────────────────────────────────────
function renderTurnBanner() {
  const gs=S.gameState;if(!gs)return;
  const isMe=gs.currentPlayerUserId===S.userId,phase=gs.phase;
  const cur=gs.players.find(p=>p.userId===gs.currentPlayerUserId);
  const bar=$('turn-bar'),txt=$('turn-bar-text');
  $('info-round').textContent=gs.roundNumber||1;
  gs.lastRound?show($('last-round-pill')):hide($('last-round-pill'));

  function setBar(cls,label){ bar.className='turn-bar '+cls; txt.textContent=label; }

  if(_dealBusy){
    setBar('other-turn',_lang==='en'?'Dealing cards…':'Distribuzione carte…');
    return;
  }
  const myPlayer=gs?.players.find(p=>p.userId===S.userId);
  if(myPlayer?.isEliminated){ setBar('other-turn',t('spectator')); return; }
  if(S._attackMode){ setBar('attack-time',t('choose_card'));return; }
  if(phase==='forced-discard'&&isMe){ setBar('attack-time',t('discard_first'));return; }
  if(isMe){
    if(phase==='draw') setBar('my-turn', gs.lastRound?'⚡ Giochi te — ultimo!':'Giochi te!');
    else if(phase==='discard'){const d=S.drawnCard;setBar('my-turn',d?.known?`Tieni o scarta ${d.label}${d.symbol} (${d.value}pt)`:'Tieni o scarta?');}
    else setBar('my-turn',t('your_turn'));
  } else {
    setBar('other-turn',cur?`${_lang==='en'?'Turn:':'Turno di'} ${cur.username}`:t('waiting_turn'));
  }
}

// ── Seats ─────────────────────────────────────────────────────────────────
function renderSeats() {
  const gs=S.gameState;if(!gs)return;
  const opp=gs.players.filter(p=>p.userId!==S.userId);
  const container=$('seats-container');container.innerHTML='';
  opp.forEach((player,idx)=>{
    const pos=getOppPosition(idx,opp.length);
    const seat=document.createElement('div');
    seat.className=`seat${player.isCurrentPlayer&&!player.isEliminated?' seat-active':''}${player.isEliminated?' seat-elim':''}`;
    seat.style.left=pos.x+'%';seat.style.top=pos.y+'%';
    seat.setAttribute('data-user-id', player.userId);
    // While a draw ghost is in flight to this seat, keep the newest mini-card
    // hidden (reserve its space) so the card doesn't appear before the ghost lands.
    const drawing=S._drawingSet&&S._drawingSet.has(player.userId);
    const drawn=S._oppDrawn&&S._oppDrawn[player.userId];
    const motion=getOpponentMotion(player.userId);
    const minis=Array(Math.max(0,player.cardCount)).fill(0).map((_,i,a)=>{
      const incoming=drawing&&i===a.length-1;
      const hidden=motion?.reconciled
        ? motion.targetIndex===i && ['keep','forced'].includes(motion.kind)
        : motion?.sourceIndex===i && motion.kind!=='discard-drawn';
      const dealHidden=_dealBusy&&!S._dealLanded?.has(`${player.userId}:${i}`);
      return `<div class="mini-card${incoming?' mini-incoming':''}${hidden?' motion-hidden':''}${dealHidden?' deal-hidden':''}" data-card-index="${i}"></div>`;
    }).join('');
    const drawnMini=drawn?`<div class="mini-card opp-drawn-card${drawn==='incoming'?' mini-incoming':''}${motion?.hideDrawn?' motion-hidden':''}"></div>`:'';
    const current=player.isCurrentPlayer&&!player.isEliminated;
    seat.innerHTML=`
      <div class="seat-cards">${minis}${drawnMini}</div>
      <div class="seat-info">
        <div class="seat-name">${esc(player.username)}</div>
        <div class="seat-lives">${livesHTML(player.lives)}</div>
      </div>
      <div class="seat-turn-badge${current?' active':''}">▶ Turno</div>
      ${player.isEliminated?'<div class="seat-elim-badge">☠</div>':''}`;
    container.appendChild(seat);
  });
}

// ── My info ───────────────────────────────────────────────────────────────
function renderMyInfo() {
  const gs=S.gameState;if(!gs)return;
  const me=gs.players.find(p=>p.userId===S.userId);if(!me)return;
  $('my-name-display').textContent=S.username||'';
  $('my-lives').innerHTML=livesHTML(me.lives);
  $('my-av').textContent=(S.username?.[0]||'?').toUpperCase();
}

// ── My hand — always face-down, with drag-to-reorder ─────────────────────
function renderMyHand() {
  const gs=S.gameState;
  const isMe=gs?.currentPlayerUserId===S.userId,phase=gs?.phase;
  const inDiscard=phase==='discard'&&isMe&&S.drawnCard;
  const inForcedDiscard=phase==='forced-discard'&&isMe;

  const me=gs?.players.find(p=>p.userId===S.userId);
  const count=me?.cardCount??4;

  const handEl=$('my-hand');
  if(me?.isEliminated){
    handEl.innerHTML='<div class="spectator-msg">👁 Stai guardando</div>';
    return;
  }

  // Keep handOrder in sync with actual count
  if(!S.handOrder||S.handOrder.length!==count) {
    S.handOrder=Array.from({length:count},(_,i)=>i);
  }
  handEl.innerHTML=S.handOrder.map((serverIdx,visualIdx)=>{
    let cls='';
    if(inDiscard||inForcedDiscard) cls+=' clickable';
    if(S._attackMode) cls+=' atk-tgt';
    if(S._nove9Mode) cls+=' clickable'; // nove9: tap to peek
    if(visualIdx===S._selIdx) cls+=' selected';
    const raise=S.cardRaise?.[visualIdx]||0;
    const raiseAttr=raise>0?` data-raise="${raise}"`:'';
    const dealHidden=_dealBusy&&!S._dealLanded?.has(`${S.userId}:${serverIdx}`);
    const hiddenAttr=(S._animSlot===visualIdx||S._animHidden?.has(visualIdx)||dealHidden)?' style="visibility:hidden"':'';

    // Show face-up: initial peek OR nove9/special card reveal
    const isPeekUp=S._peekRevealed?.has(visualIdx);
    const isTempUp=(S._tempRevealServerIdx!==null&&S._tempRevealServerIdx===serverIdx)
      || (S._keptRevealServerIdx!==null&&S._keptRevealServerIdx===serverIdx);
    if(isPeekUp){
      const card=S.peekCards?.[visualIdx];
      if(card) return cardHTML({...card,known:true},{cls,index:visualIdx});
    }
    if(isTempUp){
      const card=S.privateState?.hand?.[serverIdx];
      if(card&&card.suit) return cardHTML({...card,known:true},{cls,index:visualIdx});
    }

    return `<div class="card-3d card-back ${cls}"${raiseAttr}${hiddenAttr} data-index="${visualIdx}"></div>`;
  }).join('');

  handEl.querySelectorAll('.card-3d').forEach((el,vi)=>{
    el.addEventListener('click',()=>onHandClick(vi));
    // Drag-to-reorder
    el.draggable=true;
    el.addEventListener('dragstart',e=>{
      _dragIdx=vi; e.dataTransfer.effectAllowed='move'; el.style.opacity='.35';
    });
    el.addEventListener('dragend',()=>{ el.style.opacity=''; _dragIdx=null; });
    el.addEventListener('dragover',e=>{ e.preventDefault(); el.style.outline='2px solid var(--gold)'; });
    el.addEventListener('dragleave',()=>{ el.style.outline=''; });
    el.addEventListener('drop',e=>{
      e.preventDefault(); el.style.outline='';
      if(_dragIdx===null||_dragIdx===vi)return;
      animateCardSwap(_dragIdx, vi);
      _dragIdx=null;
    });
  });

  // Drawn card
  const slot=$('drawn-slot');
  if(S.drawnCard&&isMe){
    show(slot);
    $('drawn-card-display').innerHTML=cardHTML(S.drawnCard,{cls:'clickable',index:-1}); // no anim-appear: replays on every renderMyHand call
    $('drawn-card-display').querySelector('.card-3d')?.addEventListener('click',()=>{ if(phase==='discard'&&isMe&&!S._attackMode) discardDrawn(); });
  } else hide(slot);

  // Update overflow arrow after hand renders
  requestAnimationFrame(updateHandOverflow);
}

function renderScore() {
  const el=$('score-pill');if(!el)return;
  if(!S.privateState?.hand?.length){el.textContent='';el.className='score-pill';return;}
  let sc=0,kn=0;
  // Use handOrder to get the score estimate
  (S.handOrder||[]).forEach(si=>{
    const c=S.privateState.hand[si];
    if(c?.known){sc+=c.value;kn++;}
  });
  const tot=S.privateState.hand.length;
  el.textContent=`~ ${sc}pt (${kn}/${tot})`;
  el.className='score-pill'+(sc<=8?' low':sc>=22?' high':'');
}

function renderActions() {
  const gs=S.gameState,isMe=gs?.currentPlayerUserId===S.userId,phase=gs?.phase;
  const hint=$('action-hint');
  // Always grey out all buttons — enable only what's valid right now
  const en=id=>{ const e=$(id);if(e)e.disabled=false; };
  const dis=id=>{ const e=$(id);if(e)e.disabled=true; };
  dis('btn-draw');dis('btn-knock');dis('btn-attack');dis('btn-discard-drawn');
  hint.textContent='';

  if(_dealBusy){ hint.textContent=_lang==='en'?'Dealing cards…':'Distribuzione carte…'; return; }
  const myPlayer=gs?.players.find(p=>String(p.userId)===String(S.userId));
  if(myPlayer?.isEliminated) return;
  if(S._attackRevealActive){ hint.textContent=t('attack_running'); return; }

  if(phase==='draw'&&isMe){ en('btn-draw');en('btn-knock'); }
  if(phase==='discard'&&isMe&&S.drawnCard&&!S._attackMode) en('btn-discard-drawn');
  if(phase==='special'&&isMe) hint.textContent=t('choose_special');
  if(['draw','discard','forced-discard'].includes(phase)&&gs?.discardTop&&!S._attackMode&&!S._attackAnnouncer) en('btn-attack');
  // Highlight the discard pile card as the attack target when in attack mode
  const dp=$('discard-pile');
  if(dp) dp.classList.toggle('atk-target', !!(S._attackMode||S._attackAnnouncer));
}

// ── Hand click ────────────────────────────────────────────────────────────
function onHandClick(visualIdx) {
  if(S._attackRevealActive) return;
  if(S._animSlot!==null && !S._attackMode && !S._nove9Mode) return; // ignore clicks mid-discard-animation
  const gs=S.gameState,isMe=gs?.currentPlayerUserId===S.userId,phase=gs?.phase;
  const serverIdx=S.handOrder?S.handOrder[visualIdx]:visualIdx;
  const cardEl=$('my-hand').querySelectorAll('.card-3d')[visualIdx];

  // ── Card 9 nove9: tap card → briefly shows face-up in hand ──
  if(S._nove9Mode){
    S._nove9Mode=false;
    SFX.play('9revealclick', 0.7);
    socket.emit('game:use-special-9',{cardIndex:serverIdx});
    S._tempRevealServerIdx=serverIdx;
    renderMyHand();renderActions();
    setTimeout(()=>{ S._tempRevealServerIdx=null; renderMyHand(); },3000);
    return;
  }

  if(phase==='discard'&&isMe&&S.drawnCard&&!S._attackMode){
    SFX.play('Card');
    const handSlotRect  = cardEl.getBoundingClientRect();
    const pileRect      = Cards.rect($('discard-pile'));
    const drawnSlotRect = Cards.drawnCardRect();
    const discardCard   = knownHandCardAtVisual(visualIdx);
    const drawnCard     = S.drawnCard?.known ? {...S.drawnCard,known:true} : null;

    // The selected hand card leaves; the drawn card joins at the right edge.
    // Known/unknown state follows the actual card state through the animation.
    const appendVI=appendDrawnOrderAfterDiscard(visualIdx, serverIdx, drawnCard);
    const keptServerIdx=S.handOrder?.[appendVI] ?? appendVI;
    S._skipDiscard = true;
    S._animSlot    = null;
    S._animHidden  = new Set([appendVI]);
    clearTimeout(S._skipDiscardFallback);
    S._skipDiscardFallback=setTimeout(()=>{ S._animHidden=null; settleDiscardPile(); renderMyHand(); },2200);
    S.drawnCard=null; S._selIdx=-1; hide($('drawn-slot'));
    renderMyHand();

    socket.emit('game:discard',{handIndex:serverIdx});

    // Target: appended slot position (hidden, but has a valid rect)
    const appendSlotRect = Cards.rect($('my-hand').querySelectorAll('.card-3d')[appendVI]);

    Cards.discardHandCard({
      handSlotRect, pileRect, drawnSlotRect,
      discardCard, drawnCard,
      appendSlotRect,
      onPileLand: ()=>{
        settleDiscardPile();
      },
      onHandLand: ()=>{
        clearTimeout(S._keptRevealTimer);
        S._keptRevealServerIdx=keptServerIdx;
        S._animHidden=null; renderMyHand();renderScore(); SFX.play('Card',0.18);
        $('my-hand')?.querySelectorAll('.card-3d')[appendVI]?.classList.add('card-turn-in');
        S._keptRevealTimer=setTimeout(()=>{
          S._keptRevealServerIdx=null;
          renderMyHand();
        },4000);
      },
    });
    return;
  }

  if(phase==='forced-discard'&&isMe&&!S._attackMode){
    SFX.play('Card');
    const handSlotRect = cardEl.getBoundingClientRect();
    const pileRect     = Cards.rect($('discard-pile'));
    const deckRect     = Cards.rect($('deck-pile'));
    const discardCard  = knownHandCardAtVisual(visualIdx);

    const appendVI=appendDrawnOrderAfterDiscard(visualIdx, serverIdx, {known:false});
    S._skipDiscard = true;
    S._animSlot    = null;
    S._animHidden  = new Set([appendVI]);
    clearTimeout(S._skipDiscardFallback);
    S._skipDiscardFallback=setTimeout(()=>{ S._animHidden=null; settleDiscardPile(); renderMyHand(); },2200);
    renderMyHand();
    socket.emit('game:forced-discard',{handIndex:serverIdx});
    S._selIdx=-1;

    const appendSlotRect = Cards.rect($('my-hand').querySelectorAll('.card-3d')[appendVI]);

    Cards.forcedDiscard({
      handSlotRect, pileRect, deckRect, appendSlotRect,
      discardCard,
      onPileLand: ()=>{
        settleDiscardPile();
      },
      onDeckLand: ()=>{
        S._animHidden=null; renderMyHand();renderScore(); SFX.play('Card',0.18);
      },
    });
    return;
  }

  if(S._attackMode){
    if(cardEl){
      // Capture rect NOW before any re-render can detach cardEl
      const slotR = cardEl.getBoundingClientRect();
      const pileR = Cards.rect($('discard-pile'));
      // Brief gold ring lift, then immediately fly
      cardEl.style.pointerEvents='none';
      cardEl.style.transition='transform .18s cubic-bezier(.34,1.2,.64,1),box-shadow .18s';
      cardEl.style.transform='translateY(-12px) scale(1.06)';
      cardEl.style.boxShadow='0 0 0 3px var(--gold),0 10px 24px rgba(0,0,0,.65)';
      // Block pile render immediately so game:card-discarded can't update
      // the pile before the attack ghost arrives
      S._skipDiscard=true;
      setTimeout(()=>{
        S._animHidden=new Set([visualIdx]);
        renderMyHand();
        Cards.attackCard(slotR, pileR, ()=>settleDiscardPile(), knownHandCardAtVisual(visualIdx));
      },200);
    }
    $('discard-pile')?.classList.remove('atk-target');
    socket.emit('game:attack',{cardIndex:serverIdx});
    S._selIdx=-1;   // never show selection border on attack
    return;
  }

  // No active game action → cycle raise level (click to float card up/down)
  const count=gs?.players.find(p=>p.userId===S.userId)?.cardCount??4;
  if(!S.cardRaise||S.cardRaise.length!==count) S.cardRaise=Array(count).fill(0);
  S.cardRaise[visualIdx]=(S.cardRaise[visualIdx]+1)%4; // 0→1→2→3→0
  renderMyHand();
}


// FLIP card swap: the ACTUAL card elements move — no ghost overlay
function animateCardSwap(fromVI, toVI) {
  const cards = Array.from($('my-hand').querySelectorAll('.card-3d'));
  const fromEl = cards[fromVI], toEl = cards[toVI];

  if (!fromEl || !toEl) {
    [S.handOrder[fromVI], S.handOrder[toVI]] = [S.handOrder[toVI], S.handOrder[fromVI]];
    if (S.cardRaise) [S.cardRaise[fromVI], S.cardRaise[toVI]] = [S.cardRaise[toVI], S.cardRaise[fromVI]];
    renderMyHand(); renderScore(); return;
  }

  // ── FLIP: First ── snapshot positions before any DOM change
  const fr = fromEl.getBoundingClientRect();
  const tr = toEl.getBoundingClientRect();

  // ── FLIP: Last ── swap data and re-render (elements now at swapped positions)
  [S.handOrder[fromVI], S.handOrder[toVI]] = [S.handOrder[toVI], S.handOrder[fromVI]];
  if (S.cardRaise) [S.cardRaise[fromVI], S.cardRaise[toVI]] = [S.cardRaise[toVI], S.cardRaise[fromVI]];
  renderMyHand(); renderScore();

  // ── FLIP: Invert ── apply transforms to put elements back at their OLD positions
  const nc = Array.from($('my-hand').querySelectorAll('.card-3d'));
  const nf = nc[fromVI]; // now visually at toVI's position
  const nt = nc[toVI];   // now visually at fromVI's position
  if (!nf || !nt) return;

  const nfR = nf.getBoundingClientRect();
  const ntR = nt.getBoundingClientRect();

  // Instant: move elements back to where they started
  nf.style.transition = 'none';
  nf.style.transform  = `translate(${fr.left - nfR.left}px, ${fr.top - nfR.top}px)`;
  nt.style.transition = 'none';
  nt.style.transform  = `translate(${tr.left - ntR.left}px, ${tr.top - ntR.top}px)`;

  // ── FLIP: Play ── remove transforms with transition → elements animate to natural positions
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const D = '.6s cubic-bezier(.4,0,.2,1)';
    nf.style.transition = `transform ${D}`;
    nf.style.transform  = '';
    nt.style.transition = `transform ${D}`;
    nt.style.transform  = '';
  }));

  // Cleanup inline styles after animation
  setTimeout(() => {
    if (nf.isConnected) { nf.style.transition=''; nf.style.transform=''; }
    if (nt.isConnected) { nt.style.transition=''; nt.style.transform=''; }
  }, 680);
}

function discardDrawn() {
  SFX.play('Card', 0.5);
  // Capture rects BEFORE hiding the slot (hidden elements have zero rect)
  const drawnSlotRect = Cards.drawnCardRect(); // rect of the card-3d inside drawn-slot
  const pileRect      = Cards.rect($('discard-pile'));
  const card          = S.drawnCard?.known ? S.drawnCard : null;
  S.drawnCard=null; S._selIdx=-1; hide($('drawn-slot'));
  socket.emit('game:discard',{handIndex:-1});
  S._skipDiscard=true;
  clearTimeout(S._skipDiscardFallback);
  S._skipDiscardFallback=setTimeout(()=>settleDiscardPile(),1500);
  Cards.discardDrawnCard({
    drawnSlotRect, pileRect, card,
    onLand: ()=>settleDiscardPile(),
  });
}

// ── flyAnim: used only for swap panel (reparents actual element) ──────────
function flyAnim(fromEl, toEl) {
  if(!fromEl||!toEl)return;
  try{
  const fr=fromEl.getBoundingClientRect(),tr=toEl.getBoundingClientRect();
  // Block discard-pile renders while this card is in flight
  const isToDiscard = toEl.id==='discard-pile';
  if(isToDiscard){
    S._skipDiscard=true;
    // Safety fallback: never stay blocked for more than 1.5s
    clearTimeout(S._skipDiscardFallback);
    S._skipDiscardFallback = setTimeout(()=>{
      if(S._skipDiscard){ S._skipDiscard=false; const c=S._pendingDiscardCard||S.gameState?.discardTop; S._pendingDiscardCard=null; if(c)renderDiscardPile(c); }
    },1500);
  }
  // Reparent to body at exact current position — the actual element flies, no copy
  fromEl.style.cssText=`position:fixed;left:${fr.left}px;top:${fr.top}px;width:${fr.width}px;height:${fr.height}px;z-index:9999;margin:0;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.7)`;
  document.body.appendChild(fromEl);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    fromEl.style.transition='left .55s cubic-bezier(.25,.46,.45,.94), top .55s cubic-bezier(.25,.46,.45,.94), transform .55s';
    fromEl.style.left=`${tr.left+tr.width/2-fr.width/2}px`;
    fromEl.style.top =`${tr.top +tr.height/2-fr.height/2}px`;
    fromEl.style.transform='scale(.88)'; // slight shrink as it lands, fully visible the whole way
  }));
  setTimeout(()=>{
    fromEl.remove();
    if(isToDiscard){
      clearTimeout(S._skipDiscardFallback);
      S._skipDiscard=false;
      const c=S._pendingDiscardCard||S.gameState?.discardTop;
      S._pendingDiscardCard=null;
      if(c) renderDiscardPile(c);
    }
  },680);
  }catch(e){ S._skipDiscard=false; try{fromEl.remove();}catch(_){} }
}
function animDeckDraw(onArrive) {
  Cards.drawFromDeck(onArrive);
}

// ── Buttons ───────────────────────────────────────────────────────────────
$('btn-draw').addEventListener('click',()=>{socket.emit('game:draw');$('btn-draw').disabled=true;$('btn-knock').disabled=true;});
$('deck-pile').addEventListener('click',()=>{
  if(S.gameState?.phase==='draw'&&S.gameState.currentPlayerUserId===S.userId){
    socket.emit('game:draw');
    $('btn-draw').disabled=true;
    $('btn-knock').disabled=true;
  }
});
$('btn-knock').addEventListener('click',()=>{
  if(!confirm(t('knock_confirm')))return;
  socket.emit('game:knock');addLog('Hai bussato!','gold');
});
$('btn-discard-drawn').addEventListener('click',discardDrawn);

// ⚔ button: enter attack mode IMMEDIATELY (don't wait for server round-trip)
// then announce to others so they see the banner
$('btn-attack').addEventListener('click',()=>{
  S._attackMode=true;
  $('btn-attack').disabled=true;
  renderMyHand();renderActions();renderTurnBanner();
  socket.emit('game:announce-attack'); // broadcast announcement to all other players
});

// ── Drawn card ────────────────────────────────────────────────────────────
socket.on('game:drawn-card',({card,penalized})=>{
  if(penalized||!card){
    S.drawnCard={known:false,id:'__hidden__'};
    addLog('Hai pescato (penalizzato — carta nascosta)','danger');
    toast('⚠ Penalizzato!','error');
  } else {
    S.drawnCard={...card,known:true};
    addLog(`Hai pescato: ${cardStr(card)} (${card.value}pt)`,'gold');
  }
  SFX.play('Card', 0.55);
  renderMyHand();renderActions();renderTurnBanner();
  // Ghost flies face-down deck→slot; when it lands, drawn-slot fades in face-up
  const _dcd=$('drawn-card-display');
  if(_dcd) _dcd.style.opacity='0';
  requestAnimationFrame(()=>animDeckDraw(()=>{
    if(_dcd){
      _dcd.style.transition='opacity .15s';
      _dcd.style.opacity='1';
      _dcd.querySelector('.card-3d')?.classList.add('card-turn-in');
    }
  }));
});

// ── Special cards ─────────────────────────────────────────────────────────
socket.on('game:special-prompt',({type,card})=>{S.specialPrompt={type,card};showSpecial(type,card);});
function showSpecial(type,card){
  if(type==='9'){
    // Card 9: NO popup — activate nove9 mode so user taps a hand card directly
    S._nove9Mode=true;
    addLog('🔍 Nove: tocca una tua carta per sbirciare!','gold');
    const _tb=$('turn-bar'),_tt=$('turn-bar-text');
    if(_tb&&_tt){ _tb.className='turn-bar my-turn'; _tt.textContent='👁 Tocca una carta'; show(_tb); }
    renderMyHand();renderActions(); // shows clickable hint on cards
    return; // skip the panel entirely
  }

  show($('panel-special'));
  // Skip button: only available for card 9 peek (8 swap is mandatory)
  const skipBtn=$('btn-special-skip');
  if(skipBtn) skipBtn.style.display = type==='8' ? 'none' : '';
  $('special-card-preview').innerHTML=cardHTML({...card,known:true},{cls:'anim-appear'});

  if(type==='8'){
    $('special-title').textContent=t('swap');
    $('special-desc').textContent=t('choose_swap');
    const myCount=S.gameState?.players.find(p=>p.userId===S.userId)?.cardCount??4;
    const opp=(S.gameState?.players||[]).filter(p=>p.userId!==S.userId&&!p.isEliminated);
    let selMyVI=null;

    $('special-actions').innerHTML=`
      <p class="s8-label">${t('your_card')}</p>
      <div class="special-hand-row" id="s8-mine" style="opacity:0">${Array(myCount).fill(0).map((_,i)=>cardHTML({known:false,index:i},{index:i})).join('')}</div>
      <div id="s8-step2" style="display:none;margin-top:.75rem">
        <p class="s8-label">${t('with_whom')}</p>
        <div class="special-opts" id="s8-opp"></div>
        <div id="s8-theirs"></div>
      </div>`;

    // Animate hand cards flying into panel: each card ghosts from hand → panel slot
    requestAnimationFrame(()=>{
      const handCards=$('my-hand').querySelectorAll('.card-3d');
      const panelSlots=$('s8-mine').querySelectorAll('.card-3d');
      const stCS=getComputedStyle(document.documentElement);
      Array.from(panelSlots).forEach((pCard,i)=>{
        const hCard=handCards[i];
        if(!hCard||!pCard) return;
        const hr=hCard.getBoundingClientRect(), pr=pCard.getBoundingClientRect();
        if(!hr.width||!pr.width) return;
        const g=document.createElement('div');
        g.className='card-3d card-back';
        g.style.cssText=`position:fixed;left:${hr.left}px;top:${hr.top}px;width:${hr.width}px;height:${hr.height}px;z-index:9996;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.55);transition:none`;
        document.body.appendChild(g);
        const delay=i*55;
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
          g.style.transition=`left 360ms ${delay}ms cubic-bezier(.25,.46,.45,.94),top 360ms ${delay}ms cubic-bezier(.25,.46,.45,.94),width 360ms ${delay}ms,height 360ms ${delay}ms`;
          g.style.left=pr.left+'px'; g.style.top=pr.top+'px';
          g.style.width=pr.width+'px'; g.style.height=pr.height+'px';
        }));
        const isLast = i === Array.from(panelSlots).length - 1;
        setTimeout(()=>{ g.remove(); if(isLast) $('s8-mine').style.opacity='1'; },delay+400);
      });
    });

    $('s8-mine').querySelectorAll('.card-3d').forEach(el=>{
      el.addEventListener('click',()=>{
        selMyVI=parseInt(el.dataset.index);
        $('s8-mine').querySelectorAll('.card-3d').forEach(c=>c.classList.remove('selected'));
        el.classList.add('selected');
        $('s8-step2').style.display='';
        $('s8-opp').innerHTML=opp.map(p=>`<button class="special-opt" data-id="${p.userId}" data-count="${p.cardCount}">${esc(p.username)} (${p.cardCount})</button>`).join('');
        $('s8-opp').querySelectorAll('.special-opt').forEach(btn=>{
          btn.addEventListener('click',()=>{
            const tid=btn.dataset.id,cnt=parseInt(btn.dataset.count);
            $('s8-opp').querySelectorAll('.special-opt').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
            $('s8-theirs').innerHTML=`
              <p class="s8-label">${t('which_card')}</p>
              <div class="special-hand-row">${Array(cnt).fill(0).map((_,i)=>cardHTML({known:false,index:i},{index:i})).join('')}</div>`;
            $('s8-theirs').querySelectorAll('.card-3d').forEach(cb=>{
              cb.addEventListener('click',()=>{
                const myServerIdx=S.handOrder?S.handOrder[selMyVI]:selMyVI;
                // Cross-animate the two selected cards before closing
                const myEl=$('s8-mine').querySelectorAll('.card-3d')[selMyVI];
                const theirEl=cb;
                if(myEl&&theirEl){
                  const mr=myEl.getBoundingClientRect(), tr2=theirEl.getBoundingClientRect();
                  [myEl,theirEl].forEach(el=>{ el.style.transition='transform .35s cubic-bezier(.25,.46,.45,.94),opacity .35s'; el.style.transform='scale(1.15)'; el.style.opacity='.6'; });
                  setTimeout(()=>{
                    socket.emit('game:use-special-8',{myCardIndex:myServerIdx,targetUserId:tid,targetCardIndex:parseInt(cb.dataset.index)});
                    hide($('panel-special'));
                  },380);
                } else {
                  socket.emit('game:use-special-8',{myCardIndex:myServerIdx,targetUserId:tid,targetCardIndex:parseInt(cb.dataset.index)});
                  hide($('panel-special'));
                }
              });
            });
          });
        });
      });
    });
  }
}
$('btn-special-skip').addEventListener('click',()=>{
  socket.emit('game:skip-special');
  hide($('panel-special'));S.specialPrompt=null;
});

// ── Peek reveal (card 9) ───────────────────────────────────────────────────
// 10-card effect: update private state so score is correct; no visual reveal
socket.on('game:forced-draw-reveal',({card,serverIndex})=>{
  setTimeout(()=>{
    SFX.play('Card',0.3);
    if(S.privateState?.hand?.[serverIndex]) S.privateState.hand[serverIndex]={...card,known:true,index:serverIndex};
    renderScore();
    addLog(`🔟 Hai pescato: ${card.label}${card.symbol} — ricordala!`,'gold');
  },820);
});

socket.on('game:peeked',({cardIndex,card})=>{
  if(S.privateState?.hand?.[cardIndex]) S.privateState.hand[cardIndex]={...card,known:true,index:cardIndex};
  renderScore();
  const vi=(S.handOrder||[]).findIndex(si=>si===cardIndex);
  // Show the peeked card face-up in hand for 3s, then back down
  S._tempRevealServerIdx=cardIndex;
  renderMyHand();
  setTimeout(()=>{ S._tempRevealServerIdx=null; renderMyHand(); },3000);
  addLog(`👁 Posizione #${vi>=0?vi+1:'?'}: ricordatela!`,'gold');
});

socket.on('game:swapped',({receivedCard})=>{
  // No longer used — special-8 completes without drawn card
  renderMyHand();renderActions();addLog('Scambio 8 completato!','gold');
});

// Someone else used a special card — show notification
socket.on('game:special-triggered',({username,type,card})=>{
  const names={'8':'Otto (Scambia)','9':'Nove (Sbircia)'};
  addLog(`✨ ${username} usa ${names[type]||'carta speciale'}: ${cardStr(card)}`,'gold');
  toast(`✨ ${username} ha usato ${names[type]||'carta speciale'}!`,'',3500);
});

// 10-card effect: next player will be forced to discard first
socket.on('game:forced-discard-next',({username})=>{
  addLog(`🔟 ${username} ha scartato il 10 — il prossimo giocatore deve scartare prima di pescare!`,'gold');
  toast(`🔟 Effetto 10 di ${username}: il prossimo deve scartare prima!`,'',5000);
});

// ── New card on discard pile — ⚔ becomes available ───────────────────────
socket.on('game:player-drew',({userId})=>{
  if(String(userId)===String(S.userId)) return;
  S._oppDrawn=S._oppDrawn||{};
  S._oppDrawn[userId]='incoming';
  renderSeats();
  animOppDrawn(userId);
});

socket.on('game:card-discarded',({card, discarderId, handIndex, forced})=>{
  S._pendingDiscardCard = card;
  if(discarderId && String(discarderId) !== String(S.userId)){
    animOppDiscard(discarderId, card, handIndex, forced);
  } else {
    // Self-discard: ghost is flying and _skipDiscard=true.
    // onPileLand/onLand handles renderDiscardPile when ghost arrives.
    // Safety: if _skipDiscard somehow isn't set, render immediately.
    if(!S._skipDiscard) setTimeout(()=>renderDiscardPile(card),50);
  }
  addLog(`${cardStr(card)} scartata`,'info');
  renderActions();
});

// ── Attack reveal ─────────────────────────────────────────────────────────
socket.on('game:attack-reveal',({attackerUserId,attackerUsername,card,discardCard,success,penaltyCard})=>{
  S._attackAnnouncer=null;
  S._attackRevealActive=true;
  // Don't clear S.drawnCard here — if this player was in discard phase,
  // game:private will restore it so they can finish their turn after the attack
  clearInterval(S._annCdInt);
  hide($('attack-announce-bar'));
  renderActions();

  setTimeout(()=>SFX.play(success?'Success':'Fail', 0.85), 2800);
  showAttackReveal(attackerUserId,attackerUsername,card,success,penaltyCard,discardCard);
  addLog(success?`✅ ${attackerUsername}: azzeccato! ${cardStr(card)}`:`❌ ${attackerUsername}: sbagliato! +1 carta`,success?'success':'danger');

  // At 2.5s: clear selection visual (game:state will drive the full unpause)
  setTimeout(()=>{
    if(attackerUserId===S.userId) S._attackMode=false;
    S._selIdx=-1;
    renderMyHand();renderScore();renderSeats();
  },2500);

  // Safety fallback: leave enough time for a post-popup penalty draw.
  setTimeout(()=>{ if(S._attackRevealActive){ S._attackRevealActive=false; S._attackMode=false; S._attackAnnouncer=null; renderActions();renderTurnBanner(); } },8000);
});

socket.on('game:attack-penalty-draw', animateAttackPenaltyDraw);

function animateAttackPenaltyDraw({userId,targetCardCount}) {
  const deckRect=Cards.rect($('deck-pile'));
  if(!deckRect||!targetCardCount) return;
  S._penaltyAnimating=true;
  const isMe=String(userId)===String(S.userId);

  if(isMe){
    const player=S.gameState?.players.find(p=>String(p.userId)===String(userId));
    if(player) player.cardCount=targetCardCount;
    S.privateState=S.privateState||{hand:[]};
    S.privateState.hand=S.privateState.hand||[];
    while(S.privateState.hand.length<targetCardCount){
      const index=S.privateState.hand.length;
      S.privateState.hand.push({id:`__attack_penalty_${index}`,known:false,index});
    }
    S.handOrder=S.handOrder||Array.from({length:Math.max(0,targetCardCount-1)},(_,i)=>i);
    const newServerIndex=targetCardCount-1;
    if(!S.handOrder.includes(newServerIndex)) S.handOrder.push(newServerIndex);
    const visualIndex=S.handOrder.indexOf(newServerIndex);
    S._animHidden=new Set([visualIndex]);
    renderMyHand();
    const target=Cards.rect($('my-hand')?.querySelectorAll('.card-3d')[visualIndex]);
    Cards.penaltyDraw(deckRect,target,()=>{
      S._animHidden=null;
      S._penaltyAnimating=false;
      renderMyHand();
      SFX.play('Card',0.35);
    });
    return;
  }

  const player=S.gameState?.players.find(p=>String(p.userId)===String(userId));
  if(player) player.cardCount=targetCardCount;
  _prevCounts[userId]=targetCardCount;
  S._drawingSet=S._drawingSet||new Set();
  S._drawingSet.add(userId);
  renderSeats();
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const seat=document.querySelector(`.seat[data-user-id="${userId}"]`);
    const target=Cards.rect(seat?.querySelector('.mini-card.mini-incoming')||seat?.querySelector('.seat-cards'));
    Cards.penaltyDraw(deckRect,target,()=>{
      S._drawingSet?.delete(userId);
      S._penaltyAnimating=false;
      renderSeats();
      SFX.play('Card',0.35);
    },true);
  }));
}

// ── Attack reveal: discard card shown first, then attack card ─────────────
function showAttackReveal(auId, auName, card, success, penaltyCard, discardCard) {
  document.querySelector('.atk-reveal-overlay')?.remove();
  const isMe = auId === S.userId;

  const overlay = document.createElement('div');
  overlay.className = 'atk-reveal-overlay';
  overlay.innerHTML = `<div class="ar-box">
    <div class="ar-who">${_lang==='en'
      ? `Attack by ${esc(auName)}${isMe?' (you)':''}!`
      : `${esc(auName)}${isMe?' (tu)':''} tenta un attacco!`}</div>

    <!-- Step 1: show discard card (immediately visible) -->
    <div class="ar-step" id="ar-step1">
      <div class="ar-vs-lbl">${_lang==='en'?'Card to match:':'Carta da abbinare:'}</div>
      ${discardCard ? cardHTML({...discardCard,known:true}) : '<div class="ar-unknown">?</div>'}
    </div>

    <!-- Step 2: suspense then reveal attack card -->
    <div class="ar-step ar-hidden" id="ar-step2">
      <div class="ar-vs-lbl">${_lang==='en'?'Attacker card:':"Carta dell'attaccante:"}</div>
      <div class="ar-dots"><span></span><span></span><span></span></div>
      <div class="ar-attack-card ar-hidden" id="ar-atk-card">
        ${cardHTML({...card,known:true},{cls:'anim-appear'})}
      </div>
    </div>

    <!-- Result -->
    <div class="ar-result ar-hidden" id="ar-res">
      ${success
        ? `<div class="ar-success">${_lang==='en'?'CORRECT!':'AZZECCATO!'}</div>`
        : `<div class="ar-fail">${_lang==='en'?'WRONG!':'SBAGLIATO!'}${penaltyCard?`<div class="ar-penalty">${_lang==='en'?'+1 card in hand':'+1 carta in mano'}</div>`:''}</div>`}
    </div>
  </div>`;
  document.body.appendChild(overlay);

  // 1.2s: show step 2 with suspense dots
  setTimeout(() => {
    overlay.querySelector('#ar-step2')?.classList.remove('ar-hidden');
  }, 1200);

  // 2.2s: reveal the attack card
  setTimeout(() => {
    overlay.querySelector('.ar-dots')?.remove();
    const attackCard=overlay.querySelector('#ar-atk-card');
    attackCard?.classList.remove('ar-hidden');
    attackCard?.querySelector('.card-3d')?.classList.add('card-turn-in');
  }, 2200);

  // 3.2s: show result
  setTimeout(() => {
    overlay.querySelector('#ar-res')?.classList.remove('ar-hidden');
  }, 3200);

  // 5s: fade out
  setTimeout(() => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity .4s';
    setTimeout(() => overlay.remove(), 420);
  }, 5000);
}

// ── Otto swap: face-down cards crossing between two piles ─────────────────
function showSwapAnimation(initiatorName, targetName, iCount, tCount, initiatorIndex=0, targetIndex=0) {
  document.querySelector('.swap-overlay')?.remove();
  SFX.play('Swapswoosh', 0.75);

  const makePile = (n) =>
    Array(Math.min(n, 8)).fill(0)
      .map(() => cardHTML({known:false},{cls:'swap-mini-back'}))
      .join('');

  const overlay = document.createElement('div');
  overlay.className = 'swap-overlay';
  overlay.innerHTML = `<div class="swap-box">
    <div class="swap-title">${t('swap_title')}</div>
    <div class="swap-piles-row">
      <div class="swap-section">
        <div class="swap-pname">${esc(initiatorName)}</div>
        <div class="swap-pile-row" id="spl-l">${makePile(iCount)}</div>
      </div>
      <div class="swap-arrow-mid">⇄</div>
      <div class="swap-section">
        <div class="swap-pname">${esc(targetName)}</div>
        <div class="swap-pile-row" id="spl-r">${makePile(tCount)}</div>
      </div>
    </div>
    <div class="swap-prog-wrap"><div id="sp" class="swap-prog"></div></div>
  </div>`;
  document.body.appendChild(overlay);

  // After layout renders, get exact card positions and animate
  setTimeout(() => {
    const lCards = Array.from(overlay.querySelectorAll('#spl-l .swap-mini-back'));
    const rCards = Array.from(overlay.querySelectorAll('#spl-r .swap-mini-back'));
    const src = lCards[Math.max(0, Math.min(initiatorIndex, lCards.length - 1))];
    const dst = rCards[Math.max(0, Math.min(targetIndex, rCards.length - 1))];
    if (!src || !dst) return;

    const sr = src.getBoundingClientRect();
    const dr = dst.getBoundingClientRect();

    // Highlight source cards
    src.classList.add('swap-selected-source');
    dst.classList.add('swap-selected-target');
    src.style.outline = '2px solid var(--gold)';
    dst.style.outline = '2px solid var(--gold)';

    // Ghost cards at exact positions, cross over
    const makeGhost = (r) => {
      const g = document.createElement('div');
      g.className = 'card-3d card-back card-ghost swap-fly-card';
      g.style.cssText = [
        `position:fixed`, `z-index:9998`, `pointer-events:none`,
        `left:${r.left}px`, `top:${r.top}px`,
        `width:${r.width}px`, `height:${r.height}px`,
        `box-shadow:0 6px 18px rgba(0,0,0,.7)`
      ].join(';');
      document.body.appendChild(g);
      return g;
    };

    const gl = makeGhost(sr);
    const gr = makeGhost(dr);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      const DUR = '.85s cubic-bezier(.4,0,.2,1)';
      gl.style.transition = `all ${DUR}`;
      gl.style.left = dr.left + 'px';
      gl.style.top  = dr.top  + 'px';

      gr.style.transition = `all ${DUR}`;
      gr.style.left = sr.left + 'px';
      gr.style.top  = sr.top  + 'px';
    }));

    setTimeout(() => { gl.remove(); gr.remove(); }, 950);
  }, 400);

  // Progress bar
  const prog = overlay.querySelector('#sp');
  if (prog) {
    prog.style.width = '100%';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      prog.style.transition = 'width 3.5s linear';
      prog.style.width = '0%';
    }));
  }

  setTimeout(() => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity .4s';
    setTimeout(() => overlay.remove(), 420);
  }, 3500);
}

socket.on('game:swap-reveal', ({
  initiatorUserId, initiatorUsername, targetUserId, targetUsername,
  initiatorCardIndex=0, targetCardIndex=0,
}) => {
  const gs = S.gameState;
  const iCount = gs?.players.find(p => p.userId === initiatorUserId)?.cardCount || 4;
  const tCount = gs?.players.find(p => p.userId === targetUserId)?.cardCount || 4;
  const iVisual = String(initiatorUserId) === String(S.userId)
    ? Math.max(0, (S.handOrder || []).indexOf(initiatorCardIndex))
    : initiatorCardIndex;
  const tVisual = String(targetUserId) === String(S.userId)
    ? Math.max(0, (S.handOrder || []).indexOf(targetCardIndex))
    : targetCardIndex;
  showSwapAnimation(initiatorUsername, targetUsername, iCount, tCount, iVisual, tVisual);
  addLog(`🔄 ${initiatorUsername} → ${targetUsername} scambio carte`, 'gold');
});

// attack-window-closed / attack-cancelled — safety reset, unblock game
socket.on('game:attack-window-closed',()=>{ S._attackRevealActive=false;S._attackMode=false;S._attackAnnouncer=null;clearInterval(S._annCdInt);hide($('attack-announce-bar'));$('discard-pile')?.classList.remove('atk-target'); renderMyHand();renderActions();renderTurnBanner(); });
socket.on('game:attack-cancelled',({username,penalty})=>{ S._attackRevealActive=false;S._attackMode=false;S._attackAnnouncer=null; const bar=$('attack-announce-bar');if(bar)bar.classList.add('hidden'); if(penalty){SFX.play('Fail',0.85);addLog(`⏰ ${username} non ha attaccato in tempo — carta di penalità!`);} renderMyHand();renderActions();renderTurnBanner(); });

// ── Attack announcement — shown to ALL players when ⚔ is pressed ─────────
socket.on('game:attack-announced',({attackerUserId, attackerUsername, discardCard, duration})=>{
  SFX.play('Attacknotify', 0.6);
  S._attackAnnouncer=attackerUserId; // track announcer — hides ⚔ for others
  const isAttacker = attackerUserId === S.userId;

  // Show the announce bar with the discard card and suspense dots
  const bar = $('attack-announce-bar');
  show(bar);

  // Put discard card into the bar
  const cardEl = $('ann-discard-card');
  if(cardEl && discardCard) {
    const fb = discardCard.color==='red'?'red':'black';
    cardEl.innerHTML=`<div class="card-3d card-front" style="width:40px;height:61px;pointer-events:none"><img src="/cards/${discardCard.suit}_${discardCard.value}.jpg" class="card-img" onerror="this.style.display='none';makeFB(this.parentElement,'${discardCard.label}','${discardCard.symbol}','${fb}')"></div>`;
  }

  $('ann-title').textContent = isAttacker ? '⚔ Scegli carta!' : `⚔ ${esc(attackerUsername)} attacca!`;
  $('ann-sub').textContent   = isAttacker ? 'Tocca una carta…' : '';

  // Progress bar
  const prog=$('ann-progress');
  if(prog){ prog.style.transition='none';prog.style.width='100%';
    requestAnimationFrame(()=>requestAnimationFrame(()=>{ prog.style.transition=`width ${duration}ms linear`; prog.style.width='0%'; })); }

  // Countdown
  let rem=duration/1000;$('ann-cd').textContent=Math.ceil(rem);
  clearInterval(S._annCdInt);
  S._annCdInt=setInterval(()=>{ rem-=.25;$('ann-cd').textContent=Math.max(0,Math.ceil(rem));if(rem<=0)clearInterval(S._annCdInt); },250);

  // For the attacker: _attackMode already set by button click — just re-render to be safe
  renderActions(); // immediately hide/update buttons for everyone
  if(isAttacker && !S._attackMode){ S._attackMode=true; renderMyHand(); }

  addLog(`⚔ ${attackerUsername} sta attaccando!`,'danger');
});

// ── Knock ─────────────────────────────────────────────────────────────────
socket.on('game:knocked',({username})=>{
  SFX.play('Knock', 0.85); // heard by ALL players
  SFX.loop('Drumlooppostknock', 0.55);
  addLog(`✊ ${username} ha bussato — ultimo giro!`,'gold');
  toast(`✊ ${username} ha bussato!`,'',5000);show($('last-round-pill'));
});

// ── Scoring ───────────────────────────────────────────────────────────────
function animateScoreCounts(root) {
  root?.querySelectorAll('.score-val[data-score]').forEach(el=>{
    const target=Number(el.dataset.score)||0;
    const started=performance.now();
    const duration=1100;
    const frame=now=>{
      const raw=Math.min(1,(now-started)/duration);
      const eased=1-Math.pow(1-raw,3);
      el.textContent=String(Math.round(target*eased));
      if(raw<1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

function showRoundEndTransition(done) {
  S._roundEndBusy=true;
  SFX.stop('Drumlooppostknock',300);
  SFX.play('Matchend',0.82,{cooldown:1000});
  $('count-cards-kicker').textContent=_lang==='en'?'GAME END!':'FINE PARTITA!';
  $('count-cards-title').textContent=_lang==='en'?'Count the cards.':'Contate le carte.';
  show($('panel-count-cards'));
  setTimeout(()=>{
    hide($('panel-count-cards'));
    S._roundEndBusy=false;
    done?.();
  },2400);
}

socket.on('game:scoring',payload=>{
  showRoundEndTransition(()=>renderScoring(payload));
});

function renderScoring({scores,losers,knockedBy}){
  const gs=S.gameState;show($('panel-scoring'));
  const iLost = losers.some(id=>String(id)===String(S.userId));
  setTimeout(()=>SFX.play(iLost?'Miniloss':'Miniwin', 0.8), 400);
  $('scoring-round').textContent=gs?.roundNumber||'';
  const ki=$('scoring-knocked-info');
  if(knockedBy){const kn=gs?.players.find(p=>p.userId===knockedBy)?.username||'?';show(ki);ki.textContent=`✊ ${kn} ha bussato — paga doppio se ha più punti!`;}
  else hide(ki);
  $('scoring-list').innerHTML=[...scores].sort((a,b)=>a.score-b.score).map(s=>{
    const isL=losers.includes(s.userId),pl=gs?.players.find(p=>p.userId===s.userId);
    const hh=(s.hand||[]).map(c=>`<div style="width:30px;height:46px;border-radius:4px;overflow:hidden;box-shadow:1px 2px 5px rgba(0,0,0,.4);flex-shrink:0;background:#f5f0e8"><img src="/cards/${c.suit}_${c.value}.jpg" style="width:100%;height:100%;object-fit:contain;display:block" onerror="this.style.display='none'"></div>`).join('');
    return `<div class="score-row${isL?' loser':''}"><div class="score-meta"><div class="score-name">${esc(s.username)}${isL?' 💔':' ✅'}${knockedBy===s.userId?' ✊':''}</div><div class="score-lives">❤ ${pl?.lives??'?'} vite</div><div class="score-hand-row">${hh}</div></div><div class="score-val" data-score="${s.score}">0</div></div>`;
  }).join('');
  animateScoreCounts($('scoring-list'));
  const isHost=gs?.hostUserId===S.userId;
  isHost?show($('btn-next-round')):hide($('btn-next-round'));
  $('scoring-hint').textContent=isHost?'':'In attesa che l\'host avvii il prossimo round…';
  addLog(`Fine round! Perdono vita: ${losers.map(id=>gs?.players.find(p=>p.userId===id)?.username||id).join(', ')}`,'danger');
}

socket.on('game:gameover',payload=>{
  showRoundEndTransition(()=>renderGameover(payload));
});

function renderGameover({scores,winner}){
  hide($('panel-scoring'));show($('panel-gameover'));
  const iWon = winner && String(winner.userId)===String(S.userId);
  SFX.play(iWon ? 'Youwintheleaderboard' : 'Youlosetheleaderboard', 0.9);
  $('gameover-trophy').textContent = iWon ? '🏆' : '💀';
  $('gameover-text').textContent = iWon ? 'Hai vinto!' : winner ? `Ha vinto ${winner.username}!` : 'Partita terminata!';
  $('gameover-sub').textContent = iWon ? 'Memoria di ferro — avversari distrutti.' : 'Meglio la prossima. Forse.';
  $('gameover-scores').innerHTML=[...(scores||[])].sort((a,b)=>a.score-b.score).map(s=>`<div class="score-row${s.userId===winner?.userId?' winner':''}"><span class="score-name">${esc(s.username)}</span><span class="score-val" data-score="${s.score}">0</span></div>`).join('');
  animateScoreCounts($('gameover-scores'));
  addLog(`🏆 Vincitore: ${winner?.username||'—'}`,'gold');
}

$('btn-next-round').addEventListener('click',()=>{socket.emit('game:next-round');hide($('panel-scoring'));});
$('btn-back-lobby').addEventListener('click',()=>{
  socket.emit('lobby:leave');S.currentRoomId=null;S.gameState=null;S.privateState=null;S.drawnCard=null;
  hide($('panel-gameover'));showScreen('lobby');socket.emit('lobby:get-list');
});

socket.on('game:message',({text})=>{toast(text);addLog(text,'info');});
socket.on('game:error',({message})=>{
  resetMotionState();
  renderMyHand();renderActions();renderTurnBanner();
  toast(message,'error');
});

// ── Sound effects ─────────────────────────────────────────────────────────
const SFX = {
  _muted: localStorage.getItem('buio_muted') === '1',
  _last: Object.create(null),
  _loops: Object.create(null),
  get muted(){ return this._muted; },

  play(name, vol=0.7, options={}){
    if(this._muted) return null;
    const now=performance.now();
    const cooldown=options.cooldown??160;
    if(now-(this._last[name]||0)<cooldown) return null;
    this._last[name]=now;
    try{
      const a = new Audio(`/SFX/${name}.mp3`);
      a.volume = Math.min(1, Math.max(0, vol));
      a.play().catch(()=>{});
      return a;
    } catch(e){ return null; }
  },

  loop(name, vol=0.7){
    this.stop(name,0);
    if(this._muted) return null;
    try{
      const a=new Audio(`/SFX/${name}.mp3`);
      a.loop=true;
      a.volume=Math.min(1,Math.max(0,vol));
      this._loops[name]=a;
      a.play().catch(()=>{});
      return a;
    }catch(e){ return null; }
  },

  stop(name, fadeMs=250){
    const a=this._loops[name];
    if(!a) return;
    delete this._loops[name];
    if(!fadeMs){
      a.pause();
      a.currentTime=0;
      return;
    }
    const start=a.volume;
    const started=performance.now();
    const fade=now=>{
      const t=Math.min(1,(now-started)/fadeMs);
      a.volume=Math.max(0,start*(1-t));
      if(t<1) requestAnimationFrame(fade);
      else { a.pause();a.currentTime=0; }
    };
    requestAnimationFrame(fade);
  },

  toggle(){
    this._muted = !this._muted;
    if(this._muted) Object.keys(this._loops).forEach(name=>this.stop(name,0));
    localStorage.setItem('buio_muted', this._muted ? '1' : '0');
    const btn = $('mute-btn');
    if(btn) btn.textContent = this._muted ? '🔇' : '🔊';
    return this._muted;
  }
};

// ── Opponent animation helpers ────────────────────────────────────────────

function getOpponentMotion(userId) {
  return S._oppMotions?.[String(userId)] || null;
}

function setOpponentMotion(userId, motion) {
  S._oppMotions=S._oppMotions||{};
  clearTimeout(S._oppMotions[String(userId)]?.timeout);
  S._oppMotions[String(userId)]=motion;
}

function reconcileOpponentMotions(state) {
  if(!S._oppMotions||!state?.players) return;
  Object.entries(S._oppMotions).forEach(([userId,motion])=>{
    const player=state.players.find(p=>String(p.userId)===String(userId));
    if(!player) return;
    motion.reconciled=true;
    motion.targetIndex=Math.max(0,player.cardCount-1);
  });
}

function finishOpponentMotion(userId) {
  if(S._oppDrawn) delete S._oppDrawn[userId];
  if(S._oppMotions){
    clearTimeout(S._oppMotions[String(userId)]?.timeout);
    delete S._oppMotions[String(userId)];
    if(!Object.keys(S._oppMotions).length) S._oppMotions=null;
  }
  renderSeats();
}

function animOppDraw(userId) {
  const deckRect = Cards.rect(document.getElementById('deck-pile'));
  if (!deckRect){ S._drawingSet?.delete(userId); return; }
  SFX.play('Card', 0.35);
  // Wait one frame so renderSeats has injected the .mini-incoming slot
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const seat = document.querySelector('.seat[data-user-id="'+userId+'"]');
    if (!seat){ S._drawingSet?.delete(userId); return; }
    const tgt  = seat.querySelector('.mini-card.mini-incoming') || seat.querySelector('.seat-cards') || seat;
    const seatR = tgt.getBoundingClientRect();
    Cards.oppDraw(deckRect, seatR, ()=>{
      S._drawingSet?.delete(userId);
      const s  = document.querySelector('.seat[data-user-id="'+userId+'"]');
      const mc = s?.querySelector('.mini-card.mini-incoming');
      if (mc){ mc.classList.remove('mini-incoming'); mc.classList.add('card-new-pop'); }
    });
  }));
}

function animOppDrawn(userId) {
  const deckRect = Cards.rect(document.getElementById('deck-pile'));
  if (!deckRect) return;
  SFX.play('Card', 0.32);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const seat = document.querySelector('.seat[data-user-id="'+userId+'"]');
    const tgt = seat?.querySelector('.opp-drawn-card') || seat?.querySelector('.seat-cards') || seat;
    const targetRect = Cards.rect(tgt);
    Cards.oppDraw(deckRect, targetRect, ()=>{
      S._oppDrawn=S._oppDrawn||{};
      S._oppDrawn[userId]=true;
      renderSeats();
    });
  }));
}

function finishOppDrawn(userId) {
  if(S._oppDrawn) delete S._oppDrawn[userId];
  renderSeats();
}

function opponentHandSource(seat, handIndex) {
  const cards=[...seat.querySelectorAll('.mini-card:not(.mini-incoming):not(.opp-drawn-card)')];
  if(!cards.length) return {element:null,index:-1,rect:Cards.rect(seat.querySelector('.seat-cards'))||Cards.rect(seat)};
  const idx=Number.isInteger(handIndex)&&handIndex>=0?Math.min(handIndex,cards.length-1):cards.length-1;
  return {element:cards[idx],index:idx,rect:Cards.rect(cards[idx])};
}

function animOppDiscard(userId, card, handIndex=-1, forced=false) {
  const seat = document.querySelector('.seat[data-user-id="'+userId+'"]');
  const pile = document.getElementById('discard-pile');
  if (!seat || !pile) return;
  SFX.play('Card', 0.4);
  S._skipDiscard = true;
  clearTimeout(S._skipDiscardFallback);
  S._skipDiscardFallback=setTimeout(()=>settleDiscardPile(card),2400);
  const pileRect = pile.getBoundingClientRect();
  const drawnEl=seat.querySelector('.opp-drawn-card');
  const drawnRect=Cards.rect(drawnEl);
  const source=opponentHandSource(seat,handIndex);
  const handTarget=Cards.seatCardsRect(seat);
  const kind=handIndex===-1&&drawnEl?'discard-drawn':forced?'forced':drawnEl?'keep':'hand-only';
  const motion={
    kind,
    sourceIndex:source.index,
    targetIndex:Math.max(0,seat.querySelectorAll('.mini-card:not(.opp-drawn-card)').length-1),
    hideDrawn:!!drawnEl,
    reconciled:false,
  };
  setOpponentMotion(userId,motion);
  motion.timeout=setTimeout(()=>{
    settleDiscardPile(card);
    finishOpponentMotion(userId);
  },2800);
  source.element?.classList.add('motion-hidden');
  drawnEl?.classList.add('motion-hidden');

  if(handIndex===-1 && drawnEl){
    Cards.oppDiscard(drawnRect, pileRect, ()=>{
      settleDiscardPile(card);
      finishOpponentMotion(userId);
    }, {...card,known:true}, 'auto');
    return;
  }

  let flights=1+(drawnEl||forced?1:0);
  const landed=()=>{
    flights--;
    if(flights===0) finishOpponentMotion(userId);
  };
  Cards.oppDiscard(source.rect, pileRect, ()=>{
    settleDiscardPile(card);
    landed();
  }, null, 'down');

  if(drawnEl){
    Cards.oppKeepDrawn(drawnRect, handTarget, landed);
  } else if(forced){
    const deckRect=Cards.rect(document.getElementById('deck-pile'));
    Cards.oppDraw(deckRect, handTarget, landed);
  }
}

// ── Track opponent card counts to detect draws ────────────────────────────
const _prevCounts = {};

function checkOppCardChanges(newState) {
  if (!newState?.players) return;
  newState.players.forEach(p => {
    if (String(p.userId) === String(S.userId)) { _prevCounts[p.userId]=p.cardCount; return; }
    const prev = _prevCounts[p.userId];
    if (prev !== undefined && p.cardCount > prev) {
      S._drawingSet=S._drawingSet||new Set(); S._drawingSet.add(p.userId);
      animOppDraw(p.userId);
    }
    _prevCounts[p.userId] = p.cardCount;
  });
}

// ── Hand overflow indicator ───────────────────────────────────────────────
function updateHandOverflow() {
  const hand=$('my-hand'), arrow=$('hand-arrow'), track=$('hand-scroll-track'), thumb=$('hand-scroll-thumb');
  if(!hand||!arrow) return;
  const hasOv = hand.scrollWidth > hand.clientWidth+2;
  if(hasOv) arrow.classList.remove('hidden'); else arrow.classList.add('hidden');
  if(track&&thumb){
    if(hasOv){ show(track); const r=hand.clientWidth/hand.scrollWidth; const s=hand.scrollLeft/(hand.scrollWidth-hand.clientWidth||1); thumb.style.width=(r*100)+'%'; thumb.style.marginLeft=(s*(1-r)*100)+'%'; }
    else hide(track);
  }
}
// Wire scroll listener once (after DOM ready)
setTimeout(()=>{ $('my-hand')?.addEventListener('scroll',updateHandOverflow); },1000);

// ── Chat ─────────────────────────────────────────────────────────────────
let _chatOpen = false;
function chatToggle(force) {
  _chatOpen = force !== undefined ? force : !_chatOpen;
  _chatOpen ? show($('chat-bar')) : hide($('chat-bar'));
  if (_chatOpen) $('chat-input')?.focus();
}
$('chat-toggle').addEventListener('click', () => chatToggle());
$('chat-send').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => { if(e.key==='Enter') sendChat(); if(e.key==='Escape') chatToggle(false); });
document.addEventListener('keydown', e => {
  if (e.key==='c' && !e.ctrlKey && !e.altKey && !e.shiftKey && document.activeElement.tagName!=='INPUT') chatToggle();
});
function sendChat() {
  const inp = $('chat-input');
  const txt = inp?.value.trim();
  if (!txt) return;
  socket.emit('game:chat', { text: txt });
  inp.value = '';
}
socket.on('game:chat-msg', ({username, text}) => {
  addLog(`💬 ${esc(username)}: ${esc(text)}`, 'chat');
  if (username !== S.username) toast(`💬 ${esc(username)}: ${esc(text)}`, '', 4000);
});
socket.on('game:bot-reaction', ({username, key}) => {
  const text=t(key);
  addLog(`BOT ${username}: ${text}`, 'chat');
  toast(`${username}: ${text}`, '', 4000);
});

function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ── Debug panel ───────────────────────────────────────────────────────────
let _dbOpen = false, _dbAutoRefresh = null;

function dbToggle() {
  _dbOpen = !_dbOpen;
  const panel = $('debug-panel');
  if (_dbOpen) { show(panel); dbRefresh(); _dbAutoRefresh = setInterval(dbRefresh, 2500); }
  else { hide(panel); clearInterval(_dbAutoRefresh); }
}
window.dbToggle = dbToggle;

async function dbRefresh() {
  if (!S.currentRoomId) { $('dp-body').innerHTML = '<div class="dp-info">Nessuna partita attiva</div>'; return; }
  try {
    const r  = await fetch(`/api/debug/room/${S.currentRoomId}`);
    const d  = await r.json();
    $('dp-title').textContent = `🐛 ${d.phase} | R${d.round} | ${d.status}`;
    const body = $('dp-body');

    const disc = d.discardTop ? `${d.discardTop.label}/${d.discardTop.suit?.slice(0,3)} (${d.discardTop.value}pt)` : '—';
    let html = `<div class="dp-info">Mazzo: ${d.deckCount} | Scarti: ${disc}</div>`;

    d.players.forEach(p => {
      const isCur = d.currentPlayer === p.username;
      const cls   = `dp-player${isCur?' dp-cur':''}${p.isEliminated?' dp-elim':''}`;
      const icon  = p.isBot ? '🤖' : p.userId === S.userId ? '⭐' : '👤';
      const handHtml = p.hand.map(c =>
        `<span class="dp-card${c.known?' dp-known':''}" title="Pos ${c.pos}${c.known?' (visto)':' (coperta)'}">${c.label}/${c.suit?.slice(0,3)}</span>`
      ).join('');
      html += `<div class="${cls}">
        <div class="dp-pname">${isCur?'▶ ':''}${icon} ${p.username} ❤${p.lives}${p.penalized?' ⚠':''}</div>
        <div class="dp-hand">${handHtml}</div>
        <div class="dp-meta">Score: ${p.score}pt | Viste: [${p.seenCards}]${p.isEliminated?' ☠':''}</div>
      </div>`;
    });

    body.innerHTML = html;
  } catch(e) {
    $('dp-body').innerHTML = `<div class="dp-info" style="color:var(--danger)">${e.message}</div>`;
  }
}
window.dbRefresh = dbRefresh;

$('debug-toggle').addEventListener('click', dbToggle);
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') { e.preventDefault(); dbToggle(); }
  if (!e.ctrlKey && !e.altKey && e.key === 'm') SFX.toggle();
});

// ── Browser console test API ──────────────────────────────────────────────
window.buioTest = {
  // Play one turn (draw → discard drawn card)
  play(delay=1200) {
    const gs=S.gameState;
    if(!gs||gs.currentPlayerUserId!==S.userId){ console.log('[buioTest] Not your turn'); return; }
    if(gs.phase==='draw'){
      socket.emit('game:draw');
      setTimeout(()=>{ if(S.gameState?.phase==='discard') socket.emit('game:discard',{handIndex:-1}); },delay);
    } else if(gs.phase==='discard'){
      socket.emit('game:discard',{handIndex:-1});
    } else if(gs.phase==='forced-discard'){
      socket.emit('game:forced-discard',{handIndex:0});
    }
  },
  // Toggle auto-play (runs every `ms` milliseconds when it's your turn)
  autoPlay(ms=3500) {
    if(this._ap){ clearInterval(this._ap); this._ap=null; console.log('[buioTest] AutoPlay OFF'); return; }
    this._ap=setInterval(()=>{
      const gs=S.gameState;
      if(!gs||gs.status!=='playing'||gs.currentPlayerUserId!==S.userId) return;
      this.play(1200);
    },ms);
    console.log('[buioTest] AutoPlay ON — call buioTest.autoPlay() to stop');
  },
  // Dump current game state
  state(){ return {gs:S.gameState,priv:S.privateState,drawn:S.drawnCard,hand:S.privateState?.hand}; },
  // Show attack reveal UI test
  testReveal(success=true){
    const fc={suit:'bastoni',value:7,label:'7',symbol:'♣',color:'black',isSpecial:false};
    showAttackReveal(S.userId,S.username||'Tu',fc,success,success?null:{suit:'denari',value:1},{suit:'denari',value:7,label:'7',symbol:'♦',color:'red',isSpecial:false});
  },
  // Show swap UI test
  testSwap(){ showSwapAnimation('Mario','Luigi',4,4,0,3); },
  testPenalty(userId=S.userId){
    const player=S.gameState?.players.find(p=>String(p.userId)===String(userId));
    animateAttackPenaltyDraw({userId,targetCardCount:(player?.cardCount||4)+1});
  },
  testRoundEnd(){
    showRoundEndTransition(()=>renderScoring({
      scores:[
        {userId:S.userId,username:S.username||'Tu',score:17,hand:[]},
        {userId:'bot_test',username:'Aldo',score:9,hand:[]},
      ],
      losers:[S.userId],
      knockedBy:'bot_test',
    }));
  },
  // Test card raise (set specific card to raise level)
  raise(visualIdx,level=1){ if(!S.cardRaise)S.cardRaise=Array(4).fill(0); S.cardRaise[visualIdx]=level%4; renderMyHand(); },
};
console.log('%c🃏 buioTest ready: play(), autoPlay(), state(), testReveal(), testSwap(), testPenalty(), testRoundEnd()', 'color:#F0A030;font-weight:bold');

// ── Language switcher (IT ↔ EN) ───────────────────────────────────────────
const LEGACY_TRANSLATIONS = {
  en: {
    'brand-tagline':    'Your memory is your light, strategy your guide.',
    'login-username':   'Username',     // placeholder
    'login-password':   'Password',
    'reg-username':     'Choose username (min 3)',
    'reg-password':     'Password (min 6)',
    'btn-vs-bot':       '🤖 Play vs Bot — Quick Start',
    'btn-create-room':  'Create Room',
    'btn-refresh':      '↻ Refresh',
    'tab-login':        'Login',
    'tab-register':     'Register',
    'submit-login':     'Enter the Game',
    'submit-register':  'Create Account',
    'auth-signoff':     'Made with ❤️ by Carlo',
  }
};
let _lang = localStorage.getItem('buio_lang') || 'it';

function legacyToggleLang() {
  _lang = _lang === 'it' ? 'en' : 'it';
  localStorage.setItem('buio_lang', _lang);
  applyLang();
}
window.toggleLang = legacyToggleLang;

function legacyApplyLang() {
  const btn = $('lang-toggle');
  if (!btn) return;
  const en = _lang === 'en';
  btn.textContent = en ? '🌐 IT' : '🌐 EN';

  // brand tagline
  const tagline = document.querySelector('.brand-tagline');
  if (tagline) tagline.textContent = en ? LEGACY_TRANSLATIONS.en['brand-tagline'] : 'La tua memoria è la tua luce, la strategia la tua guida.';

  // form placeholders
  const lp = { 'login-username':en?'Username':'Username', 'login-password':en?'Password':'Password',
                'reg-username':en?'Choose username (min 3)':'Scegli username (min 3)', 'reg-password':en?'Password (min 6)':'Password (min 6)' };
  for (const [id,ph] of Object.entries(lp)) { const el=$(id); if(el) el.placeholder=ph; }

  // tabs
  document.querySelectorAll('.auth-tab').forEach(t => {
    if(t.dataset.tab==='login')    t.textContent = en?'Login':'Accedi';
    if(t.dataset.tab==='register') t.textContent = en?'Register':'Registrati';
  });

  // submit buttons
  const sl = document.querySelector('#form-login button[type=submit]');
  const sr = document.querySelector('#form-register button[type=submit]');
  if(sl) sl.textContent = en?'Enter the Game':'Entra nel Gioco';
  if(sr) sr.textContent = en?'Create Account':'Crea Account';

  // lobby button
  const vb=$('btn-vs-bot'); if(vb) vb.textContent=en?'🤖 Play vs Bot — Quick Start':'🤖 Gioca vs Bot — Partenza Rapida';

  // signoff
  const so=document.querySelector('.auth-signoff'); if(so) so.textContent='Made with ❤️ by Carlo';
}

const I18N = {
  it: {
    brand_tagline:'La tua memoria è la tua luce, la strategia la tua guida.',
    login:'Accedi', register:'Registrati', enter_game:'Entra nel Gioco', create_account:'Crea Account',
    logout:'Esci', create_game:'Crea Partita', room_name:'Nome Stanza', players:'Giocatori (2-8)',
    create_room:'Crea Stanza', play_bot:'Gioca vs Bot - Partenza Rapida',
    bot_difficulty:'Difficolta bot', easy:'Facile', medium:'Medio', hard:'Difficile',
    available_games:'Partite Disponibili', no_games:'Nessuna partita. Creane una!',
    how_to_play:'Come si gioca', start_game:'Inizia Partita', add_bot:'Aggiungi Bot',
    leave:'Lascia', skip:'Salta', next_round:'Prossimo Round', back_lobby:'Lobby',
    deck:'MAZZO', discards:'SCARTI', drawn:'Pescata', draw:'Pesca', knock:'Busso',
    attack:'Attacca!', discard:'Scarta', waiting_turn:'In attesa del prossimo turno',
    spectator:'Spettatore', your_turn:'Giochi te!', choose_card:'Scegli carta!',
    discard_first:'Scarta prima!', attack_running:'Attacco in corso...',
    choose_special:'Scegli l’azione per la carta speciale', swap:'Scambia',
    choose_swap:'Scegli la tua carta, poi quella di un avversario', your_card:'La tua carta',
    with_whom:'Con chi?', which_card:'Quale carta?', swap_title:'Scambio!',
    chat_placeholder:'Scrivi un messaggio...',
    knock_confirm:'Vuoi davvero bussare? Tutti gli altri faranno un ultimo turno.',
    bot_attack_hit_1:'Bella mossa. Questa ha fatto male.',
    bot_attack_hit_2:'Te la sei ricordata davvero. Rispetto.',
    bot_attack_hit_3:'Va bene, quella era forte.',
    bot_attack_miss_1:'Il buio ti ha tradito questa volta.',
    bot_attack_miss_2:'Coraggioso. Non corretto, ma coraggioso.',
  },
  en: {
    brand_tagline:'Your memory is your light, strategy your guide.',
    login:'Login', register:'Register', enter_game:'Enter the Game', create_account:'Create Account',
    logout:'Log out', create_game:'Create Game', room_name:'Room Name', players:'Players (2-8)',
    create_room:'Create Room', play_bot:'Play vs Bot - Quick Start',
    bot_difficulty:'Bot difficulty', easy:'Easy', medium:'Medium', hard:'Hard',
    available_games:'Available Games', no_games:'No games available. Create one!',
    how_to_play:'How to play', start_game:'Start Game', add_bot:'Add Bot',
    leave:'Leave', skip:'Skip', next_round:'Next Round', back_lobby:'Lobby',
    deck:'DECK', discards:'DISCARD', drawn:'Drawn', draw:'Draw', knock:'Knock',
    attack:'Attack!', discard:'Discard', waiting_turn:'Waiting for the next turn',
    spectator:'Spectating', your_turn:'Your turn!', choose_card:'Choose a card!',
    discard_first:'Discard first!', attack_running:'Attack in progress...',
    choose_special:'Choose the special-card action', swap:'Swap',
    choose_swap:'Choose your card, then an opponent card', your_card:'Your card',
    with_whom:'Swap with whom?', which_card:'Which card?', swap_title:'Swap!',
    chat_placeholder:'Write a message...',
    knock_confirm:'Knock now? Every other player will take one final turn.',
    bot_attack_hit_1:'Nice move. That one hurt.',
    bot_attack_hit_2:'You really remembered it. Respect.',
    bot_attack_hit_3:'All right, that was strong.',
    bot_attack_miss_1:'The dark betrayed you this time.',
    bot_attack_miss_2:'Bold. Not correct, but bold.',
  },
};

function t(key) {
  return I18N[_lang]?.[key] || I18N.it[key] || key;
}

function setLanguageToggle() {
  _lang = _lang === 'it' ? 'en' : 'it';
  localStorage.setItem('buio_lang', _lang);
  applyLang();
  if(S.token){
    S._languageSave=fetch('/api/preferences/language',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${S.token}`},
      body:JSON.stringify({language:_lang}),
    }).then(response=>{
      if(!response.ok) throw new Error(`Language save failed (${response.status})`);
      return response.json();
    }).catch(error=>({error:error.message}));
  }
}
window.toggleLang=setLanguageToggle;

function applyLang() {
  const en=_lang==='en';
  document.documentElement.lang=_lang;
  document.title=en?'BUIO - Card Game':'BUIO - Gioco di Carte';
  if($('lang-toggle'))$('lang-toggle').textContent=en?'IT':'EN';
  if($('lobby-lang-toggle'))$('lobby-lang-toggle').textContent=en?'IT':'EN';
  const tagline=document.querySelector('.brand-tagline');
  if(tagline)tagline.textContent=t('brand_tagline');
  $('reg-username').placeholder=en?'Choose username (min 3)':'Scegli username (min 3)';
  document.querySelectorAll('.auth-tab').forEach(tab=>{
    tab.textContent=t(tab.dataset.tab==='login'?'login':'register');
  });
  document.querySelector('#form-login button[type=submit]').textContent=t('enter_game');
  document.querySelector('#form-register button[type=submit]').textContent=t('create_account');
  const textById={
    'btn-logout':'logout','btn-create-room':'create_room','btn-vs-bot':'play_bot',
    'difficulty-label':'bot_difficulty','btn-start-game':'start_game','btn-add-bot':'add_bot',
    'btn-leave-room':'leave','btn-special-skip':'skip','btn-next-round':'next_round',
    'btn-back-lobby':'back_lobby','btn-draw':'draw','btn-knock':'knock',
    'btn-attack':'attack','btn-discard-drawn':'discard',
  };
  Object.entries(textById).forEach(([id,key])=>{if($(id))$(id).textContent=t(key);});
  ['easy','medium','hard'].forEach(level=>{
    const label=document.querySelector(`label[for="bot-${level}"]`);
    if(label)label.textContent=t(level);
  });
  const heads=document.querySelectorAll('.lobby-create-panel h2,.lobby-list-panel h2');
  if(heads[0])heads[0].textContent=t('create_game');
  if(heads[1])heads[1].textContent=t('available_games');
  const fields=document.querySelectorAll('.lobby-create-panel .field label');
  if(fields[0])fields[0].textContent=t('room_name');
  if(fields[1])fields[1].textContent=t('players');
  const rulesTitle=document.querySelector('.rules-box h3');
  if(rulesTitle)rulesTitle.textContent=t('how_to_play');
  const rules=document.querySelector('.rules-box ul');
  if(rules) rules.innerHTML=en
    ? `<li>4 face-down cards - peek at the <b>first 2</b> at the start</li>
       <li>Draw, then discard - keep your score low (Ace=1 through King=10)</li>
       <li><b>Attack</b> whenever you remember a card matching the discard</li>
       <li><b>Knock</b> when you believe your score is low enough</li>
       <li>The highest score loses a life - you have 3 lives</li>
       <li><b>Special cards when discarded:</b></li>
       <li>Eight: swap one of your cards with an opponent card</li>
       <li>Nine: peek at one of your face-down cards</li>
       <li>Ten: the next player discards before drawing</li>`
    : `<li>4 carte coperte - sbircia le <b>prime 2</b> all'inizio</li>
       <li>Pesca dal mazzo, poi scarta - tieni basso il punteggio (A=1 fino a Re=10)</li>
       <li><b>Attacca</b> quando ricordi una carta uguale allo scarto</li>
       <li><b>Busso</b> quando credi di avere pochi punti</li>
       <li>Chi ha più punti perde una vita - hai 3 vite</li>
       <li><b>Carte speciali quando vengono scartate:</b></li>
       <li>Otto: scambia una tua carta con quella di un avversario</li>
       <li>Nove: sbircia una tua carta coperta</li>
       <li>Dieci: il prossimo giocatore scarta prima di pescare</li>`;
  const piles=document.querySelectorAll('.pile-lbl');
  if(piles[0])piles[0].textContent=t('deck');
  if(piles[1])piles[1].textContent=t('discards');
  const drawnLabel=document.querySelector('.drawn-lbl');
  if(drawnLabel)drawnLabel.textContent=t('drawn');
  if($('chat-input'))$('chat-input').placeholder=t('chat_placeholder');
  const peekTitle=document.querySelector('#panel-peek h2');
  if(peekTitle)peekTitle.textContent=en?'Memorise your cards!':'Memorizza le tue carte!';
  const peekHint=document.querySelector('#panel-peek .hint-text');
  if(peekHint)peekHint.innerHTML=en
    ? `You have <strong id="peek-timer-val">10</strong>s - then they turn face-down for good!`
    : `Hai <strong id="peek-timer-val">10</strong>s - poi tornano coperte per sempre!`;
  const scoringTitle=document.querySelector('#panel-scoring h2');
  if(scoringTitle)scoringTitle.innerHTML=`${en?'Round complete':'Fine Round'} <span id="scoring-round"></span>`;
  if(S.gameState){renderBoard();renderTurnBanner();}
}
$('lobby-lang-toggle').addEventListener('click',setLanguageToggle);

(function(){
  S._selIdx=-1;
  preloadCardImages();
  hydrateAppVersion();
  applyLang(); // apply saved language on load
  // Set mute button icon from saved preference
  const btn=$('mute-btn');
  if(btn) btn.textContent = SFX.muted ? '🔇' : '🔊';
  if(tryRestore()) connectSocket();
  else showScreen('auth');
})();
