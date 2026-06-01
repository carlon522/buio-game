'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  BUIO — Card Physics Engine
//
//  Frame-by-frame physics animation using requestAnimationFrame.
//  No CSS transitions. Every ghost has:
//    • Parabolic arc  (card rises/falls naturally mid-flight)
//    • Rotation       (card tilts/spins as it travels)
//    • Size lerp      (for opponent cards shrinking/growing)
//    • Easing curve   (smooth acceleration/deceleration)
//
//  All ghosts are face-down. No in-flight flips.
//  Special card reveals (nove9, peek) are handled by renderMyHand state.
// ═══════════════════════════════════════════════════════════════════════════

const Cards = (() => {

  // ── Easing ────────────────────────────────────────────────────────────────
  function easeOut(t)   { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2; }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function cw() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cw')) || 66; }
  function ch() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ch')) || 100; }
  function lerp(a, b, t) { return a + (b - a) * t; }

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

  // ── Core physics ghost ────────────────────────────────────────────────────
  //
  //  from, to  : DOMRect
  //  p         : physics profile {
  //    dur       : ms
  //    z         : z-index
  //    arc       : px to lift at midpoint (negative = upward arc)
  //    rotation  : max degrees at peak (returns to 0 at destination)
  //    toW, toH  : destination size (defaults to card size)
  //    ease      : easing function
  //    onLand(g) : callback when animation completes
  //  }
  //
  function fly(from, to, p) {
    p = p || {};
    if (!from || !to) { if (p.onLand) p.onLand(null); return null; }

    const toW    = p.toW  || cw();
    const toH    = p.toH  || ch();
    const dur    = p.dur  || 420;
    const z      = p.z    || 9990;
    const arc    = p.arc  || 0;
    const rotMax = p.rotation || 0;
    const easeFn = p.ease || easeOut;

    // Centre points
    const sx = from.left + from.width  / 2;
    const sy = from.top  + from.height / 2;
    const ex = to.left   + to.width    / 2;
    const ey = to.top    + to.height   / 2;

    // Create ghost
    const g = document.createElement('div');
    g.className = 'card-3d card-back';
    g.style.cssText = [
      'position:fixed',
      'left:' + from.left + 'px',
      'top:'  + from.top  + 'px',
      'width:'  + from.width  + 'px',
      'height:' + from.height + 'px',
      'z-index:' + z,
      'margin:0',
      'overflow:hidden',
      'border-radius:6px',
      'box-shadow:0 8px 28px rgba(0,0,0,.7)',
      'pointer-events:none',
      'will-change:transform',
      'transform-origin:center center',
    ].join(';');
    document.body.appendChild(g);

    const t0 = performance.now();

    function frame(now) {
      const raw = Math.min((now - t0) / dur, 1); // 0 → 1 linear
      const e   = easeFn(raw);                    // eased

      // Position: lerp centres, then offset by half of current size
      const w = lerp(from.width,  toW, e);
      const h = lerp(from.height, toH, e);
      const cx = lerp(sx, ex, e);
      const cy = lerp(sy, ey, e) + arc * Math.sin(Math.PI * raw); // arc at midpoint

      g.style.left   = (cx - w / 2) + 'px';
      g.style.top    = (cy - h / 2) + 'px';
      g.style.width  = w + 'px';
      g.style.height = h + 'px';

      // Rotation peaks at midpoint, zeroes at destination
      const rot = rotMax * Math.sin(Math.PI * raw);
      g.style.transform = rot ? 'rotate(' + rot.toFixed(2) + 'deg)' : '';

      if (raw < 1) {
        requestAnimationFrame(frame);
      } else {
        g.style.transform = '';
        if (p.onLand) p.onLand(g);
      }
    }

    requestAnimationFrame(frame);
    return g;
  }

  // ── Physics profiles ──────────────────────────────────────────────────────

  // Gentle slide out of deck into drawn-slot
  function DRAW_PROFILE(onLand) {
    return { dur: 370, z: 9995, arc: 10, rotation: 4, ease: easeOut, onLand };
  }

  // Natural throw to discard pile
  function THROW_PROFILE(onLand) {
    return { dur: 360, z: 9999, arc: -50, rotation: -14, ease: easeOut, onLand };
  }

  // Smooth slide into hand position
  function SLIDE_PROFILE(onLand) {
    return { dur: 400, z: 9998, arc: -15, rotation: 2, ease: easeInOut, onLand };
  }

  // Aggressive attack throw
  function ATTACK_PROFILE(onLand) {
    return { dur: 300, z: 9999, arc: -70, rotation: -20, ease: easeOut, onLand };
  }

  // Opponent card shrinking into seat
  function OPP_DRAW_PROFILE(onLand) {
    return { dur: 460, z: 9990, arc: -18, rotation: 6, toW: 28, toH: 43, ease: easeOut, onLand };
  }

  // Opponent card growing from seat to pile
  function OPP_DISC_PROFILE(onLand) {
    return { dur: 400, z: 9995, arc: -40, rotation: -10, ease: easeOut, onLand };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  // 1. DRAW: deck → drawn-slot
  function drawFromDeck(onReveal) {
    var dk   = rect(document.getElementById('deck-pile'));
    var slot = drawnCardRect() || rect(document.getElementById('drawn-slot'));
    if (!dk || !slot) { if (onReveal) onReveal(); return; }
    fly(dk, slot, DRAW_PROFILE(function(g) { g.remove(); if (onReveal) onReveal(); }));
  }

  // 2. DISCARD HAND CARD: discarded → pile + drawn → last slot (both simultaneously)
  //    opts: { handSlotRect, pileRect, drawnSlotRect, lastSlotRect, onPileLand, onHandLand }
  function discardHandCard(opts) {
    fly(opts.handSlotRect, opts.pileRect,
      THROW_PROFILE(function(g) { g.remove(); if (opts.onPileLand) opts.onPileLand(); }));

    if (opts.drawnSlotRect && opts.lastSlotRect) {
      fly(opts.drawnSlotRect, opts.lastSlotRect,
        SLIDE_PROFILE(function(g) { g.remove(); if (opts.onHandLand) opts.onHandLand(); }));
    } else {
      setTimeout(function() { if (opts.onHandLand) opts.onHandLand(); }, 450);
    }
  }

  // 3. DISCARD DRAWN CARD: drawn-slot → pile
  function discardDrawnCard(opts) {
    if (!opts.drawnSlotRect || !opts.pileRect) { if (opts.onLand) opts.onLand(); return; }
    fly(opts.drawnSlotRect, opts.pileRect,
      THROW_PROFILE(function(g) { g.remove(); if (opts.onLand) opts.onLand(); }));
  }

  // 4. FORCED DISCARD: hand → pile + deck → same slot
  function forcedDiscard(opts) {
    fly(opts.handSlotRect, opts.pileRect,
      THROW_PROFILE(function(g) { g.remove(); if (opts.onPileLand) opts.onPileLand(); }));

    if (opts.deckRect && opts.targetSlotRect) {
      fly(opts.deckRect, opts.targetSlotRect,
        SLIDE_PROFILE(function(g) { g.remove(); if (opts.onDeckLand) opts.onDeckLand(); }));
    } else {
      setTimeout(function() { if (opts.onDeckLand) opts.onDeckLand(); }, 450);
    }
  }

  // 5. ATTACK: aggressive throw
  function attackCard(handSlotRect, pileRect, onLand) {
    if (!handSlotRect || !pileRect) { if (onLand) onLand(); return; }
    fly(handSlotRect, pileRect,
      ATTACK_PROFILE(function(g) { g.remove(); if (onLand) onLand(); }));
  }

  // 6. OPPONENT DRAW: deck (full size) → seat (mini)
  function oppDraw(deckRect, seatTargetRect, onLand) {
    if (!deckRect || !seatTargetRect) { if (onLand) onLand(); return; }
    fly(deckRect, seatTargetRect,
      OPP_DRAW_PROFILE(function(g) { g.remove(); if (onLand) onLand(); }));
  }

  // 7. OPPONENT DISCARD: seat → pile (grows to full size)
  function oppDiscard(seat, pileRect, onLand) {
    var from = seatCardsRect(seat);
    if (!from || !pileRect) { if (onLand) onLand(); return; }
    var p = OPP_DISC_PROFILE(function(g) { g.remove(); if (onLand) onLand(); });
    p.toW = cw(); p.toH = ch();
    fly(from, pileRect, p);
  }

  // 8. SWAP: two cards cross mid-air
  function swap(rectA, rectB, onDone) {
    if (!rectA || !rectB) { if (onDone) onDone(); return; }
    fly(rectA, rectB, { dur: 520, z: 9992, arc: -60, rotation:  12, ease: easeInOut,
      onLand: function(g) { g.remove(); } });
    fly(rectB, rectA, { dur: 520, z: 9991, arc:  60, rotation: -12, ease: easeInOut,
      onLand: function(g) { g.remove(); if (onDone) onDone(); } });
  }

  return {
    rect, drawnCardRect, seatCardsRect,
    drawFromDeck, discardHandCard, discardDrawnCard,
    forcedDiscard, attackCard, oppDraw, oppDiscard, swap,
  };

})();
