'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  BUIO — Card Animation Engine
//  All card movement goes through here.  One rule: a card is ALWAYS visible.
//  It never disappears and reappears.  It travels from A to B.
// ═══════════════════════════════════════════════════════════════════════════

const Cards = (() => {
  // ── helpers ────────────────────────────────────────────────────────────
  function css() {
    const s = getComputedStyle(document.documentElement);
    return {
      cw: parseInt(s.getPropertyValue('--cw')) || 66,
      ch: parseInt(s.getPropertyValue('--ch')) || 100,
    };
  }

  function rect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return r;
  }

  const EASE = 'cubic-bezier(.25,.46,.45,.94)';

  // ── Core: create a flying ghost card ────────────────────────────────────
  // from  : DOMRect of start position
  // to    : DOMRect of end position
  // opts  : { faceUp, card, toW, toH, dur, z, onLand }
  function fly(from, to, opts = {}) {
    if (!from || !to) { opts.onLand?.(null); return null; }
    const { cw, ch } = css();
    const dur  = opts.dur  ?? 420;
    const toW  = opts.toW  ?? cw;
    const toH  = opts.toH  ?? ch;
    const z    = opts.z    ?? 9990;

    const g = document.createElement('div');
    if (opts.faceUp && opts.card) {
      g.className = 'card-3d card-front';
      g.style.background = '#f5f0e8';
      g.innerHTML = `<img src="/cards/${opts.card.suit}_${opts.card.value}.jpg" class="card-img">`;
    } else {
      g.className = 'card-3d card-back';
    }
    Object.assign(g.style, {
      position: 'fixed',
      left:   from.left + 'px',
      top:    from.top  + 'px',
      width:  from.width  + 'px',
      height: from.height + 'px',
      zIndex: String(z),
      margin: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
      borderRadius: '6px',
      boxShadow: '0 8px 24px rgba(0,0,0,.6)',
      transition: 'none',
    });
    document.body.appendChild(g);

    const tx = to.left + to.width  / 2 - toW / 2;
    const ty = to.top  + to.height / 2 - toH / 2;

    requestAnimationFrame(() => requestAnimationFrame(() => {
      g.style.transition = [
        `left   ${dur}ms ${EASE}`,
        `top    ${dur}ms ${EASE}`,
        `width  ${dur}ms ${EASE}`,
        `height ${dur}ms ${EASE}`,
      ].join(',');
      g.style.left   = tx + 'px';
      g.style.top    = ty + 'px';
      g.style.width  = toW + 'px';
      g.style.height = toH + 'px';
    }));

    setTimeout(() => opts.onLand?.(g), dur + 30);
    return g;
  }

  // Flip a ghost in-place: face-down → face-up
  // Waits for the card image before revealing so it never flips open blank.
  // ONE-SHOT guard: doFlip can only run once regardless of which path fires first.
  function flipUp(g, card, onDone) {
    if (!g) { onDone?.(); return; }
    const img = new Image();
    img.className = 'card-img';
    img.src = `/cards/${card.suit}_${card.value}.jpg`;

    let fired = false;
    const doFlip = () => {
      if (fired) return; fired = true;
      g.style.transition = 'transform .12s ease-in';
      g.style.transform  = 'scaleX(0)';
      setTimeout(() => {
        g.className        = 'card-3d card-front';
        g.style.background = '#f5f0e8';
        g.innerHTML        = '';
        g.appendChild(img);
        g.style.transition = 'transform .12s ease-out';
        g.style.transform  = 'scaleX(1)';
        setTimeout(() => onDone?.(), 130);
      }, 130);
    };

    if (img.complete) {
      doFlip();
    } else {
      img.onload  = doFlip;
      img.onerror = doFlip;
      setTimeout(doFlip, 300); // safety — now guarded by `fired`
    }
  }

  // Flip a ghost in-place: face-up → face-down
  function flipDown(g, onDone) {
    if (!g) { onDone?.(); return; }
    g.style.transition = 'transform .12s ease-in';
    g.style.transform  = 'scaleX(0)';
    setTimeout(() => {
      g.className        = 'card-3d card-back';
      g.innerHTML        = '';
      g.style.background = '';
      g.style.transition = 'transform .12s ease-out';
      g.style.transform  = 'scaleX(1)';
      setTimeout(() => onDone?.(), 130);
    }, 130);
  }

  // ── Public moves ────────────────────────────────────────────────────────

  // Helper: best rect for the drawn card — the card-3d inside drawn-card-display,
  // or fall back to the drawn-slot container if the card isn't rendered yet.
  function drawnCardRect() {
    const card3d = document.querySelector('#drawn-card-display .card-3d');
    return rect(card3d) || rect(document.getElementById('drawn-slot'));
  }

  // Helper: rect of the last (rightmost) mini-card in the seat —
  // the one most recently added, so ghosts start from the right card.
  function seatCardsRect(seat) {
    const cards = Array.from(seat.querySelectorAll('.mini-card:not(.mini-incoming)'));
    const last = cards[cards.length - 1];
    return rect(last) || rect(seat.querySelector('.seat-cards')) || rect(seat);
  }

  // 1. DRAW: deck → drawn-card-display (the exact card area, not the wider slot container).
  //    Pre-loads the card image so it's ready before the flip reveal.
  function drawFromDeck(card, onDone) {
    const dk   = rect(document.getElementById('deck-pile'));
    // Target the card-3d inside drawn-card-display for pixel-perfect alignment.
    const slot = drawnCardRect() || rect(document.getElementById('drawn-slot'));
    if (!dk || !slot) { onDone?.(); return; }

    // Pre-load image immediately so it's cached by the time the ghost flips
    if (card) {
      const preload = new Image();
      preload.src = `/cards/${card.suit}_${card.value}.jpg`;
    }

    const g = fly(dk, slot, { dur: 380, z: 9995 });
    if (!g) return;
    if (card) {
      setTimeout(() => flipUp(g, card, () => { g.remove(); onDone?.(); }), 420);
    } else {
      setTimeout(() => { g.remove(); onDone?.(); }, 420);
    }
  }

  // 2. DISCARD HAND CARD (normal turn): hand-slot → pile, drawn-card → right end
  //    The drawn card goes to the RIGHTMOST slot so the player sees it arrive there.
  //    Returns nothing — caller must pass callbacks in opts.
  //    opts: { handSlotRect, pileRect, drawnSlotRect, drawnCard,
  //            lastSlotRect, onPileLand, onHandLand }
  function discardHandCard(opts) {
    const { handSlotRect, pileRect, drawnSlotRect, lastSlotRect } = opts;

    // Ghost A: hand card → pile, face-down
    const gA = fly(handSlotRect, pileRect, {
      dur: 420, z: 9999,
      onLand: g => { g.remove(); opts.onPileLand?.(); },
    });

    // Ghost B: drawn card → last hand slot, face-down
    // Starts immediately alongside Ghost A — viewer sees both move at once.
    if (drawnSlotRect && lastSlotRect) {
      fly(drawnSlotRect, lastSlotRect, {
        dur: 420, z: 9998,
        onLand: g => { g.remove(); opts.onHandLand?.(); },
      });
    } else {
      // No drawn-slot visible — just finalise
      setTimeout(() => opts.onHandLand?.(), 460);
    }

    return gA;
  }

  // 3. DISCARD DRAWN CARD: drawn-slot → pile, face-up
  function discardDrawnCard(opts) {
    const { drawnSlotRect, pileRect, card } = opts;
    if (!drawnSlotRect || !pileRect) { opts.onLand?.(); return; }
    fly(drawnSlotRect, pileRect, {
      faceUp: true, card,
      dur: 400, z: 9999,
      onLand: g => { g.remove(); opts.onLand?.(); },
    });
  }

  // 4. FORCED DISCARD: hand-slot → pile, replacement from deck → same slot
  //    opts: { handSlotRect, pileRect, deckRect, onPileLand, onDeckLand }
  function forcedDiscard(opts) {
    const { handSlotRect, pileRect, deckRect, targetSlotRect } = opts;

    fly(handSlotRect, pileRect, {
      dur: 420, z: 9999,
      onLand: g => { g.remove(); opts.onPileLand?.(); },
    });

    if (deckRect && targetSlotRect) {
      fly(deckRect, targetSlotRect, {
        dur: 420, z: 9998,
        onLand: g => { g.remove(); opts.onDeckLand?.(); },
      });
    } else {
      setTimeout(() => opts.onDeckLand?.(), 460);
    }
  }

  // 5. ATTACK: hand-slot → pile
  function attackCard(handSlotRect, pileRect, onLand) {
    fly(handSlotRect, pileRect, {
      dur: 380, z: 9999,
      onLand: g => { g.remove(); onLand?.(); },
    });
  }

  // 6. OPPONENT DRAW: deck (full size) → seat (mini size)
  //    Caller must show the mini card only after onLand fires.
  function oppDraw(deckRect, seatRect, onLand) {
    if (!deckRect || !seatRect) { onLand?.(); return; }
    fly(deckRect, seatRect, {
      toW: 28, toH: 43, dur: 480, z: 9990,
      onLand: g => { g.remove(); onLand?.(); },
    });
  }

  // 7. OPPONENT DISCARD: seat mini-cards → pile (full size), face-up in flight.
  //    Pre-loads the image so the ghost doesn't show blank at the seat.
  function oppDiscard(seat, pileRect, card, onLand) {
    const seatRect = seat ? seatCardsRect(seat) : null;
    if (!seatRect || !pileRect) { onLand?.(); return; }
    const { cw, ch } = css();

    const doFly = () => fly(seatRect, pileRect, {
      faceUp: !!card, card,
      toW: cw, toH: ch, dur: 460, z: 9995,
      onLand: g => { g?.remove(); onLand?.(); },
    });

    if (card) {
      const img = new Image();
      img.src = `/cards/${card.suit}_${card.value}.jpg`;
      let fired = false;
      const once = () => { if (!fired) { fired = true; doFly(); } };
      if (img.complete) { once(); }
      else { img.onload = once; img.onerror = once; setTimeout(once, 200); }
    } else {
      doFly();
    }
  }

  // 8. SWAP: two rects cross each other (card 8 special)
  function swap(rectA, rectB, onDone) {
    if (!rectA || !rectB) { onDone?.(); return; }
    const dur = 600;
    fly(rectA, rectB, { dur, z: 9992, onLand: g => g?.remove() }); // must remove, was leaking
    fly(rectB, rectA, { dur, z: 9991, onLand: g => { g?.remove(); onDone?.(); } });
  }

  // 9. PEEK: flip a specific hand card element face-up in place, then back down
  //    el: the actual .card-3d element in the hand
  function peekCard(el, card, holdMs, onDone) {
    if (!el) { onDone?.(); return; }
    // We work on the real element (it's already in the hand DOM)
    flipUp(el, card, () => {
      setTimeout(() => flipDown(el, onDone), holdMs ?? 2800);
    });
  }

  return { fly, flipUp, flipDown, rect, css,
           drawnCardRect, seatCardsRect,
           drawFromDeck, discardHandCard, discardDrawnCard,
           forcedDiscard, attackCard, oppDraw, oppDiscard,
           swap, peekCard };
})();
