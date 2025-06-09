document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // --- Éléments du DOM ---
    const canvasContainer = document.getElementById('canvas-container');
    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    const gmViewStatus = document.getElementById('gm-view-status');
    const playerListFogDiv = document.getElementById('player-list-fog');
    const playerListHeader = document.getElementById('player-list-header');
    const loginPanel = document.getElementById('login-panel');
    const gmPanel = document.getElementById('gm-panel');
    const playerPanel = document.getElementById('player-panel');
    const controlsPanel = document.getElementById('controls-panel');
    const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
    const sessionIdDisplay = document.getElementById('session-id-display');
    const brushSizeDisplay = document.getElementById('brush-size-display');
    const opacityDisplay = document.getElementById('opacity-display');
    const sessionInfoP = document.getElementById('session-info-p');

    // --- État Local du Client ---
    let clientState = {
        sessionId: null, role: null,
        map: { image: null, url: null },
        fogCanvas: null, 
        tokens: [], myFog: [], allPlayersFog: {},
        gmViewAsPlayerId: null, fogOpacity: 0.7, selectedTokenId: null,
        mouse: { isDown: false, button: -1, action: null },
        dragStart: { x: 0, y: 0 },
        gmTools: { brushSize: 50 }
    };

    // --- Fonctions d'UI ---
    function updatePlayerListHeaderText() {
        if (clientState.role !== 'gm' || !playerListHeader) return;
        if (clientState.selectedTokenId) {
            playerListHeader.innerHTML = "Cliquez sur un joueur pour <b>assigner</b>, double-cliquez pour <b>renommer</b>.";
        } else {
            playerListHeader.innerHTML = "Cliquez sur un joueur pour <b>sélectionner</b> son pion. Double-cliquez pour renommer.";
        }
    }

    function updatePlayerListHighlights() {
        if (clientState.role !== 'gm') return;
        document.querySelectorAll('#player-list-fog label').forEach(label => {
            label.classList.remove('highlighted');
        });
        if (clientState.selectedTokenId) {
            const selectedToken = clientState.tokens.find(t => t.id === clientState.selectedTokenId);
            if (selectedToken && selectedToken.ownerId) {
                const playerLabel = document.querySelector(`#player-list-fog label[data-player-id="${selectedToken.ownerId}"]`);
                if (playerLabel) {
                    playerLabel.classList.add('highlighted');
                }
            }
        }
    }

    // --- Initialisation et Barre Latérale ---
    function resizeCanvas() {
        canvasContainer.style.width = `${window.innerWidth - controlsPanel.offsetWidth}px`;
        if (clientState.map.image) {
            canvas.width = clientState.map.image.width;
            canvas.height = clientState.map.image.height;
        } else {
            canvas.width = canvasContainer.offsetWidth;
            canvas.height = canvasContainer.offsetHeight;
        }
        draw();
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    toggleSidebarBtn.addEventListener('click', () => {
        document.getElementById('app-container').classList.toggle('panel-collapsed');
        setTimeout(resizeCanvas, 300);
    });

    if (sessionInfoP) {
        sessionInfoP.addEventListener('click', () => {
            const sessionId = clientState.sessionId;
            if (!sessionId) return;
            navigator.clipboard.writeText(sessionId).then(() => {
                const feedback = document.createElement('span');
                feedback.textContent = 'Copié !';
                feedback.className = 'copy-feedback';
                sessionInfoP.appendChild(feedback);
                setTimeout(() => {
                    feedback.remove();
                }, 1200);
            }).catch(err => {
                console.error('Erreur lors de la copie dans le presse-papiers:', err);
            });
        });
    }

    // --- NOUVELLE LOGIQUE DE DESSIN FINALE ---

    // Étape A: Préparer le calque du brouillard (les "données" brutes)
    function prepareFogCanvas(fogPoints) {
        if (!clientState.fogCanvas || !clientState.map.image) return;
        const fogCtx = clientState.fogCanvas.getContext('2d');
        const fogColor = 'rgba(0, 0, 0, 1.0)'; // On travaille TOUJOURS avec du 100% opaque

        // 1. On remplit avec du noir opaque
        fogCtx.clearRect(0, 0, clientState.fogCanvas.width, clientState.fogCanvas.height);
        fogCtx.fillStyle = fogColor;
        fogCtx.fillRect(0, 0, clientState.fogCanvas.width, clientState.fogCanvas.height);

        // 2. On rejoue la chronologie des opérations sur ce calque opaque
        if (fogPoints && fogPoints.length > 0) {
            fogPoints.forEach(point => {
                if (point.type === 'reveal') {
                    // On gomme
                    fogCtx.globalCompositeOperation = 'destination-out';
                    fogCtx.beginPath();
                    fogCtx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
                    fogCtx.fill();
                } else if (point.type === 'remask') {
                    // On repeint avec la même couleur opaque que le fond
                    fogCtx.globalCompositeOperation = 'source-over';
                    fogCtx.fillStyle = fogColor;
                    fogCtx.beginPath();
                    fogCtx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
                    fogCtx.fill();
                }
            });
        }
        fogCtx.globalCompositeOperation = 'source-over'; // On remet l'état par défaut
    }

    // Étape B: Dessiner la scène finale (la "présentation")
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 1. Dessiner la carte
        if (clientState.map.image) {
            ctx.drawImage(clientState.map.image, 0, 0);
        } else {
            ctx.fillStyle = '#ccc'; ctx.font = '24px Arial'; ctx.textAlign = 'center';
            ctx.fillText("En attente d'une carte...", canvas.width / 2, canvas.height / 2);
        }

        // 2. Préparer et dessiner le brouillard
        if (clientState.map.image) {
            const fogToDraw = (clientState.role === 'player')
                ? clientState.myFog
                : (clientState.gmViewAsPlayerId ? (clientState.allPlayersFog[clientState.gmViewAsPlayerId] || []) : Object.values(clientState.allPlayersFog).flat());
            
            prepareFogCanvas(fogToDraw);

            // On dessine le calque de brouillard (opaque) préparé.
            // Pour le MJ, on applique un filtre de transparence global à ce dessin.
            ctx.save(); // On sauvegarde l'état du canvas
            if (clientState.role === 'gm') {
                ctx.globalAlpha = clientState.fogOpacity;
            }
            ctx.drawImage(clientState.fogCanvas, 0, 0);
            ctx.restore(); // On restaure l'état (donc globalAlpha redevient 1.0)
        }

        // 3. Dessiner les pions par-dessus tout
        clientState.tokens.forEach(token => {
            if (token.image) {
                if (token.id === clientState.selectedTokenId) {
                    ctx.strokeStyle = token.ownerId ? 'cyan' : 'yellow';
                    ctx.lineWidth = 4;
                    ctx.strokeRect(token.x - 2, token.y - 2, token.size + 4, token.size + 4);
                }
                ctx.drawImage(token.image, token.x, token.y, token.size, token.size);
            }
        });
        
        // 4. Dessiner l'aperçu du pinceau
        if (clientState.role === 'gm' && clientState.mouse.isDown && (clientState.mouse.action === 'revealingFog' || clientState.mouse.action === 'remaskingFog')) {
            const mousePos = getMousePos(canvas, lastMouseEvent);
            if (mousePos) {
                ctx.beginPath();
                ctx.arc(mousePos.x, mousePos.y, clientState.gmTools.brushSize, 0, Math.PI * 2);
                if (clientState.mouse.action === 'revealingFog') {
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                } else if (clientState.mouse.action === 'remaskingFog') {
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
            }
        }
    }

    let lastMouseEvent = null;
    canvas.addEventListener('mousemove', e => {
        lastMouseEvent = e;
        if (clientState.role === 'gm' || clientState.mouse.isDown) requestAnimationFrame(draw);
    });

    // Le reste du fichier est identique et correct...
    // --- Connexion & Session ---
    document.getElementById('create-session-btn').addEventListener('click', () => socket.emit('create-session'));
    document.getElementById('join-session-btn').addEventListener('click', () => {
        const sessionId = document.getElementById('session-id-input').value;
        if (sessionId) socket.emit('join-session', sessionId);
    });
    socket.on('session-created', ({ sessionId, role }) => {
        clientState.sessionId = sessionId;
        clientState.role = role;
        loginPanel.classList.add('hidden');
        if (role === 'gm') {
            gmPanel.classList.remove('hidden');
            sessionIdDisplay.textContent = sessionId;
            opacityDisplay.textContent = `${Math.round(clientState.fogOpacity * 100)}%`;
            updatePlayerListHeaderText();
        } else {
            playerPanel.classList.remove('hidden');
        }
        resizeCanvas();
    });
    socket.on('game-state', ({ map, tokens }) => {
        if (map) updateMap(map);
        if (tokens) tokens.forEach(addOrUpdateToken);
        draw();
    });

    // --- Carte & Pions ---
    document.getElementById('map-upload').addEventListener('change', (e) => {
        const file = e.target.files[0]; if (!file) return;
        const formData = new FormData(); formData.append('map-image', file);
        fetch('/upload-map', { method: 'POST', body: formData }).then(res => res.json())
            .then(data => socket.emit('update-map', { sessionId: clientState.sessionId, mapUrl: data.filePath }))
            .catch(err => console.error("Erreur d'upload de la carte:", err));
    });
    document.getElementById('token-upload').addEventListener('change', (e) => {
        const file = e.target.files[0]; if (!file) return;
        const formData = new FormData(); formData.append('token-image', file);
        fetch('/upload-token', { method: 'POST', body: formData }).then(res => res.json())
            .then(data => addToken(data.filePath))
            .catch(err => console.error("Erreur d'upload du pion:", err));
    });
    socket.on('map-updated', (mapUrl) => updateMap(mapUrl));
    
    function updateMap(mapUrl){
        clientState.map.url = mapUrl;
        const img = new Image();
        img.src = mapUrl;
        img.onload = () => {
            clientState.map.image = img;
            clientState.fogCanvas = document.createElement('canvas');
            clientState.fogCanvas.width = img.width;
            clientState.fogCanvas.height = img.height;
            resizeCanvas();
        };
    }
    
    function addToken(src) {
        const token = { id: null, x: 50, y: 50, size: 50, src: src, ownerId: null };
        socket.emit('add-token', { sessionId: clientState.sessionId, token });
    }
    document.getElementById('add-default-token-btn').addEventListener('click', () => addToken(null));
    socket.on('token-added', (token) => { addOrUpdateToken(token); draw(); });
    socket.on('token-moved', ({ tokenId, x, y }) => { const t = clientState.tokens.find(tok=>tok.id===tokenId); if(t){t.x=x;t.y=y;draw();} });
    socket.on('token-resized', ({tokenId, size}) => { const t=clientState.tokens.find(tok=>tok.id===tokenId); if(t){t.size=size;draw();} });
    socket.on('token-updated', (updatedToken) => { addOrUpdateToken(updatedToken); draw(); });
    
    function addOrUpdateToken(tokenData) {
        const existingToken = clientState.tokens.find(t => t.id === tokenData.id);
        if (existingToken) {
            Object.assign(existingToken, tokenData);
            if(!existingToken.image || (tokenData.src && existingToken.image.src !== window.location.origin + tokenData.src)) {
                loadImageForToken(existingToken);
            }
        } else {
            const newToken = { ...tokenData };
            clientState.tokens.push(newToken);
            loadImageForToken(newToken);
        }
    }
    function loadImageForToken(token) {
        if (token.src) {
            const img = new Image();
            img.src = token.src;
            img.onload = () => { token.image = img; draw(); };
        } else {
            token.image = createDefaultTokenImage();
            draw();
        }
    }
    function createDefaultTokenImage() {
        const tempCanvas = document.createElement('canvas'); tempCanvas.width = 50; tempCanvas.height = 50;
        const tempCtx = tempCanvas.getContext('2d'); tempCtx.fillStyle = `hsl(${Math.random() * 360}, 70%, 50%)`;
        tempCtx.beginPath(); tempCtx.arc(25, 25, 25, 0, Math.PI * 2); tempCtx.fill();
        const img = new Image(); img.src = tempCanvas.toDataURL(); return img;
    }

    // --- Interactions Utilisateur ---
    function getMousePos(canvas, evt) {
        if(!evt) return null;
        const rect = canvas.getBoundingClientRect();
        return { x: evt.clientX - rect.left + canvasContainer.scrollLeft, y: evt.clientY - rect.top + canvasContainer.scrollTop };
    }
    function getTokenAt(x, y) { for (let i = clientState.tokens.length - 1; i >= 0; i--) { const t = clientState.tokens[i]; if (x > t.x && x < t.x + t.size && y > t.y && y < t.y + t.size) return t; } return null; }
    
    canvas.addEventListener('mousedown', (e) => {
        const pos = getMousePos(canvas, e); if (!pos) return;
        clientState.mouse.isDown = true; clientState.mouse.button = e.button;
        const token = getTokenAt(pos.x, pos.y);
        
        if (e.button === 0) {
            if (token && (clientState.role === 'gm' || token.ownerId === socket.id)) {
                clientState.mouse.action = 'draggingToken';
                clientState.selectedTokenId = token.id;
                if (clientState.role === 'gm') {
                    document.body.classList.add('gm-assign-mode');
                    updatePlayerListHeaderText();
                    updatePlayerListHighlights();
                }
                clientState.dragStart = { x: pos.x - token.x, y: pos.y - token.y };
                if (clientState.role === 'gm' && token.ownerId) {
                    clientState.gmViewAsPlayerId = token.ownerId;
                    gmViewStatus.textContent = `Vue de : ${token.ownerId.substring(0, 6)}`;
                    gmViewStatus.classList.remove('hidden');
                }
            } else if (clientState.role === 'gm') {
                clientState.mouse.action = 'revealingFog';
                clientState.selectedTokenId = null;
                document.body.classList.remove('gm-assign-mode');
                updatePlayerListHeaderText();
                updatePlayerListHighlights();
                handleFogInteraction(pos, 'reveal');
            }
        } else if (e.button === 2) {
            e.preventDefault();
            if (clientState.role === 'gm') {
                clientState.mouse.action = 'remaskingFog'; handleFogInteraction(pos, 'remask');
            }
        }
        draw();
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousemove', (e) => {
        if (!clientState.mouse.isDown) return;
        const pos = getMousePos(canvas, e); if (!pos) return;
        switch(clientState.mouse.action) {
            case 'draggingToken':
                const selectedToken = clientState.tokens.find(t => t.id === clientState.selectedTokenId);
                if (selectedToken) socket.emit('move-token', { sessionId: clientState.sessionId, tokenId: selectedToken.id, x: pos.x - clientState.dragStart.x, y: pos.y - clientState.dragStart.y });
                break;
            case 'revealingFog': handleFogInteraction(pos, 'reveal'); break;
            case 'remaskingFog': handleFogInteraction(pos, 'remask'); break;
        }
    });
    window.addEventListener('mouseup', () => { clientState.mouse.isDown = false; clientState.mouse.action = null; draw(); });
    
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            e.preventDefault();
            if (clientState.role === 'gm') {
                clientState.selectedTokenId = null;
                clientState.gmViewAsPlayerId = null;
                gmViewStatus.classList.add('hidden');
                document.body.classList.remove('gm-assign-mode');
                updatePlayerListHeaderText();
                updatePlayerListHighlights();
                draw();
            } return;
        }
        const selectedToken = clientState.tokens.find(t => t.id === clientState.selectedTokenId);
        if (clientState.role === 'gm' && selectedToken) {
            let newSize = selectedToken.size;
            if (e.key === 'PageUp') newSize *= 1.1; if (e.key === 'PageDown') newSize *= 0.9;
            if(newSize !== selectedToken.size) socket.emit('resize-token', { sessionId: clientState.sessionId, tokenId: selectedToken.id, size: newSize });
        }
        if (clientState.role === 'gm') {
            let opacityChanged = false;
            if(e.key === '+' || e.key === '=') {
                clientState.fogOpacity += 0.05;
                opacityChanged = true;
            }
            if(e.key === '-' || e.key === '_') {
                clientState.fogOpacity -= 0.05;
                opacityChanged = true;
            }
            if (opacityChanged) {
                clientState.fogOpacity = Math.max(0, Math.min(1, clientState.fogOpacity));
                opacityDisplay.textContent = `${Math.round(clientState.fogOpacity * 100)}%`;
                draw();
            }
        }
    });

    canvas.addEventListener('wheel', (e) => {
        if (clientState.role === 'gm') {
            e.preventDefault();
            clientState.gmTools.brushSize += e.deltaY > 0 ? -10 : 10;
            clientState.gmTools.brushSize = Math.max(10, clientState.gmTools.brushSize);
            brushSizeDisplay.textContent = `${clientState.gmTools.brushSize}px`; draw();
        }
    });

    // --- Brouillard de Guerre & Liste des Joueurs ---
    socket.on('fog-update', (fogPoints) => { if (clientState.role === 'player') { clientState.myFog = fogPoints; draw(); } });
    socket.on('gm-fog-update', (allPlayersFog) => { if (clientState.role === 'gm') { clientState.allPlayersFog = allPlayersFog; draw(); } });

    socket.on('player-list-update', ({ players, tokens }) => {
        if (clientState.role !== 'gm') return;
        if (tokens) {
            tokens.forEach(addOrUpdateToken);
        }
        playerListFogDiv.innerHTML = '';
        if (players.length === 0) {
            playerListFogDiv.innerHTML = '<p class="small-text"><i>Aucun joueur connecté.</i></p>';
        } else {
             const playerTokenMap = {};
             clientState.tokens.forEach(t => {
                 if(t.ownerId) playerTokenMap[t.ownerId] = (playerTokenMap[t.ownerId] || 0) + 1;
             });
            players.forEach(player => {
                const label = document.createElement('label');
                label.dataset.playerId = player.id;
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox'; checkbox.value = player.id; checkbox.checked = true;
                label.appendChild(checkbox);
                let labelText = ` ${player.name}`;
                if(playerTokenMap[player.id]) labelText += ` (${playerTokenMap[player.id]} pion(s))`;
                label.appendChild(document.createTextNode(labelText));
                playerListFogDiv.appendChild(label);
            });
        }
        updatePlayerListHighlights();
        draw();
    });
    
    playerListFogDiv.addEventListener('click', (e) => {
        const label = e.target.closest('label');
        if (!label || e.target.tagName === 'INPUT') return;
        
        e.preventDefault(); 
        const playerId = label.dataset.playerId;
        
        if (clientState.role !== 'gm' || !playerId) return;

        if (clientState.selectedTokenId) {
            socket.emit('assign-token', { sessionId: clientState.sessionId, tokenId: clientState.selectedTokenId, ownerId: playerId });
            clientState.selectedTokenId = null;
            document.body.classList.remove('gm-assign-mode');
            updatePlayerListHeaderText();
            updatePlayerListHighlights();
        } 
        else {
            const ownedTokens = clientState.tokens.filter(t => t.ownerId === playerId);
            if (ownedTokens.length > 0) {
                const tokenToSelect = ownedTokens[0];
                clientState.selectedTokenId = tokenToSelect.id;
                document.body.classList.add('gm-assign-mode');
                updatePlayerListHeaderText();
                updatePlayerListHighlights();
                draw();
            }
        }
    });

    playerListFogDiv.addEventListener('dblclick', (e) => {
        const label = e.target.closest('label');
        if (!label || clientState.role !== 'gm') return;
        e.preventDefault();
        const playerId = label.dataset.playerId;
        const currentName = label.textContent.split('(')[0].trim();
        const newName = prompt("Entrez le nouveau nom pour ce joueur :", currentName);
        if (newName && newName.trim() !== '' && newName.trim() !== currentName) {
            socket.emit('change-player-name', { sessionId: clientState.sessionId, playerId: playerId, newName: newName });
        }
    });

    function handleFogInteraction(pos, tool) {
        let targetPlayerIds;
        if (clientState.gmViewAsPlayerId) targetPlayerIds = [clientState.gmViewAsPlayerId];
        else targetPlayerIds = Array.from(document.querySelectorAll('#player-list-fog input:checked')).map(input => input.value);
        if(targetPlayerIds.length === 0) return;
        const point = { x: pos.x, y: pos.y, radius: clientState.gmTools.brushSize };
        
        if (tool === 'reveal') socket.emit('reveal-fog', { sessionId: clientState.sessionId, points: [point], targetPlayerIds });
        else if (tool === 'remask') socket.emit('remask-fog', { sessionId: clientState.sessionId, points: [point], targetPlayerIds });
    }
    
    // --- UI & Aide ---
    const modal = document.getElementById('help-modal');
    document.getElementById('help-btn').onclick = () => modal.classList.remove('hidden');
    document.querySelector('.close-btn').onclick = () => modal.classList.add('hidden');
    window.onclick = (event) => { if (event.target == modal) modal.classList.add('hidden'); };
});