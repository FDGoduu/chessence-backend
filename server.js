const express = require("express");
const http = require("http");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const { Server } = require("socket.io");
require("dotenv").config();
const serverVersion = "0.6.0";
const app = express();
const server = http.createServer(app);
const socketToNick = {};

// --- Ustawienie CORS NA SZTYWNO ---
app.use(cors({
  origin: 'https://chessence-frontend.onrender.com',
  methods: ["GET", "POST"],
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
  prestige: 0, // 🆕 Dodane
  achievements: {},
  ui: {
    avatar: "avatar1.png",
    background: "bg0.png",
    frame: "default_frame",
    title: ""
  },
  friends: [],
  pendingFriends: [],
  pendingInvites: [],
  isLoggedIn: false,
  lastSocketId: null
};

  await usersCollection.insertOne(newUser);
  res.sendStatus(200);
});

// --- API login z blokadą ponownego logowania ---
const loggedUsers = new Map(); // nick → socketId (lub true)

app.post("/api/login", async (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.status(400).send("Brak nicku lub hasła");

  const user = await usersCollection.findOne({ nick });
  if (!user || user.password !== password) return res.status(401).send("Niepoprawne hasło");

 if (user.isLoggedIn) {
  const stillConnected = [...io.sockets.sockets.keys()].includes(user.lastSocketId);
  if (stillConnected) {
    return res.status(409).json({ error: "alreadyLoggedIn" });
  } else {
    // martwa sesja – wyczyść
    await usersCollection.updateOne({ nick }, {
      $set: {
        isLoggedIn: false,
        lastSocketId: null
      }
    });
    console.log(`🧹 Wyczyściłem martwą sesję gracza ${nick}`);
  }
}


  const { password: _, ...safeUser } = user;
  await usersCollection.updateOne({ nick }, { $set: { isLoggedIn: true } });
  res.status(200).json({ user: safeUser });
});

// --- API pobrania użytkowników (bez haseł) ---
app.get('/api/users', async (req, res) => {
  const users = await usersCollection.find({}).toArray();
  const safeUsers = {};
  for (const user of users) {
    const { password, _id, isLoggedIn = false, ...safeData } = user;
    safeUsers[user.nick] = {
      ...safeData,
      isLoggedIn: isLoggedIn
    };
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

app.post('/api/profile/save', async (req, res) => {
  const { nick, ui, prestige } = req.body;
  if (!nick || !ui) return res.status(400).send("Brakuje nicku lub danych UI");

  const avatar = ui.avatar || "avatar1.png";
  const frame = ui.frame || "default_frame";
  const background = ui.background || "bg0.png";
  const title = ui.title || "";

await usersCollection.updateOne({ nick }, {
  $set: {
    "ui.avatar": avatar,
    "ui.frame": frame,
    "ui.background": background,
    "ui.title": title,
    prestige: typeof prestige === "number" ? prestige : 0 // 🆕
  }
});

  console.log(`💾 Zapisano profil gracza ${nick} (wszystkie ustawienia UI)`);
  res.sendStatus(200);
});

app.get('/api/profile/:nick', async (req, res) => {
  const nick = req.params.nick;
  console.log(`➡️ Żądanie profilu dla nicka: "${nick}" (długość: ${nick.length})`);

  if (!nick) return res.status(400).send('Missing nick');

  const user = await usersCollection.findOne({ nick: { $eq: nick } });

  if (!user) {
    console.log(`🚫 Nie znaleziono użytkownika "${nick}"`);
    return res.status(404).send('User not found');
  }

  res.json({ user });
});
app.get("/api/friends/:nick", async (req, res) => {
  const user = await usersCollection.findOne({ nick: req.params.nick });

  if (!user || !user.friends) return res.json([]);

  const friendsWithStatus = await Promise.all(
    user.friends.map(async (friendNick) => {
      const friend = await usersCollection.findOne({ nick: friendNick });
      return {
        nick: friendNick,
        id: friend?.id || "brak",
        avatar: friend?.ui?.avatar || "avatar1.png",
        frame: friend?.ui?.frame || "default.png",
        level: friend?.level || 1,
        online: !!friend?.isLoggedIn, // 💡 To jest kluczowe!
      };
    })
  );

  res.json(friendsWithStatus);
});

// --- API usuwania konta ---
app.post('/api/users/delete', async (req, res) => {
  const { nick, password } = req.body;
  if (!nick || !password) return res.status(400).send('Brak nicku albo hasła');

  const user = await usersCollection.findOne({ nick });
  if (!user || user.password !== password) return res.status(401).send('Niepoprawne dane');

  await usersCollection.deleteOne({ nick });
  res.sendStatus(200);
});

// --- API wysyłania zaproszenia do znajomych ---
// --- Wysłanie zaproszenia ---
app.post('/api/friends/request', async (req, res) => {
  const { sender, receiver } = req.body;
  if (!sender || !receiver) return res.status(400).send('Missing sender or receiver');

  const senderUser = await usersCollection.findOne({ nick: sender });
  const receiverUser = await usersCollection.findOne({ nick: receiver });

  if (!receiverUser || !senderUser) return res.status(404).send('Sender or Receiver not found');

  // Sprawdź, czy już jest wysłane zaproszenie
  if (receiverUser.pendingFriends?.includes(sender) || senderUser.pendingInvites?.includes(receiver)) {
    return res.status(400).send('Invitation already sent');
  }

  // 🔵 Dodaj sendera do pendingFriends odbiorcy
  await usersCollection.updateOne(
    { nick: receiver },
    { $addToSet: { pendingFriends: sender } }
  );

  // 🟡 Dodaj receivera do pendingInvites nadawcy
  await usersCollection.updateOne(
    { nick: sender },
    { $addToSet: { pendingInvites: receiver } }
  );

  res.sendStatus(200);
});

// --- Akceptacja zaproszenia ---
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
      $pull: { pendingInvites: receiver },
      $addToSet: { friends: receiver }
    }
  );

  res.sendStatus(200);
});

