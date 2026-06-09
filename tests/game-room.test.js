'use strict';

const assert = require('assert');
const GameRoom = require('../game/GameRoom');

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
  room.discardPile = [makeCard(7, 'coppe')];
  room.deck = [makeCard(3), makeCard(6)];

  const result = room.attack('p1', 1);

  assert.strictEqual(result.success, true);
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
  assert.strictEqual(result.replaceSlot, 2);
  assert.strictEqual(player.hand.length, 4);
  assert.strictEqual(player.hand[2].value, 1);
  assert.strictEqual(room.discardPile.at(-1).value, 2);
}

console.log('GameRoom logic tests passed.');
