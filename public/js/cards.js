'use strict';

const Cards = (() => {
  const D = {
    draw: 900,
    keep: 950,
    discard: 980,
    forced: 980,
    attack: 820,
    opponent: 980,
    swap: 1100,
  };

  function cw() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cw')) || 68; }
  function ch() { return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ch')) || 104; }
  function miniW() { return window.matchMedia('(max-width:600px)').matches ? 24 : 28; }
  function miniH() { return window.matchMedia('(max-width:600px)').matches ? 37 : 43; }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function rect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return (r.width || r.height) ? r : null;
  }

  function drawnCardRect() {
    return rect(document.querySelector('#drawn-card-display .card-3d')) || rect(document.getElementById('drawn-slot'));
  }

  function seatCardsRect(seat) {
    if (!seat) return null;
    const cards = [...seat.querySelectorAll('.mini-card:not(.mini-incoming):not(.opp-drawn-card)')];
    return rect(cards[cards.length - 1]) || rect(seat.querySelector('.seat-cards')) || rect(seat);
  }

  function faceUp(card) {
    return !!(card && card.known && card.suit && card.value);
  }

  function ghostHTML(card) {
    if (!faceUp(card)) return '';
    const color = card.color === 'red' ? 'red' : 'black';
    return `<img src="/cards/${esc(card.suit)}_${esc(card.value)}.jpg" class="card-img" alt="${esc(card.label)}"
      onerror="this.style.display='none';makeFB(this.parentElement,'${esc(card.label)}','${esc(card.symbol)}','${color}')">`;
  }

  function makeGhost(from, opts = {}) {
    const g = document.createElement('div');
    const card = opts.face === 'down' ? null : opts.card;
    g.className = `${faceUp(card) ? 'card-3d card-front' : 'card-3d card-back'} card-ghost ${opts.className || ''}`.trim();
    g.innerHTML = ghostHTML(card);
    Object.assign(g.style, {
      position: 'fixed',
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
      margin: '0',
      zIndex: String(opts.z || 9990),
      pointerEvents: 'none',
      boxShadow: opts.shadow || '0 10px 30px rgba(0,0,0,.72)',
      transformOrigin: 'center center',
      willChange: 'left,top,width,height,transform,opacity',
    });
    document.body.appendChild(g);
    return g;
  }

  function ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function targetTopLeft(from, to, opts) {
    const w = opts.toW || from.width || cw();
    const h = opts.toH || from.height || ch();
    return {
      left: to.left + to.width / 2 - w / 2,
      top: to.top + to.height / 2 - h / 2,
      width: w,
      height: h,
    };
  }

  function fly(opts) {
    const { from, to } = opts;
    if (!from || !to) {
      opts.onDone?.();
      return null;
    }

    const duration = opts.duration || D.discard;
    const end = targetTopLeft(from, to, opts);
    const start = {
      left: from.left,
      top: from.top,
      width: from.width,
      height: from.height,
    };
    const arc = opts.arc ?? -55;
    const spin = opts.spin ?? 0;
    const g = makeGhost(from, opts);
    const started = performance.now();

    function frame(now) {
      const raw = Math.min(1, (now - started) / duration);
      const t = ease(raw);
      const lift = Math.sin(Math.PI * raw) * arc;
      g.style.left = `${lerp(start.left, end.left, t)}px`;
      g.style.top = `${lerp(start.top, end.top, t) + lift}px`;
      g.style.width = `${lerp(start.width, end.width, t)}px`;
      g.style.height = `${lerp(start.height, end.height, t)}px`;
      g.style.transform = `rotate(${Math.sin(Math.PI * raw) * spin}deg)`;
      g.style.opacity = String(lerp(1, opts.endOpacity ?? 1, Math.max(0, raw - 0.8) / 0.2));

      if (raw < 1) {
        requestAnimationFrame(frame);
        return;
      }
      opts.onDone?.(g);
    }

    requestAnimationFrame(frame);
    return g;
  }

  function removeOnDone(done) {
    return g => {
      g?.remove();
      done?.();
    };
  }

  function drawFromDeck(onDone) {
    fly({
      from: rect(document.getElementById('deck-pile')),
      to: drawnCardRect() || rect(document.getElementById('drawn-slot')),
      duration: D.draw,
      arc: 26,
      spin: 4,
      face: 'down',
      z: 9995,
      onDone: removeOnDone(onDone),
    });
  }

  function discardDrawnCard(opts) {
    fly({
      from: opts.drawnSlotRect,
      to: opts.pileRect,
      card: opts.card,
      duration: D.discard,
      arc: -70,
      spin: -10,
      z: 9999,
      onDone: removeOnDone(opts.onLand),
    });
  }

  function discardHandCard(opts) {
    fly({
      from: opts.handSlotRect,
      to: opts.pileRect,
      card: opts.discardCard,
      face: opts.discardFace || 'auto',
      duration: D.discard,
      arc: -72,
      spin: -9,
      z: 9999,
      onDone: removeOnDone(opts.onPileLand),
    });

    fly({
      from: opts.drawnSlotRect,
      to: opts.appendSlotRect,
      card: opts.drawnCard,
      face: opts.drawnFace || 'auto',
      duration: D.keep,
      arc: -24,
      spin: 4,
      z: 9998,
      onDone: removeOnDone(opts.onHandLand),
    });
  }

  function forcedDiscard(opts) {
    fly({
      from: opts.handSlotRect,
      to: opts.pileRect,
      card: opts.discardCard,
      face: opts.discardFace || 'auto',
      duration: D.forced,
      arc: -72,
      spin: -9,
      z: 9999,
      onDone: removeOnDone(opts.onPileLand),
    });

    fly({
      from: opts.deckRect,
      to: opts.appendSlotRect || opts.targetSlotRect,
      card: opts.drawCard,
      face: opts.drawFace || 'down',
      duration: D.keep,
      arc: -26,
      spin: 4,
      z: 9998,
      onDone: removeOnDone(opts.onDeckLand),
    });
  }

  function attackCard(handSlotRect, pileRect, onLand, card) {
    fly({
      from: handSlotRect,
      to: pileRect,
      card,
      duration: D.attack,
      arc: -86,
      spin: -14,
      z: 9999,
      onDone: removeOnDone(onLand),
    });
  }

  function oppDraw(deckRect, seatTargetRect, onLand) {
    fly({
      from: deckRect,
      to: seatTargetRect,
      toW: miniW(),
      toH: miniH(),
      face: 'down',
      duration: D.opponent,
      arc: -32,
      spin: 5,
      z: 9990,
      onDone: removeOnDone(onLand),
    });
  }

  function oppDiscard(fromRect, pileRect, onLand, card, face = 'down') {
    fly({
      from: fromRect,
      to: pileRect,
      card,
      face,
      toW: cw(),
      toH: ch(),
      duration: D.opponent,
      arc: -58,
      spin: -8,
      z: 9995,
      onDone: removeOnDone(onLand),
    });
  }

  function oppKeepDrawn(drawnRect, handRect, onLand) {
    fly({
      from: drawnRect,
      to: handRect,
      face: 'down',
      toW: miniW(),
      toH: miniH(),
      duration: D.opponent,
      arc: -20,
      spin: 3,
      z: 9994,
      onDone: removeOnDone(onLand),
    });
  }

  function swap(rectA, rectB, onDone) {
    let done = 0;
    const oneDone = () => {
      done++;
      if (done === 2) onDone?.();
    };
    fly({ from: rectA, to: rectB, face: 'down', duration: D.swap, arc: -70, spin: 9, z: 9992, onDone: removeOnDone(oneDone) });
    fly({ from: rectB, to: rectA, face: 'down', duration: D.swap, arc: 70, spin: -9, z: 9991, onDone: removeOnDone(oneDone) });
  }

  return {
    rect,
    drawnCardRect,
    seatCardsRect,
    drawFromDeck,
    discardDrawnCard,
    discardHandCard,
    forcedDiscard,
    attackCard,
    oppDraw,
    oppDiscard,
    oppKeepDrawn,
    swap,
    durations: D,
  };
})();
