const express = require("express");
const http = require("http");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

// --- Ustawienie CORS NA SZTYWNO ---
app.use(cors({
  origin: "https://chessence-frontend.onrender.com",
  credentials: true
}));

app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "https://chessence-frontend.onrender.com",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Reszta Twojego kodu bez zmian...


// --- MongoDB Client setup ---
const client = new MongoClient(process.env.MONGO_URI);
let usersCollection;

// Połączenie z MongoDB
async function connectToMongo() {
  await client.connect();
  const db = client.db("chessence");
  usersCollection = db.collection("users");
  console.log("✅ Połączono z MongoDB!");
}
connectToMongo();

// --- API Rejestracja użytkownika ---
app.post('/api/register', async (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.status(400).send('Missing nick or password');

  const existingUser = await usersCollection.findOne({ nick });
  if (existingUser) return res.status(409).send('User already exists');

  const newUser = {
    nick,
    password,
    id: "u_" + Math.random().toString(36).substring(2, 10),
    xp: 0,
    level: 0,
    achievements: {},
    ui: {
      avatar: "avatar1.png",
      background: "bg0.png",
      frame: "default_frame"
    },
    friends: [],
    pendingFriends: [],
    pendingInvites: []
  };

  await usersCollection.insertOne(newUser);
  res.sendStatus(200);
});

// --- API Logowanie użytkownika ---
app.post('/api/login', async (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.status(400).send('Missing nick or password');

  const user = await usersCollection.findOne({ nick });
  if (!user || user.password !== password) return res.status(401).send('Invalid credentials');

  const { password: _, ...safeUser } = user; // usuń hasło z odpowiedzi
  res.json({ user: safeUser });
});

// --- API pobrania użytkowników (bez haseł) ---
app.get('/api/users', async (req, res) => {
  const users = await usersCollection.find({}).toArray();
  const safeUsers = {};
  for (const user of users) {
    const { password, _id, ...safeData } = user;
    safeUsers[user.nick] = safeData;
  }
  res.json({ users: safeUsers });
});

// --- API zapisu profilu użytkownika ---
// Alias /api/users/save -> działa jak /api/profile/save
app.post('/api/users/save', async (req, res) => {
  const { users } = req.body;
  if (!users) return res.status(400).send('Missing users data');

  const operations = Object.entries(users).map(([nick, userData]) => ({
    updateOne: {
      filter: { nick },
      update: { $set: userData },
      upsert: true
    }
  }));

  if (operations.length > 0) {
    await usersCollection.bulkWrite(operations);
  }

  res.sendStatus(200);
});

app.get('/api/profile/:nick', async (req, res) => {
  const nick = req.params.nick;
  if (!nick) return res.status(400).send('Missing nick');

  const user = await usersCollection.findOne({ nick });
  if (!user) return res.status(404).send('User not found');

  const { password, _id, ...safeUser } = user; // Usuń hasło i ID
  res.json({ user: safeUser });
});

// --- API usuwania konta ---
app.post('/api/users/delete', async (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.status(400).send('Missing nick or password');

  const user = await usersCollection.findOne({ nick });
  if (!user || user.password !== password) return res.status(401).send('Invalid credentials');

  await usersCollection.deleteOne({ nick });
  res.sendStatus(200);
});

// --- API wysyłania zaproszenia do znajomych ---
app.post('/api/friends/request', async (req, res) => {
  const { sender, receiver } = req.body;
  if (!sender || !receiver) return res.status(400).send('Missing sender or receiver');

  const receiverUser = await usersCollection.findOne({ nick: receiver });
  if (!receiverUser) return res.status(404).send('Receiver not found');

  if (receiverUser.pendingFriends?.includes(sender)) {
    return res.status(400).send('Invitation already sent');
  }

  await usersCollection.updateOne(
    { nick: receiver },
    { $push: { pendingFriends: sender } }
  );
  res.sendStatus(200);
});

// --- API akceptacji zaproszenia ---
app.post('/api/friends/accept', async (req, res) => {
  const { sender, receiver } = req.body;
  if (!sender || !receiver) return res.status(400).send('Missing sender or receiver');

  await usersCollection.updateOne(
    { nick: receiver },
    { 
      $pull: { pendingFriends: sender },
      $addToSet: { friends: sender }
    }
  );

  await usersCollection.updateOne(
    { nick: sender },
    { 
      $addToSet: { friends: receiver }
    }
  );

  res.sendStatus(200);
});

