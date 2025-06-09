const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
    console.log(`Le dossier ${uploadsDir} a été créé.`);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

app.post('/upload-map', upload.single('map-image'), (req, res) => {
    if (!req.file) return res.status(400).send('Aucun fichier uploadé.');
    res.json({ filePath: `/uploads/${req.file.filename}` });
});
app.post('/upload-token', upload.single('token-image'), (req, res) => {
    if (!req.file) return res.status(400).send('Aucun fichier uploadé.');
    res.json({ filePath: `/uploads/${req.file.filename}` });
});

const gameSessions = {};

function sendFullFogStateToGm(sessionId) {
    const session = gameSessions[sessionId];
    if (session && session.gmId) {
        io.to(session.gmId).emit('gm-fog-update', session.fogOfWar);
    }
}

function sendPlayerListToGm(sessionId) {
    const session = gameSessions[sessionId];
    if (session && session.gmId) {
        const playerList = Object.keys(session.players)
            .filter(id => id !== session.gmId)
            .map(id => ({ id: id, name: session.players[id].name }));
        io.to(session.gmId).emit('player-list-update', { players: playerList, tokens: session.tokens });
    }
}

io.on('connection', (socket) => {
    console.log(`Nouvel utilisateur connecté: ${socket.id}`);

    socket.on('create-session', () => {
        const sessionId = `game-${Math.random().toString(36).substr(2, 9)}`;
        socket.join(sessionId);
        gameSessions[sessionId] = {
            gmId: socket.id,
            players: { [socket.id]: { role: 'gm', name: 'Maître de Jeu' } },
            map: null, tokens: [], fogOfWar: {},
        };
        socket.emit('session-created', { sessionId, role: 'gm' });
        console.log(`Session ${sessionId} créée par le MJ ${socket.id}`);
    });

    socket.on('join-session', (sessionId) => {
        const session = gameSessions[sessionId];
        if (session) {
            socket.join(sessionId);
            session.players[socket.id] = { role: 'player', name: `Joueur ${socket.id.substring(0, 6)}` };
            session.fogOfWar[socket.id] = [];
            socket.emit('session-created', { sessionId, role: 'player' });
            socket.emit('game-state', { map: session.map, tokens: session.tokens });
            sendFullFogStateToGm(sessionId);
            sendPlayerListToGm(sessionId);
        } else {
            socket.emit('error-message', 'Session non trouvée.');
        }
    });

    socket.on('change-player-name', ({ sessionId, playerId, newName }) => {
        const session = gameSessions[sessionId];
        if (session && session.gmId === socket.id && session.players[playerId]) {
            if (newName && newName.trim().length > 0) {
                session.players[playerId].name = newName.trim();
                sendPlayerListToGm(sessionId);
            }
        }
    });
    
    socket.on('disconnect', () => {
        for (const sessionId in gameSessions) {
            if (gameSessions[sessionId].players[socket.id]) {
                const playerWasGm = gameSessions[sessionId].gmId === socket.id;
                delete gameSessions[sessionId].players[socket.id];
                delete gameSessions[sessionId].fogOfWar[socket.id];
                if (playerWasGm) {
                    io.to(sessionId).emit('error-message', 'Le Maître de Jeu a mis fin à la partie.');
                    delete gameSessions[sessionId];
                } else {
                    sendFullFogStateToGm(sessionId);
                    sendPlayerListToGm(sessionId);
                }
                break;
            }
        }
    });

    socket.on('update-map', ({ sessionId, mapUrl }) => {
        const session = gameSessions[sessionId];
        if (session && session.gmId === socket.id) {
            session.map = mapUrl;
            io.to(sessionId).emit('map-updated', mapUrl);
        }
    });

    socket.on('add-token', ({ sessionId, token }) => {
        const session = gameSessions[sessionId];
        if (session && session.gmId === socket.id) {
            token.id = `token-${Date.now()}`;
            session.tokens.push(token);
            io.to(sessionId).emit('token-added', token);
        }
    });

    socket.on('move-token', ({ sessionId, tokenId, x, y }) => {
        const session = gameSessions[sessionId];
        if (!session) return;
        const token = session.tokens.find(t => t.id === tokenId);
        if (token && (session.gmId === socket.id || token.ownerId === socket.id)) {
            token.x = x;
            token.y = y;
            io.to(sessionId).emit('token-moved', { tokenId, x, y });
        }
    });

    socket.on('resize-token', ({ sessionId, tokenId, size }) => {
        const session = gameSessions[sessionId];
        if (!session) return;
        const token = session.tokens.find(t => t.id === tokenId);
        if (token && session.gmId === socket.id) {
            token.size = size;
            io.to(sessionId).emit('token-resized', { tokenId, size });
        }
    });

    socket.on('assign-token', ({ sessionId, tokenId, ownerId }) => {
        const session = gameSessions[sessionId];
        if (!session) return;
        const token = session.tokens.find(t => t.id === tokenId);
        if (token && session.gmId === socket.id) {
            token.ownerId = ownerId;
            io.to(sessionId).emit('token-updated', token);
            sendPlayerListToGm(sessionId);
        }
    });

    socket.on('reveal-fog', ({ sessionId, points, targetPlayerIds }) => {
        const session = gameSessions[sessionId];
        if (session && session.gmId === socket.id) {
            const revealPoints = points.map(p => ({ ...p, type: 'reveal' }));
            targetPlayerIds.forEach(playerId => {
                if (session.fogOfWar[playerId]) {
                    session.fogOfWar[playerId].push(...revealPoints);
                    io.to(playerId).emit('fog-update', session.fogOfWar[playerId]);
                }
            });
            sendFullFogStateToGm(sessionId);
        }
    });

    socket.on('remask-fog', ({ sessionId, points, targetPlayerIds }) => {
        const session = gameSessions[sessionId];
        if (session && session.gmId === socket.id) {
            const remaskPoints = points.map(p => ({ ...p, type: 'remask' }));
            targetPlayerIds.forEach(playerId => {
                if (session.fogOfWar[playerId]) {
                    session.fogOfWar[playerId].push(...remaskPoints);
                    io.to(playerId).emit('fog-update', session.fogOfWar[playerId]);
                }
            });
            sendFullFogStateToGm(sessionId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur en écoute sur le port ${PORT || 3000}`));