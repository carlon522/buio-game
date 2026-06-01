'use strict';
// ── Card Animation Engine v4 ──────────────────────────────────────────────
//
//  Cards travel in their actual visual state:
//  - Face-down cards (unknown) fly face-down.
//  - Face-up cards (known/drawn) fly face-up.
//  - When the drawn card enters the hand it flips face-down on arrival
//    (it's now hidden in the hand). That is the ONLY flip.
//  - No random in-place reveals. No _tempRevealServerIdx. Nothing else turns.

const Cards = (() => {

  function getCW() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cw'))||66; }
  function getCH() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ch'))||100; }

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
    const all = [...seat.querySelectorAll('.mini-card:not(.mini-incoming)')];
    return rect(all[all.length - 1])
        || rect(seat.querySelector('.seat-cards'))
        || rect(seat);
  }

  const EASE = 'cubic-bezier(.25,.46,.45,.94)';

  // Core fly function. opts.faceUp + opts.card = show card face.
  function fly(from, to, opts) {
    opts = opts || {};
    if (!from || !to) { if (opts.onLand) opts.onLand(null); return null; }

    const toW = opts.toW || getCW();
    const toH = opts.toH || getCH();
    const dur = opts.dur || 400;
    const z   = opts.z   || 9990;

    const g = document.createElement('div');
    if (opts.faceUp && opts.card) {
      g.className = 'card-3d card-front';
      g.style.background = '#f5f0e8';
      g.innerHTML = '<img src="/cards/' + opts.card.suit + '_' + opts.card.value + '.jpg" class="card-img">';
    } else {
      g.className = 'card-3d card-back';
    }
    g.style.cssText = [
      'position:fixed',
      'left:'   + from.left   + 'px',
      'top:'    + from.top    + 'px',
      'width:'  + from.width  + 'px',
      'height:' + from.height + 'px',
      'z-index:' + z,
      'margin:0',
      'overflow:hidden',
      'border-radius:6px',
      'box-shadow:0 6px 20px rgba(0,0,0,.65)',
      'pointer-events:none',
      'transition:none',
    ].join(';');
    // faceUp styles added above as className+background, cssText would overwrite, so re-apply:
    if (opts.faceUp && opts.card) {
      g.style.background = '#f5f0e8';
    }
    document.body.appendChild(g);

    const tx = to.left + to.width  / 2 - toW / 2;
    const ty = to.top  + to.height / 2 - toH / 2;

    requestAnimationFrame(function() { requestAnimationFrame(function() {
      g.style.transition = [
        'left '   + dur + 'ms ' + EASE,
        'top '    + dur + 'ms ' + EASE,
        'width '  + dur + 'ms ' + EASE,
        'height ' + dur + 'ms ' + EASE,
      ].join(',');
      g.style.left   = tx + 'px';
      g.style.top    = ty + 'px';
      g.style.width  = toW + 'px';
      g.style.height = toH + 'px';
    }); });

    setTimeout(function() { if (opts.onLand) opts.onLand(g); }, dur + 30);
    return g;
  }

  // 1. DRAW: deck → drawn-slot (face-down ghost). onReveal shows drawn card.
  function drawFromDeck(onReveal) {
    var dk   = rect(document.getElementById('deck-pile'));
    var slot = drawnCardRect() || rect(document.getElementById('drawn-slot'));
    if (!dk || !slot) { if (onReveal) onReveal(); return; }
    fly(dk, slot, { dur: 350, z: 9995,
      onLand: function(g) { g.remove(); if (onReveal) onReveal(); }
    });
  }

  // 2. DISCARD HAND CARD:
  //    Ghost A — discarded card → pile, face-down.
  //    Ghost B — drawn card → rightmost slot, face-down (it enters the hand hidden).
  function discardHandCard(opts) {
    fly(opts.handSlotRect, opts.pileRect, { dur: 400, z: 9999,
      onLand: function(g) { g.remove(); if (opts.onPileLand) opts.onPileLand(); }
    });
    if (opts.drawnSlotRect && opts.lastSlotRect) {
      fly(opts.drawnSlotRect, opts.lastSlotRect, { dur: 400, z: 9998,
        onLand: function(g) { g.remove(); if (opts.onHandLand) opts.onHandLand(); }
      });
    } else {
      setTimeout(function() { if (opts.onHandLand) opts.onHandLand(); }, 450);
    }
  }

  // 3. DISCARD DRAWN CARD: drawn-slot → pile (face-UP, already visible).
  function discardDrawnCard(opts) {
    if (!opts.drawnSlotRect || !opts.pileRect) { if (opts.onLand) opts.onLand(); return; }
    fly(opts.drawnSlotRect, opts.pileRect,
      { faceUp: !!(opts.card && opts.card.known), card: opts.card,
        dur: 380, z: 9999,
        onLand: function(g) { g.remove(); if (opts.onLand) opts.onLand(); }
      }
    );
  }

  // 4. FORCED DISCARD: hand→pile (face-down) + deck→slot (face-down).
  function forcedDiscard(opts) {
    fly(opts.handSlotRect, opts.pileRect, { dur: 400, z: 9999,
      onLand: function(g) { g.remove(); if (opts.onPileLand) opts.onPileLand(); }
    });
    if (opts.deckRect && opts.targetSlotRect) {
      fly(opts.deckRect, opts.targetSlotRect, { dur: 400, z: 9998,
        onLand: function(g) { g.remove(); if (opts.onDeckLand) opts.onDeckLand(); }
      });
    } else {
      setTimeout(function() { if (opts.onDeckLand) opts.onDeckLand(); }, 450);
    }
  }

  // 5. ATTACK: hand → pile (face-down).
  function attackCard(handSlotRect, pileRect, onLand) {
    if (!handSlotRect || !pileRect) { if (onLand) onLand(); return; }
    fly(handSlotRect, pileRect, { dur: 360, z: 9999,
      onLand: function(g) { g.remove(); if (onLand) onLand(); }
    });
  }

  // 6. OPPONENT DRAW: deck (full) → seat mini slot (shrinks).
  function oppDraw(deckRect, seatTargetRect, onLand) {
    if (!deckRect || !seatTargetRect) { if (onLand) onLand(); return; }
    fly(deckRect, seatTargetRect, { toW: 28, toH: 43, dur: 450, z: 9990,
      onLand: function(g) { g.remove(); if (onLand) onLand(); }
    });
  }

  // 7. OPPONENT DISCARD: seat → pile (mini→full, face-down).
  function oppDiscard(seat, pileRect, onLand) {
    var from = seatCardsRect(seat);
    if (!from || !pileRect) { if (onLand) onLand(); return; }
    fly(from, pileRect, { toW: getCW(), toH: getCH(), dur: 420, z: 9995,
      onLand: function(g) { g.remove(); if (onLand) onLand(); }
    });
  }

  // 8. SWAP.
  function swap(rectA, rectB, onDone) {
    if (!rectA || !rectB) { if (onDone) onDone(); return; }
    fly(rectA, rectB, { dur: 500, z: 9992, onLand: function(g) { g.remove(); } });
    fly(rectB, rectA, { dur: 500, z: 9991,
      onLand: function(g) { g.remove(); if (onDone) onDone(); }
    });
  }

  return {
    rect, drawnCardRect, seatCardsRect,
    drawFromDeck, discardHandCard, discardDrawnCard,
    forcedDiscard, attackCard, oppDraw, oppDiscard, swap,
  };

})();
