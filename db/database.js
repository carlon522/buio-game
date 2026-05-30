const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'buio.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    games_played INTEGER DEFAULT 0,
    games_won INTEGER DEFAULT 0
  )
`);

module.exports = {
  createUser(id, username, passwordHash) {
    const stmt = db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)');
    stmt.run(id, username, passwordHash);
    return { id, username };
  },

  getUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  getUserById(id) {
    return db.prepare('SELECT id, username, games_played, games_won FROM users WHERE id = ?').get(id);
  },

  incrementGamesPlayed(userId) {
    db.prepare('UPDATE users SET games_played = games_played + 1 WHERE id = ?').run(userId);
  },

  incrementGamesWon(userId) {
    db.prepare('UPDATE users SET games_won = games_won + 1 WHERE id = ?').run(userId);
  }
};
