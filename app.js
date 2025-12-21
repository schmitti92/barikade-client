const DEFAULT_WSS = "wss://barikade-server.onrender.com";

const LOCAL_WS = "ws://localhost:10000";

const $ = (id) => document.getElementById(id);

const hostBtn = $("hostBtn");
const joinBtn = $("joinBtn");
const roomInput = $("roomInput");
const connPill = $("connPill");
const roomPill = $("roomPill");
const turnPill = $("turnPill");

const colorRow = $("colorRow");
const myColorEl = $("myColor");
const myRoleEl = $("myRole");

const startBtn = $("startBtn");
const resetBtn = $("resetBtn");
const hostTools = $("hostTools");

const editEdgesBtn = $("editEdgesBtn");
const editBarrBtn = $("editBarrBtn");
const editOffBtn = $("editOffBtn");

const exportBtn = $("exportBtn");
const importBtn = $("importBtn");
const saveLocalBtn = $("saveLocalBtn");
const loadLocalBtn = $("loadLocalBtn");
const jsonBox = $("jsonBox");

const phaseText = $("phaseText");
const rollBtn = $("rollBtn");
const diceBox = $("diceBox");
const diceHint = $("diceHint");
const actionHint = $("actionHint");
const boardSvg = $("board");

const COLORS = ["blue","red","green","yellow"];
const COLOR_LABEL = { blue:"Blau", red:"Rot", green:"Grün", yellow:"Gelb" };
const COLOR_HEX = { blue:"var(--blue)", red:"var(--red)", green:"var(--green)", yellow:"var(--yellow)" };

// ---- Identity (reconnect-safe) ----
const LS_PLAYER_ID = "barikade_playerId";
const LS_LAST_COLOR = "barikade_lastColor";
const LS_LAST_ROOM = "barikade_lastRoom";
const LS_BOARD_PREFIX = "barikade_board_";

let playerId = localStorage.getItem(LS_PLAYER_ID);
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem(LS_PLAYER_ID, playerId);
}

let ws = null;
let socketId = null;
let roomCode = null;
let state = null;

let myColor = localStorage.getItem(LS_LAST_COLOR) || null;
let editMode = "OFF"; // OFF | EDGES | BARRICADES
let editPickA = null; // for edge toggling (node id)
let selectedPiece = null; // {color, index}

function wsUrl(){
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  return isLocal ? LOCAL_WS : DEFAULT_WSS;
}

function setConn(ok){
  connPill.textContent = ok ? "online" : "offline";
  connPill.classList.toggle("ok", ok);
  connPill.classList.toggle("bad", !ok);
}

function send(msg){
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(msg));
}

function connect(){
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  ws = new WebSocket(wsUrl());
  setConn(false);

  ws.onopen = () => {
    setConn(true);
    // Auto-join last room if we have one
    const lastRoom = localStorage.getItem(LS_LAST_ROOM);
    if (lastRoom && !roomCode) {
      roomInput.value = lastRoom;
      joinRoom(lastRoom);
    }
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === "HELLO") {
      socketId = msg.socketId;
      return;
    }
    if (msg.t === "ROOM_CODE") {
      roomCode = msg.code;
      localStorage.setItem(LS_LAST_ROOM, roomCode);
      roomPill.textContent = `Room: ${roomCode}`;
      roomPill.classList.remove("ghost");
      return;
    }
    if (msg.t === "STATE") {
      state = msg.state;
      roomCode = state.code;
      localStorage.setItem(LS_LAST_ROOM, roomCode);
      roomPill.textContent = `Room: ${roomCode}`;
      roomPill.classList.remove("ghost");
      renderAll();
      return;
    }
    if (msg.t === "ERR") {
      toast(msg.message || "Fehler");
      return;
    }
  };

  ws.onclose = () => {
    setConn(false);
    // try reconnect
    setTimeout(connect, 800);
  };
}

function toast(text){
  actionHint.textContent = text;
  actionHint.style.opacity = "1";
  setTimeout(() => actionHint.style.opacity = "0.85", 900);
}

function hostRoom(){
  connect();
  send({ t:"HOST_ROOM" });
}

function joinRoom(code){
  connect();
  send({ t:"JOIN_ROOM", code });
}

function claimColor(color){
  if (!roomCode) return toast("Erst Raum erstellen/beitreten.");
  myColor = color;
  localStorage.setItem(LS_LAST_COLOR, myColor);
  send({ t:"CLAIM_COLOR", color, playerId });
}

