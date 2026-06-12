// Enhanced inline special-8 swap animation override.
(function(){
  const baseSwapAnimation = typeof showSwapAnimation === 'function' ? showSwapAnimation : function(){};
// ── Otto swap: face-down cards crossing between two piles ─────────────────
function swapSourceRect(userId, visualIndex) {
  if(String(userId)===String(S.userId)){
    return Cards.rect($('my-hand')?.querySelectorAll('.card-3d')[visualIndex]);
  }
  const seat=document.querySelector(`.seat[data-user-id="${userId}"]`);
  return Cards.rect(seat?.querySelectorAll('.mini-card:not(.mini-incoming):not(.opp-drawn-card)')[visualIndex]) || Cards.rect(seat?.querySelector('.seat-cards'));
}
function swapTableRect() {
  return Cards.rect(document.querySelector('.table-center')) || Cards.rect($('discard-pile')) || Cards.rect(document.querySelector('.poker-table'));
}
// ── Otto swap: slow, traceable face-down cards through table center ───────
function enhancedSwapAnimation(initiatorName, targetName, iCount, tCount, initiatorIndex=0, targetIndex=0) {
  const players=S.gameState?.players||[];
  const initiatorUserId=players.find(p=>p.username===initiatorName)?.userId;
  const targetUserId=players.find(p=>p.username===targetName&&String(p.userId)!==String(initiatorUserId))?.userId;
  if(!initiatorUserId||!targetUserId){ return baseSwapAnimation(initiatorName,targetName,iCount,tCount,initiatorIndex,targetIndex); }
  SFX.play('Swapswoosh', 0.75);
  showCenterCue('Scambio', `${initiatorName} ⇄ ${targetName}`);
  const srcA=swapSourceRect(initiatorUserId, initiatorIndex);
  const srcB=swapSourceRect(targetUserId, targetIndex);
  const mid=swapTableRect();
  if(!srcA||!srcB||!mid){ setTimeout(clearSwap8Mode, 1200); return; }

  const oldAnimHidden=S._animHidden;
  const oldOppMotions=S._oppMotions?{...S._oppMotions}:null;
  if(String(initiatorUserId)===String(S.userId)) S._animHidden=new Set([initiatorIndex]);
  if(String(targetUserId)===String(S.userId)) S._animHidden=new Set([targetIndex]);
  if(String(initiatorUserId)!==String(S.userId)) setOpponentMotion(initiatorUserId,{kind:'swap',sourceIndex:initiatorIndex,timeout:setTimeout(()=>{},1)});
  if(String(targetUserId)!==String(S.userId)) setOpponentMotion(targetUserId,{kind:'swap',sourceIndex:targetIndex,timeout:setTimeout(()=>{},1)});
  renderMyHand();renderSeats();

  const layer=document.createElement('div');
  layer.className='swap-field-layer';
  document.body.appendChild(layer);
  const makeGhost=(r,label)=>{
    const g=document.createElement('div');
    g.className='card-3d card-back swap-field-card';
    g.setAttribute('aria-label', label);
    Object.assign(g.style,{
      left:`${r.left}px`,top:`${r.top}px`,width:`${r.width}px`,height:`${r.height}px`,
      transformOrigin:'top left',
      transform:'translate3d(0,0,0) scale(1,1) rotate(0deg)',
    });
    layer.appendChild(g);
    return g;
  };
  const a=makeGhost(srcA, initiatorName);
  const b=makeGhost(srcB, targetName);
  const centerA={
    left:mid.left+mid.width/2-srcA.width/2-18,
    top:mid.top+mid.height/2-srcA.height/2,
    scaleX:1.08,scaleY:1.08,rot:-4,
  };
  const centerB={
    left:mid.left+mid.width/2-srcB.width/2+18,
    top:mid.top+mid.height/2-srcB.height/2,
    scaleX:1.08,scaleY:1.08,rot:4,
  };
  const endA={
    left:srcB.left+srcB.width/2-srcA.width/2,
    top:srcB.top+srcB.height/2-srcA.height/2,
    scaleX:srcB.width/Math.max(1,srcA.width),
    scaleY:srcB.height/Math.max(1,srcA.height),
    rot:0,
  };
  const endB={
    left:srcA.left+srcA.width/2-srcB.width/2,
    top:srcA.top+srcA.height/2-srcB.height/2,
    scaleX:srcA.width/Math.max(1,srcB.width),
    scaleY:srcA.height/Math.max(1,srcB.height),
    rot:0,
  };
  const smooth=t=>t*t*t*(t*(t*6-15)+10);
  const lerp=(x,y,t)=>x+(y-x)*t;
  const place=(el,start,pos)=>{
    const dx=pos.left-start.left;
    const dy=pos.top-start.top;
    el.style.transform=`translate3d(${dx}px,${dy}px,0) scale(${pos.scaleX},${pos.scaleY}) rotate(${pos.rot}deg)`;
  };
  const animate=(el,start,midPoint,endPoint,duration=3600)=>new Promise(resolve=>{
    const pauseFrom=.43;
    const pauseTo=.57;
    let began=null;
    let paused=false;
    const startPoint={left:start.left,top:start.top,scaleX:1,scaleY:1,rot:0};
    const frame=now=>{
      if(began===null) began=now;
      const raw=Math.min(1,(now-began)/duration);
      let pos;
      if(raw<pauseFrom){
        const t=smooth(raw/pauseFrom);
        pos={
          left:lerp(startPoint.left,midPoint.left,t),
          top:lerp(startPoint.top,midPoint.top,t),
          scaleX:lerp(startPoint.scaleX,midPoint.scaleX,t),
          scaleY:lerp(startPoint.scaleY,midPoint.scaleY,t),
          rot:lerp(startPoint.rot,midPoint.rot,t),
        };
      } else if(raw<pauseTo){
        if(!paused){ el.classList.add('swap-paused'); paused=true; }
        pos=midPoint;
      } else {
        if(paused){ el.classList.remove('swap-paused'); paused=false; }
        const t=smooth((raw-pauseTo)/(1-pauseTo));
        pos={
          left:lerp(midPoint.left,endPoint.left,t),
          top:lerp(midPoint.top,endPoint.top,t),
          scaleX:lerp(midPoint.scaleX,endPoint.scaleX,t),
          scaleY:lerp(midPoint.scaleY,endPoint.scaleY,t),
          rot:lerp(midPoint.rot,endPoint.rot,t),
        };
      }
      place(el,start,pos);
      if(raw<1) requestAnimationFrame(frame);
      else { place(el,start,endPoint); resolve(); }
    };
    requestAnimationFrame(()=>requestAnimationFrame(frame));
  });

  Promise.all([animate(a,srcA,centerA,endA),animate(b,srcB,centerB,endB)]).then(()=>{
    hideCenterCue();
    S._animHidden=oldAnimHidden;
    if(S._oppMotions){ Object.keys(S._oppMotions).forEach(id=>{ if(S._oppMotions[id]?.kind==='swap') delete S._oppMotions[id]; }); }
    if(oldOppMotions) S._oppMotions={...(S._oppMotions||{}),...oldOppMotions};
    if(!Object.keys(S._oppMotions||{}).length) S._oppMotions=null;
    S._swap8Mode=null;
    renderMyHand();renderSeats();renderActions();
    requestAnimationFrame(()=>{
      layer.classList.add('leaving');
      setTimeout(()=>layer.remove(),360);
    });
  });
}
  showSwapAnimation = enhancedSwapAnimation;
})();
