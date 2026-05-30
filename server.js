require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db/database');
const GameRoom = require('./game/GameRoom');

const JWT_SECRET = process.env.JWT_SECRET || 'buio-dev-secret-change-in-prod';
const PORT = process.env.PORT || 3000;
const ATTACK_WINDOW_MS = 6000;
const PEEK_DURATION_MS = 10000;
const TURN_TIMER_MS = 60000;

// â”€â”€ Bot system â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BOT_NAMES = [
  'Aldo','Bruno','Carlo','Dario','Enzo','Fabio','Gianni','Luca',
  'Marco','Nicola','Pietro','Roberto','Sandro','Toni','Ugo',
  'Anna','Bella','Clara','Diana','Elena','Francesca','Giulia',
  'Laura','Maria','Nina','Paola','Rosa','Sofia','Valentina'
];
const isBot  = id => typeof id === 'string' && id.startsWith('bot_');
const randMs = (min,max) => min + Math.floor(Math.random()*(max-min));

function addBotToRoom(room) {
  if (room.players.length >= room.maxPlayers) return null;
  const botId   = 'bot_' + Math.random().toString(36).slice(2,9);
  const botName = BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)];
  room.addPlayer(botId, botName, null);
  // Mark bot as connected so the client canStart check passes
  const bp = room.players.find(p => p.userId === botId);
  if (bp) bp.connected = true;
  return { botId, botName };
}

function startRoomGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.canStart()) return;
  room.startGame();
  io.to(roomId).emit('game:state', room.getPublicState());
  io.to(roomId).emit('game:starting');
  sendPeekToAll(room);
  sendPrivateToAll(room);
  room._peekTimer = setTimeout(() => endPeek(roomId), PEEK_DURATION_MS);
  io.emit('lobby:list', getLobbyList());
}

// â”€â”€ Central turn-advance helper (shared by bots and human handlers) â”€â”€â”€â”€â”€â”€â”€â”€
function advanceTurnInRoom(roomId, result) {
  const room = rooms.get(roomId);
  if (!room) return;
  // Guard: never advance on error results
  if (result?.error) { console.warn('[advanceTurn] called with error result:', result.error); return; }
  if (result?.type === 'scoring' || result?.type === 'gameover') {
    broadcastScoring(roomId, result);
    return;
  }
  sendPrivateToAll(room);
  startTurnTimer(room);
  const cur = room.getCurrentPlayer();
  if (cur) io.to(roomId).emit('game:turn-start', { userId: cur.userId, username: cur.username });
  triggerBot(roomId);   // no-op if current player is human
}

// â”€â”€ Bot engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function triggerBot(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing') return;
  const cur = room.getCurrentPlayer();
  if (!cur || !isBot(cur.userId)) return;
  if (room._botBusy) return;

  room._botBusy = true;
  room._botBusySince = Date.now();
  const botId = cur.userId;

  setTimeout(() => {
    try {
      botAct(roomId, botId);
    } catch (err) {
      console.error('[bot] uncaught error:', err.message);
    } finally {
      room._botBusy = false;
    }
  }, randMs(900, 2200));
}

