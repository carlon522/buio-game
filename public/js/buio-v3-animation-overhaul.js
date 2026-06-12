// Animation Overhaul v3: deterministic queues, transform-only ghosts, and stable opponent slots.
(function(){
  if(typeof Cards === 'undefined') return;

  const D=Cards.durations||{};
  Object.assign(D,{deal:760,draw:960,penalty:1040,keep:1080,discard:1080,forced:1120,opponent:1500,swap:1700});

  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  const lerp=(a,b,t)=>a+(b-a)*t;
  const smoother=t=>t*t*t*(t*(t*6-15)+10);
  const easeOut=t=>1-Math.pow(1-t,3);
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const rootSize=axis=>parseFloat(getComputedStyle(document.documentElement).getPropertyValue(axis==='w'?'--cw':'--ch'))||(axis==='w'?68:104);
  const rectOf=elOrRect=>{
    if(!elOrRect) return null;
    const r=typeof elOrRect.getBoundingClientRect==='function'?elOrRect.getBoundingClientRect():elOrRect;
    if(!r||!(r.width||r.height)) return null;
    return {left:r.left,top:r.top,width:r.width,height:r.height,right:r.right??r.left+r.width,bottom:r.bottom??r.top+r.height};
  };
  const miniSize=axis=>{
    const sample=document.querySelector('.seat .mini-card:not(.mini-incoming)')||document.querySelector('.mini-card');
    if(sample){
      const value=parseFloat(getComputedStyle(sample)[axis==='w'?'width':'height']);
      if(value) return value;
    }
    return window.matchMedia('(max-width:600px)').matches ? (axis==='w'?29:45) : (axis==='w'?34:52);
  };
  const faceUp=card=>!!(card&&card.known&&card.suit&&card.value);
  const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const ghostHTML=card=>{
    if(!faceUp(card)) return '';
    const color=card.color==='red'?'red':'black';
    return `<img src="/cards/${esc(card.suit)}_${esc(card.value)}.jpg" class="card-img" alt="${esc(card.label)}"
      onload="cardImageLoaded(this)"
      onerror="cardImageFailed(this,'${esc(card.label)}','${esc(card.symbol)}','${color}')">`;
  };

  const coordinator=S._animationOverhaul||(S._animationOverhaul={queue:Promise.resolve(),active:0});
  function enqueueVisual(task){
    const run=coordinator.queue.catch(()=>{}).then(async()=>{
      coordinator.active++;
      try{return await task();}
      finally{coordinator.active--;}
    });
    coordinator.queue=run.catch(error=>console.warn('[animation queue]',error));
    return run;
  }

  function targetTopLeft(from,to,opts={}){
    const w=opts.toW||to.width||from.width||rootSize('w');
    const h=opts.toH||to.height||from.height||rootSize('h');
    return {left:to.left+to.width/2-w/2,top:to.top+to.height/2-h/2,width:w,height:h};
  }

  function makeGhost(from,opts={}){
    const card=opts.face==='down'?null:opts.card;
    const g=document.createElement('div');
    g.className=`${faceUp(card)?'card-3d card-front':'card-3d card-back'} card-ghost ${opts.className||''}`.trim();
    g.innerHTML=ghostHTML(card);
    Object.assign(g.style,{
      position:'fixed',left:`${from.left}px`,top:`${from.top}px`,width:`${from.width}px`,height:`${from.height}px`,
      margin:'0',zIndex:String(opts.z||9990),pointerEvents:'none',boxSizing:'border-box',
      boxShadow:opts.shadow||'0 12px 30px rgba(0,0,0,.72)',
      transformOrigin:'top left',transform:'translate3d(0,0,0) scale(1,1) rotate(0deg)',
      willChange:'transform,opacity',backfaceVisibility:'hidden',contain:'layout paint style',
    });
    document.body.appendChild(g);
    return g;
  }

  function bezier(p0,p1,p2,t){const u=1-t;return u*u*p0+2*u*t*p1+t*t*p2;}

  function fly(opts={}){
    const from=rectOf(opts.from),to=rectOf(opts.to);
    if(!from||!to){ opts.onDone?.(); return Promise.resolve(null); }
    const end=targetTopLeft(from,to,opts);
    const duration=opts.duration||D.discard||1000;
    const distance=Math.hypot(end.left-from.left,end.top-from.top);
    const arc=opts.arc??-clamp(distance*.16,22,90);
    const spin=opts.spin??0;
    const g=makeGhost(from,opts);
    const c={left:(from.left+end.left)/2,top:(from.top+end.top)/2+arc};
    return new Promise(resolve=>{
      let started=null;
      const frame=now=>{
        if(started===null) started=now;
        const raw=clamp((now-started)/duration,0,1);
        const t=smoother(raw);
        const x=bezier(from.left,c.left,end.left,t)-from.left;
        const y=bezier(from.top,c.top,end.top,t)-from.top;
        const sx=lerp(1,end.width/Math.max(1,from.width),t);
        const sy=lerp(1,end.height/Math.max(1,from.height),t);
        const rot=Math.sin(Math.PI*raw)*spin;
        const fadeStart=opts.fadeStart??.88;
        const fadeT=raw<=fadeStart?0:(raw-fadeStart)/(1-fadeStart);
        g.style.transform=`translate3d(${x}px,${y}px,0) scale(${sx},${sy}) rotate(${rot}deg)`;
        g.style.opacity=String(lerp(1,opts.endOpacity??1,easeOut(clamp(fadeT,0,1))));
        if(raw<1){requestAnimationFrame(frame);return;}
        g.style.transform=`translate3d(${end.left-from.left}px,${end.top-from.top}px,0) scale(${end.width/Math.max(1,from.width)},${end.height/Math.max(1,from.height)}) rotate(0deg)`;
        opts.onDone?.(g);
        resolve(g);
      };
      requestAnimationFrame(()=>requestAnimationFrame(frame));
    });
  }

  const removeOnDone=done=>g=>{done?.();requestAnimationFrame(()=>requestAnimationFrame(()=>g?.remove()));};
  const landOnPile=done=>g=>{done?.();requestAnimationFrame(()=>requestAnimationFrame(()=>g?.remove()));};

  Object.assign(Cards,{
    drawFromDeck(onDone){return fly({from:Cards.rect(document.getElementById('deck-pile')),to:Cards.drawnCardRect()||Cards.rect(document.getElementById('drawn-slot')),duration:D.draw,arc:24,spin:2,face:'down',z:9995,onDone:removeOnDone(onDone)});},
    dealCard(deckRect,targetRect,onLand,isMini=false,round=0){return fly({from:deckRect,to:targetRect,toW:isMini?miniSize('w'):undefined,toH:isMini?miniSize('h'):undefined,face:'down',className:'deal-card-ghost',duration:D.deal+round*18,arc:-28-round*5,spin:round%2?2:-2,z:9980+round,onDone:removeOnDone(onLand)});},
    penaltyDraw(deckRect,targetRect,onLand,isMini=false){return fly({from:deckRect,to:targetRect,toW:isMini?miniSize('w'):undefined,toH:isMini?miniSize('h'):undefined,face:'down',className:'penalty-draw-ghost',duration:D.penalty,arc:-34,spin:3,z:9998,onDone:removeOnDone(onLand)});},
    discardDrawnCard(opts){return fly({from:opts.drawnSlotRect,to:opts.pileRect,card:opts.card,duration:D.discard,arc:-50,spin:-4,z:9999,onDone:landOnPile(opts.onLand)});},
    discardHandCard(opts){
      fly({from:opts.handSlotRect,to:opts.pileRect,card:opts.discardCard,face:opts.discardFace||'auto',duration:D.discard,arc:-52,spin:-4,z:9999,onDone:landOnPile(opts.onPileLand)});
      return fly({from:opts.drawnSlotRect,to:opts.appendSlotRect,card:opts.drawnCard,face:opts.drawnFace||'auto',duration:D.keep,arc:-18,spin:2,z:9998,onDone:removeOnDone(opts.onHandLand)});
    },
    discardHandToPile(handSlotRect,pileRect,card,onLand){return fly({from:handSlotRect,to:pileRect,card,duration:D.discard,arc:-52,spin:-4,z:9999,onDone:landOnPile(onLand)});},
    keepDrawnToHand(drawnSlotRect,appendSlotRect,card,onLand){return fly({from:drawnSlotRect,to:appendSlotRect,card,duration:D.keep,arc:-18,spin:2,z:9998,onDone:removeOnDone(onLand)});},
    forcedReplacement(deckRect,appendSlotRect,onLand){return fly({from:deckRect,to:appendSlotRect,face:'down',duration:D.keep,arc:-20,spin:2,z:9998,onDone:removeOnDone(onLand)});},
    forcedDiscard(opts){
      fly({from:opts.handSlotRect,to:opts.pileRect,card:opts.discardCard,face:opts.discardFace||'auto',duration:D.forced,arc:-52,spin:-4,z:9999,onDone:landOnPile(opts.onPileLand)});
      return fly({from:opts.deckRect,to:opts.appendSlotRect||opts.targetSlotRect,card:opts.drawCard,face:opts.drawFace||'down',duration:D.keep,arc:-20,spin:2,z:9998,onDone:removeOnDone(opts.onDeckLand)});
    },
    oppDraw(deckRect,seatTargetRect,onLand){return fly({from:deckRect,to:seatTargetRect,toW:miniSize('w'),toH:miniSize('h'),face:'down',duration:D.opponent,arc:-32,spin:1.5,z:9990,onDone:removeOnDone(onLand)});},
    oppDiscard(fromRect,pileRect,onLand,card,face='down'){return fly({from:fromRect,to:pileRect,card,face,className:'opp-discard-ghost',toW:rootSize('w'),toH:rootSize('h'),duration:D.opponent+80,arc:-54,spin:-3,z:9995,onDone:landOnPile(onLand)});},
    oppKeepDrawn(drawnRect,handRect,onLand){return fly({from:drawnRect,to:handRect,face:'down',className:'opp-keep-ghost',toW:miniSize('w'),toH:miniSize('h'),duration:D.opponent,arc:-24,spin:1.5,z:9994,onDone:removeOnDone(onLand)});},
    swap(rectA,rectB,onDone){
      let done=0;const oneDone=()=>{if(++done===2)onDone?.();};
      const a=fly({from:rectA,to:rectB,face:'down',duration:D.swap,arc:-58,spin:3,z:9992,onDone:removeOnDone(oneDone)});
      const b=fly({from:rectB,to:rectA,face:'down',duration:D.swap,arc:58,spin:-3,z:9991,onDone:removeOnDone(oneDone)});
      return Promise.all([a,b]);
    },
  });

  function playerFor(userId){return S.gameState?.players?.find(p=>String(p.userId)===String(userId));}
  function seatFor(userId){return document.querySelector(`.seat[data-user-id="${userId}"]`);}
  function clearMotion(userId){if(typeof finishOpponentMotion==='function') finishOpponentMotion(userId); else renderSeats();}
  function frozenCountFor(userId,sourceIndex,hasReplacement){
    const seat=seatFor(userId);
    const domCount=seat?.querySelectorAll('.mini-card:not(.mini-incoming):not(.opp-drawn-card)').length||0;
    const stateCount=playerFor(userId)?.cardCount||0;
    if(hasReplacement) return Math.max(domCount,stateCount,sourceIndex+1);
    if(domCount>sourceIndex) return Math.max(domCount,stateCount);
    return Math.max(domCount,stateCount+1,sourceIndex+1);
  }
  function setFrozenMotion(userId,motion){
    if(typeof setOpponentMotion==='function') setOpponentMotion(userId,motion);
    else {S._oppMotions=S._oppMotions||{};S._oppMotions[String(userId)]=motion;}
  }

  if(typeof animOppDraw==='function'){
    animOppDraw=function(userId){
      return enqueueVisual(async()=>{
        const deckRect=Cards.rect(document.getElementById('deck-pile'));
        if(!deckRect){S._drawingSet?.delete(userId);return;}
        SFX.play('Card',0.35);
        S._drawingSet=S._drawingSet||new Set();
        S._drawingSet.add(userId);
        renderSeats();
        await nextFrame();
        const seat=seatFor(userId);
        const target=Cards.rect(seat?.querySelector('.mini-card.mini-incoming'))||Cards.seatCardsRect(seat)||Cards.rect(seat);
        await Cards.oppDraw(deckRect,target);
        S._drawingSet?.delete(userId);
        const s=seatFor(userId);
        const mc=s?.querySelector('.mini-card.mini-incoming');
        if(mc){mc.classList.remove('mini-incoming');mc.classList.add('card-new-pop');}
        await delay(120);
      });
    };
  }

  if(typeof animOppDrawn==='function'){
    animOppDrawn=function(userId){
      return enqueueVisual(async()=>{
        const deckRect=Cards.rect(document.getElementById('deck-pile'));
        if(!deckRect) return;
        SFX.play('Card',0.32);
        S._oppDrawn=S._oppDrawn||{};
        S._oppDrawn[userId]='incoming';
        renderSeats();
        await nextFrame();
        const seat=seatFor(userId);
        const target=Cards.rect(seat?.querySelector('.opp-drawn-card'))||Cards.seatCardsRect(seat)||Cards.rect(seat);
        await Cards.oppDraw(deckRect,target);
        S._oppDrawn[userId]=true;
        renderSeats();
        await delay(120);
      });
    };
  }

  if(typeof animOppDiscard==='function'){
    animOppDiscard=function(userId,card,handIndex=-1,forced=false){
      return enqueueVisual(async()=>{
        const pile=document.getElementById('discard-pile');
        let seat=seatFor(userId);
        if(!seat||!pile) return;
        SFX.play('Card',0.4);
        S._skipDiscard=true;
        clearTimeout(S._skipDiscardFallback);
        S._skipDiscardFallback=setTimeout(()=>settleDiscardPile(card),5200);

        const drawnEl=seat.querySelector('.opp-drawn-card');
        const drawnRect=Cards.rect(drawnEl);
        const source=opponentHandSource(seat,handIndex);
        const sourceIndex=Math.max(0,source.index);
        const hasReplacement=!!drawnEl||!!forced;
        const frozenCount=frozenCountFor(userId,sourceIndex,hasReplacement);
        const kind=handIndex===-1&&drawnEl?'discard-drawn':forced?'forced':drawnEl?'keep':'hand-only';
        setFrozenMotion(userId,{kind,sourceIndex,targetIndex:sourceIndex,hideDrawn:!!drawnEl,reconciled:false,stage:'gap',frozenCount,timeout:setTimeout(()=>clearMotion(userId),6200)});
        renderSeats();
        await nextFrame();

        seat=seatFor(userId);
        const frozenSource=Cards.rect(seat?.querySelector(`.mini-card[data-card-index="${sourceIndex}"]`))||source.rect||Cards.seatCardsRect(seat)||Cards.rect(seat);
        const pileRect=Cards.rect(pile);
        const finalDrawnRect=drawnRect||Cards.rect(seat?.querySelector('.opp-drawn-card'));

        if(kind==='discard-drawn'){
          await Cards.oppDiscard(finalDrawnRect,pileRect,()=>settleDiscardPile(card),{...card,known:true},'auto');
          if(S._oppDrawn) delete S._oppDrawn[userId];
          clearMotion(userId);
          return;
        }

        await Cards.oppDiscard(frozenSource,pileRect,()=>settleDiscardPile(card),null,'down');
        if(drawnEl&&finalDrawnRect){
          await Cards.oppKeepDrawn(finalDrawnRect,frozenSource);
          if(S._oppDrawn) delete S._oppDrawn[userId];
        }else if(forced){
          await Cards.oppDraw(Cards.rect(document.getElementById('deck-pile')),frozenSource);
        }
        clearMotion(userId);
      });
    };
  }

  const baseSwapAnimation=typeof showSwapAnimation==='function'?showSwapAnimation:function(){};
  function swapSourceRect(userId,visualIndex){
    if(String(userId)===String(S.userId)) return Cards.rect($('my-hand')?.querySelectorAll('.card-3d')[visualIndex]);
    const seat=seatFor(userId);
    return Cards.rect(seat?.querySelectorAll('.mini-card:not(.mini-incoming):not(.opp-drawn-card)')[visualIndex])||Cards.seatCardsRect(seat)||Cards.rect(seat);
  }
  function swapTableRect(){return Cards.rect(document.querySelector('.table-center'))||Cards.rect($('discard-pile'))||Cards.rect(document.querySelector('.poker-table'));}

  function enhancedSwapAnimation(initiatorName,targetName,iCount,tCount,initiatorIndex=0,targetIndex=0){
    const players=S.gameState?.players||[];
    const initiatorUserId=players.find(p=>p.username===initiatorName)?.userId;
    const targetUserId=players.find(p=>p.username===targetName&&String(p.userId)!==String(initiatorUserId))?.userId;
    showCenterCue('Scambio',`${initiatorName} ⇄ ${targetName} — preparati`,30000);
    if(!initiatorUserId||!targetUserId) return enqueueVisual(()=>baseSwapAnimation(initiatorName,targetName,iCount,tCount,initiatorIndex,targetIndex));
    return enqueueVisual(async()=>{
      SFX.play('Swapswoosh',0.75);
      showCenterCue('Scambio',`${initiatorName} ⇄ ${targetName}`);
      await nextFrame();
      const srcA=swapSourceRect(initiatorUserId,initiatorIndex);
      const srcB=swapSourceRect(targetUserId,targetIndex);
      const mid=swapTableRect();
      if(!srcA||!srcB||!mid){setTimeout(clearSwap8Mode,1200);return;}

      const oldAnimHidden=S._animHidden;
      const oldOppMotions=S._oppMotions?{...S._oppMotions}:null;
      if(String(initiatorUserId)===String(S.userId)) S._animHidden=new Set([initiatorIndex]);
      if(String(targetUserId)===String(S.userId)) S._animHidden=new Set([targetIndex]);
      if(String(initiatorUserId)!==String(S.userId)) setFrozenMotion(initiatorUserId,{kind:'swap',sourceIndex:initiatorIndex,frozenCount:frozenCountFor(initiatorUserId,initiatorIndex,true),timeout:setTimeout(()=>{},1)});
      if(String(targetUserId)!==String(S.userId)) setFrozenMotion(targetUserId,{kind:'swap',sourceIndex:targetIndex,frozenCount:frozenCountFor(targetUserId,targetIndex,true),timeout:setTimeout(()=>{},1)});
      renderMyHand();renderSeats();

      const layer=document.createElement('div');
      layer.className='swap-field-layer';
      document.body.appendChild(layer);
      const makeSwapGhost=(r,label)=>{
        const g=document.createElement('div');
        g.className='card-3d card-back swap-field-card';
        g.setAttribute('aria-label',label);
        Object.assign(g.style,{left:`${r.left}px`,top:`${r.top}px`,width:`${r.width}px`,height:`${r.height}px`,transformOrigin:'top left',transform:'translate3d(0,0,0) scale(1,1) rotate(0deg)'});
        layer.appendChild(g);
        return g;
      };
      const a=makeSwapGhost(srcA,initiatorName);
      const b=makeSwapGhost(srcB,targetName);
      const centerA={left:mid.left+mid.width/2-srcA.width/2-18,top:mid.top+mid.height/2-srcA.height/2,scaleX:1.08,scaleY:1.08,rot:-4};
      const centerB={left:mid.left+mid.width/2-srcB.width/2+18,top:mid.top+mid.height/2-srcB.height/2,scaleX:1.08,scaleY:1.08,rot:4};
      const endA={left:srcB.left+srcB.width/2-srcA.width/2,top:srcB.top+srcB.height/2-srcA.height/2,scaleX:srcB.width/Math.max(1,srcA.width),scaleY:srcB.height/Math.max(1,srcA.height),rot:0};
      const endB={left:srcA.left+srcA.width/2-srcB.width/2,top:srcA.top+srcA.height/2-srcB.height/2,scaleX:srcA.width/Math.max(1,srcB.width),scaleY:srcA.height/Math.max(1,srcB.height),rot:0};
      const place=(el,start,pos)=>{el.style.transform=`translate3d(${pos.left-start.left}px,${pos.top-start.top}px,0) scale(${pos.scaleX},${pos.scaleY}) rotate(${pos.rot}deg)`;};
      const animate=(el,start,midPoint,endPoint,duration=3800)=>new Promise(resolve=>{
        const pauseFrom=.43,pauseTo=.58,startPoint={left:start.left,top:start.top,scaleX:1,scaleY:1,rot:0};
        let began=null,paused=false;
        const frame=now=>{
          if(began===null) began=now;
          const raw=clamp((now-began)/duration,0,1);
          let pos;
          if(raw<pauseFrom){const t=smoother(raw/pauseFrom);pos={left:lerp(startPoint.left,midPoint.left,t),top:lerp(startPoint.top,midPoint.top,t),scaleX:lerp(1,midPoint.scaleX,t),scaleY:lerp(1,midPoint.scaleY,t),rot:lerp(0,midPoint.rot,t)};}
          else if(raw<pauseTo){if(!paused){el.classList.add('swap-paused');paused=true;}pos=midPoint;}
          else{if(paused){el.classList.remove('swap-paused');paused=false;}const t=smoother((raw-pauseTo)/(1-pauseTo));pos={left:lerp(midPoint.left,endPoint.left,t),top:lerp(midPoint.top,endPoint.top,t),scaleX:lerp(midPoint.scaleX,endPoint.scaleX,t),scaleY:lerp(midPoint.scaleY,endPoint.scaleY,t),rot:lerp(midPoint.rot,endPoint.rot,t)};}
          place(el,start,pos);
          if(raw<1) requestAnimationFrame(frame); else{place(el,start,endPoint);resolve();}
        };
        requestAnimationFrame(()=>requestAnimationFrame(frame));
      });
      await Promise.all([animate(a,srcA,centerA,endA),animate(b,srcB,centerB,endB)]);
      hideCenterCue();
      S._animHidden=oldAnimHidden;
      if(S._oppMotions) Object.keys(S._oppMotions).forEach(id=>{if(S._oppMotions[id]?.kind==='swap') delete S._oppMotions[id];});
      if(oldOppMotions) S._oppMotions={...(S._oppMotions||{}),...oldOppMotions};
      if(!Object.keys(S._oppMotions||{}).length) S._oppMotions=null;
      S._swap8Mode=null;
      renderMyHand();renderSeats();renderActions();
      requestAnimationFrame(()=>{layer.classList.add('leaving');setTimeout(()=>layer.remove(),360);});
    });
  }
  showSwapAnimation=enhancedSwapAnimation;
})();