function isHost(){
  return state && socketId && state.hostSocketId === socketId;
}

function amIPlayer(){
  if (!state || !myColor) return false;
  const p = state.players?.[myColor];
  return !!(p && p.taken);
}

function isMyTurn(){
  return state && state.turn?.activeColor === myColor;
}

function canRoll(){
  return state && state.phase === "GAME" && isMyTurn() && state.turn.step === "ROLL";
}

function canMove(){
  return state && state.phase === "GAME" && isMyTurn() && state.turn.step === "MOVE";
}

function canPlaceBarricade(){
  return state && state.phase === "GAME" && isMyTurn() && state.turn.step === "BARRICADE_PLACE";
}

function startGame(){
  send({ t:"START_GAME" });
}

function resetRoom(){
  send({ t:"RESET_ROOM", keepPlayers: true });
}

function setEditMode(mode){
  editMode = mode;
  editPickA = null;
  renderAll();
}

function boardKey(){
  return `${LS_BOARD_PREFIX}${roomCode || "no_room"}`;
}

function saveBoardLocal(){
  if (!state) return;
  localStorage.setItem(boardKey(), JSON.stringify(state.board));
  toast("Board lokal gespeichert.");
}

function loadBoardLocal(){
  if (!state) return;
  const raw = localStorage.getItem(boardKey());
  if (!raw) return toast("Kein lokales Board gefunden.");
  try{
    const board = JSON.parse(raw);
    send({ t:"BOARD_SET", board });
    toast("Board geladen & gesendet.");
  }catch{
    toast("Ungültiges JSON.");
  }
}

function exportBoard(){
  if (!state) return;
  jsonBox.value = JSON.stringify(state.board, null, 2);
  jsonBox.focus();
  toast("Export bereit.");
}

function importBoard(){
  if (!state) return;
  try{
    const board = JSON.parse(jsonBox.value);
    send({ t:"BOARD_SET", board });
    toast("Import gesendet.");
  }catch{
    toast("JSON kaputt.");
  }
}

// ---- Rendering ----
function makeColorButtons(){
  colorRow.innerHTML = "";
  for (const c of COLORS){
    const btn = document.createElement("button");
    btn.className = "colorBtn";
    const p = state?.players?.[c];
    const taken = p?.taken;
    btn.classList.toggle("taken", !!taken && c !== myColor);
    btn.classList.toggle("active", c === myColor);

    btn.innerHTML = `
      <div class="colorDot" style="background:${COLOR_HEX[c]}"></div>
      <div><b>${COLOR_LABEL[c]}</b></div>
      <small>${taken ? (p.connected ? "online" : "offline") : "frei"}</small>
    `;
    btn.disabled = !!taken && c !== myColor;
    btn.onclick = () => claimColor(c);
    colorRow.appendChild(btn);
  }
}

function updateTop(){
  if (!state){
    turnPill.textContent = "Zug: –";
    turnPill.classList.add("ghost");
    return;
  }
  const ac = state.turn?.activeColor;
  const step = state.turn?.step;
  if (state.phase !== "GAME"){
    turnPill.textContent = "Zug: –";
    turnPill.classList.add("ghost");
  } else {
    turnPill.textContent = `Zug: ${COLOR_LABEL[ac] || ac} • ${step}`;
    turnPill.classList.remove("ghost");
  }
}

function updateLobby(){
  makeColorButtons();
  myColorEl.textContent = myColor ? COLOR_LABEL[myColor] : "–";

  let role = "Zuschauer";
  if (isHost()) role = "Host";
  if (myColor && state?.players?.[myColor]?.taken) role = isHost() ? "Host‑Spieler" : "Spieler";
  myRoleEl.textContent = role;

  const showHost = !!state && isHost();
  startBtn.classList.toggle("hidden", !(showHost && state.phase === "LOBBY"));
  resetBtn.classList.toggle("hidden", !(showHost && state.phase === "GAME"));
  hostTools.classList.toggle("hidden", !(showHost && state.phase === "LOBBY"));

  // Enable start only if at least 2 colors taken
  if (showHost && state.phase === "LOBBY"){
    const taken = COLORS.filter(c => state.players?.[c]?.taken).length;
    startBtn.disabled = taken < 2;
  }
}

