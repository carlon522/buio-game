'use strict';
// ── Card Animation Engine v3 ──────────────────────────────────────────────
//
//  Every card move = a ghost div that travels from A to B.
//  No in-flight flips. The ONE exception: when a drawn card enters the hand
//  it arrives face-up (player sees it), then flips face-down in place.
//  That flip happens AFTER the position transition is complete — no overlap.
//
//  API:
//    Cards.drawFromDeck(onReveal)
//    Cards.discardHandCard({ handSlotRect, pileRect, drawnSlotRect,
//                            lastSlotRect, drawnCard, onPileLand, onHandLand })
//    Cards.discardDrawnCard({ drawnSlotRect, pileRect, card, onLand })
//    Cards.forcedDiscard({ handSlotRect, pileRect, deckRect,
//                          targetSlotRect, onPileLand, onDeckLand })
//    Cards.attackCard(handSlotRect, pileRect, onLand)
//    Cards.oppDraw(deckRect, seatRect, onLand)
//    Cards.oppDiscard(seat, pileRect, onLand)
//    Cards.swap(rectA, rectB, onDone)
//    Cards.rect(el)  — null-safe getBoundingClientRect
//    Cards.drawnCardRect()  — rect of card inside drawn-card-display
//    Cards.seatCardsRect(seat) — rect of last mini-card in seat

