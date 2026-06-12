'use strict';

const assert = require('assert');
const GameRoom = require('../game/GameRoom');
const BotStrategy = require('../game/BotStrategy');

function makeCard(value, suit = 'denari') {
  return {
    id: `${suit}_${value}_${Math.random().toString(36).slice(2)}`,
    suit,
    value,
    label: String(value),
    symbol: suit === 'denari' ? 'D' : 'C',
    color: suit === 'denari' ? 'red' : 'black',
    isSpecial: [8, 9, 10].includes(value),
  };
}

function makeStartedRoom() {
  const room = new GameRoom('room-1', 'p1', 'Player 1', 'Test Room', 2);
  room.addPlayer('p2', 'Player 2', 'sock-2');
  room.startGame();
  room.endPeekPhase();
  return room;
}

{
  const room = makeStartedRoom();
  const player = room.players[0];
  player.hand = [makeCard(4), makeCard(7), makeCard(2), makeCard(5)];
  player.seenCards = new Set([0, 1]);
  room.phase = 'discard';
  room.drawnCard = makeCard(6);

  const result = room.discardCard('p1', 1);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.appendedDrawnCard, true);
  assert.deepStrictEqual(player.hand.map(c => c.value), [4, 2, 5, 6]);
  assert.deepStrictEqual([...player.seenCards].sort(), [0, 3]);
  assert.strictEqual(room.discardPile.at(-1).value, 7);
}

{
  const room = makeStartedRoom();
  const player = room.players[0];
  const target = room.players[1];
  player.hand = [makeCard(4), makeCard(9), makeCard(2), makeCard(5)];
  target.hand = [makeCard(7), makeCard(1), makeCard(6), makeCard(3)];
  player.seenCards = new Set([0, 1, 2, 3]);
  room.phase = 'special';

  const result = room.useSpecial8Full('p1', 1, 'p2', 3);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.initiatorCardIndex, 1);
  assert.strictEqual(result.targetCardIndex, 3);
  assert.strictEqual(player.hand[1].value, 3);
  assert.strictEqual(target.hand[3].value, 9);
}

{
  const player = {
    hand: [makeCard(2), makeCard(9), makeCard(5), makeCard(7)],
    seenCards: new Set([0, 1, 2, 3]),
  };
  const drawn = makeCard(4);
  assert.strictEqual(BotStrategy.chooseDiscard(player, drawn, 'hard', () => 0), 1);
  assert.strictEqual(BotStrategy.chooseDiscard(player, makeCard(10), 'hard', () => 0), -1);
  assert.strictEqual(BotStrategy.chooseDiscard(player, drawn, 'easy', () => 0.99), 3);
}

{
  const room = makeStartedRoom();
  const player = room.players[0];
  player.hand = [makeCard(1), makeCard(2), makeCard(3), makeCard(4)];
  player.seenCards = new Set([0, 1, 2, 3]);
  room.phase = 'draw';
  room.deck = Array(20).fill(makeCard(5));
  assert.strictEqual(BotStrategy.shouldKnock(player, room, 'hard', () => 0), true);
  player.hand[3] = makeCard(10);
  assert.strictEqual(BotStrategy.shouldKnock(player, room, 'hard', () => 0), false);
}

{
  const player = {
    hand: [makeCard(2), makeCard(10), makeCard(6), makeCard(4)],
    seenCards: new Set([0, 1, 2, 3]),
  };
  const opponents = [{
    userId: 'p2',
    hand: [makeCard(7), makeCard(1), makeCard(8), makeCard(3)],
    seenCards: new Set([0, 1]),
  }];
  const choice = BotStrategy.chooseSwap(player, opponents, 'hard', () => 0);
  assert.deepStrictEqual(choice, { myCardIndex: 1, targetUserId: 'p2', targetCardIndex: 0 });
}

{
  const player = {
    hand: [makeCard(2), makeCard(7), makeCard(4), makeCard(9)],
    seenCards: new Set([0, 1, 3]),
  };
  assert.deepStrictEqual(
    BotStrategy.chooseAttack(player, makeCard(7, 'coppe'), 'hard', () => 0),
    { cardIndex: 1, expectedSuccess: true }
  );
  assert.strictEqual(BotStrategy.chooseAttack(player, makeCard(4), 'hard', () => 0.5), null);
  assert.ok(BotStrategy.getTiming('easy').think[0] > BotStrategy.getTiming('hard').think[1]);
}

{
  const room = makeStartedRoom();
  const player = room.players[0];
  player.hand = [makeCard(4), makeCard(7), makeCard(2), makeCard(5)];
  player.seenCards = new Set([0, 1]);
  player.penalized = true;
  room.phase = 'discard';
  room.drawnCard = makeCard(6);

  const result = room.discardCard('p1', 1);

  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(player.hand.map(c => c.value), [4, 2, 5, 6]);
  assert.deepStrictEqual([...player.seenCards].sort(), [0]);
}

{
  const room = makeStartedRoom();
  const player = room.players[0];
  player.hand = [makeCard(4), makeCard(7), makeCard(2), makeCard(5)];
  room.discardPile = [makeCard(7, 'coppe')];
  room.deck = [makeCard(3), makeCard(6)];

  const result = room.attack('p1', 1);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.cardIndex, 1);
  assert.strictEqual(player.hand.length, 3);
  assert.strictEqual(room.discardPile.at(-1).value, 7);
}

{
  const room = makeStartedRoom();
  const player = room.players[0];
  player.hand = [makeCard(4), makeCard(7), makeCard(2), makeCard(5)];
  room.discardPile = [makeCard(9, 'coppe')];
  room.deck = [makeCard(3)];

  const result = room.attack('p1', 1);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.cardIndex, 1);
  assert.strictEqual(player.hand.length, 5);
  assert.strictEqual(player.hand.at(-1).value, 3);
  assert.strictEqual(room.discardPile.at(-1).value, 9);
}

{
  const room = makeStartedRoom();
  const player = room.players[0];
  player.hand = [makeCard(4), makeCard(7), makeCard(2), makeCard(5)];
  room.discardPile = [makeCard(10, 'coppe')];
  room.deck = [makeCard(1)];
  room.phase = 'forced-discard';

  const result = room.forcedDiscardFromHand('p1', 2);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.replaceSlot, 3);
  assert.strictEqual(result.appendSlot, 3);
  assert.strictEqual(player.hand.length, 4);
  assert.deepStrictEqual(player.hand.map(c => c.value), [4, 7, 5, 1]);
  assert.strictEqual(player.hand[3].value, 1);
  assert.strictEqual(room.discardPile.at(-1).value, 2);
}

{
  const room = makeStartedRoom();
  const player = room.players[0];
  player.hand = [makeCard(4), makeCard(10), makeCard(2), makeCard(5)];
  room.discardPile = [makeCard(10, 'coppe')];
  room.deck = [makeCard(1)];
  room.phase = 'forced-discard';

  const result = room.forcedDiscardFromHand('p1', 1);

  assert.strictEqual(result.success, true);
  assert.strictEqual(room.phase, 'draw');
  assert.notStrictEqual(room.getCurrentPlayer().userId, 'p1');
  assert.deepStrictEqual(player.hand.map(c => c.value), [4, 2, 5, 1]);
}
console.log('GameRoom logic tests passed.');
