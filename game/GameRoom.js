const { createDeck, shuffle } = require('./Deck');

const INITIAL_LIVES = 3;
const CARDS_PER_PLAYER = 4;

class GameRoom {
  constructor(id, hostUserId, hostUsername, name, maxPlayers = 4) {
    this.id = id;
    this.name = name;
    this.hostUserId = String(hostUserId);
    this.maxPlayers = Math.min(Math.max(maxPlayers, 2), 8);
    this.status = 'waiting';
    this.phase = 'waiting';
    this.players = [];
    this.deck = [];
    this.discardPile = [];
    this.currentPlayerIndex = 0;
    this.drawnCard = null;
    this.lastDiscard = null;
    this.attackWindowAttackers = new Set();
    this.knockedBy = null;
    this.lastRound = false;
    this.lastRoundQueue = [];
    this.roundNumber = 0;
    this.readyPlayers = new Set();
    this.addPlayer(hostUserId, hostUsername, null);
  }

  addPlayer(userId, username, socketId) {
    const uid = String(userId);
    const existing = this.players.find(p => p.userId === uid);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      return true;
    }
    if (this.players.length >= this.maxPlayers) return false;
    this.players.push({
      userId: uid, username, socketId,
      hand: [],
      lives: INITIAL_LIVES,
      seenCards: new Set(),
      penalized: false,
      connected: !!socketId,
      isEliminated: false,
      score: null
    });
    return true;
  }

  removePlayer(userId) {
    const idx = this.players.findIndex(p => p.userId === userId);
    if (idx === -1) return;
    if (this.status === 'waiting') {
      this.players.splice(idx, 1);
      if (this.hostUserId === userId && this.players.length > 0) {
        this.hostUserId = this.players[0].userId;
      }
    } else {
      this.players[idx].connected = false;
    }
  }

  canStart() {
    return this.players.length >= 2 && this.status === 'waiting';
  }

  startGame() {
    this.status = 'playing';
    this.roundNumber = 1;
    this._dealRound();
  }

  _dealRound() {
    this.deck = createDeck();
    this.discardPile = [];
    this.drawnCard = null;
    this.lastDiscard = null;
    this.knockedBy = null;
    this.lastRound = false;
    this.lastRoundQueue = [];
    this.attackWindowAttackers = new Set();
    this.attackAnnouncer = null;
    this.forcedDiscardNext = false;
    this._pendingForcedDiscardDraw = false; // true when special fires during forced-discard
    this.readyPlayers = new Set();

    for (const p of this.getActivePlayers()) {
      p.hand = [];
      p.seenCards = new Set();
      p.penalized = false;
      p.score = null;
      for (let i = 0; i < CARDS_PER_PLAYER; i++) p.hand.push(this.deck.pop());
    }

    // Seed discard pile
    this.discardPile.push(this.deck.pop());
    this.phase = 'peek';
    this.currentPlayerIndex = this._nextActiveIndex(-1);
  }

  getActivePlayers() {
    return this.players.filter(p => !p.isEliminated);
  }

  _nextActiveIndex(from) {
    const total = this.players.length;
    let idx = (from + 1) % total;
    for (let i = 0; i < total; i++) {
      if (!this.players[idx].isEliminated) return idx;
      idx = (idx + 1) % total;
    }
    return 0;
  }

  playerReady(userId) {
    this.readyPlayers.add(userId);
    return this.readyPlayers.size >= this.getActivePlayers().length;
  }

  endPeekPhase() {
    for (const p of this.getActivePlayers()) {
      p.seenCards.add(0);
      p.seenCards.add(1);
    }
    this.phase = 'draw';
  }

  getCurrentPlayer() {
    return this.players[this.currentPlayerIndex] || null;
  }

  drawFromDeck(userId) {
    if (this.phase !== 'draw') return { error: 'Not draw phase' };
    if (this.getCurrentPlayer()?.userId !== userId) return { error: 'Not your turn' };

    if (this.deck.length === 0) {
      const top = this.discardPile.pop();
      this.deck = shuffle(this.discardPile);
      this.discardPile = top ? [top] : [];
    }
    if (this.deck.length === 0) return { error: 'No cards left' };

    this.drawnCard = this.deck.pop();
    this.phase = 'discard';

    const player = this.players.find(p => p.userId === userId);
    const penalized = player?.penalized || false;

    return { drawnCard: penalized ? null : this.drawnCard, penalized, actualCard: this.drawnCard };
  }

  discardCard(userId, handIndex) {
    if (this.phase !== 'discard') return { error: 'Not discard phase' };
    if (this.getCurrentPlayer()?.userId !== userId) return { error: 'Not your turn' };
    if (!this.drawnCard) return { error: 'No drawn card' };

    const player = this.players.find(p => p.userId === userId);
    let discardedCard;

    if (handIndex === -1) {
      discardedCard = this.drawnCard;
    } else {
      if (handIndex < 0 || handIndex >= player.hand.length) return { error: 'Invalid index' };
      discardedCard = player.hand[handIndex];
      player.hand[handIndex] = this.drawnCard;
      player.seenCards.add(handIndex);
    }

    player.penalized = false;
    this.drawnCard = null;
    this.discardPile.push(discardedCard);
    this.lastDiscard = discardedCard;
    this.attackAnnouncer = null;

    // Special cards activate ON DISCARD
    if (discardedCard.value === 8 || discardedCard.value === 9) {
      this.phase = 'special'; // pause here until special action is completed
      return { discardedCard, success: true, specialType: discardedCard.value };
    }
    if (discardedCard.value === 10) {
      this.forcedDiscardNext = true; // next player must discard before drawing
    }

    return this._advanceTurn(discardedCard);
  }

  // Called after special card (8 or 9) action is completed
  completeSpecialAndAdvance() {
    if (this.phase !== 'special') return { error: 'Not special phase' };
    // If special fired during forced-discard, draw the replacement card now
    if (this._pendingForcedDiscardDraw) {
      this._pendingForcedDiscardDraw = false;
      const player = this.getCurrentPlayer();
      if (player) {
        if (this.deck.length === 0 && this.discardPile.length > 1) {
          const top = this.discardPile.pop();
          this.deck = shuffle(this.discardPile);
          this.discardPile = top ? [top] : [];
        }
        if (this.deck.length > 0) player.hand.push(this.deck.pop());
      }
    }
    return this._advanceTurn(null);
  }

  // For 10-card effect: ATOMIC — discard a hand card, auto-draw replacement, advance turn.
  // "Scarta prima di pescare" = discard → pick up → done. No second discard decision.
  forcedDiscardFromHand(userId, handIndex) {
    if (this.phase !== 'forced-discard') return { error: 'Not forced-discard phase' };
    if (this.getCurrentPlayer()?.userId !== userId) return { error: 'Not your turn' };

    const player = this.players.find(p => p.userId === userId);
    if (!player) return { error: 'Player not found' };
    if (handIndex < 0 || handIndex >= player.hand.length) return { error: 'Invalid card' };

    // 1. Discard the chosen hand card
    const discardedCard = player.hand.splice(handIndex, 1)[0];
    const newSeen = new Set();
    for (const idx of player.seenCards) {
      if (idx < handIndex) newSeen.add(idx);
      else if (idx > handIndex) newSeen.add(idx - 1);
    }
    player.seenCards = newSeen;
    this.discardPile.push(discardedCard);
    this.lastDiscard = discardedCard;

    // 2a. Special card (8 or 9): trigger special BEFORE drawing replacement
    if (discardedCard.value === 8 || discardedCard.value === 9) {
      this._pendingForcedDiscardDraw = true;
      this.phase = 'special';
      return { discardedCard, success: true, specialType: discardedCard.value };
    }

    // 2b. 10 card discarded during forced-discard: chain the effect
    if (discardedCard.value === 10) this.forcedDiscardNext = true;

    // 3. Automatically draw a replacement card, then advance turn
    let drawnCard = null;
    if (this.deck.length === 0 && this.discardPile.length > 1) {
      const top = this.discardPile.pop();
      this.deck = shuffle(this.discardPile);
      this.discardPile = top ? [top] : [];
    }
    if (this.deck.length > 0) {
      drawnCard = this.deck.pop();
      player.hand.push(drawnCard);
    }
    return this._advanceTurn(discardedCard, drawnCard);
  }

  _advanceTurn(discardedCard, drawnCard = null) {
    if (this.lastRound) {
      if (this.lastRoundQueue.length === 0) {
        const sr = this._scoreRound();
        return discardedCard ? { discardedCard, success: true, ...sr } : { success: true, ...sr };
      }
      const nextId = this.lastRoundQueue.shift();
      if (!nextId) {
        const sr = this._scoreRound();
        return discardedCard ? { discardedCard, success: true, ...sr } : { success: true, ...sr };
      }
      const nextIdx = this.players.findIndex(p => p.userId === nextId);
      if (nextIdx !== -1 && !this.players[nextIdx].isEliminated) {
        this.currentPlayerIndex = nextIdx;
      } else if (this.lastRoundQueue.length === 0) {
        const sr = this._scoreRound();
        return discardedCard ? { discardedCard, success: true, ...sr } : { success: true, ...sr };
      } else {
        const fallbackId = this.lastRoundQueue.shift();
        const fallbackIdx = this.players.findIndex(p => p.userId === fallbackId);
        if (fallbackIdx !== -1) this.currentPlayerIndex = fallbackIdx;
        else { const sr = this._scoreRound(); return discardedCard ? { discardedCard, success: true, ...sr } : { success: true, ...sr }; }
      }
    } else {
      this.currentPlayerIndex = this._nextActiveIndex(this.currentPlayerIndex);
    }

    const nextPhase = this.forcedDiscardNext ? 'forced-discard' : 'draw';
    this.forcedDiscardNext = false;
    this.phase = nextPhase;
    return discardedCard ? { discardedCard, success: true } : { success: true };
  }

  useSpecial9(userId, cardIndex) {
    if (this.phase !== 'special') return { error: 'Not special phase' };
    if (this.getCurrentPlayer()?.userId !== userId) return { error: 'Not your turn' };

    const player = this.players.find(p => p.userId === userId);
    if (cardIndex < 0 || cardIndex >= player.hand.length) return { error: 'Invalid index' };

    player.seenCards.add(cardIndex);
    return { success: true, cardIndex, card: player.hand[cardIndex] };
  }

  useSpecial8(userId, targetUserId, targetCardIndex) {
    if (this.phase !== 'special') return { error: 'Not special phase' };
    if (this.getCurrentPlayer()?.userId !== userId) return { error: 'Not your turn' };

    const target = this.players.find(p => p.userId === targetUserId);
    if (!target || target.isEliminated) return { error: 'Invalid target' };
    if (targetCardIndex < 0 || targetCardIndex >= target.hand.length) return { error: 'Invalid target card' };

    const player = this.players.find(p => p.userId === userId);
    // Pick a random card from my own hand to swap with target's card
    // Actually: swap a specific card from my hand with target's card
    // The discard pile top card (the 8) is already discarded — we swap one of my hand cards
    if (targetCardIndex < 0 || targetCardIndex >= target.hand.length) return { error: 'Invalid target card' };

    // The swap: take one of the opponent's cards into MY hand at the end,
    // give them one of MY cards. The server picks which of my cards to swap.
    // Actually per rules: swap MY card (any) with opponent's card (any)
    const myCardIndex = 0; // default: swap first hand card
    const myCard = player.hand[myCardIndex];
    const targetCard = target.hand[targetCardIndex];

    player.hand[myCardIndex] = targetCard;
    target.hand[targetCardIndex] = myCard;
    // I now know position myCardIndex (I can see what I received)
    player.seenCards.add(myCardIndex);
    target.seenCards.delete(targetCardIndex); // target doesn't know what they got

    return { success: true };
  }

  // For special-8: choose which of MY cards to swap with an opponent's card
  useSpecial8Full(userId, myCardIndex, targetUserId, targetCardIndex) {
    if (this.phase !== 'special') return { error: 'Not special phase' };
    if (this.getCurrentPlayer()?.userId !== userId) return { error: 'Not your turn' };

    const player = this.players.find(p => p.userId === userId);
    const target = this.players.find(p => p.userId === targetUserId);
    if (!target || target.isEliminated) return { error: 'Invalid target' };
    if (myCardIndex < 0 || myCardIndex >= player.hand.length) return { error: 'Invalid own card' };
    if (targetCardIndex < 0 || targetCardIndex >= target.hand.length) return { error: 'Invalid target card' };

    const myCard = player.hand[myCardIndex];
    const targetCard = target.hand[targetCardIndex];

    player.hand[myCardIndex] = targetCard;
    target.hand[targetCardIndex] = myCard;
    player.seenCards.add(myCardIndex);   // I see what I received
    target.seenCards.delete(targetCardIndex); // they don't know what they got

    // Return both cards so the server can broadcast the swap animation to all
    return {
      success: true,
      initiatorCard: myCard,     // the card the initiator gave away
      targetCard: targetCard,    // the card the target gave away
      targetUserId: target.userId,
      targetUsername: target.username
    };
  }

  attack(userId, cardIndex) {
    // Attacks allowed any time during active gameplay
    if (!['draw', 'discard', 'forced-discard'].includes(this.phase)) return { error: 'Cannot attack now' };
    if (!this.discardPile.length) return { error: 'Nothing to attack' };

    const player = this.players.find(p => p.userId === userId);
    if (!player || player.isEliminated) return { error: 'Not in game' };
    if (cardIndex < 0 || cardIndex >= player.hand.length) return { error: 'Invalid card' };

    const attackCard = player.hand[cardIndex];
    const discardTop = this.discardPile[this.discardPile.length - 1];

    if (attackCard.value === discardTop.value) {
      // ✅ Correct — remove card from hand
      player.hand.splice(cardIndex, 1);
      const newSeen = new Set();
      for (const idx of player.seenCards) {
        if (idx < cardIndex) newSeen.add(idx);
        else if (idx > cardIndex) newSeen.add(idx - 1);
      }
      player.seenCards = newSeen;
      this.discardPile.push(attackCard);
      return { success: true, revealedCard: attackCard };
    } else {
      // ❌ Wrong — add an extra card from deck as penalty
      let penaltyCard = null;
      if (this.deck.length > 0) {
        penaltyCard = this.deck.pop();
        player.hand.push(penaltyCard); // face-down, not in seenCards
      }
      return { success: false, revealedCard: attackCard, penaltyCard };
    }
  }

  knock(userId) {
    if (this.phase !== 'draw') return { error: 'Not draw phase' };
    if (this.getCurrentPlayer()?.userId !== userId) return { error: 'Not your turn' };
    if (this.lastRound) return { error: 'Last round already started' };

    this.knockedBy = userId;
    this.lastRound = true;

    const active = this.getActivePlayers();
    const ki = active.findIndex(p => p.userId === userId);
    this.lastRoundQueue = [];
    for (let i = 1; i < active.length; i++) {
      const p = active[(ki + i) % active.length];
      this.lastRoundQueue.push(p.userId);
    }

    if (this.lastRoundQueue.length === 0) return this._scoreRound();

    const nextId = this.lastRoundQueue.shift();
    const nextIdx = this.players.findIndex(p => p.userId === nextId);
    this.currentPlayerIndex = nextIdx;
    this.phase = 'draw';
    return { success: true };
  }

  endAttackWindow() {
    if (this.phase !== 'attack-window') return { error: 'Not attack window phase' };
    this.attackWindowAttackers = new Set();
    this.attackAnnouncer = null;

    if (this.lastRound) {
      if (this.lastRoundQueue.length === 0) return this._scoreRound();
      const nextId = this.lastRoundQueue.shift();
      const nextIdx = this.players.findIndex(p => p.userId === nextId);
      if (nextIdx !== -1 && !this.players[nextIdx].isEliminated) {
        this.currentPlayerIndex = nextIdx;
      } else {
        if (this.lastRoundQueue.length === 0) return this._scoreRound();
        const fallback = this.lastRoundQueue.shift();
        this.currentPlayerIndex = this.players.findIndex(p => p.userId === fallback);
      }
      this.phase = 'draw';
      return { type: 'continue' };
    }

    this.currentPlayerIndex = this._nextActiveIndex(this.currentPlayerIndex);
    this.phase = 'draw';
    return { type: 'continue' };
  }

  _scoreRound() {
    this.phase = 'scoring';
    const active = this.getActivePlayers();
    const scores = active.map(p => {
      const score = p.hand.reduce((s, c) => s + c.value, 0);
      p.score = score;
      return { userId: p.userId, username: p.username, score, hand: [...p.hand] };
    });

    const maxScore = Math.max(...scores.map(s => s.score));
    const losers = scores.filter(s => s.score === maxScore).map(s => s.userId);

    for (const loserId of losers) {
      const p = this.players.find(pl => pl.userId === loserId);
      if (!p) continue;
      const penalty = this.knockedBy === loserId ? 2 : 1;
      p.lives = Math.max(0, p.lives - penalty);
      if (p.lives <= 0) p.isEliminated = true;
    }

    const remaining = this.players.filter(p => !p.isEliminated);
    if (remaining.length <= 1) {
      this.status = 'finished';
      this.phase = 'gameover';
      return { type: 'gameover', scores, losers, winner: remaining[0] || null, knockedBy: this.knockedBy };
    }

    return { type: 'scoring', scores, losers, knockedBy: this.knockedBy };
  }

  nextRound() {
    this.roundNumber++;
    this._dealRound();
  }

  getPublicState() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      phase: this.phase,
      roundNumber: this.roundNumber,
      hostUserId: this.hostUserId,
      maxPlayers: this.maxPlayers,
      currentPlayerUserId: this.getCurrentPlayer()?.userId || null,
      knockedBy: this.knockedBy,
      lastRound: this.lastRound,
      discardTop: this.discardPile.length ? this.discardPile[this.discardPile.length - 1] : null,
      deckCount: this.deck.length,
      lastDiscard: this.lastDiscard,
      players: this.players.map(p => ({
        userId: p.userId,
        username: p.username,
        lives: p.lives,
        cardCount: p.hand.length,
        isEliminated: p.isEliminated,
        connected: p.connected,
        penalized: p.penalized,
        isCurrentPlayer: this.getCurrentPlayer()?.userId === p.userId,
        score: p.score
      }))
    };
  }

  getPrivateState(userId) {
    const p = this.players.find(pl => pl.userId === userId);
    if (!p) return null;
    return {
      hand: p.hand.map((card, idx) =>
        p.seenCards.has(idx)
          ? { ...card, known: true, index: idx }
          : { id: card.id, known: false, index: idx }
      ),
      drawnCard: this.getCurrentPlayer()?.userId === userId && this.drawnCard
        ? (p.penalized ? { known: false, index: -1 } : { ...this.drawnCard, known: true, index: -1 })
        : null,
      penalized: p.penalized,
      seenIndices: [...p.seenCards]
    };
  }

  getPeekCards(userId) {
    const p = this.players.find(pl => pl.userId === userId);
    if (!p) return [];
    return [
      { ...p.hand[0], index: 0 },
      { ...p.hand[1], index: 1 }
    ];
  }
}

module.exports = GameRoom;
