'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  BUIO — Card Animation Engine  v2
//
//  RULE: every ghost travels face-DOWN from A to B.
//  The destination (drawn-slot, discard pile, hand slot) renders the card
//  face-up once the ghost lands — that is the reveal. No in-flight flips.
//
//  The single exception: discardDrawnCard — the drawn card is already
//  face-up in the drawn-slot so the ghost stays face-up as it moves.
// ═══════════════════════════════════════════════════════════════════════════

const Cards = (() => {

  // ── CSS vars ──────────────────────────────────────────────────────────────
  function cardSize() {
    const s = getComputedStyle(document.documentElement);
    return {
      cw: parseInt(s.getPropertyValue('--cw')) || 66,
      ch: parseInt(s.getPropertyValue('--ch')) || 100,
    };
  }

  // ── rect helper: returns null for zero-size or missing elements ───────────
  function rect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return r;
  }

  const EASE = 'cubic-bezier(.25,.46,.45,.94)';

  // ── Core: fly a ghost from A to B ─────────────────────────────────────────
  // opts: { faceUp, card, toW, toH, dur, z, onLand }
  // onLand(ghost) fires dur+30ms after creation.
  function fly(from, to, opts = {}) {
    if (!from || !to) { opts.onLand?.(null); return null; }

    const { cw, ch } = cardSize();
    const dur = opts.dur ?? 420;
    const toW = opts.toW ?? cw;
    const toH = opts.toH ?? ch;
    const z   = opts.z   ?? 9990;

    const g = document.createElement('div');
    if (opts.faceUp && opts.card) {
      g.className = 'card-3d card-front';
      g.style.background = '#f5f0e8';
      g.innerHTML = `<img src="/cards/${opts.card.suit}_${opts.card.value}.jpg" class="card-img">`;
    } else {
      g.className = 'card-3d card-back';
    }
    Object.assign(g.style, {
      position:      'fixed',
      left:          from.left   + 'px',
      top:           from.top    + 'px',
      width:         from.width  + 'px',
      height:        from.height + 'px',
      zIndex:        String(z),
      margin:        '0',
      pointerEvents: 'none',
      overflow:      'hidden',
      borderRadius:  '6px',
      boxShadow:     '0 8px 24px rgba(0,0,0,.6)',
      transition:    'none',
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

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Rect of the actual card-3d inside drawn-card-display (not the outer slot container)
  function drawnCardRect() {
    const card3d = document.querySelector('#drawn-card-display .card-3d');
    return rect(card3d) || rect(document.getElementById('drawn-slot'));
  }

  // Rect of the last (rightmost) visible mini-card in an opponent seat
  function seatCardsRect(seat) {
    if (!seat) return null;
    const cards = Array.from(seat.querySelectorAll('.mini-card:not(.mini-incoming)'));
    const last  = cards[cards.length - 1];
    return rect(last) || rect(seat.querySelector('.seat-cards')) || rect(seat);
  }

  // ── Public moves ─────────────────────────────────────────────────────────

  // 1. DRAW: deck → drawn-slot  (face-down ghost; onDone reveals the drawn card)
  function drawFromDeck(onDone) {
    const dk   = rect(document.getElementById('deck-pile'));
    const slot = drawnCardRect() || rect(document.getElementById('drawn-slot'));
    if (!dk || !slot) { onDone?.(); return; }
    fly(dk, slot, {
      dur: 380, z: 9995,
      onLand: g => { g.remove(); onDone?.(); },
    });
  }

  // 2. DISCARD HAND CARD: discarded → pile, drawn → rightmost slot (both face-down)
  //    opts: { handSlotRect, pileRect, drawnSlotRect, lastSlotRect, onPileLand, onHandLand }
  function discardHandCard(opts) {
    const { handSlotRect, pileRect, drawnSlotRect, lastSlotRect } = opts;

    // Ghost A: discarded card → pile
    fly(handSlotRect, pileRect, {
      dur: 420, z: 9999,
      onLand: g => { g.remove(); opts.onPileLand?.(); },
    });

    // Ghost B: drawn card → rightmost slot (simultaneous with A)
    if (drawnSlotRect && lastSlotRect) {
      fly(drawnSlotRect, lastSlotRect, {
        dur: 420, z: 9998,
        onLand: g => { g.remove(); opts.onHandLand?.(); },
      });
    } else {
      setTimeout(() => opts.onHandLand?.(), 460);
    }
  }

  // 3. DISCARD DRAWN CARD: drawn-slot → pile  (face-UP — card was already visible)
  function discardDrawnCard(opts) {
    const { drawnSlotRect, pileRect, card } = opts;
    if (!drawnSlotRect || !pileRect) { opts.onLand?.(); return; }
    fly(drawnSlotRect, pileRect, {
      faceUp: true, card,
      dur: 400, z: 9999,
      onLand: g => { g.remove(); opts.onLand?.(); },
    });
  }

  // 4. FORCED DISCARD: discarded → pile, replacement from deck → same slot (both face-down)
  //    opts: { handSlotRect, pileRect, deckRect, targetSlotRect, onPileLand, onDeckLand }
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

  // 5. ATTACK: hand-slot → pile  (face-down)
  function attackCard(handSlotRect, pileRect, onLand) {
    if (!handSlotRect || !pileRect) { onLand?.(); return; }
    fly(handSlotRect, pileRect, {
      dur: 380, z: 9999,
      onLand: g => { g.remove(); onLand?.(); },
    });
  }

  // 6. OPPONENT DRAW: deck (full size) → seat mini-card slot (shrinks during flight)
  function oppDraw(deckRect, seatRect, onLand) {
    if (!deckRect || !seatRect) { onLand?.(); return; }
    fly(deckRect, seatRect, {
      toW: 28, toH: 43, dur: 480, z: 9990,
      onLand: g => { g.remove(); onLand?.(); },
    });
  }

  // 7. OPPONENT DISCARD: seat → pile  (face-down; renderDiscardPile shows card on land)
  function oppDiscard(seat, pileRect, onLand) {
    const seatRect = seatCardsRect(seat);
    if (!seatRect || !pileRect) { onLand?.(); return; }
    const { cw, ch } = cardSize();
    fly(seatRect, pileRect, {
      toW: cw, toH: ch, dur: 460, z: 9995,
      onLand: g => { g?.remove(); onLand?.(); },
    });
  }

  // 8. SWAP: two rects cross each other
  function swap(rectA, rectB, onDone) {
    if (!rectA || !rectB) { onDone?.(); return; }
    const dur = 550;
    fly(rectA, rectB, { dur, z: 9992, onLand: g => g?.remove() });
    fly(rectB, rectA, { dur, z: 9991, onLand: g => { g?.remove(); onDone?.(); } });
  }

  return {
    fly, rect, cardSize, drawnCardRect, seatCardsRect,
    drawFromDeck, discardHandCard, discardDrawnCard,
    forcedDiscard, attackCard, oppDraw, oppDiscard, swap,
  };
})();