// --- Odrzucenie zaproszenia ---
app.post('/api/friends/decline', async (req, res) => {
  const { sender, receiver } = req.body;
  if (!sender || !receiver) return res.status(400).send('Missing sender or receiver');

  await usersCollection.updateOne(
    { nick: receiver },
    { $pull: { pendingFriends: sender } }
  );

  await usersCollection.updateOne(
    { nick: sender },
    { $pull: { pendingInvites: receiver } }
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
  
  // 🔥 Utworzenie pokoju i wysłanie zaproszenia do znajomego
socket.on('createGameInvite', ({ fromNick, toFriendId }) => {
  const roomCode = generateRoomCode();
  rooms[roomCode] = [socket.id];
  socket.join(roomCode);
  console.log(`🆕 Pokój ${roomCode} utworzony dla zaproszenia znajomego`);

  // Znajdź socket ID znajomego
  const targetSocketId = Object.entries(players).find(([_, data]) => data.id === toFriendId)?.[0];
  if (targetSocketId) {
    io.to(targetSocketId).emit('incomingGameInvite', { fromNick, roomCode });
  }
});

// 🔥 Odbiór akceptacji zaproszenia
socket.on('acceptGameInvite', ({ roomCode, nickname }) => {
  const room = rooms[roomCode];
  if (!room || room.length >= 2) {
    socket.emit("roomError", { message: "Pokój pełny lub nie istnieje" });
    return;
  }
  room.push(socket.id);
  socket.join(roomCode);

  io.to(roomCode).emit("startGame", {
    colorMap: assignColors(room),
    roomCode: roomCode, // 🆕 Dodane!
  });

  console.log(`✅ Gracz ${nickname} zaakceptował zaproszenie i dołączył do pokoju ${roomCode}`);
});
  
 socket.on('sendFriendRequest', async ({ from, to }) => {
  try {
    const senderUser = await usersCollection.findOne({ nick: from });
    const receiverUser = await usersCollection.findOne({ nick: to });

    if (!senderUser || !receiverUser) {
      console.error('Sender or Receiver not found!');
      return;
    }

    // 🔥 SPRAWDZENIE: Czy odbiorca już wysłał zaproszenie do nadawcy?
    if (senderUser.pendingFriends?.includes(to)) {
      console.log(`🤝 Wzajemne zaproszenie wykryte: ${from} i ${to}`);

      // --- USTAW ZNAJOMYCH ---
      await usersCollection.updateOne(
        { nick: from },
        {
          $pull: { pendingFriends: to },
          $addToSet: { friends: to }
        }
      );

      await usersCollection.updateOne(
        { nick: to },
        {
          $pull: { pendingInvites: from },
          $addToSet: { friends: from }
        }
      );

      // 🔥 Jeśli chcesz: możesz też wysłać do obu stron event refreshFriends
      const receiverSocketId = Object.entries(players).find(([_, data]) => data.nick === to)?.[0];
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('refreshFriends');
      }

      const senderSocketId = Object.entries(players).find(([_, data]) => data.nick === from)?.[0];
      if (senderSocketId) {
        io.to(senderSocketId).emit('refreshFriends');
      }

      return; // 🔥 PRZERWIJ – NIE WYSYŁAJ zwykłego zaproszenia
    }

    // --- Jeśli nie było wzajemnego zaproszenia, idziemy normalnie ---
    if (receiverUser.pendingFriends?.includes(from) || senderUser.pendingInvites?.includes(to)) {
      console.log('Invitation already sent.');
      return;
    }

    await usersCollection.updateOne(
      { nick: to },
      { $addToSet: { pendingFriends: from } }
    );

    await usersCollection.updateOne(
      { nick: from },
      { $addToSet: { pendingInvites: to } }
    );

    console.log(`📨 Zaproszenie socket: ${from} -> ${to}`);

    const receiverSocketId = Object.entries(players).find(([_, data]) => data.nick === to)?.[0];
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('refreshFriends');
    }

  } catch (error) {
    console.error('❌ Błąd przy socketowym wysyłaniu zaproszenia:', error);
  }
});


  socket.on('registerPlayer', ({ nick, id }) => {
    console.log(`🔵 Zarejestrowano gracza: ${nick} (socket.id = ${socket.id})`);
    players[socket.id] = { nick, id };
  });

  console.log("🔌 Gracz połączony:", socket.id);

socket.on('friendListUpdated', ({ friend }) => {
  const targetSocketId = Object.entries(players).find(([_, data]) => data.nick === friend)?.[0];
  if (targetSocketId) {
    io.to(targetSocketId).emit('refreshFriends');
  }

  const mySocketId = Object.entries(players).find(([_, data]) => data.nick === players[socket.id]?.nick)?.[0];
  if (mySocketId) {
    io.to(mySocketId).emit('refreshFriends');
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
    roomCode: roomCode, // 🆕 Dodane!
  });

  console.log(`✅ Gracz ${nickname} dołączył do pokoju ${roomCode}`);
});

  socket.on("matchmake", ({ nickname }) => {
    let found = false;
    for (const [code, sockets] of Object.entries(rooms)) {
      if (sockets.length === 1) {
        sockets.push(socket.id);
        socket.join(code);
        const colorMap = assignColors(sockets);
        const playerData = sockets.map(id => players[id] || { nickname: "Nieznany", avatar: "avatar1.png", frame: "default_frame", level: 1 });
        
        io.to(code).emit("startGame", {
          colorMap,
          roomCode: code,
          players: sockets.map((id, i) => ({
            id,
            ...playerData[i]
          }))
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

socket.on("disconnect", async () => {
  const player = players[socket.id];
  const nick = player?.nick;

  console.log(`🔴 Rozłączono socket: ${socket.id} (${nick || "?"})`);
  delete players[socket.id];
  if (nick) loggedUsers.delete(nick);

  await usersCollection.updateOne({ nick }, {
    $set: { isLoggedIn: false, lastSocketId: null }
  });

  // 🔥 Odśwież znajomym
  const user = await usersCollection.findOne({ nick });
  if (user?.friends?.length > 0) {
    for (const friendNick of user.friends) {
      const targetSocketId = Object.entries(players).find(([_, data]) => data.nick === friendNick)?.[0];
      if (targetSocketId) {
        io.to(targetSocketId).emit("refreshFriends");
      }
    }
  }
});

  // --- Rejestracja aktywnego użytkownika ---
socket.on("registerSession", async (nick) => {
  loggedUsers.set(nick, socket.id);
  console.log(`✅ Zarejestrowano sesję gracza ${nick} (${socket.id})`);

  try {
    // ✅ Zapisz status gracza
    await usersCollection.updateOne({ nick }, {
      $set: {
        isLoggedIn: true,
        lastSocketId: socket.id
      }
    });

    // ✅ Pobierz użytkownika po zapisie
    const user = await usersCollection.findOne({ nick });

    // ✅ Emituj refreshFriends do jego znajomych
    if (user?.friends?.length > 0) {
      for (const friendNick of user.friends) {
        const targetSocketId = Object.entries(players).find(([_, data]) => data.nick === friendNick)?.[0];
        if (targetSocketId) {
          io.to(targetSocketId).emit("refreshFriends");
        }
      }
    }

  } catch (err) {
    console.error(`❌ Błąd przy rejestracji sesji dla ${nick}:`, err.message);
  }
});

// --- Jawne wylogowanie przez klienta ---
socket.on("logoutSession", async (nick) => {
  console.log(`👋 Wylogowanie sesji gracza ${nick}`);
  loggedUsers.delete(nick);
  await usersCollection.updateOne({ nick }, {
    $set: { isLoggedIn: false, lastSocketId: null }
  });

  // 🔥 Odśwież znajomym
  const user = await usersCollection.findOne({ nick });
  if (user?.friends?.length > 0) {
    for (const friendNick of user.friends) {
      const targetSocketId = Object.entries(players).find(([_, data]) => data.nick === friendNick)?.[0];
      if (targetSocketId) {
        io.to(targetSocketId).emit("refreshFriends");
      }
    }
  }
});

  socket.on("leaveRoom", ({ roomCode }) => {
  const room = rooms[roomCode];
  if (room) {
    const otherSocketId = room.find(id => id !== socket.id);
    if (otherSocketId) {
      io.to(otherSocketId).emit("opponentLeft");
    }
    delete rooms[roomCode];
    console.log(`🚪 Gracz opuścił pokój ${roomCode}`);
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
setInterval(async () => {
  try {
    const users = await usersCollection.find({ isLoggedIn: true }).toArray();
    for (const user of users) {
      const stillConnected = [...io.sockets.sockets.keys()].includes(user.lastSocketId);
      if (!stillConnected) {
        await usersCollection.updateOne({ nick: user.nick }, {
          $set: { isLoggedIn: false, lastSocketId: null }
        });
        console.log(`🧹 Auto-wylogowano nieaktywnego gracza: ${user.nick}`);
      }
    }
  } catch (err) {
    console.error("❌ Błąd czyszczenia sesji:", err.message);
  }
}, 60000); // co minutę

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Serwer działa na http://0.0.0.0:${PORT}`);
});
