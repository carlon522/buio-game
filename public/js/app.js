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
  _skipDiscard:false,       // true while a card is flying TO the discard pile
  _pendingDiscardCard:null, // card to show in pile once animation completes
  gameLog:[], _selIdx:-1,
  _atkCdInt:null,
};

const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);
const show = el => { if(el) el.classList.remove('hidden'); };
const hide = el => { if(el) el.classList.add('hidden'); };
let _dragIdx = null; // index being dragged

function showScreen(n) {
  document.querySelectorAll('.screen').forEach(s=>{ s.classList.remove('active'); s.classList.add('hidden'); });
  const sc=$('screen-'+n); if(sc){ sc.classList.remove('hidden'); sc.classList.add('active'); }
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
      onerror="this.style.display='none';makeFB(this.parentElement,'${card.label}','${card.symbol}','${fb}')">
  </div>`;
}
function makeFB(el,label,sym,color) {
  if(el.querySelector('.card-fb'))return;
  const d=document.createElement('div'); d.className=`card-fb ${color}`;
  d.innerHTML=`<span>${label}</span><span>${sym}</span>`; el.style.background='#fff'; el.appendChild(d);
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
  if(!c){el.innerHTML='<div class="discard-empty">—</div>';return;}
  const fb=c.color==='red'?'red':'black';
  el.innerHTML=`<img src="/cards/${c.suit}_${c.value}.jpg" alt="${c.label}"
    onerror="this.style.display='none';makeFB(this.parentElement,'${c.label}','${c.symbol}','${fb}')">`;
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
function saveSession(tk,un,id){S.token=tk;S.username=un;S.userId=id;localStorage.setItem('buio_token',tk);localStorage.setItem('buio_username',un);localStorage.setItem('buio_userId',id);}
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
  saveSession(d.token,d.username,d.userId);connectSocket();
});
$('form-register').addEventListener('submit',async e=>{
  e.preventDefault();$('reg-error').textContent='';
  const d=await apiPost('/api/register',{username:$('reg-username').value.trim(),password:$('reg-password').value});
  if(d.error){$('reg-error').textContent=d.error;return;}
  saveSession(d.token,d.username,d.userId);connectSocket();
});
$('btn-logout').addEventListener('click',()=>{clearSession();socket.disconnect();showScreen('auth');});

// ── Socket ────────────────────────────────────────────────────────────────
function connectSocket(){socket.connect();}
socket.on('connect',()=>{if(S.token)socket.emit('authenticate',S.token);});
socket.on('authenticated',({username})=>{S.username=username;$('lobby-username').textContent=username;showScreen('lobby');});
socket.on('auth:error',({message})=>{clearSession();showScreen('auth');toast(message,'error');});
socket.on('disconnect',()=>{if(S.currentRoomId)toast('Connessione persa…','error');});

// ── Lobby ─────────────────────────────────────────────────────────────────
$('btn-refresh').addEventListener('click',()=>socket.emit('lobby:get-list'));
$('btn-create-room').addEventListener('click',()=>{socket.emit('lobby:create',{name:$('room-name').value.trim()||undefined,maxPlayers:parseInt($('room-max-players').value)});});
$('btn-vs-bot').addEventListener('click',()=>socket.emit('lobby:vs-bot',{name:$('room-name').value.trim()||undefined}));
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
    const hasBots=gs.players.some(p=>p.userId?.startsWith('bot_'));
    const hasSpace=gs.players.length<gs.maxPlayers;
    if(!hasBots&&hasSpace) show($('btn-add-bot'));
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
  S.gameState=state;
  if(state.status==='waiting'){showWaiting(state);return;}
  hide($('panel-waiting'));

  // Trigger deal animation when a new peek phase starts
  if(state.phase==='peek' && _dealBusy){
    renderBoard(); renderTurnBanner();
    // DO NOT clear _pendingPeek here — game:peek may have already buffered it
    runDealAnimation(()=>{
      _dealBusy=false;
      if(_pendingPeek){ const d=_pendingPeek; _pendingPeek=null; showPeekOverlay(d); }
    });
    return;
  }

  renderBoard();renderTurnBanner();
});
socket.on('game:private',priv=>{
  S.privateState=priv;
  renderMyHand();renderScore();renderActions();
  priv?.penalized?show($('penalized-pill')):hide($('penalized-pill'));
});
socket.on('game:turn-start',({userId,username})=>{
  renderTurnBanner();
  if(userId===S.userId){
    toast('⭐ È il tuo turno!','success');
    SFX.play('Card',0.3); // subtle reminder it's your turn
  }
  addLog(`Turno di ${username}`,'info');
});
socket.on('game:starting',()=>{
  _dealBusy=true; _pendingPeek=null; // arm deal animation for the upcoming peek
  hide($('panel-waiting'));hide($('panel-scoring'));hide($('panel-gameover'));
  S.drawnCard=null;S.privateState=null;S._attackMode=false;S.handOrder=null;S.cardRaise=null;S._animSlot=null;S._skipDiscard=false;S._pendingDiscardCard=null;
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

function runDealAnimation(cb) {
  const gs = S.gameState;
  if (!gs) { cb?.(); return; }
  const deck = $('deck-pile');
  if (!deck) { cb?.(); return; }
  const dr = deck.getBoundingClientRect();
  const st = getComputedStyle(document.documentElement);
  const cw = parseInt(st.getPropertyValue('--cw'))||66;
  const ch = parseInt(st.getPropertyValue('--ch'))||100;

  const players = gs.players;
  const totalCards = players.length * 4;
  let count = 0;

  // Deal in round-robin: card 0 to each player, then card 1, etc.
  for (let round = 0; round < 4; round++) {
    players.forEach(p => {
      const delay = count * 130;
      count++;
      setTimeout(() => {
        // Target: last seat element for opponents, hand area for self
        let tx, ty, tw, th;
        if (p.userId === S.userId) {
          const hand = $('my-hand');
          if (!hand) return;
          const hr = hand.getBoundingClientRect();
          tx = hr.left + round * (cw + 6); ty = hr.top; tw = cw; th = ch;
        } else {
          const seat = document.querySelector(`.seat[data-user-id="${p.userId}"]`);
          if (!seat) return;
          const sr = seat.getBoundingClientRect();
          tx = sr.left + sr.width/2 - 15; ty = sr.top; tw = 30; th = 46;
        }
        const f = document.createElement('div');
        f.className = 'card-3d card-back';
        f.style.cssText = `position:fixed;left:${dr.left+dr.width/2-cw/2}px;top:${dr.top+dr.height/2-ch/2}px;width:${cw}px;height:${ch}px;z-index:8000;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.6);transition:none`;
        document.body.appendChild(f);
        SFX.play('Card', 0.18);
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
          f.style.transition='all .38s cubic-bezier(.25,.46,.45,.94)';
          f.style.left=tx+'px'; f.style.top=ty+'px';
          f.style.width=tw+'px'; f.style.height=th+'px';
          f.style.opacity='0';
        }));
        setTimeout(()=>f.remove(), 480);
      }, delay);
    });
  }

  // Callback after all cards dealt
  setTimeout(()=>cb?.(), totalCards * 130 + 200);
}

// ── Peek ──────────────────────────────────────────────────────────────────
function showPeekOverlay({cards,duration}){
  S.peekCards=cards; show($('panel-peek'));
  $('btn-ready').disabled=false;$('btn-ready').textContent='✓ Ho memorizzato';
  $('peek-cards').innerHTML=cards.map(c=>cardHTML({...c,known:true},{cls:'anim-appear'})).join('');
  const prog=$('peek-progress');
  prog.style.transition='none';prog.style.width='100%';
  requestAnimationFrame(()=>requestAnimationFrame(()=>{prog.style.transition=`width ${duration}ms linear`;prog.style.width='0%';}));
  let secs=Math.ceil(duration/1000);$('peek-timer-val').textContent=secs;
  clearInterval(S.peekCountdown);
  S.peekCountdown=setInterval(()=>{secs--;$('peek-timer-val').textContent=Math.max(0,secs);if(secs<=0)clearInterval(S.peekCountdown);},1000);
}

socket.on('game:peek',data=>{
  if(_dealBusy){ _pendingPeek=data; return; }
  showPeekOverlay(data);
});

socket.on('game:peek-ended',()=>{
  clearInterval(S.peekCountdown);
  hide($('panel-peek'));
  S.handOrder=null;
  renderBoard();renderTurnBanner();

  // Simple stagger: cards deal from slightly above into position — no flying overlay
  const handCards=Array.from($('my-hand')?.querySelectorAll('.card-3d')||[]);
  handCards.forEach((el,i)=>{
    el.style.opacity='0';
    el.style.transform='translateY(-16px) scale(.88)';
    setTimeout(()=>{
      el.style.transition='opacity .35s ease-out,transform .35s ease-out';
      el.style.opacity='';
      el.style.transform='';
      setTimeout(()=>{el.style.transition='';el.style.transform='';},380);
    },i*90);
  });

  SFX.play('Cardshuffle',0.5);
  addLog('Carte coperte — il gioco inizia!','gold');
  // Remove old dead code below — it was causing the "cards already there" retarded animation
  if(false){
    const handCards2=[];
    handCards2.forEach((fromRect,i)=>{
      const fly=document.createElement('div');
    });
  } // end dead code
});

$('btn-ready').addEventListener('click',()=>{
  socket.emit('game:ready');$('btn-ready').disabled=true;$('btn-ready').textContent='In attesa degli altri…';
});

// ── Board ─────────────────────────────────────────────────────────────────
function renderBoard() {
  const gs=S.gameState;if(!gs)return;
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
  $('info-round').textContent=gs.roundNumber||1;
  gs.lastRound?show($('last-round-pill')):hide($('last-round-pill'));
  hide($('tb-badge'));

  if(S._attackMode){
    $('turn-banner').className='turn-banner attack-time';$('tb-avatar').textContent='⚔';
    $('tb-title').textContent='Clicca la carta da usare!';
    $('tb-sub').textContent='Puoi attaccare più volte se hai più carte uguali';
    return;
  }
  if(phase==='scoring'){$('turn-banner').className='turn-banner neutral';$('tb-avatar').textContent='📊';$('tb-title').textContent='Fine Round — Punteggi';$('tb-sub').textContent='';return;}
  if(phase==='special'){
    $('turn-banner').className=isMe?'turn-banner my-turn':'turn-banner other-turn';
    $('tb-avatar').textContent='✨';
    $('tb-title').textContent=isMe?'Completa l\'azione speciale':`${cur?.username||'...'} sta completando carta speciale`;
    $('tb-sub').textContent='';return;
  }
  if(phase==='forced-discard'){
    $('turn-banner').className=isMe?'turn-banner attack-time':'turn-banner other-turn';
    $('tb-avatar').textContent='🔟';
    $('tb-title').textContent=isMe?'⚠ Devi scartare PRIMA di pescare!':
      `${cur?.username||'...'} deve scartare prima di pescare`;
    $('tb-sub').textContent=isMe?'Effetto del 10: scegli una carta da scartare dalla mano':'';return;
  }

  if(isMe){
    $('turn-banner').className='turn-banner my-turn';$('tb-avatar').textContent=(S.username?.[0]||'?').toUpperCase();
    if(phase==='draw'){$('tb-title').textContent=gs.lastRound?'⚡ Tuo Turno — Ultimo Giro!':'⭐ Il Tuo Turno!';$('tb-sub').textContent='Clicca il mazzo per pescare — oppure ✊ Busso';}
    else if(phase==='discard'){const d=S.drawnCard;$('tb-title').textContent='Cosa fare con la carta pescata?';$('tb-sub').textContent=d?.known?`${d.label}${d.symbol} (${d.value}pt) — tienitela o scartala`:'Tienitela o scartala';}
    if(gs.lastRound){show($('tb-badge'));$('tb-badge').textContent='⚡ ULTIMO GIRO';}
  } else {
    $('turn-banner').className='turn-banner other-turn';$('tb-avatar').textContent=(cur?.username?.[0]||'?').toUpperCase();
    $('tb-title').textContent=`Turno di ${cur?.username||'…'}`;
    $('tb-sub').textContent=phase==='draw'?'Sta per pescare…':phase==='discard'?'Sta scegliendo…':'';
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
    const minis=Array(Math.max(0,player.cardCount)).fill(0).map(()=>`<div class="mini-card"></div>`).join('');
    seat.innerHTML=`
      <div class="seat-cards">${minis}</div>
      <div class="seat-info">
        <div class="seat-name">${esc(player.username)}</div>
        <div class="seat-lives">${livesHTML(player.lives)}</div>
      </div>
      ${player.isCurrentPlayer&&!player.isEliminated?'<div class="seat-turn-badge">▶ Turno</div>':''}
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

  // Keep handOrder in sync with actual count
  if(!S.handOrder||S.handOrder.length!==count) {
    S.handOrder=Array.from({length:count},(_,i)=>i);
  }

  const handEl=$('my-hand');
  handEl.innerHTML=S.handOrder.map((serverIdx,visualIdx)=>{
    let cls='';
    if(inDiscard||inForcedDiscard) cls+=' clickable';
    if(S._attackMode) cls+=' atk-tgt';
    if(visualIdx===S._selIdx) cls+=' selected';
    const raise=S.cardRaise?.[visualIdx]||0;
    const raiseAttr=raise>0?` data-raise="${raise}"`:'';
    // Keep slot invisible while a card is animating into it
    const hiddenAttr=S._animSlot===visualIdx?' style="visibility:hidden"':'';
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
    $('drawn-card-display').innerHTML=cardHTML(S.drawnCard,{cls:'clickable anim-appear',index:-1});
    $('drawn-card-display').querySelector('.card-3d')?.addEventListener('click',()=>{ if(phase==='discard'&&isMe) discardDrawn(); });
  } else hide(slot);
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
  hide($('btn-draw'));hide($('btn-knock'));hide($('btn-attack'));hide($('btn-discard-drawn'));
  hint.textContent='';

  if(phase==='draw'&&isMe){ show($('btn-draw'));show($('btn-knock')); }
  if(phase==='discard'&&isMe&&S.drawnCard){ show($('btn-discard-drawn')); }
  if(phase==='forced-discard'&&isMe){
    hint.textContent='⚠ Effetto 10 — Scegli una carta da scartare PRIMA di pescare!';
  }
  if(phase==='special'&&isMe){
    hint.textContent='Scegli l\'azione per la carta speciale';
  }
  // ⚔ available any time during active phases when there's a discard top
  if(['draw','discard','forced-discard'].includes(phase) && gs?.discardTop && !S._attackMode){
    show($('btn-attack'));
  }
  if(S._attackMode){
    hint.textContent='⚔ Clicca una carta — puoi attaccare più volte!';
  }
}