function botAct(roomId, botId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing') return;
  if (room.getCurrentPlayer()?.userId !== botId) {
    // Not bot's turn â€” but trigger anyway in case another bot is waiting
    triggerBot(roomId);
    return;
  }

  const phase = room.phase;

  if (phase === 'draw') {
    // Human-like pause before reaching for the deck (think time already passed in triggerBot)
    setTimeout(() => {
      if (room.getCurrentPlayer()?.userId !== botId || room.phase !== 'draw') {
        triggerBot(roomId); return;
      }
      const dr = room.drawFromDeck(botId);
      if (dr.error) { console.warn('[bot] draw error:', dr.error); triggerBot(roomId); return; }
      io.to(roomId).emit('game:state', room.getPublicState());

      // Pause while "looking at the drawn card" before deciding
      setTimeout(() => {
      if (room.getCurrentPlayer()?.userId !== botId || room.phase !== 'discard') {
        triggerBot(roomId); return;
      }
      const player = room.players.find(p => p.userId === botId);
      const hLen = player?.hand.length || 0;
      const idx = hLen > 0 && Math.random() < 0.55 ? Math.floor(Math.random() * hLen) : -1;
      const dis = room.discardCard(botId, idx);
      if (dis.error) {
        // Fallback: discard drawn card
        const fb = room.discardCard(botId, -1);
        if (fb.error) { console.warn('[bot] discard fallback error:', fb.error); triggerBot(roomId); return; }
        io.to(roomId).emit('game:state', room.getPublicState());
        if (fb.discardedCard) io.to(roomId).emit('game:card-discarded', { card: fb.discardedCard, discarderId: botId });
        advanceTurnInRoom(roomId, fb);
        return;
      }
      io.to(roomId).emit('game:state', room.getPublicState());
      if (dis.discardedCard) io.to(roomId).emit('game:card-discarded', { card: dis.discardedCard, discarderId: botId });
      if (dis.specialType === 9) {
        // Nove: peek at a card the bot hasn't seen yet
        setTimeout(() => {
          const bp = room.players.find(p => p.userId === botId);
          let pi = bp?.hand.findIndex((_, i) => !bp.seenCards.has(i));
          if (pi < 0) pi = 0;
          room.useSpecial9(botId, pi);
          io.to(roomId).emit('game:state', room.getPublicState());
          const adv = room.completeSpecialAndAdvance();
          io.to(roomId).emit('game:state', room.getPublicState());
          advanceTurnInRoom(roomId, adv);
        }, randMs(500, 1000));
      } else if (dis.specialType === 8) {
        // Otto: swap bot's highest-value card with a random opponent card
        setTimeout(() => {
          const bp = room.players.find(p => p.userId === botId);
          const opponents = room.getActivePlayers().filter(p => p.userId !== botId);
          if (bp && bp.hand.length > 0 && opponents.length > 0) {
            // Find highest-value card in bot's hand
            let maxVal = -1, myCardIdx = 0;
            bp.hand.forEach((c, i) => { if (c.value > maxVal) { maxVal=c.value; myCardIdx=i; } });
            const opp = opponents[Math.floor(Math.random() * opponents.length)];
            const oppCardIdx = Math.floor(Math.random() * opp.hand.length);
            const res = room.useSpecial8Full(botId, myCardIdx, opp.userId, oppCardIdx);
            if (!res.error) {
              io.to(roomId).emit('game:swap-reveal', {
                initiatorUserId: botId,
                initiatorUsername: bp.username,
                targetUserId: opp.userId,
                targetUsername: opp.username,
              });
              sendPrivateToAll(room);
              io.to(roomId).emit('game:state', room.getPublicState());
            }
          }
          setTimeout(() => {
            const adv = room.completeSpecialAndAdvance();
            io.to(roomId).emit('game:state', room.getPublicState());
            advanceTurnInRoom(roomId, adv);
          }, 3300); // wait for swap animation to finish
        }, randMs(600, 1200));
      } else {
        advanceTurnInRoom(roomId, dis);
      }
    }, randMs(900, 1800));   // time "looking at drawn card"
    }, randMs(400, 800));    // time "reaching for deck"
    return;
  }

  if (phase === 'forced-discard') {
    const player = room.players.find(p => p.userId === botId);
    const idx = Math.floor(Math.random() * Math.max(1, player?.hand.length || 1));
    const res = room.forcedDiscardFromHand(botId, idx);
    if (res.error) { console.warn('[bot] forced-discard error:', res.error); triggerBot(roomId); return; }
    io.to(roomId).emit('game:state', room.getPublicState());
    io.to(roomId).emit('game:card-discarded', { card: res.discardedCard, discarderId: botId });
    sendPrivateToAll(room);
    // Phase is now 'draw' â€” re-trigger self
    setTimeout(() => { room._botBusy = false; triggerBot(roomId); }, randMs(500, 900));
    return;
  }

  if (phase === 'special') {
    const adv = room.completeSpecialAndAdvance();
    io.to(roomId).emit('game:state', room.getPublicState());
    advanceTurnInRoom(roomId, adv);
    return;
  }

  // Unknown phase â€” don't get stuck
  console.warn('[bot] unhandled phase:', phase, 'â€” waiting for watchdog');
}

