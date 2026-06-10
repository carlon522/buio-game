'use strict';

const PROFILES = {
  easy: {
    knownCardUse: 0.35, keepImprovement: 4, knockScore: 16, knockConfidence: 0.45,
    attackChance: 0.38, mistakeChance: 0.12,
    timing: { think: [2800, 4200], reach: [1100, 1700], inspect: [2300, 3400], special: [1500, 2300], attack: [3300, 4600] },
  },
  medium: {
    knownCardUse: 0.8, keepImprovement: 1, knockScore: 11, knockConfidence: 0.5,
    attackChance: 0.72, mistakeChance: 0.045,
    timing: { think: [1900, 2900], reach: [800, 1250], inspect: [1500, 2300], special: [1000, 1600], attack: [2400, 3400] },
  },
  hard: {
    knownCardUse: 1, keepImprovement: 0, knockScore: 13, knockConfidence: 0.5,
    attackChance: 0.96, mistakeChance: 0.008,
    timing: { think: [1250, 2000], reach: [650, 950], inspect: [1050, 1600], special: [750, 1150], attack: [1700, 2500] },
  },
};

function normalizeDifficulty(value) {
  return Object.hasOwn(PROFILES, value) ? value : 'medium';
}

function knownScore(player) {
  let total = 0;
  let known = 0;
  player.hand.forEach((card, index) => {
    if (player.seenCards.has(index)) {
      total += card.value;
      known++;
    }
  });
  return { total, known };
}

function estimatedScore(player, difficulty = 'medium') {
  const level = normalizeDifficulty(difficulty);
  const { total, known } = knownScore(player);
  const unknown = player.hand.length - known;
  const unknownEstimate = level === 'hard' ? 5.5 : level === 'medium' ? 6 : 6.5;
  return total + unknown * unknownEstimate;
}

function chooseDiscard(player, drawnCard, difficulty = 'medium', random = Math.random) {
  const level = normalizeDifficulty(difficulty);
  const profile = PROFILES[level];
  if (!player?.hand?.length || !drawnCard) return -1;
  if (level === 'easy' && random() > profile.knownCardUse) {
    return random() < 0.5 ? -1 : Math.floor(random() * player.hand.length);
  }

  const candidates = player.hand
    .map((card, index) => ({ card, index }))
    .filter(({ index }) => player.seenCards.has(index));
  if (!candidates.length) return -1;
  const worst = candidates.reduce((best, item) => item.card.value > best.card.value ? item : best);
  return worst.card.value >= drawnCard.value + profile.keepImprovement ? worst.index : -1;
}

function shouldKnock(player, room, difficulty = 'medium', random = Math.random) {
  if (!player || room.lastRound || room.phase !== 'draw') return false;
  if (room.deck.length > 24) return false;
  const level = normalizeDifficulty(difficulty);
  const profile = PROFILES[level];
  const { known } = knownScore(player);
  const confidence = player.hand.length ? known / player.hand.length : 0;
  const estimate = estimatedScore(player, level);
  if (estimate > profile.knockScore || confidence < profile.knockConfidence) return false;
  return random() < (level === 'hard' ? 0.95 : level === 'medium' ? 0.72 : 0.38);
}

function choosePeekIndex(player, difficulty = 'medium', random = Math.random) {
  const unknown = player.hand.map((_, index) => index).filter(index => !player.seenCards.has(index));
  if (!unknown.length) return 0;
  return normalizeDifficulty(difficulty) === 'easy'
    ? unknown[Math.floor(random() * unknown.length)]
    : unknown[0];
}

function chooseSwap(player, opponents, difficulty = 'medium', random = Math.random) {
  if (!player?.hand?.length || !opponents?.length) return null;
  const level = normalizeDifficulty(difficulty);
  const knownOwn = player.hand
    .map((card, index) => ({ card, index }))
    .filter(({ index }) => player.seenCards.has(index));
  const ownPool = knownOwn.length ? knownOwn : player.hand.map((card, index) => ({ card, index }));
  const own = level === 'easy'
    ? ownPool[Math.floor(random() * ownPool.length)]
    : ownPool.reduce((best, item) => item.card.value > best.card.value ? item : best);

  let target = opponents[Math.floor(random() * opponents.length)];
  let targetIndex = Math.floor(random() * target.hand.length);
  if (level === 'hard') {
    target = opponents.reduce((best, opponent) =>
      opponent.hand.length > best.hand.length ? opponent : best
    );
    targetIndex = Math.floor(random() * target.hand.length);
  } else if (level === 'medium') {
    target = opponents.reduce((best, opponent) =>
      opponent.hand.length < best.hand.length ? opponent : best
    );
    targetIndex = Math.floor(random() * target.hand.length);
  }

  return { myCardIndex: own.index, targetUserId: target.userId, targetCardIndex: targetIndex };
}

function chooseAttack(player, discardCard, difficulty = 'medium', random = Math.random) {
  if (!player?.hand?.length || !discardCard) return null;
  const profile = PROFILES[normalizeDifficulty(difficulty)];
  const remembered = player.hand
    .map((card, index) => ({ card, index }))
    .filter(({ index }) => player.seenCards.has(index));
  const matches = remembered.filter(({ card }) => card.value === discardCard.value);
  if (matches.length && random() < profile.attackChance) {
    return { cardIndex: matches[0].index, expectedSuccess: true };
  }
  const misses = remembered.filter(({ card }) => card.value !== discardCard.value);
  if (misses.length && random() < profile.mistakeChance) {
    return { cardIndex: misses[Math.floor(random() * misses.length)].index, expectedSuccess: false };
  }
  return null;
}

function getTiming(difficulty = 'medium') {
  return PROFILES[normalizeDifficulty(difficulty)].timing;
}

module.exports = {
  normalizeDifficulty,
  estimatedScore,
  chooseDiscard,
  shouldKnock,
  choosePeekIndex,
  chooseSwap,
  chooseAttack,
  getTiming,
};