// ── Hand click ────────────────────────────────────────────────────────────
function onHandClick(visualIdx) {
  const gs=S.gameState,isMe=gs?.currentPlayerUserId===S.userId,phase=gs?.phase;
  const serverIdx=S.handOrder?S.handOrder[visualIdx]:visualIdx;
  const cardEl=$('my-hand').querySelectorAll('.card-3d')[visualIdx];

  if(phase==='discard'&&isMe&&S.drawnCard){
    // Clicked card goes to discard pile
    flyAnim(cardEl,$('discard-pile'));
    SFX.play('Card');

    // Update visual order: remove clicked position, drawn card goes to the RIGHT END
    const lastVI = S.handOrder.length - 1;
    const newOrder = S.handOrder.filter((_,i)=>i!==visualIdx);
    newOrder.push(serverIdx); // drawn card's server-index at last visual slot
    S.handOrder = newOrder;
    if(S.cardRaise){ const r=S.cardRaise.filter((_,i)=>i!==visualIdx); r.push(0); S.cardRaise=r; }

    // Mark last slot as animating so every renderMyHand keeps it hidden
    S._animSlot = lastVI;
    renderMyHand(); // hand renders with last slot invisible

    // Create face-up ghost at drawn-slot position, animate it to the last slot
    const slotEl=$('drawn-slot');
    const lastEl=$('my-hand').querySelectorAll('.card-3d')[lastVI];
    if(slotEl&&lastEl&&S.drawnCard?.suit){
      const fr=slotEl.getBoundingClientRect();
      const tr=lastEl.getBoundingClientRect();
      // Use explicit CSS-var dimensions — not getBoundingClientRect (avoids size bugs)
      const st=getComputedStyle(document.documentElement);
      const cw=parseInt(st.getPropertyValue('--cw'))||66;
      const ch=parseInt(st.getPropertyValue('--ch'))||100;
      const fly=document.createElement('div');
      fly.className='card-3d card-front';
      fly.style.cssText=`position:fixed;left:${fr.left+fr.width/2-cw/2}px;top:${fr.top+fr.height/2-ch/2}px;width:${cw}px;height:${ch}px;z-index:9999;margin:0;border-radius:6px;overflow:hidden;box-shadow:2px 5px 14px rgba(0,0,0,.55)`;
      fly.innerHTML=`<img src="/cards/${S.drawnCard.suit}_${S.drawnCard.value}.jpg" class="card-img">`;
      document.body.appendChild(fly);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        fly.style.transition='left .5s ease-out,top .5s ease-out';
        fly.style.left=tr.left+'px'; fly.style.top=tr.top+'px';
      }));
      // Flip to face-down as it lands
      setTimeout(()=>{ fly.className='card-3d card-back'; fly.innerHTML=''; },370);
      setTimeout(()=>{ fly.remove(); S._animSlot=null; renderMyHand(); },640);
    } else {
      S._animSlot=null; renderMyHand();
    }

    socket.emit('game:discard',{handIndex:serverIdx});
    S.drawnCard=null; S._selIdx=-1; hide($('drawn-slot'));
    return;
  }

  if(phase==='forced-discard'&&isMe){
    flyAnim(cardEl,$('discard-pile'));
    socket.emit('game:forced-discard',{handIndex:serverIdx});
    return;
  }

  if(S._attackMode){
    if(cardEl){
      cardEl.style.pointerEvents='none';
      cardEl.style.transition='transform .25s ease-out,opacity .25s';
      cardEl.style.transform='translateY(-14px) scale(1.08)';
      setTimeout(()=>{
        cardEl.style.opacity='0'; // hide before fly so ghost is only visible element
        flyAnim(cardEl,$('discard-pile'));
      },220);
    }
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
  flyAnim($('drawn-card-display')?.querySelector('.card-3d'),$('discard-pile'));
  socket.emit('game:discard',{handIndex:-1});
  S.drawnCard=null;S._selIdx=-1;hide($('drawn-slot'));
}