// --- API odrzucenia zaproszenia ---
app.post('/api/friends/decline', async (req, res) => {
  const { sender, receiver } = req.body;
  if (!sender || !receiver) return res.status(400).send('Missing sender or receiver');

  await usersCollection.updateOne(
    { nick: receiver },
    { $pull: { pendingFriends: sender } }
  );

  res.sendStatus(200);
});

// --- API usunięcia znajomego ---
app.post('/api/friends/remove', async (req, res) => {
  const { user, friend } = req.body;
  if (!user || !friend) return res.status(400).send('Missing user or friend');

  await usersCollection.updateOne(
    { nick: user },
    { $pull: { friends: friend } }
  );

  await usersCollection.updateOne(
    { nick: friend },
    { $pull: { friends: user } }
  );

  res.sendStatus(200);
});

// 🧩 Twoje WebSockety zostają BEZ ZMIAN:
const currentTurns = {};
const rooms = {};
let players = {};

io.on("connection", (socket) => {
  socket.on('registerPlayer', ({ nick, id }) => {
    console.log(`🔵 Zarejestrowano gracza: ${nick} (socket.id = ${socket.id})`);
    players[socket.id] = { nick, id };
  });

  console.log("🔌 Gracz połączony:", socket.id);

  socket.on('friendListUpdated', ({ friend }) => {
    const friendSocket = Object.entries(players).find(([_, data]) => data.nick === friend)?.[0];
    if (friendSocket) {
      io.to(friendSocket).emit('refreshFriends');
    }
  });

  socket.on("createRoom", ({ nickname }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = [socket.id];
    socket.join(roomCode);
    socket.emit("roomCreated", { roomCode });
    console.log(`🆕 Pokój ${roomCode} utworzony przez ${nickname}`);
  });

  socket.on("joinRoom", ({ roomCode, nickname }) => {
    const room = rooms[roomCode];
    if (!room || room.length >= 2) {
      socket.emit("roomError", { message: "Pokój pełny lub nie istnieje" });
      return;
    }
    room.push(socket.id);
    socket.join(roomCode);
    io.to(roomCode).emit("startGame", {
      colorMap: assignColors(room),
    });
    console.log(`✅ Gracz ${nickname} dołączył do pokoju ${roomCode}`);
  });

  socket.on("matchmake", ({ nickname }) => {
    let found = false;
    for (const [code, sockets] of Object.entries(rooms)) {
      if (sockets.length === 1) {
        sockets.push(socket.id);
        socket.join(code);
        io.to(code).emit("startGame", {
          colorMap: assignColors(sockets),
        });
        console.log(`🤝 Automatyczne parowanie: ${sockets[0]} vs ${sockets[1]}`);
        found = true;
        break;
      }
    }
    if (!found) {
      const roomCode = generateRoomCode();
      rooms[roomCode] = [socket.id];
      socket.join(roomCode);
      socket.emit("roomCreated", { roomCode });
    }
  });

  socket.on("move", (data) => {
    const { roomCode, from, to, promotion, senderId } = data;
    if (!roomCode) return;

    if (!(roomCode in currentTurns)) {
      currentTurns[roomCode] = 'w';
    }
    const newTurn = currentTurns[roomCode] === 'w' ? 'b' : 'w';
    currentTurns[roomCode] = newTurn;

    io.to(roomCode).emit("opponentMove", {
      from,
      to,
      promotion,
      senderId,
      newTurn
    });
  });

  socket.on("resign", ({ roomCode }) => {
    socket.to(roomCode).emit("gameOver", { reason: "resign" });
  });

  socket.on("timeout", ({ roomCode }) => {
    socket.to(roomCode).emit("gameOver", { reason: "timeout" });
  });

  socket.on("disconnect", () => {
    console.log(`🔴 Rozłączono socket: ${socket.id}`);
    delete players[socket.id];
    for (const [roomCode, sockets] of Object.entries(rooms)) {
      if (sockets.includes(socket.id)) {
        const other = sockets.find((id) => id !== socket.id);
        if (other) io.to(other).emit("opponentLeft");
        delete rooms[roomCode];
        break;
      }
    }
  });
});

function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function assignColors(players) {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  return {
    [shuffled[0]]: "w",
    [shuffled[1]]: "b",
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Serwer działa na http://0.0.0.0:${PORT}`);
});