// â”€â”€ Bot watchdog: unsticks frozen bots every 5 s â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.status !== 'playing') continue;
    const cur = room.getCurrentPlayer();
    if (!cur || !isBot(cur.userId)) continue;
    const idle = Date.now() - (room._botBusySince || 0);
    if (room._botBusy && idle > 10000) {
      console.log('[bot watchdog] unsticking room', roomId);
      room._botBusy = false;
    }
    if (!room._botBusy) triggerBot(roomId);
  }
}, 5000);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// â”€â”€ Debug endpoint (dev only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/debug/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    phase: room.phase, round: room.roundNumber, status: room.status,
    currentPlayer: room.getCurrentPlayer()?.username,
    discardTop: room.discardPile[room.discardPile.length - 1] || null,
    deckCount: room.deck.length,
    players: room.players.map(p => ({
      userId: p.userId, username: p.username,
      isBot: isBot(p.userId), lives: p.lives,
      isEliminated: p.isEliminated, connected: p.connected,
      penalized: p.penalized, seenCards: [...p.seenCards],
      hand: p.hand.map((c,i) => ({ ...c, pos: i, known: p.seenCards.has(i) })),
      score: p.hand.reduce((s,c) => s+c.value, 0),
    }))
  });
});

// â”€â”€ Auth REST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const user = db.createUser(uuidv4(), username.trim(), hash);
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, userId: user.id });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const user = db.getUserByUsername(username?.trim());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, userId: user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// â”€â”€ In-memory game state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const rooms = new Map();          // roomId â†’ GameRoom
const socketRoom = new Map();     // socketId â†’ roomId
const socketUser = new Map();     // socketId â†’ { userId, username }

// â”€â”€ Socket.io â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