function updateGamePanel(){
  if (!state){
    phaseText.textContent = "–";
    rollBtn.disabled = true;
    diceHint.textContent = "Warte…";
    diceBox.textContent = "–";
    return;
  }

  phaseText.textContent = state.phase;
  rollBtn.disabled = !canRoll();
  diceBox.textContent = (state.turn?.roll ?? state.turn?.lastRoll ?? "–");
  if (state.phase === "LOBBY"){
    diceHint.textContent = "Wähle Farbe → Host startet.";
  } else if (canRoll()){
    diceHint.textContent = "Du bist dran: Würfeln.";
  } else if (canMove()){
    diceHint.textContent = "Du bist dran: Figur bewegen.";
  } else if (canPlaceBarricade()){
    diceHint.textContent = "Barikade platzieren.";
  } else {
    const ac = state.turn?.activeColor;
    diceHint.textContent = `Warte: ${COLOR_LABEL[ac] || ac} ist dran.`;
  }

  const la = state.turn?.lastAction;
  actionHint.textContent = la ? `${la.type}` : "—";
}


function drawBoard(){
  boardSvg.innerHTML = "";
  if (!state?.board) return;

  const { nodes, edges, barricades, startNodes } = state.board;

  // Compute bounds for viewBox from raw coordinates
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes){
    if (typeof n.x !== "number" || typeof n.y !== "number") continue;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  if (!isFinite(minX)) return;
  const pad = 90;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = (maxX - minX) + pad*2;
  const vbH = (maxY - minY) + pad*2;
  boardSvg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);

  const byId = new Map(nodes.map(n => [n.id, n]));
  const barrSet = new Set(barricades || []);

  // Pieces map: nodeId -> [{color,index}]
  const piecesAt = new Map();
  for (const c of COLORS){
    const arr = state.pieces?.[c] || [];
    arr.forEach((pos, i) => {
      if (pos === null) return;
      const list = piecesAt.get(pos) || [];
      list.push({ color:c, index:i });
      piecesAt.set(pos, list);
    });
  }

  // Draw edges
  for (const [a,b] of edges){
    const na = byId.get(a);
    const nb = byId.get(b);
    if (!na || !nb) continue;
    const line = document.createElementNS("http://www.w3.org/2000/svg","line");
    line.setAttribute("x1", na.x);
    line.setAttribute("y1", na.y);
    line.setAttribute("x2", nb.x);
    line.setAttribute("y2", nb.y);
    line.setAttribute("class", "edge" + (editMode==="EDGES" ? " edit" : ""));
    boardSvg.appendChild(line);
  }

  // Nodes
  for (const n of nodes){
    const g = document.createElementNS("http://www.w3.org/2000/svg","g");
    g.setAttribute("class","node");
    g.dataset.id = n.id;
    g.setAttribute("transform", `translate(${n.x},${n.y})`);

    const circle = document.createElementNS("http://www.w3.org/2000/svg","circle");
    circle.setAttribute("r", 18);
    circle.setAttribute("class", "nodeCircle" + (editMode!=="OFF" ? " edit" : ""));
    if (n.kind && n.kind !== "board"){
      circle.setAttribute("opacity","0.55");
    }
    g.appendChild(circle);

    // Start ring
    const startColor = startNodes ? Object.entries(startNodes).find(([_c, id]) => id === n.id)?.[0] : null;
    if (startColor){
      const ring = document.createElementNS("http://www.w3.org/2000/svg","circle");
      ring.setAttribute("r", 24);
      ring.setAttribute("fill","none");
      ring.setAttribute("stroke", COLOR_HEX[startColor]);
      ring.setAttribute("stroke-width","4");
      ring.setAttribute("opacity","0.95");
      g.appendChild(ring);
    }

    // Barricade marker
    if (barrSet.has(n.id)){
      const b = document.createElementNS("http://www.w3.org/2000/svg","rect");
      b.setAttribute("x",-12); b.setAttribute("y",-12);
      b.setAttribute("width",24); b.setAttribute("height",24);
      b.setAttribute("rx",6);
      b.setAttribute("class","barricade");
      g.appendChild(b);
    }

    // Pieces stacked
    const list = piecesAt.get(n.id) || [];
    list.slice(0,4).forEach((p, idx) => {
      const pc = document.createElementNS("http://www.w3.org/2000/svg","circle");
      pc.setAttribute("r", 9);
      pc.setAttribute("cx", -12 + (idx%2)*24);
      pc.setAttribute("cy", -12 + (idx>=2 ? 24 : 0));
      pc.setAttribute("fill", COLOR_HEX[p.color]);
      pc.setAttribute("class","piece");
      pc.dataset.pieceColor = p.color;
      pc.dataset.pieceIndex = p.index;
      if (selectedPiece && selectedPiece.color === p.color && selectedPiece.index === p.index){
        pc.setAttribute("stroke","rgba(255,255,255,.75)");
        pc.setAttribute("stroke-width","5");
      }
      g.appendChild(pc);
    });

    g.addEventListener("click", (ev) => onNodeClick(n.id, ev));
    boardSvg.appendChild(g);
  }
}