const Cards = (() => {

  // ── helpers ───────────────────────────────────────────────────────────────

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

  // ── ghost factory ─────────────────────────────────────────────────────────
  // Creates a fixed-position ghost div, starts it at `from`, moves it to `to`.
  // opts.faceUp / opts.card  — show card face instead of back
  // opts.toW / opts.toH      — destination size (defaults to --cw/--ch)
  // opts.dur                 — transition duration ms
  // opts.z                   — z-index
  // opts.onLand(g)           — fires dur+30ms after creation; ghost NOT auto-removed

  function fly(from, to, opts) {
    opts = opts || {};
    if (!from || !to) { if (opts.onLand) opts.onLand(null); return null; }

    const toW = opts.toW || getCW();
    const toH = opts.toH || getCH();
    const dur = opts.dur || 400;
    const z   = opts.z   || 9990;

    const g = document.createElement('div');
    if (opts.faceUp && opts.card) {
      g.className        = 'card-3d card-front';
      g.style.background = '#f5f0e8';
      g.innerHTML        = '<img src="/cards/' + opts.card.suit + '_' + opts.card.value + '.jpg" class="card-img">';
    } else {
      g.className = 'card-3d card-back';
    }

    g.style.position      = 'fixed';
    g.style.left          = from.left   + 'px';
    g.style.top           = from.top    + 'px';
    g.style.width         = from.width  + 'px';
    g.style.height        = from.height + 'px';
    g.style.zIndex        = String(z);
    g.style.margin        = '0';
    g.style.overflow      = 'hidden';
    g.style.borderRadius  = '6px';
    g.style.boxShadow     = '0 6px 20px rgba(0,0,0,.65)';
    g.style.pointerEvents = 'none';
    g.style.transition    = 'none';
    document.body.appendChild(g);

    // centre the ghost in the destination rect
    const tx = to.left + to.width  / 2 - toW / 2;
    const ty = to.top  + to.height / 2 - toH / 2;

    requestAnimationFrame(function() { requestAnimationFrame(function() {
      g.style.transition = 'left '  + dur + 'ms ' + EASE + ','
                         + 'top '   + dur + 'ms ' + EASE + ','
                         + 'width ' + dur + 'ms ' + EASE + ','
                         + 'height '+ dur + 'ms ' + EASE;
      g.style.left   = tx   + 'px';
      g.style.top    = ty   + 'px';
      g.style.width  = toW  + 'px';
      g.style.height = toH  + 'px';
    }); });

    var t = setTimeout(function() { if (opts.onLand) opts.onLand(g); }, dur + 30);
    g._landTimer = t; // stored so callers can cancel if needed
    return g;
  }

  // Flip a ghost from face-up to face-down IN PLACE (after it has landed).
  // Position transitions are done by this point so transition override is safe.
  function flipToBack(g, onDone) {
    if (!g) { if (onDone) onDone(); return; }
    // fold in
    g.style.transition = 'transform .13s ease-in';
    g.style.transform  = 'scaleX(0)';
    setTimeout(function() {
      // swap to back face
      g.className        = 'card-3d card-back';
      g.innerHTML        = '';
      g.style.background = '';
      // fold out
      g.style.transition = 'transform .13s ease-out';
      g.style.transform  = 'scaleX(1)';
      setTimeout(function() { if (onDone) onDone(); }, 140);
    }, 140);
  }

  // ── public moves ─────────────────────────────────────────────────────────

  // 1. DRAW: deck → drawn-slot, face-down.
  //    onReveal() fires when ghost lands — caller shows drawn card content.
  function drawFromDeck(onReveal) {
    var dk   = rect(document.getElementById('deck-pile'));
    var slot = drawnCardRect() || rect(document.getElementById('drawn-slot'));
    if (!dk || !slot) { if (onReveal) onReveal(); return; }
    fly(dk, slot, { dur: 350, z: 9995,
      onLand: function(g) { g.remove(); if (onReveal) onReveal(); }
    });
  }

  // 2. DISCARD HAND CARD (normal turn):
  //    Ghost A — discarded card → pile, face-down.
  //    Ghost B — drawn card    → rightmost slot, arrives face-up then flips face-down.
  //    opts: { handSlotRect, pileRect, drawnSlotRect, lastSlotRect, drawnCard,
  //            onPileLand, onHandLand }
  function discardHandCard(opts) {
    // Ghost A: discard → pile
    fly(opts.handSlotRect, opts.pileRect, { dur: 400, z: 9999,
      onLand: function(g) { g.remove(); if (opts.onPileLand) opts.onPileLand(); }
    });

    // Ghost B: drawn card → last hand slot
    if (opts.drawnSlotRect && opts.lastSlotRect) {
      fly(opts.drawnSlotRect, opts.lastSlotRect,
        { faceUp: true, card: opts.drawnCard, dur: 400, z: 9998,
          onLand: function(g) {
            // card arrived face-up — now flip face-down so it's hidden in hand
            flipToBack(g, function() {
              g.remove();
              if (opts.onHandLand) opts.onHandLand();
            });
          }
        }
      );
    } else {
      setTimeout(function() { if (opts.onHandLand) opts.onHandLand(); }, 450);
    }
  }

  // 3. DISCARD DRAWN CARD: drawn-slot → pile, face-up (already visible).
  //    opts: { drawnSlotRect, pileRect, card, onLand }
  function discardDrawnCard(opts) {
    if (!opts.drawnSlotRect || !opts.pileRect) { if (opts.onLand) opts.onLand(); return; }
    fly(opts.drawnSlotRect, opts.pileRect,
      { faceUp: true, card: opts.card, dur: 380, z: 9999,
        onLand: function(g) { g.remove(); if (opts.onLand) opts.onLand(); }
      }
    );
  }

  // 4. FORCED DISCARD: hand → pile (face-down) + deck → same slot (face-down).
  //    opts: { handSlotRect, pileRect, deckRect, targetSlotRect, onPileLand, onDeckLand }
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

  // 5. ATTACK: hand → pile, face-down.
  function attackCard(handSlotRect, pileRect, onLand) {
    if (!handSlotRect || !pileRect) { if (onLand) onLand(); return; }
    fly(handSlotRect, pileRect, { dur: 360, z: 9999,
      onLand: function(g) { g.remove(); if (onLand) onLand(); }
    });
  }

  // 6. OPPONENT DRAW: deck (full size) → seat mini slot (shrinks in flight).
  function oppDraw(deckRect, seatTargetRect, onLand) {
    if (!deckRect || !seatTargetRect) { if (onLand) onLand(); return; }
    fly(deckRect, seatTargetRect, { toW: 28, toH: 43, dur: 450, z: 9990,
      onLand: function(g) { g.remove(); if (onLand) onLand(); }
    });
  }

  // 7. OPPONENT DISCARD: seat mini → pile (full size), face-down.
  //    renderDiscardPile shows the card face-up after ghost lands.
  function oppDiscard(seat, pileRect, onLand) {
    var from = seatCardsRect(seat);
    if (!from || !pileRect) { if (onLand) onLand(); return; }
    fly(from, pileRect, { toW: getCW(), toH: getCH(), dur: 420, z: 9995,
      onLand: function(g) { g.remove(); if (onLand) onLand(); }
    });
  }

  // 8. SWAP: two rects cross each other (card 8 special).
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