io.on('connection', socket => {
  let me = null; // { userId, username }

  socket.on('authenticate', token => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      me = { userId: payload.userId, username: payload.username };
      socketUser.set(socket.id, me);
      socket.emit('authenticated', me);
      socket.emit('lobby:list', getLobbyList());
    } catch {
      socket.emit('auth:error', { message: 'Invalid or expired token' });
    }
  });

  socket.on('lobby:get-list', () => {
    socket.emit('lobby:list', getLobbyList());
  });

  socket.on('lobby:create', ({ name, maxPlayers } = {}) => {
    if (!me) return;
    if (socketRoom.has(socket.id)) leaveRoom();

    const roomId = uuidv4();
    const room = new GameRoom(roomId, me.userId, me.username, name?.trim() || `${me.username}'s Room`, maxPlayers || 4);
    room.players[0].socketId = socket.id;
    room.players[0].connected = true;
    rooms.set(roomId, room);

    socket.join(roomId);
    socketRoom.set(socket.id, roomId);
    socket.emit('lobby:joined', { roomId, room: room.getPublicState() });
    io.emit('lobby:list', getLobbyList());
  });

  socket.on('lobby:join', ({ roomId } = {}) => {
    if (!me) return;
    const room = rooms.get(roomId);
    if (!room) return socket.emit('lobby:error', { message: 'Room not found' });
    if (room.status !== 'waiting') return socket.emit('lobby:error', { message: 'Game already started' });
    if (room.players.length >= room.maxPlayers) return socket.emit('lobby:error', { message: 'Room is full' });

    if (socketRoom.has(socket.id)) leaveRoom();
    room.addPlayer(me.userId, me.username, socket.id);
    socket.join(roomId);
    socketRoom.set(socket.id, roomId);

    io.to(roomId).emit('game:state', room.getPublicState());
    socket.emit('lobby:joined', { roomId, room: room.getPublicState() });
    io.emit('lobby:list', getLobbyList());
  });

  socket.on('lobby:leave', () => leaveRoom());

  // â”€â”€ Quick play vs bot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  socket.on('lobby:vs-bot', ({ name } = {}) => {
    if (!me) return;
    if (socketRoom.has(socket.id)) leaveRoom();

    const roomId = uuidv4();
    const room = new GameRoom(roomId, me.userId, me.username,
      name?.trim() || `${me.username} vs Bot`, 2);
    room.players[0].socketId = socket.id;
    room.players[0].connected = true;
    rooms.set(roomId, room);

    socket.join(roomId);
    socketRoom.set(socket.id, roomId);

    const bot = addBotToRoom(room);
    socket.emit('lobby:joined', { roomId, room: room.getPublicState() });
    if (bot) {
      io.to(roomId).emit('game:message', { text: `ðŸ¤– ${bot.botName} Ã¨ pronto!` });
    }
    io.emit('lobby:list', getLobbyList());

    // Auto-start after a short delay so the client screen transition completes
    setTimeout(() => startRoomGame(roomId), 600);
  });

  // â”€â”€ Add bot to existing waiting room â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  socket.on('game:add-bot', () => {
    if (!me) return;
    const room = getMyRoom();
    if (!room || room.hostUserId !== me.userId || room.status !== 'waiting') return;

    const bot = addBotToRoom(room);
    if (!bot) return socket.emit('lobby:error', { message: 'Stanza piena' });

    io.to(room.id).emit('game:state', room.getPublicState());
    io.to(room.id).emit('game:message', { text: `ðŸ¤– ${bot.botName} aggiunto come bot!` });
    io.emit('lobby:list', getLobbyList());
  });

  socket.on('lobby:start', () => {
    if (!me) return;
    const room = getMyRoom();
    if (!room) return;
    if (room.hostUserId !== me.userId) return socket.emit('lobby:error', { message: 'Only host can start' });
    if (!room.canStart()) return socket.emit('lobby:error', { message: 'Need at least 2 players' });

    startRoomGame(room.id);
    return; // startRoomGame handles everything
    // (code below is unreachable but kept for clarity)
    room._peekTimer = setTimeout(() => endPeek(room.id), PEEK_DURATION_MS);
    io.emit('lobby:list', getLobbyList());
  });

  socket.on('game:ready', () => {
    if (!me) return;
    const room = getMyRoom();
    if (!room || room.phase !== 'peek') return;

    const allReady = room.playerReady(me.userId);
    if (allReady) {
      clearTimeout(room._peekTimer);
      endPeek(room.id);
    }
  });

  socket.on('game:draw', () => {
    if (!me) return;
    const room = getMyRoom();
    if (!room) return;

    const result = room.drawFromDeck(me.userId);
    if (result.error) return socket.emit('game:error', { message: result.error });

    socket.emit('game:drawn-card', { card: result.drawnCard, penalized: result.penalized });
    io.to(room.id).emit('game:state', room.getPublicState());
    // No special prompts on draw â€” specials trigger when discarded
    clearTimeout(room._turnTimer);
    room._turnTimer = setTimeout(() => autoDiscard(room.id, me.userId), TURN_TIMER_MS);
  });

  // Special 9 (Nove) â€” peek own card after discarding the 9
  socket.on('game:use-special-9', ({ cardIndex } = {}) => {
    if (!me) return;
    const room = getMyRoom();
    if (!room) return;

    const result = room.useSpecial9(me.userId, cardIndex);
    if (result.error) return socket.emit('game:error', { message: result.error });

    socket.emit('game:peeked', { cardIndex: result.cardIndex, card: result.card });
    socket.emit('game:private', room.getPrivateState(me.userId));

    // Complete special and advance turn
    const adv = room.completeSpecialAndAdvance();
    socket.emit('game:private', room.getPrivateState(me.userId));
    io.to(room.id).emit('game:state', room.getPublicState());
    advanceTurnInRoom(room.id, adv);
  });

  // Special 8 (Otto) â€” swap own card with opponent's card after discarding the 8
  socket.on('game:use-special-8', ({ myCardIndex, targetUserId, targetCardIndex } = {}) => {
    if (!me) return;
    const room = getMyRoom();
    if (!room) return;

    const result = room.useSpecial8Full(me.userId, myCardIndex ?? 0, targetUserId, targetCardIndex);
    if (result.error) return socket.emit('game:error', { message: result.error });

    // Broadcast swap animation to ALL players â€” they all see which cards were swapped
    io.to(room.id).emit('game:swap-reveal', {
      initiatorUserId: me.userId,
      initiatorUsername: me.username,
      targetUserId: result.targetUserId,
      targetUsername: result.targetUsername,
      initiatorCard: result.initiatorCard,   // card the initiator gave away
      targetCard: result.targetCard,          // card the target gave away
    });

    sendPrivateToAll(room);
    io.to(room.id).emit('game:state', room.getPublicState());

    // Advance turn after swap animation plays (3 s)
    setTimeout(() => {
      const adv = room.completeSpecialAndAdvance();
      io.to(room.id).emit('game:state', room.getPublicState());
      advanceTurnInRoom(room.id, adv);
    }, 3200);
  });

  // Skip special action
  socket.on('game:skip-special', () => {
    if (!me) return;
    const room = getMyRoom();
    if (!room || room.phase !== 'special') return;
    if (room.getCurrentPlayer()?.userId !== me.userId) return;

    const adv = room.completeSpecialAndAdvance();
    io.to(room.id).emit('game:state', room.getPublicState());
    advanceTurnInRoom(room.id, adv);
  });

  socket.on('game:discard', ({ handIndex } = {}) => {
    if (!me) return;
    const room = getMyRoom();
    if (!room) return;

    clearTimeout(room._turnTimer);
    const result = room.discardCard(me.userId, handIndex ?? -1);
    if (result.error) return socket.emit('game:error', { message: result.error });

    socket.emit('game:private', room.getPrivateState(me.userId));
    io.to(room.id).emit('game:state', room.getPublicState());
    io.to(room.id).emit('game:card-discarded', { card: result.discardedCard, discarderId: me.userId });

    if (result.specialType === 8 || result.specialType === 9) {
      // Special card activated â€” emit prompt only to the current player
      socket.emit('game:special-prompt', {
        type: String(result.specialType),
        card: result.discardedCard,
      });
      // Notify others that a special was triggered
      socket.broadcast.to(room.id).emit('game:special-triggered', {
        username: me.username,
        type: String(result.specialType),
        card: result.discardedCard,
      });
      // Auto-skip timer
      room._turnTimer = setTimeout(() => {
        if (room.phase === 'special') {
          room.completeSpecialAndAdvance();
          io.to(room.id).emit('game:state', room.getPublicState());
          sendPrivateToAll(room);
          startTurnTimer(room);
          const cur = room.getCurrentPlayer();
          if (cur) io.to(room.id).emit('game:turn-start', { userId: cur.userId, username: cur.username });
        }
      }, 30000);
    } else if (result.type === 'scoring' || result.type === 'gameover') {
      broadcastScoring(room.id, result);
    } else {
      sendPrivateToAll(room);
      startTurnTimer(room);
      const cur = room.getCurrentPlayer();
      if (cur) io.to(room.id).emit('game:turn-start', { userId: cur.userId, username: cur.username });
      if (result.discardedCard?.value === 10) {
        io.to(room.id).emit('game:forced-discard-next', { username: me.username });
      }
      triggerBot(room.id);  // kick bot if it's their turn next
    }
  });

  // 10-card effect: forced discard before drawing
  socket.on('game:forced-discard', ({ handIndex } = {}) => {
    if (!me) return;
    const room = getMyRoom();
    if (!room) return;

    clearTimeout(room._turnTimer);
    const result = room.forcedDiscardFromHand(me.userId, handIndex ?? 0);
    if (result.error) return socket.emit('game:error', { message: result.error });

    socket.emit('game:private', room.getPrivateState(me.userId));
    io.to(room.id).emit('game:state', room.getPublicState());
    io.to(room.id).emit('game:card-discarded', { card: result.discardedCard, discarderId: me.userId });
    // Now phase is 'draw' â€” player can draw
    startTurnTimer(room);
  });

  // game:announce-attack kept for backward compat but no-op â€” client goes direct now
  socket.on('game:announce-attack', () => {});

  socket.on('game:attack', ({ cardIndex } = {}) => {
    if (!me) return;
    const room = getMyRoom();
    if (!room) return;

    const result = room.attack(me.userId, cardIndex);
    if (result.error) return socket.emit('game:error', { message: result.error });

    // Reveal to ALL: show both the discard top (what was being matched) AND the attacker's card
    const discardTop = room.discardPile[room.discardPile.length - 1];
    io.to(room.id).emit('game:attack-reveal', {
      attackerUserId: me.userId,
      attackerUsername: me.username,
      card: result.revealedCard,        // attacker's card
      discardCard: discardTop || null,  // the card on the pile (target of attack)
      success: result.success,
      penaltyCard: result.penaltyCard || null
    });

    // Delay ALL state updates until after the reveal overlay closes (overlay fades at 5s)
    // This way the card count/hand changes only appear AFTER the announcement sequence
    setTimeout(() => {
      io.to(room.id).emit('game:state', room.getPublicState());
      if (result.success) {
        // Success: show updated hand after overlay gone
        socket.emit('game:private', room.getPrivateState(me.userId));
      } else {
        // Failed: penalty card appears 700ms after state update
        setTimeout(() => {
          socket.emit('game:private', room.getPrivateState(me.userId));
        }, 700);
      }
    }, 5100);
    // No window timer â€” attack can happen again any time
  });

  socket.on('game:knock', () => {
    if (!me) return;
    const room = getMyRoom();
    if (!room) return;

    clearTimeout(room._turnTimer);
    const result = room.knock(me.userId);
    if (result.error) return socket.emit('game:error', { message: result.error });

    if (result.type === 'scoring' || result.type === 'gameover') {
      broadcastScoring(room.id, result);
    } else {
      io.to(room.id).emit('game:knocked', { username: me.username });
      io.to(room.id).emit('game:state', room.getPublicState());
      advanceTurnInRoom(room.id, result);
    }
  });

  socket.on('game:next-round', () => {
    if (!me) return;
    const room = getMyRoom();
    if (!room || room.hostUserId !== me.userId) return;
    if (room.phase !== 'scoring') return;

    room.nextRound();
    io.to(room.id).emit('game:starting');
    io.to(room.id).emit('game:state', room.getPublicState());
    sendPeekToAll(room);
    sendPrivateToAll(room);   // hand state before peek ends so UI isn't blank
    room._peekTimer = setTimeout(() => endPeek(room.id), PEEK_DURATION_MS);
  });

  socket.on('disconnect', () => {
    leaveRoom();
    socketUser.delete(socket.id);
    socketRoom.delete(socket.id);
  });

  // â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function getMyRoom() {
    const roomId = socketRoom.get(socket.id);
    return roomId ? rooms.get(roomId) : null;
  }

  function leaveRoom() {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !me) return;
    const room = rooms.get(roomId);
    if (room) {
      room.removePlayer(me.userId);
      if (room.status === 'waiting' && room.players.length === 0) {
        clearTimers(room);
        rooms.delete(roomId);
      } else {
        io.to(roomId).emit('game:state', room.getPublicState());
        io.to(roomId).emit('game:message', { text: `${me.username} left the game` });
      }
      io.emit('lobby:list', getLobbyList());
    }
    socket.leave(roomId);
    socketRoom.delete(socket.id);
  }
});