// ── flyAnim: reparent the actual element to body, animate it to destination ──
function flyAnim(fromEl, toEl) {
  if(!fromEl||!toEl)return;
  const fr=fromEl.getBoundingClientRect(),tr=toEl.getBoundingClientRect();
  // Block discard-pile renders while this card is in flight
  const isToDiscard = toEl.id==='discard-pile';
  if(isToDiscard){ S._skipDiscard=true; }
  // Reparent to body at exact current position — the actual element flies, no copy
  fromEl.style.cssText=`position:fixed;left:${fr.left}px;top:${fr.top}px;width:${fr.width}px;height:${fr.height}px;z-index:9999;margin:0;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.7)`;
  document.body.appendChild(fromEl);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    fromEl.style.transition='all .6s cubic-bezier(.25,.46,.45,.94)';
    fromEl.style.left=`${tr.left+tr.width/2-fr.width/2}px`;
    fromEl.style.top =`${tr.top +tr.height/2-fr.height/2}px`;
    fromEl.style.transform='scale(.7) rotate(5deg)';
    fromEl.style.opacity='0';
  }));
  setTimeout(()=>{
    fromEl.remove();
    if(isToDiscard){
      S._skipDiscard=false;
      // Now show the card that arrived
      const c=S._pendingDiscardCard||S.gameState?.discardTop;
      S._pendingDiscardCard=null;
      if(c) renderDiscardPile(c);
    }
  },680);
}
// Lightweight deck-draw animation: a slim card arc from deck to drawn-slot
function animDeckDraw() {
  const dk=$('deck-pile'); if(!dk)return;
  const fr=dk.getBoundingClientRect();
  const slot=$('drawn-slot');
  const tr=slot?.getBoundingClientRect()||{left:fr.left,top:fr.bottom+8,width:fr.width,height:fr.height};
  // Use 65% size to be less obtrusive — it's just a visual cue, not the main actor
  const w=Math.round(fr.width*.65), h=Math.round(fr.height*.65);
  const f=document.createElement('div');
  f.className='card-3d card-back';
  f.style.cssText=`position:fixed;left:${fr.left+fr.width/2-w/2}px;top:${fr.top+fr.height/2-h/2}px;width:${w}px;height:${h}px;z-index:9990;pointer-events:none;opacity:.75`;
  document.body.appendChild(f);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    f.style.transition='all .38s cubic-bezier(.25,.46,.45,.94)';
    f.style.left=`${tr.left}px`; f.style.top=`${tr.top}px`;
    f.style.width=`${tr.width||w}px`; f.style.height=`${tr.height||h}px`;
    f.style.opacity='1';
  }));
  setTimeout(()=>{ f.style.transition='opacity .18s'; f.style.opacity='0'; setTimeout(()=>f.remove(),200); },400);
}