function onNodeClick(nodeId, ev){
  if (!state) return;

  // Host editing in lobby
  if (state.phase === "LOBBY" && isHost()){
    if (editMode === "EDGES"){
      if (editPickA === null){
        editPickA = nodeId;
        toast(`Edge: A=${nodeId} gewählt. Jetzt B klicken.`);
      } else {
        const a = editPickA;
        const b = nodeId;
        editPickA = null;
        toggleEdge(a,b);
      }
      return;
    }
    if (editMode === "BARRICADES"){
      toggleBarricade(nodeId);
      return;
    }
  }

  // In game
  if (state.phase !== "GAME") return;

  // Barricade placement phase
  if (canPlaceBarricade()){
    send({ t:"PLACE_BARRICADE", nodeId });
    return;
  }

  // Move phase: first select piece then destination
  if (!canMove()) return;

  // If clicked on a piece, select it
  const target = ev.target;
  if (target && target.dataset && target.dataset.pieceColor){
    const pc = target.dataset.pieceColor;
    const pi = Number(target.dataset.pieceIndex);
    if (pc !== myColor) return toast("Nur deine Figuren.");
    selectedPiece = { color: pc, index: pi };
    drawBoard();
    return;
  }

  // If no piece selected, auto-select first of my pieces that can reach? (simple)
  if (!selectedPiece){
    selectedPiece = { color: myColor, index: 0 };
  }

  if (selectedPiece.color !== myColor) return toast("Nur deine Figuren.");
  send({ t:"MOVE", pieceIndex: selectedPiece.index, toNode: nodeId });
}

function toggleEdge(a,b){
  if (!state?.board) return;
  if (a === b) return;
  const edges = state.board.edges.map(e => [e[0], e[1]]);
  const norm = (x,y) => x<y ? `${x}-${y}` : `${y}-${x}`;
  const key = norm(a,b);
  const set = new Set(edges.map(e => norm(e[0],e[1])));
  if (set.has(key)){
    const filtered = edges.filter(e => norm(e[0],e[1]) !== key);
    send({ t:"BOARD_SET", board: { ...state.board, edges: filtered } });
    toast(`Verbindung entfernt: ${key}`);
  } else {
    edges.push([a,b]);
    send({ t:"BOARD_SET", board: { ...state.board, edges } });
    toast(`Verbindung hinzugefügt: ${key}`);
  }
}

function toggleBarricade(nodeId){
  if (!state?.board) return;
  const barr = new Set(state.board.barricades || []);
  if (barr.has(nodeId)) barr.delete(nodeId); else barr.add(nodeId);
  send({ t:"BOARD_SET", board: { ...state.board, barricades: [...barr] } });
  toast(`Barikade ${barr.has(nodeId) ? "gesetzt" : "entfernt"}: ${nodeId}`);
}

function renderAll(){
  updateTop();
  updateLobby();
  updateGamePanel();
  drawBoard();
}

// ---- Events ----
hostBtn.onclick = () => hostRoom();
joinBtn.onclick = () => joinRoom(roomInput.value.trim().toUpperCase());

startBtn.onclick = () => startGame();
resetBtn.onclick = () => resetRoom();

rollBtn.onclick = () => send({ t:"REQUEST_ROLL" });

editEdgesBtn.onclick = () => setEditMode("EDGES");
editBarrBtn.onclick = () => setEditMode("BARRICADES");
editOffBtn.onclick = () => setEditMode("OFF");

exportBtn.onclick = () => exportBoard();
importBtn.onclick = () => importBoard();
saveLocalBtn.onclick = () => saveBoardLocal();
loadLocalBtn.onclick = () => loadBoardLocal();

// Bootstrap
connect();