// â”€â”€ Server-side game flow helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function sendPeekToAll(room) {
  room.readyPlayers = new Set();
  for (const p of room.getActivePlayers()) {
    if (!p.socketId) continue;
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('game:peek', { cards: room.getPeekCards(p.userId), duration: PEEK_DURATION_MS });
  }
}

function endPeek(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'peek') return;
  room.endPeekPhase();
  // Send state FIRST so client has phase='draw' and discardTop when peek-ended fires
  io.to(roomId).emit('game:state', room.getPublicState());
  sendPrivateToAll(room);
  io.to(roomId).emit('game:peek-ended');
  advanceTurnInRoom(roomId, {});   // starts timer, emits turn-start, triggers bot
}

function endAttackWindow(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'attack-window') return;

  const result = room.endAttackWindow();
  io.to(roomId).emit('game:attack-window-closed');

  if (result.type === 'scoring' || result.type === 'gameover') {
    broadcastScoring(roomId, result);
  } else {
    io.to(roomId).emit('game:state', room.getPublicState());
    sendPrivateToAll(room);   // refresh hand state for all (attacks may have changed hands)
    startTurnTimer(room);
    // notify whose turn it is
    const cur = room.getCurrentPlayer();
    if (cur?.socketId) {
      io.to(roomId).emit('game:turn-start', { userId: cur.userId, username: cur.username });
    }
  }
}