// ── Buttons ───────────────────────────────────────────────────────────────
$('btn-draw').addEventListener('click',()=>{socket.emit('game:draw');hide($('btn-draw'));hide($('btn-knock'));});
$('deck-pile').addEventListener('click',()=>{
  if(S.gameState?.phase==='draw'&&S.gameState.currentPlayerUserId===S.userId)
    socket.emit('game:draw'),hide($('btn-draw')),hide($('btn-knock'));
});
$('btn-knock').addEventListener('click',()=>{
  if(!confirm('Vuoi davvero bussare? Tutti gli altri faranno un ultimo turno.'))return;
  SFX.play('Knock',0.85);
  socket.emit('game:knock');addLog('Hai bussato!','gold');
});
$('btn-discard-drawn').addEventListener('click',discardDrawn);

// ⚔ button: no server emit, just enter attack mode locally
$('btn-attack').addEventListener('click',()=>{
  S._attackMode=true;
  SFX.play('Attacknotify', 0.7);
  hide($('btn-attack'));
  renderMyHand();renderActions();renderTurnBanner();
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
  requestAnimationFrame(()=>animDeckDraw());
});

// ── Special cards ─────────────────────────────────────────────────────────
socket.on('game:special-prompt',({type,card})=>{S.specialPrompt={type,card};showSpecial(type,card);});
function showSpecial(type,card){
  show($('panel-special'));
  $('special-card-preview').innerHTML=cardHTML({...card,known:true},{cls:'anim-appear'});

  if(type==='9'){
    $('special-title').textContent='🔍 Nove — Sbircia una Carta!';
    $('special-desc').textContent='Hai scartato il 9. Scegli quale delle tue carte sbirciare (3 secondi).';
    const count=S.gameState?.players.find(p=>p.userId===S.userId)?.cardCount??4;
    $('special-actions').innerHTML=`<div class="special-hand-row">${Array(count).fill(0).map((_,i)=>cardHTML({known:false,index:i},{index:i})).join('')}</div>`;
    $('special-actions').querySelectorAll('.card-3d').forEach(el=>{
      el.addEventListener('click',()=>{
        const vi=parseInt(el.dataset.index);
        const si=S.handOrder?S.handOrder[vi]:vi;
        socket.emit('game:use-special-9',{cardIndex:si});
        hide($('panel-special'));
      });
    });
  }

  if(type==='8'){
    $('special-title').textContent='🔄 Otto — Scambia una Carta!';
    $('special-desc').textContent="Hai scartato l'8. Scegli prima la TUA carta, poi quella dell'avversario.";
    const myCount=S.gameState?.players.find(p=>p.userId===S.userId)?.cardCount??4;
    const opp=(S.gameState?.players||[]).filter(p=>p.userId!==S.userId&&!p.isEliminated);
    let selMyVI=null;

    $('special-actions').innerHTML=`
      <p style="font-size:.8rem;font-weight:700;color:var(--gold-lt)">1️⃣ Quale TUA carta vuoi dare?</p>
      <div class="special-hand-row" id="s8-mine">${Array(myCount).fill(0).map((_,i)=>cardHTML({known:false,index:i},{index:i})).join('')}</div>
      <div id="s8-step2" style="display:none;margin-top:.75rem">
        <p style="font-size:.8rem;font-weight:700;color:var(--gold-lt)">2️⃣ Da chi?</p>
        <div class="special-opts" id="s8-opp"></div>
        <div id="s8-theirs"></div>
      </div>`;

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
              <p style="font-size:.8rem;font-weight:700;color:var(--gold-lt);margin-top:.75rem">3️⃣ Quale sua carta vuoi?</p>
              <div class="special-hand-row">${Array(cnt).fill(0).map((_,i)=>cardHTML({known:false,index:i},{index:i})).join('')}</div>`;
            $('s8-theirs').querySelectorAll('.card-3d').forEach(cb=>{
              cb.addEventListener('click',()=>{
                const myServerIdx=S.handOrder?S.handOrder[selMyVI]:selMyVI;
                socket.emit('game:use-special-8',{myCardIndex:myServerIdx,targetUserId:tid,targetCardIndex:parseInt(cb.dataset.index)});
                hide($('panel-special'));
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
socket.on('game:peeked',({cardIndex,card})=>{
  if(S.privateState?.hand?.[cardIndex]) S.privateState.hand[cardIndex]={...card,known:true,index:cardIndex};
  renderScore();
  // Show 3-second popup
  document.querySelector('.peek-reveal-popup')?.remove();
  const popup=document.createElement('div');
  popup.className='peek-reveal-popup';
  popup.innerHTML=`<div class="prp-label">👁 Posizione #${cardIndex+1} — Ricordala!</div><div class="prp-card">${cardHTML({...card,known:true})}</div><div class="prp-value">${card.label}${card.symbol} = ${card.value}pt</div><div class="prp-prog-wrap"><div class="prp-prog"></div></div>`;
  document.body.appendChild(popup);
  const prog=popup.querySelector('.prp-prog');
  prog.style.width='100%';
  requestAnimationFrame(()=>requestAnimationFrame(()=>{prog.style.transition='width 3s linear';prog.style.width='0%';}));
  setTimeout(()=>{popup.style.opacity='0';popup.style.transform='translate(-50%,-58%) scale(.88)';setTimeout(()=>popup.remove(),400);},3000);
  toast(`👁 Posizione #${cardIndex+1}: ${card.label}${card.symbol} (${card.value}pt)`,'success',3500);
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
socket.on('game:card-discarded',({card, discarderId})=>{
  // Store the card — renderDiscardPile will pick it up once animation finishes
  S._pendingDiscardCard = card;
  if (discarderId && discarderId !== S.userId) {
    animOppDiscard(discarderId); // sets _skipDiscard; renders pile in its callback
  } else {
    // Self-discard: flyAnim already set _skipDiscard; pile renders in its callback
    // Fallback: if somehow _skipDiscard is not set, render after short delay
    if(!S._skipDiscard) setTimeout(()=>renderDiscardPile(card), 50);
  }
  addLog(`${cardStr(card)} scartata`,'info');
  renderActions();
});

// ── Attack reveal ─────────────────────────────────────────────────────────
socket.on('game:attack-reveal',({attackerUserId,attackerUsername,card,discardCard,success,penaltyCard})=>{
  // Play sound exactly when the result text appears (3.2s into the overlay)
  setTimeout(()=>SFX.play(success?'Success':'Fail', 0.85), 3200);
  showAttackReveal(attackerUserId,attackerUsername,card,success,penaltyCard,discardCard);
  addLog(success?`✅ ${attackerUsername}: azzeccato! ${cardStr(card)}`:`❌ ${attackerUsername}: sbagliato! +1 carta`,success?'success':'danger');
  // After reveal, re-render hand (card removed on success, or extra card on fail)
  setTimeout(()=>{
    if(attackerUserId===S.userId) S._attackMode=false;
    S._selIdx=-1;  // clear any residual selection border
    renderMyHand();renderScore();renderSeats();renderActions();
  },2700);
});

// ── Attack reveal: discard card shown first, then attack card ─────────────
function showAttackReveal(auId, auName, card, success, penaltyCard, discardCard) {
  document.querySelector('.atk-reveal-overlay')?.remove();
  const isMe = auId === S.userId;

  const overlay = document.createElement('div');
  overlay.className = 'atk-reveal-overlay';
  overlay.innerHTML = `<div class="ar-box">
    <div class="ar-who">⚔ ${esc(auName)}${isMe?' (tu)':''} tenta un attacco!</div>

    <!-- Step 1: show discard card (immediately visible) -->
    <div class="ar-step" id="ar-step1">
      <div class="ar-vs-lbl">Carta da abbinare:</div>
      ${discardCard ? cardHTML({...discardCard,known:true}) : '<div class="ar-unknown">?</div>'}
    </div>

    <!-- Step 2: suspense then reveal attack card -->
    <div class="ar-step ar-hidden" id="ar-step2">
      <div class="ar-vs-lbl">Carta dell'attaccante:</div>
      <div class="ar-dots"><span></span><span></span><span></span></div>
      <div class="ar-attack-card ar-hidden" id="ar-atk-card">
        ${cardHTML({...card,known:true},{cls:'anim-appear'})}
      </div>
    </div>

    <!-- Result -->
    <div class="ar-result ar-hidden" id="ar-res">
      ${success
        ? '<div class="ar-success">✅ AZZECCATO!</div>'
        : `<div class="ar-fail">❌ SBAGLIATO!${penaltyCard?'<div class="ar-penalty">+1 carta in mano</div>':''}</div>`}
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
    overlay.querySelector('#ar-atk-card')?.classList.remove('ar-hidden');
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
function showSwapAnimation(initiatorName, targetName, iCount, tCount) {
  document.querySelector('.swap-overlay')?.remove();

  const makePile = (n) =>
    Array(Math.min(n, 5)).fill(0)
      .map(() => `<div class="swap-mini-back"></div>`)
      .join('');

  const overlay = document.createElement('div');
  overlay.className = 'swap-overlay';
  overlay.innerHTML = `<div class="swap-box">
    <div class="swap-title">🔄 Scambio!</div>
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
    const src = lCards[lCards.length - 1]; // last card on left
    const dst = rCards[rCards.length - 1]; // last card on right
    if (!src || !dst) return;

    const sr = src.getBoundingClientRect();
    const dr = dst.getBoundingClientRect();

    // Highlight source cards
    src.style.outline = '2px solid var(--gold)';
    dst.style.outline = '2px solid var(--gold)';

    // Ghost cards at exact positions, cross over
    const makeGhost = (r) => {
      const g = document.createElement('div');
      g.style.cssText = [
        `position:fixed`, `z-index:9998`, `pointer-events:none`,
        `left:${r.left}px`, `top:${r.top}px`,
        `width:${r.width}px`, `height:${r.height}px`,
        `background:linear-gradient(145deg,#1a0900,#3d2000)`,
        `border:1px solid rgba(196,133,59,.6)`,
        `border-radius:4px`,
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

socket.on('game:swap-reveal', ({initiatorUserId, initiatorUsername, targetUserId, targetUsername}) => {
  const gs = S.gameState;
  const iCount = gs?.players.find(p => p.userId === initiatorUserId)?.cardCount || 4;
  const tCount = gs?.players.find(p => p.userId === targetUserId)?.cardCount || 4;
  showSwapAnimation(initiatorUsername, targetUsername, iCount, tCount);
  addLog(`🔄 ${initiatorUsername} → ${targetUsername} scambio carte`, 'gold');
});

// attack-window-closed no longer used but kept as no-op for safety
socket.on('game:attack-window-closed',()=>{ S._attackMode=false; renderMyHand();renderActions();renderTurnBanner(); });

// ── Knock ─────────────────────────────────────────────────────────────────
socket.on('game:knocked',({username})=>{
  SFX.play('Knock', 0.85); // heard by ALL players
  addLog(`✊ ${username} ha bussato — ultimo giro!`,'gold');
  toast(`✊ ${username} ha bussato!`,'',5000);show($('last-round-pill'));
});

// ── Scoring ───────────────────────────────────────────────────────────────
socket.on('game:scoring',({scores,losers,knockedBy})=>{
  const gs=S.gameState;show($('panel-scoring'));
  $('scoring-round').textContent=gs?.roundNumber||'';
  const ki=$('scoring-knocked-info');
  if(knockedBy){const kn=gs?.players.find(p=>p.userId===knockedBy)?.username||'?';show(ki);ki.textContent=`✊ ${kn} ha bussato — paga doppio se ha più punti!`;}
  else hide(ki);
  $('scoring-list').innerHTML=[...scores].sort((a,b)=>a.score-b.score).map(s=>{
    const isL=losers.includes(s.userId),pl=gs?.players.find(p=>p.userId===s.userId);
    const hh=(s.hand||[]).map(c=>`<div style="width:30px;height:46px;border-radius:4px;overflow:hidden;box-shadow:1px 2px 5px rgba(0,0,0,.4);flex-shrink:0;background:#fff"><img src="/cards/${c.suit}_${c.value}.jpg" style="width:100%;height:100%;object-fit:contain;display:block" onerror="this.style.display='none'"></div>`).join('');
    return `<div class="score-row${isL?' loser':''}"><div class="score-meta"><div class="score-name">${esc(s.username)}${isL?' 💔':' ✅'}${knockedBy===s.userId?' ✊':''}</div><div class="score-lives">❤ ${pl?.lives??'?'} vite</div><div class="score-hand-row">${hh}</div></div><div class="score-val">${s.score}</div></div>`;
  }).join('');
  const isHost=gs?.hostUserId===S.userId;
  isHost?show($('btn-next-round')):hide($('btn-next-round'));
  $('scoring-hint').textContent=isHost?'':'In attesa che l\'host avvii il prossimo round…';
  addLog(`Fine round! Perdono vita: ${losers.map(id=>gs?.players.find(p=>p.userId===id)?.username||id).join(', ')}`,'danger');
});

socket.on('game:gameover',({scores,winner})=>{
  hide($('panel-scoring'));show($('panel-gameover'));
  $('gameover-text').textContent=winner?`🏆 ${winner.username} ha vinto!`:'🎲 Partita terminata!';
  $('gameover-scores').innerHTML=[...(scores||[])].sort((a,b)=>a.score-b.score).map(s=>`<div class="score-row${s.userId===winner?.userId?' winner':''}"><span class="score-name">${esc(s.username)}</span><span class="score-val">${s.score}</span></div>`).join('');
  addLog(`🏆 Vincitore: ${winner?.username||'—'}`,'gold');
});

$('btn-next-round').addEventListener('click',()=>{socket.emit('game:next-round');hide($('panel-scoring'));});
$('btn-back-lobby').addEventListener('click',()=>{
  socket.emit('lobby:leave');S.currentRoomId=null;S.gameState=null;S.privateState=null;S.drawnCard=null;
  hide($('panel-gameover'));showScreen('lobby');socket.emit('lobby:get-list');
});

socket.on('game:message',({text})=>{toast(text);addLog(text,'info');});
socket.on('game:error',({message})=>toast(message,'error'));

// ── Sound effects ─────────────────────────────────────────────────────────
const SFX = {
  _muted: localStorage.getItem('buio_muted') === '1',
  get muted(){ return this._muted; },

  play(name, vol=0.7){
    if(this._muted) return;
    try{
      const a = new Audio(`/SFX/${name}.mp3`);
      a.volume = Math.min(1, Math.max(0, vol));
      a.play().catch(()=>{});
    } catch(e){}
  },

  toggle(){
    this._muted = !this._muted;
    localStorage.setItem('buio_muted', this._muted ? '1' : '0');
    const btn = $('mute-btn');
    if(btn) btn.textContent = this._muted ? '🔇' : '🔊';
    return this._muted;
  }
};

// ── Opponent animation helpers ────────────────────────────────────────────

// Find an opponent's seat element by userId
function getSeatEl(userId) {
  return document.querySelector(`[data-user-id="${userId}"]`) ||
         document.querySelector(`.seat[data-user-id="${userId}"]`);
}

// Ghost card flying from A to B (face-down back)
// mini=true uses opponent mini-card size instead of full hand-card size
function ghostFly(fromRect, toRect, durationMs=600, mini=false, onDone) {
  if (!fromRect||!toRect) return;
  const st = getComputedStyle(document.documentElement);
  const cw = mini ? 34 : (parseInt(st.getPropertyValue('--cw'))||68);
  const ch = mini ? 52 : (parseInt(st.getPropertyValue('--ch'))||104);
  const g = document.createElement('div');
  g.className = 'card-3d card-back';
  g.style.cssText = [
    `position:fixed`,
    `left:${fromRect.left+fromRect.width/2-cw/2}px`,
    `top:${fromRect.top+fromRect.height/2-ch/2}px`,
    `width:${cw}px`, `height:${ch}px`,
    `z-index:9990`, `pointer-events:none`,
    `box-shadow:0 6px 20px rgba(0,0,0,.65)`,
    `transition:none`
  ].join(';');
  document.body.appendChild(g);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    g.style.transition=`all ${durationMs}ms cubic-bezier(.25,.46,.45,.94)`;
    g.style.left=`${toRect.left+toRect.width/2-cw/2}px`;
    g.style.top =`${toRect.top+toRect.height/2-ch/2}px`;
    g.style.transform='scale(.6) rotate(4deg)';
    g.style.opacity='0';
  }));
  setTimeout(()=>{ g.remove(); onDone?.(); }, durationMs+80);
}

// Opponent draws: deck → their seat (mini ghost)
function animOppDraw(userId) {
  const dk=$('deck-pile');
  const seat=document.querySelector(`.seat[data-user-id="${userId}"]`);
  if (!dk||!seat) return;
  SFX.play('Card', 0.35);
  ghostFly(dk.getBoundingClientRect(), seat.getBoundingClientRect(), 580, true);
}

// Opponent discards: seat → discard pile (mini ghost)
function animOppDiscard(userId) {
  const seat=document.querySelector(`.seat[data-user-id="${userId}"]`);
  const dp=$('discard-pile');
  if (!seat||!dp) return;
  SFX.play('Card', 0.4);
  S._skipDiscard=true; // block pile render until ghost arrives
  ghostFly(seat.getBoundingClientRect(), dp.getBoundingClientRect(), 560, true, ()=>{
    S._skipDiscard=false;
    const c=S._pendingDiscardCard||S.gameState?.discardTop;
    S._pendingDiscardCard=null;
    if(c) renderDiscardPile(c);
  });
}

// ── Track opponent card counts to detect draws ────────────────────────────
const _prevCounts = {};

function checkOppCardChanges(newState) {
  if (!newState?.players) return;
  newState.players.forEach(p => {
    if (p.userId === S.userId) { _prevCounts[p.userId]=p.cardCount; return; }
    const prev = _prevCounts[p.userId];
    if (prev !== undefined && p.cardCount > prev) {
      // Card count increased → they drew
      animOppDraw(p.userId);
    }
    _prevCounts[p.userId] = p.cardCount;
  });
}

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
  testSwap(){ showSwapAnimation('Mario','Luigi',4,4); },
  // Test card raise (set specific card to raise level)
  raise(visualIdx,level=1){ if(!S.cardRaise)S.cardRaise=Array(4).fill(0); S.cardRaise[visualIdx]=level%4; renderMyHand(); },
};
console.log('%c🃏 buioTest ready: play(), autoPlay(), state(), testReveal(), testSwap()', 'color:#F0A030;font-weight:bold');

// ── Language switcher (IT ↔ EN) ───────────────────────────────────────────
const TRANSLATIONS = {
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

function toggleLang() {
  _lang = _lang === 'it' ? 'en' : 'it';
  localStorage.setItem('buio_lang', _lang);
  applyLang();
}
window.toggleLang = toggleLang;

function applyLang() {
  const btn = $('lang-toggle');
  if (!btn) return;
  const en = _lang === 'en';
  btn.textContent = en ? '🌐 IT' : '🌐 EN';

  // brand tagline
  const tagline = document.querySelector('.brand-tagline');
  if (tagline) tagline.textContent = en ? TRANSLATIONS.en['brand-tagline'] : 'La tua memoria è la tua luce, la strategia la tua guida.';

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

(function(){
  S._selIdx=-1;
  applyLang(); // apply saved language on load
  // Set mute button icon from saved preference
  const btn=$('mute-btn');
  if(btn) btn.textContent = SFX.muted ? '🔇' : '🔊';
  if(tryRestore()) connectSocket();
  else showScreen('auth');
})();
