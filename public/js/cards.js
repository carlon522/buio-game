'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  BUIO — Card Physics Engine (GSAP-powered)
//
//  Uses GSAP 3 for 60fps tweening.
//  Each card flight is three parallel GSAP tweens:
//    1. X position  — smooth ease
//    2. Y position  — parabolic arc (rises/falls naturally)
//    3. Rotation    — peaks at midpoint, settles to 0
//  Plus optional size lerp for scaling cards to/from mini seats.
//
//  All ghosts are face-down (card-back).
//  No flips, no scaleX, no in-flight reveals.
// ═══════════════════════════════════════════════════════════════════════════

const Cards = (() => {

  // ── helpers ───────────────────────────────────────────────────────────────

  function cw() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cw')) || 66; }
  function ch() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ch')) || 100; }

  function rect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return (r.width || r.height) ? r : null;
  }

  function drawnCardRect() {
    return rect(document.querySelector('#drawn-card-display .card-3d'))
        || rect(document.getElementById('drawn-slot'));
  }

  function seatCardsRect(seat) {
    if (!seat) return null;
    const cards = [...seat.querySelectorAll('.mini-card:not(.mini-incoming)')];
    return rect(cards[cards.length - 1])
        || rect(seat.querySelector('.seat-cards'))
        || rect(seat);
  }

  // ── Ghost factory ─────────────────────────────────────────────────────────
  function makeGhost(from, z) {
    const g = document.createElement('div');
    g.className = 'card-3d card-back';
    gsap.set(g, {
      position:      'fixed',
      left:          from.left,
      top:           from.top,
      width:         from.width,
      height:        from.height,
      zIndex:        z || 9990,
      margin:        0,
      overflow:      'hidden',
      borderRadius:  '6px',
      boxShadow:     '0 8px 28px rgba(0,0,0,.7)',
      pointerEvents: 'none',
      rotation:      0,
    });
    document.body.appendChild(g);
    return g;
  }

  // ── Core physics flight ───────────────────────────────────────────────────
  //
  //  from, to   : DOMRect
  //  profile    : {
  //    dur        : seconds (GSAP uses seconds)
  //    z          : z-index
  //    arc        : pixels — negative lifts card upward at midpoint
  //    rot        : max rotation degrees at midpoint (returns to 0)
  //    toW, toH   : destination size (defaults to card size)
  //    onLand(g)  : fires on completion
  //  }
  //
  function fly(from, to, profile) {
    if (!from || !to) { if (profile.onLand) profile.onLand(null); return null; }

    const toW = profile.toW || cw();
    const toH = profile.toH || ch();
    const dur = profile.dur || 0.42;
    const arc = profile.arc || 0;     // negative = up
    const rot = profile.rot || 0;

    // Destination top-left (centred at 'to')
    const endLeft = to.left + to.width  / 2 - toW / 2;
    const endTop  = to.top  + to.height / 2 - toH / 2;

    // Arc peak Y: lift upward by |arc| pixels at midpoint
    const peakTop = endTop + arc;   // arc is negative for upward lift

    const g = makeGhost(from, profile.z);

    // Determine when ghost is fully landed (longest tween)
    let completed = 0;
    const total = (arc !== 0) ? 3 : 2; // x, y1+y2 (or just y), rotation
    function check() {
      completed++;
      if (completed >= total) { if (profile.onLand) profile.onLand(g); }
    }

    // 1. X: smooth ease-out
    gsap.to(g, { duration: dur, left: endLeft, ease: 'power2.out', onComplete: check });

    // 2. Y: parabolic arc — rise to peak, then fall to destination
    if (arc !== 0) {
      const half = dur * 0.48;
      gsap.to(g, { duration: half, top: peakTop, ease: 'power2.out' });
      gsap.to(g, { duration: dur - half, top: endTop, ease: 'power2.in', delay: half, onComplete: check });
    } else {
      gsap.to(g, { duration: dur, top: endTop, ease: 'power2.out', onComplete: check });
    }

    // 3. Rotation: peaks at midpoint, returns to 0
    if (rot !== 0) {
      const half = dur * 0.5;
      gsap.to(g, { duration: half, rotation: rot, ease: 'power1.out' });
      gsap.to(g, { duration: half, rotation: 0,   ease: 'power1.in', delay: half });
    }

    // 4. Size lerp (for opponent cards scaling)
    if (profile.toW || profile.toH) {
      gsap.to(g, { duration: dur, width: toW, height: toH, ease: 'power2.out' });
    }

    return g;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  // 1. DRAW: deck peels out, gentle arc into drawn-slot
  function drawFromDeck(onReveal) {
    const dk   = rect(document.getElementById('deck-pile'));
    const slot = drawnCardRect() || rect(document.getElementById('drawn-slot'));
    if (!dk || !slot) { if (onReveal) onReveal(); return; }
    fly(dk, slot, {
      dur: 0.38, z: 9995,
      arc: 15,   // slight dip (card slides out under deck)
      rot: 5,
      onLand: g => { g.remove(); if (onReveal) onReveal(); },
    });
  }

  // 2. DISCARD HAND CARD: thrown to pile + drawn card slides to rightmost slot
  function discardHandCard(opts) {
    // Ghost A: discard → pile, arcing throw
    fly(opts.handSlotRect, opts.pileRect, {
      dur: 0.35, z: 9999,
      arc: -55,  rot: -15,
      onLand: g => { g.remove(); if (opts.onPileLand) opts.onPileLand(); },
    });

    // Ghost B: drawn card → last hand slot, controlled slide
    if (opts.drawnSlotRect && opts.lastSlotRect) {
      fly(opts.drawnSlotRect, opts.lastSlotRect, {
        dur: 0.40, z: 9998,
        arc: -12, rot: 3,
        onLand: g => { g.remove(); if (opts.onHandLand) opts.onHandLand(); },
      });
    } else {
      setTimeout(() => { if (opts.onHandLand) opts.onHandLand(); }, 450);
    }
  }

  // 3. DISCARD DRAWN CARD: throw to pile face-down
  function discardDrawnCard(opts) {
    if (!opts.drawnSlotRect || !opts.pileRect) { if (opts.onLand) opts.onLand(); return; }
    fly(opts.drawnSlotRect, opts.pileRect, {
      dur: 0.35, z: 9999,
      arc: -55, rot: -15,
      onLand: g => { g.remove(); if (opts.onLand) opts.onLand(); },
    });
  }

  // 4. FORCED DISCARD: hand → pile + replacement from deck
  function forcedDiscard(opts) {
    fly(opts.handSlotRect, opts.pileRect, {
      dur: 0.35, z: 9999,
      arc: -55, rot: -15,
      onLand: g => { g.remove(); if (opts.onPileLand) opts.onPileLand(); },
    });
    if (opts.deckRect && opts.targetSlotRect) {
      fly(opts.deckRect, opts.targetSlotRect, {
        dur: 0.40, z: 9998,
        arc: -20, rot: 5,
        onLand: g => { g.remove(); if (opts.onDeckLand) opts.onDeckLand(); },
      });
    } else {
      setTimeout(() => { if (opts.onDeckLand) opts.onDeckLand(); }, 450);
    }
  }

  // 5. ATTACK: aggressive throw — fast, high arc, hard spin
  function attackCard(handSlotRect, pileRect, onLand) {
    if (!handSlotRect || !pileRect) { if (onLand) onLand(); return; }
    fly(handSlotRect, pileRect, {
      dur: 0.28, z: 9999,
      arc: -80, rot: -22,
      onLand: g => { g.remove(); if (onLand) onLand(); },
    });
  }

  // 6. OPPONENT DRAW: full-size card shrinks as it enters seat
  function oppDraw(deckRect, seatTargetRect, onLand) {
    if (!deckRect || !seatTargetRect) { if (onLand) onLand(); return; }
    fly(deckRect, seatTargetRect, {
      dur: 0.46, z: 9990,
      arc: -18, rot: 7,
      toW: 28, toH: 43,
      onLand: g => { g.remove(); if (onLand) onLand(); },
    });
  }

  // 7. OPPONENT DISCARD: mini grows to full as it arcs to pile
  function oppDiscard(seat, pileRect, onLand) {
    const from = seatCardsRect(seat);
    if (!from || !pileRect) { if (onLand) onLand(); return; }
    fly(from, pileRect, {
      dur: 0.40, z: 9995,
      arc: -42, rot: -11,
      toW: cw(), toH: ch(),
      onLand: g => { g.remove(); if (onLand) onLand(); },
    });
  }

  // 8. SWAP: two cards cross mid-air in opposite arcs
  function swap(rectA, rectB, onDone) {
    if (!rectA || !rectB) { if (onDone) onDone(); return; }
    fly(rectA, rectB, { dur: 0.52, z: 9992, arc: -65,  rot:  14, onLand: g => g.remove() });
    fly(rectB, rectA, { dur: 0.52, z: 9991, arc:  65,  rot: -14,
      onLand: g => { g.remove(); if (onDone) onDone(); },
    });
  }

  return {
    rect, drawnCardRect, seatCardsRect,
    drawFromDeck, discardHandCard, discardDrawnCard,
    forcedDiscard, attackCard, oppDraw, oppDiscard, swap,
  };

})();