function broadcastScoring(roomId, result) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('game:state', room.getPublicState());

  if (result.type === 'gameover') {
    io.to(roomId).emit('game:gameover', result);
    if (result.winner) db.incrementGamesWon(result.winner.userId);
    for (const p of room.players) db.incrementGamesPlayed(p.userId);
  } else {
    io.to(roomId).emit('game:scoring', result);
  }
}

function sendPrivateToCurrent(room) {
  const cur = room.getCurrentPlayer();
  if (!cur?.socketId) return;
  const s = io.sockets.sockets.get(cur.socketId);
  if (s) s.emit('game:private', room.getPrivateState(cur.userId));
}

function sendPrivateToAll(room) {
  for (const p of room.getActivePlayers()) {
    if (!p.socketId) continue;
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('game:private', room.getPrivateState(p.userId));
  }
}

function startTurnTimer(room) {
  clearTimeout(room._turnTimer);
  room._turnTimer = setTimeout(() => autoPlayTurn(room.id), TURN_TIMER_MS);
}

function autoPlayTurn(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'draw') return;
  const cur = room.getCurrentPlayer();
  if (!cur) return;

  const drawRes = room.drawFromDeck(cur.userId);
  if (drawRes.error) return;

  io.to(roomId).emit('game:state', room.getPublicState());

  const discardRes = room.discardCard(cur.userId, -1);
  if (discardRes.error) return;

  io.to(roomId).emit('game:state', room.getPublicState());
  io.to(roomId).emit('game:attack-window', { card: discardRes.discardedCard, duration: ATTACK_WINDOW_MS });
  clearTimeout(room._attackTimer);
  room._attackTimer = setTimeout(() => endAttackWindow(roomId), ATTACK_WINDOW_MS);
}

function autoDiscard(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'discard') return;
  if (room.getCurrentPlayer()?.userId !== userId) return;

  const result = room.discardCard(userId, -1);
  if (result.error) return;

  io.to(roomId).emit('game:state', room.getPublicState());
  io.to(roomId).emit('game:attack-window', { card: result.discardedCard, duration: ATTACK_WINDOW_MS });
  clearTimeout(room._attackTimer);
  room._attackTimer = setTimeout(() => endAttackWindow(roomId), ATTACK_WINDOW_MS);
}

function clearTimers(room) {
  clearTimeout(room._peekTimer);
  clearTimeout(room._turnTimer);
  clearTimeout(room._attackTimer);
}

function getLobbyList() {
  return Array.from(rooms.values())
    .filter(r => r.status === 'waiting')
    .map(r => ({
      id: r.id,
      name: r.name,
      playerCount: r.players.filter(p => p.connected).length,
      maxPlayers: r.maxPlayers,
      host: r.players.find(p => p.userId === r.hostUserId)?.username || '?'
    }));
}

server.listen(PORT, () => {
  console.log(`BUIO server â†’ http://localhost:${PORT}`);
});

