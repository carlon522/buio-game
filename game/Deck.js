const { v4: uuidv4 } = require('uuid');

const SUITS = [
  { id: 'denari',  symbol: '♦', color: 'red',   name: 'Denari'  },
  { id: 'coppe',   symbol: '♥', color: 'red',   name: 'Coppe'   },
  { id: 'spade',   symbol: '♠', color: 'black', name: 'Spade'   },
  { id: 'bastoni', symbol: '♣', color: 'black', name: 'Bastoni' }
];

const VALUE_LABELS = { 1: 'A', 8: 'F', 9: 'C', 10: 'R' };
const SPECIAL_VALUES = new Set([8, 9, 10]);

function createDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (let value = 1; value <= 10; value++) {
      cards.push({
        id: uuidv4(),
        suit: suit.id,
        symbol: suit.symbol,
        color: suit.color,
        value,
        label: VALUE_LABELS[value] || String(value),
        isSpecial: SPECIAL_VALUES.has(value)
      });
    }
  }
  return shuffle(cards);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { createDeck, shuffle };
