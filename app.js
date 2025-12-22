// Barikade Phase 1 – lokal, stabil (POLISH)
// - Zoom & Pan (Mausrad / Drag / Touch-Pinch)
// - bessere Bewegung (ease + Mini-Pause + Trail/Glow)
// - bessere Figuren (Canvas shading)
//
// Bedienung:
// - Mausrad: Zoom (um Mauszeiger herum)
// - Linke Maustaste ziehen: Pan
// - Touch: 1 Finger ziehen = Pan, 2 Finger Pinch = Zoom

const $ = (sel) => document.querySelector(sel);

// ===== Online / Multiplayer (server-authoritative) =====
const SERVER_HTTP_BASE = "https://barikade-server.onrender.com"; // fest integriert
const SERVER_WS_URL = (() => {
  try{
    const u = new URL(SERVER_HTTP_BASE);
    return (u.protocol === "https:" ? "wss://" : "ws://") + u.host;
  }catch(_e){
    return "wss://barikade-server.onrender.com";
  }
})();

const SESSION_TOKEN_KEY = "barikade_session_v1";
function getSessionToken(){
  let t = localStorage.getItem(SESSION_TOKEN_KEY);
  if(!t){
    t = (crypto?.randomUUID?.() || (Math.random().toString(36).slice(2)+Date.now().toString(36))).slice(0,40);
    localStorage.setItem(SESSION_TOKEN_KEY, t);
  }
  return t;
}

const canvas = $("#boardCanvas");
const ctx = canvas.getContext("2d");

const ui = {
  btnNew: $("#btnNew"),
  btnRoll: $("#btnRoll"),
  dice: $("#dice"),
  diceOverlay: $("#diceOverlay"),
  diceFloat: $("#diceFloat"),
  turnLabel: $("#turnLabel"),
  hint: $("#hint"),
  boardStats: $("#boardStats"),
  rollStats: $("#rollStats"),
  actionStats: $("#actionStats"),
  // online lobby
  btnHost: $("#btnHost"),
  btnJoin: $("#btnJoin"),
  btnLeave: $("#btnLeave"),
  btnStart: $("#btnStart"),
  roomCode: $("#roomCode"),
  playerName: $("#playerName"),
  serverLabel: $("#serverLabel"),
  netHint: $("#netHint"),
  playersList: $("#playersList"),
  netDebug: $("#netDebug"),
  netLog: $("#netLog"),
  btnCopyDiag: $("#btnCopyDiag"),
  btnClearLog: $("#btnClearLog"),

};

const PLAYERS = ["red","blue"]; // Phase 2: 2 Spieler

const STATE = {
  board: null,
  nodes: new Map(),         // id -> node
  edges: [],                // [a,b]
  adj: new Map(),           // id -> Set(nei)
  bounds: null,             // {minX,maxX,minY,maxY}
  view: { scale: 1, tx: 0, ty: 0, dpr: 1, minScale: 0.15, maxScale: 3.0 },

  // interaction
  pointer: {
    dragging: false,
    lastPx: 0,
    lastPy: 0,
    touchMode: null, // "pan"|"pinch"
    pinchStartDist: 0,
    pinchStartScale: 1,
    pinchAnchorWorld: {x:0,y:0},
  },

  // game
  turnColor: "red",
  rolled: null,
  extraRoll: false, // 6-Regel: after finishing the turn, you may roll again
  phase: "need_roll",       // need_roll | need_piece | need_target | animating
  selectedPieceId: null,
  targets: [],              // list of target node ids (valid destinations)
  targetPaths: new Map(),   // destId -> [nodeId,...] including start

  pieces: [],               // {id,color,posKind:'house'|'board', nodeId?:string, houseId?:string}
  barricades: new Set(),     // Set<nodeId> current barricade positions
  carryingBarricade: false,  // if true, player must place it before turn ends

  // visuals
  _pathFlash: null, // {pts:[{x,y},...], t0:number, dur:number}
  // ===== Online =====
  net: {
    enabled: true,
    ws: null,
    url: SERVER_WS_URL,
    room: "",
    name: "",
    clientId: null,
    myColor: null,
    connected: false,
    started: false,
    paused: false,
  },

};

function randInt(min, max){
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function setHint(txt){ ui.hint.textContent = txt; }
function setAction(txt){ ui.actionStats.textContent = txt; }

function setDicePips(el, value){
  if(!el) return;
  const v = Number(value) || 0;
  el.setAttribute('data-value', String(v));
  el.classList.remove('dicePop');
  void el.offsetWidth;
  el.classList.add('dicePop');
}

// ===== Online helpers =====
const NET_LOG_MAX = 80;
let NET_LOG = [];

function logNet(ev, data=null){
  const ts = new Date().toLocaleTimeString();
  const line = data ? `[${ts}] ${ev} ${data}` : `[${ts}] ${ev}`;
  NET_LOG.push(line);
  if(NET_LOG.length > NET_LOG_MAX) NET_LOG = NET_LOG.slice(-NET_LOG_MAX);
  if(ui.netLog) ui.netLog.textContent = NET_LOG.join('\n') || '–';
}

function netSetHint(txt){
  if(ui.netHint) ui.netHint.textContent = txt;
  renderNetDebug();
}

function renderNetDebug(extra=''){
  if(!ui.netDebug) return;
  const lines = [];
  lines.push(`connected: ${STATE.net.connected}`);
  lines.push(`room: ${STATE.net.room || '-'}`);
  lines.push(`meColor: ${STATE.net.myColor || '-'}`);
  lines.push(`turn: ${STATE.turnColor || '-'}`);
  lines.push(`phase: ${STATE.phase || '-'}`);
  lines.push(`paused: ${STATE.net.paused}`);
  if(extra) lines.push(extra);
  ui.netDebug.textContent = lines.join('\n');
}

function canActNow(){
  if(!STATE.net.enabled) return {ok:true, reason:''};
  if(!STATE.net.connected) return {ok:false, reason:'🔌 Nicht verbunden'};
  if(!STATE.net.started) return {ok:false, reason:'⏳ Nicht gestartet'};
  if(STATE.net.paused) return {ok:false, reason:'⏸️ Pausiert'};
  if(!STATE.net.myColor) return {ok:false, reason:'👀 Zuschauer (keine Farbe)'};
  if(STATE.net.myColor !== STATE.turnColor) return {ok:false, reason:`⛔ Nicht dran (dran: ${String(STATE.turnColor).toUpperCase()})`};
  return {ok:true, reason:''};
}

function renderPlayersList(players, meId){
  if(!ui.playersList) return;
  if(!players || !players.length){
    ui.playersList.textContent = "–";
    return;
  }
  ui.playersList.innerHTML = "";
  for(const p of players){
    const row = document.createElement("div");
    row.className = "playerRow";

    const left = document.createElement("div");
    left.className = "badge";
    const dot = document.createElement("span");
    dot.className = "badgeDot " + (p.color || "red");
    const name = document.createElement("span");
    name.textContent = p.name || "Spieler";
    left.appendChild(dot);
    left.appendChild(name);

    const right = document.createElement("div");
    if(p.id === meId){
      const me = document.createElement("span");
      me.className = "badgeMe";
      me.textContent = "DU";
      right.appendChild(me);
    } else if(p.isHost){
      const h = document.createElement("span");
      h.className = "badgeMe";
      h.textContent = "HOST";
      right.appendChild(h);
    }
    row.appendChild(left);
    row.appendChild(right);
    ui.playersList.appendChild(row);
  }
}

async function copyDiagnosticsToClipboard(){
  const diag = {
    ts: new Date().toISOString(),
    url: location.href,
    userAgent: navigator.userAgent,
    net: {
      connected: STATE.net.connected,
      room: STATE.net.room,
      myColor: STATE.net.myColor,
      turn: STATE.turnColor,
      phase: STATE.phase,
      paused: STATE.net.paused,
    },
    hint: ui.netHint?.textContent || '',
    log: NET_LOG,
  };
  const txt = JSON.stringify(diag, null, 2);
  try{
    await navigator.clipboard.writeText(txt);
    netSetHint('✅ Debug kopiert. Hier einfügen & schicken.');
  }catch(_e){
    window.prompt('Kopiere den Debug-Text:', txt);
  }
}

function netSend(obj){
  const ws = STATE.net.ws;
  if(!ws || ws.readyState !== 1) return;
  try{
    ws.send(JSON.stringify(obj));
    logNet('→ send', obj.type || 'msg');
  }catch(_e){}
}

function netDisconnect(){
  try{ STATE.net.ws?.close(); }catch(_e){}
  STATE.net.ws = null;
  STATE.net.connected = false;
  STATE.net.started = false;
  STATE.net.myColor = null;
  STATE.net.paused = false;
  netSetHint("Nicht verbunden.");
  if(ui.btnLeave){ ui.btnLeave.disabled = true; ui.btnLeave.classList.add("disabled"); }
  if(ui.btnStart){ ui.btnStart.disabled = true; ui.btnStart.classList.add("disabled"); }
  renderPlayersList([], STATE.net.clientId);
}

let _reconnectTimer=null;
let _reconnectDelay=600;

function scheduleReconnect(){
  if(_reconnectTimer) return;
  if(!STATE.net.enabled) return;
  if(!STATE.net.room) return;
  netSetHint(`Verbindung weg… reconnect in ${Math.round(_reconnectDelay/100)/10}s`);
  _reconnectTimer=setTimeout(()=>{
    _reconnectTimer=null;
    netConnect(true);
    _reconnectDelay=Math.min(5000, Math.round(_reconnectDelay*1.6));
  }, _reconnectDelay);
}

function resetReconnect(){
  _reconnectDelay=600;
  if(_reconnectTimer){ clearTimeout(_reconnectTimer); _reconnectTimer=null; }
}

function applyServerSnapshot(s){
  if(!s) return;
  if(typeof s.turnColor === "string") STATE.turnColor = s.turnColor;
  if(typeof s.phase === "string"){
    const ph = (s.phase==="need_piece"||s.phase==="need_target"||s.phase==="need_roll"||s.phase==="place_barricade") ? s.phase : (s.phase==="need_move" ? "need_piece" : s.phase);
    STATE.phase = ph;
  }
  if(Array.isArray(s.pieces)) STATE.pieces = s.pieces;
  if(Array.isArray(s.barricades)) STATE.barricades = new Set(s.barricades);
  if(typeof s.started === "boolean") STATE.net.started = s.started;
  if(typeof s.paused === "boolean") STATE.net.paused = s.paused;

  updateTurnUI();
  // Roll button: only active player & correct phase
  if(ui.btnRoll){
    const act = canActNow();
    ui.btnRoll.disabled = !(act.ok && STATE.phase === "need_roll");
    ui.btnRoll.classList.toggle("disabled", ui.btnRoll.disabled);
  }
  draw();
}

function handleServerMessage(msg){
  const t = msg.type;
  if(t === "pong") return;

  if(t === "hello"){
    STATE.net.clientId = msg.clientId;
    netSetHint("Verbunden. Raumcode eingeben & Host/Beitreten.");
    return;
  }

  if(t === "room_update"){
    renderPlayersList(msg.players || [], STATE.net.clientId);
    const me = (msg.players||[]).find(p=>p.id===STATE.net.clientId);
    STATE.net.myColor = me?.color || null;
    STATE.net.paused = !!msg.paused;

    // Start enabled if I'm host and >=2 colored players
    const amHost = !!me?.isHost;
    const enough = (msg.players||[]).filter(p=>p.color).length >= 2;
    if(ui.btnStart){
      ui.btnStart.disabled = !(amHost && enough);
      ui.btnStart.classList.toggle("disabled", ui.btnStart.disabled);
    }

    const roleTxt = STATE.net.myColor ? `Du bist ${STATE.net.myColor.toUpperCase()}` : "Zuschauer";
    const turnTxt = STATE.turnColor ? `Dran: ${String(STATE.turnColor).toUpperCase()}` : "";
    const pauseTxt = STATE.net.paused ? "⏸️ pausiert" : "";
    netSetHint([roleTxt,turnTxt,pauseTxt].filter(Boolean).join(" • "));
    return;
  }

  if(t === "started"){
    applyServerSnapshot(msg.state);
    netSetHint("Spiel gestartet.");
    return;
  }

  if(t === "snapshot"){
    applyServerSnapshot(msg.state);
    return;
  }

  if(t === "roll"){
    // server rolled for current player
    applyServerSnapshot(msg.state);
    applyRollFromServer(msg.value, {from:"server"}).catch(console.error);
    return;
  }

  if(t === "move"){
    // server accepted & broadcasted move (includes path for animation)
    const s = msg.state;
    const action = msg.action;
    applyServerSnapshot(s);

    const pc = STATE.pieces.find(p=>p.id===action.pieceId);
    if(pc && Array.isArray(action.path) && action.path.length>=1){
      // If piece was in house, place it to first path node before animating
      if(pc.posKind === "house"){
        pc.posKind = "board";
        pc.nodeId = action.path[0];
      }
      if(action.path.length>=2){
        animateAlongPath(pc, action.path).catch(console.error);
      }else{
        draw();
      }
    }
    return;
  }

  if(t === "error"){
    netSetHint("Fehler: " + (msg.message || "unbekannt"));
    logNet("ERROR", msg.code || "");
    return;
  }
}

function netConnect(autoRejoin=false){
  netDisconnect();
  const url = STATE.net.url;
  if(ui.serverLabel) ui.serverLabel.textContent = url;

  try{
    const ws = new WebSocket(url);
    STATE.net.ws = ws;
    netSetHint("Verbinde…");

    ws.onopen = ()=>{
      STATE.net.connected = true;
      resetReconnect();
      logNet("ws open");
      netSetHint("Verbunden.");
      if(ui.btnLeave){ ui.btnLeave.disabled = false; ui.btnLeave.classList.remove("disabled"); }

      if(autoRejoin && STATE.net.room){
        netSend({type:"join", room: STATE.net.room, name: STATE.net.name || "Spieler", sessionToken:getSessionToken(), asHost:false});
      }
    };

    ws.onmessage = (ev)=>{
      try{
        const msg = JSON.parse(ev.data);
        logNet("← recv", msg.type || "msg");
        handleServerMessage(msg);
      }catch(e){
        console.warn("Bad message", ev.data);
      }
    };

    ws.onclose = ()=>{
      logNet("ws close");
      netDisconnect();
      scheduleReconnect();
    };

    ws.onerror = ()=>{
      logNet("ws error");
      netSetHint("Verbindungsfehler.");
    };
  }catch(_e){
    netSetHint("WebSocket nicht möglich.");
  }
}


function updateTurnUI(){
  // Phase 1: only red exists, but keep it future-proof
  const color = STATE.turnColor || "red";
  const pill = {
    red: "pill red",
    blue: "pill blue",
    green: "pill green",
    yellow: "pill yellow",
  }[color] || "pill red";

  if(ui.turnLabel){
    ui.turnLabel.innerHTML = `Spieler: <span class="${pill}">${color.charAt(0).toUpperCase()+color.slice(1)}</span>`;
    const wrap = ui.turnLabel.closest(".diceWrap");
    if(wrap){
      wrap.classList.add("activeTurnGlow","turnPulse");
    }
  }
}

function nextTurn(){
  if(STATE.net.enabled && STATE.net.started) return; // server steuert den Zug
  const idx = PLAYERS.indexOf(STATE.turnColor);
  STATE.turnColor = PLAYERS[(idx + 1) % PLAYERS.length] || "red";
  updateTurnUI();
}


function endTurnOrBonus(){
  if(STATE.net.enabled && STATE.net.started) return; // server steuert den Zug
  // Turn finished: either allow a bonus roll (if a 6 was rolled), or end normally
  if(STATE.extraRoll){
    STATE.extraRoll = false;
    STATE.phase = 'need_roll';
    ui.btnRoll.disabled = false; ui.btnRoll.classList.remove('disabled');
    STATE.rolled = null;
    setDicePips(ui.dice, 0);
    ui.rollStats.textContent = '–';
    STATE.selectedPieceId = null;
    STATE.targets = [];
    STATE.targetPaths.clear();
    setHint('🎲 Bonuswurf! Würfle nochmal.');
    setAction('Bonuswurf');
    draw();
    return;
  }

  STATE.phase = 'need_roll';
  ui.btnRoll.disabled = false; ui.btnRoll.classList.remove('disabled');
  STATE.rolled = null;
  setDicePips(ui.dice, 0);
  ui.rollStats.textContent = '–';
  STATE.selectedPieceId = null;
  STATE.targets = [];
  STATE.targetPaths.clear();
  setHint(`Würfle. ${STATE.turnColor.toUpperCase()} ist dran.`);
  setAction('Zug beendet');
  nextTurn();
  draw();
}


// ===== Canvas sizing =====

function resizeCanvas(){
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  STATE.view.dpr = dpr;

  // only fit on first load or when bounds missing
  if(!STATE.view._fittedOnce){
    fitBoardToView();
    STATE.view._fittedOnce = true;
  }
  draw();
}

function fitBoardToView(){
  if(!STATE.bounds) return;
  const {minX,maxX,minY,maxY} = STATE.bounds;
  const pad = 80; // logical units
  const bw = (maxX - minX) + pad*2;
  const bh = (maxY - minY) + pad*2;

  const vw = canvas.width / STATE.view.dpr;
  const vh = canvas.height / STATE.view.dpr;

  const s = Math.min(vw / bw, vh / bh);
  STATE.view.scale = clamp(s, STATE.view.minScale, STATE.view.maxScale);
  STATE.view.tx = (vw - bw*STATE.view.scale)/2 - (minX - pad)*STATE.view.scale;
  STATE.view.ty = (vh - bh*STATE.view.scale)/2 - (minY - pad)*STATE.view.scale;
}

function worldToScreen(x,y){
  const {scale,tx,ty} = STATE.view;
  return { x: x*scale + tx, y: y*scale + ty };
}
function screenToWorld(px,py){
  const {scale,tx,ty} = STATE.view;
  return { x: (px - tx)/scale, y: (py - ty)/scale };
}

// Zoom around a screen point (px,py)
function zoomAt(px, py, newScale){
  const {scale} = STATE.view;
  const ns = clamp(newScale, STATE.view.minScale, STATE.view.maxScale);
  if(Math.abs(ns - scale) < 1e-6) return;

  const before = screenToWorld(px, py);
  STATE.view.scale = ns;
  const after = worldToScreen(before.x, before.y);

  // Keep the world point under cursor stable:
  STATE.view.tx += (px - after.x);
  STATE.view.ty += (py - after.y);

  draw();
}

function clear(){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width, canvas.height);
}

// ===== Drawing =====

function draw(){
  if(!STATE.board) return;
  clear();
  ctx.setTransform(STATE.view.dpr,0,0,STATE.view.dpr,0,0);

  drawEdges();
  drawNodes();
  drawBarricades();
  drawPathFlash();
  drawPathFlash();
  drawBarricadePlacementHints();
  drawTargets();
  drawPieces();
}

function drawEdges(){
  ctx.lineWidth = Math.max(1.5, 2.2 * (STATE.view.scale**0.15));
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.beginPath();
  for(const [a,b] of STATE.edges){
    const na = STATE.nodes.get(a);
    const nb = STATE.nodes.get(b);
    if(!na || !nb) continue;
    const pa = worldToScreen(na.x, na.y);
    const pb = worldToScreen(nb.x, nb.y);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();
}

function nodeRadius(){
  return (STATE.board.ui?.radius ?? 20);
}

function drawNodes(){
  const r0 = nodeRadius();
  for(const n of STATE.nodes.values()){
    const p = worldToScreen(n.x, n.y);
    const r = r0;

    const isBoard = n.kind === "board";
    const isHouse = n.kind === "house";

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI*2);

    if(isHouse){
      ctx.fillStyle = "rgba(148,163,184,0.10)";
      ctx.strokeStyle = "rgba(148,163,184,0.35)";
      ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();

      const c = n.flags?.houseColor ?? "";
      ctx.fillStyle = "rgba(231,234,240,0.65)";
      ctx.font = "700 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(c.slice(0,1).toUpperCase(), p.x, p.y);
      continue;
    }

    // board nodes
    const isGoal = !!n.flags?.goal;
    const isRun = !!n.flags?.run;
    const isNoBarr = !!n.flags?.noBarricade;
    const isStart = n.flags?.startColor;

    let fill = "rgba(255,255,255,0.06)";
    let stroke = "rgba(255,255,255,0.22)";
    // noBarricade-Felder bewusst neutral dargestellt

    // run-Felder bewusst neutral dargestellt

    if(isGoal){ fill = "rgba(255,255,255,0.14)"; stroke = "rgba(255,255,255,0.75)"; }

    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.fill(); ctx.stroke();
// Startfelder bewusst neutral dargestellt (keine Farbe)

    if(isGoal){
      ctx.beginPath();
      ctx.arc(p.x, p.y, r*0.22, 0, Math.PI*2);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
    }
  }
}

function drawBarricades(){
  if(!STATE.barricades || !STATE.barricades.size) return;
  const r0 = nodeRadius();
  for(const id of STATE.barricades){
    const n = STATE.nodes.get(id);
    if(!n) continue;
    const p = worldToScreen(n.x, n.y);
    const w = r0*1.45;
    const h = r0*0.95;
    const x = p.x - w/2;
    const y = p.y - h/2;
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(x+2, y+3, w, h, Math.max(6, r0*0.28));
    ctx.fill();
    // body gradient (stone/wood neutral)
    const g = ctx.createLinearGradient(x, y, x, y+h);
    g.addColorStop(0, 'rgba(240,240,240,0.95)');
    g.addColorStop(0.45, 'rgba(200,200,200,0.95)');
    g.addColorStop(1, 'rgba(120,120,120,0.95)');
    ctx.fillStyle = g;
    roundRect(x, y, w, h, Math.max(6, r0*0.28));
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,20,25,0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // bricks lines
    ctx.strokeStyle = 'rgba(20,20,25,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x+w*0.18, y+h*0.38); ctx.lineTo(x+w*0.82, y+h*0.38);
    ctx.moveTo(x+w*0.10, y+h*0.66); ctx.lineTo(x+w*0.90, y+h*0.66);
    ctx.moveTo(x+w*0.35, y+h*0.38); ctx.lineTo(x+w*0.35, y+h*0.66);
    ctx.moveTo(x+w*0.65, y+h*0.38); ctx.lineTo(x+w*0.65, y+h*0.66);
    ctx.stroke();
  }
}

function roundRect(x,y,w,h,r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

function drawBarricadePlacementHints(){
  if(STATE.phase !== 'place_barricade') return;
  const r0 = nodeRadius();
  for(const n of STATE.nodes.values()){
    if(!isPlacableBarricadeNode(n)) continue;
    const p = worldToScreen(n.x, n.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r0*1.25, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}


function drawTargets(){
  return; // Phase 1: keine Ziel-Vorschläge anzeigen

  if(STATE.phase !== "need_target") return;
  const r0 = nodeRadius();
  for(const id of STATE.targets){
    const n = STATE.nodes.get(id);
    if(!n) continue;
    const p = worldToScreen(n.x, n.y);
    const r = r0 * 1.28;

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI*2);
    ctx.strokeStyle = "rgba(77,163,255,0.88)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // soft glow
    ctx.beginPath();
    ctx.arc(p.x, p.y, r*1.35, 0, Math.PI*2);
    ctx.strokeStyle = "rgba(77,163,255,0.20)";
    ctx.lineWidth = 8;
    ctx.stroke();
  }
}

function pieceColor(color){
  return ({
    red: "#ff4d6d",
    blue: "#60a5fa",
    green: "#2dd4bf",
    yellow: "#fbbf24",
  })[color] || "#ffffff";
}

function hexToRgba(hex, a){
  try{
    const h = String(hex||'').replace('#','');
    const v = parseInt(h.length===3 ? h.split('').map(x=>x+x).join('') : h, 16);
    const r = (v>>16)&255, g = (v>>8)&255, b = v&255;
    return `rgba(${r},${g},${b},${a})`;
  }catch(_e){
    return `rgba(255,255,255,${a})`;
  }
}

function drawPieceToken(x, y, r, color, isSel, label){
  // shadow
  ctx.beginPath();
  ctx.arc(x + 2, y + 4, r*1.03, 0, Math.PI*2);
  ctx.fillStyle = "rgba(0,0,0,0.40)";
  ctx.fill();

  // body gradient (fake 3D)
  const grad = ctx.createRadialGradient(x - r*0.35, y - r*0.45, r*0.2, x, y, r*1.2);
  grad.addColorStop(0, "rgba(255,255,255,0.35)");
  grad.addColorStop(0.22, color);
  grad.addColorStop(1, "rgba(0,0,0,0.25)");

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI*2);
  ctx.fillStyle = grad;
  ctx.fill();

  // rim
  ctx.lineWidth = isSel ? 3 : 2;
  ctx.strokeStyle = isSel ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.25)";
  ctx.stroke();

  // top highlight
  ctx.beginPath();
  ctx.arc(x - r*0.25, y - r*0.28, r*0.42, 0, Math.PI*2);
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fill();

  // label
  ctx.fillStyle = "rgba(10,13,20,0.88)";
  ctx.font = `900 ${Math.max(11, r*0.85)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(label), x, y);
}

function getPieceWorldPos(pc){
  if(pc.posKind === "board"){
    const n = STATE.nodes.get(pc.nodeId);
    if(!n) return null;
    return {x:n.x, y:n.y};
  }
  if(pc.posKind === "house"){
    const n = STATE.nodes.get(pc.houseId);
    if(!n) return null;
    return {x:n.x, y:n.y};
  }
  return null;

}

function isOccupiedAny(nodeId, exceptPieceId=null){
  for(const pc of STATE.pieces){
    if(pc.id===exceptPieceId) continue;
    if(pc.posKind==='board' && pc.nodeId===nodeId) return true;
  }
  return false;
}

function isPlacableBarricadeNode(n){
  if(!n || n.kind!=='board') return false;
  if(n.flags?.goal) return false;
  // Regel hier: Barikaden dürfen nach dem Einsammeln auf *jedes* normale Brett-Feld.
  // (Run-Felder sind dabei erlaubt; verboten bleiben: Ziel, Startfelder, noBarricade, Häuser)
  if(n.flags?.noBarricade) return false;
  if(n.flags?.startColor) return false;
  if(STATE.barricades.has(n.id)) return false;
  if(isOccupiedAny(n.id)) return false;
  return true;
}



function drawPathFlash(){
  const pf = STATE._pathFlash;
  if(!pf || !pf.pts || pf.pts.length < 2) return;

  const now = performance.now();
  const t = (now - pf.t0) / pf.dur;
  if(t >= 1){
    STATE._pathFlash = null;
    return;
  }
  const a = 1 - t;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Outer glow
  ctx.strokeStyle = `rgba(255,255,255,${0.18 * a})`;
  ctx.lineWidth = 14;
  ctx.beginPath();
  for(let i=0;i<pf.pts.length;i++){
    const p = worldToScreen(pf.pts[i].x, pf.pts[i].y);
    if(i===0) ctx.moveTo(p.x,p.y);
    else ctx.lineTo(p.x,p.y);
  }
  ctx.stroke();

  // Inner line (current player color; Phase 1 = red)
  const c = (STATE.turnColor === "blue") ? "96,165,250" :
            (STATE.turnColor === "green") ? "45,212,191" :
            (STATE.turnColor === "yellow") ? "251,191,36" :
            "255,77,109";

  ctx.strokeStyle = `rgba(${c},${0.55 * a})`;
  ctx.lineWidth = 6;
  ctx.beginPath();
  for(let i=0;i<pf.pts.length;i++){
    const p = worldToScreen(pf.pts[i].x, pf.pts[i].y);
    if(i===0) ctx.moveTo(p.x,p.y);
    else ctx.lineTo(p.x,p.y);
  }
  ctx.stroke();
}

function requestPathFlashFrame(){
  if(!STATE._pathFlash) return;
  draw();
  requestAnimationFrame(requestPathFlashFrame);
}

function drawPieces(){
  // trail behind moving piece
  if(STATE._trail && STATE._trail.length){
    ctx.lineCap = "round";
    const c = pieceColor(STATE._trailColor || STATE.turnColor || "red");
    for(let i=0;i<STATE._trail.length-1;i++){
      const a = STATE._trail[i];
      const b = STATE._trail[i+1];
      const pa = worldToScreen(a.x,a.y);
      const pb = worldToScreen(b.x,b.y);
      const t = i/(STATE._trail.length-1);
      ctx.strokeStyle = `rgba(255,255,255,${0.10*(1-t)})`;
      ctx.lineWidth = 12 * (1-t);
      ctx.beginPath();
      ctx.moveTo(pa.x,pa.y);
      ctx.lineTo(pb.x,pb.y);
      ctx.stroke();

      // colored inner
      ctx.strokeStyle = hexToRgba(c, 0.22*(1-t));
      ctx.lineWidth = 8 * (1-t);
      ctx.beginPath();
      ctx.moveTo(pa.x,pa.y);
      ctx.lineTo(pb.x,pb.y);
      ctx.stroke();
    }
  }

  const baseR = nodeRadius() * 1.0; // Figur = Feldgröße
  for(const pc of STATE.pieces){
    const pos = getPieceWorldPos(pc);
    if(!pos) continue;
    const p = worldToScreen(pos.x, pos.y);

    const isActive = (pc.color === STATE.turnColor);
    const isSel = (STATE.selectedPieceId === pc.id);

    ctx.save();
    if(!isActive){
    }
    const r = isSel ? baseR*1.12 : baseR;
    drawPieceToken(p.x, p.y, r, pieceColor(pc.color), isSel && isActive, pc.label);
    ctx.restore();
  }
}

// ===== Picking =====

function dist2(a,b){
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx*dx + dy*dy;
}

function pickPieceAtWorld(pt){
  let best = null;
  let bestD = Infinity;
  const thr = nodeRadius() * 0.95;
  const thr2 = thr*thr;
  for(const pc of STATE.pieces){
    if(pc.color !== STATE.turnColor) continue;
    const wp = getPieceWorldPos(pc);
    if(!wp) continue;
    const d = dist2(wp, pt);
    if(d < thr2 && d < bestD){
      best = pc; bestD = d;
    }
  }
  return best;
}

function pickNodeAtWorld(pt){
  let best = null;
  let bestD = Infinity;
  const thr = nodeRadius() * 0.95;
  const thr2 = thr*thr;
  for(const n of STATE.nodes.values()){
    const d = dist2({x:n.x,y:n.y}, pt);
    if(d < thr2 && d < bestD){
      best = n; bestD = d;
    }
  }
  return best;
}

// ===== Reachability =====

function computeReachableExactSteps(startNodeId, steps){
  const key = (node, depth) => `${node}@@${depth}`;
  const q = [{node:startNodeId, depth:0}];
  const prev = new Map();
  const seen = new Set([key(startNodeId,0)]);

  while(q.length){
    const cur = q.shift();
    if(cur.depth === steps) continue;
    const neigh = STATE.adj.get(cur.node);
    if(!neigh) continue;
    for(const nx of neigh){
      const k = key(nx, cur.depth+1);
      if(seen.has(k)) continue;
      seen.add(k);
      prev.set(k, {node: cur.node, depth: cur.depth});
      q.push({node:nx, depth: cur.depth+1});
    }
  }

  const targets = new Set();
  const paths = new Map();
  for(const k of seen){
    const [node, dStr] = k.split("@@");
    const d = Number(dStr);
    if(d !== steps) continue;
    targets.add(node);

    const path = [node];
    let curNode = node;
    let curDepth = d;
    while(curDepth > 0){
      const p = prev.get(key(curNode, curDepth));
      if(!p) break;
      path.push(p.node);
      curNode = p.node;
      curDepth = p.depth;
    }
    path.reverse();
    paths.set(node, path);
  }
  return {targets, paths};
}

// ===== Reachability (Phase 2.1 Regeln) =====
// Eigene Figuren dürfen NICHT auf dem selben Feld stehen.
// Außerdem: kein sofortiges Zurücklaufen (A->B->A) und keine Schleifen im selben Zug.

function getOccupiedBoardNodesByColor(color, excludePieceId=null){
  const occ = new Set();
  for(const pc of STATE.pieces){
    if(pc.color !== color) continue;
    if(excludePieceId && pc.id === excludePieceId) continue;
    if(pc.posKind === "board" && pc.nodeId) occ.add(pc.nodeId);
  }
  return occ;
}

// Phase-1 reachability rules:
// - no backtracking/loops within the same move (prevents A->B->A and revisits)
// - you MAY pass through your own pieces, but you may NOT END on a field occupied by your own piece
//   ("überspringen" ist erlaubt; nur das Zielfeld darf nicht belegt sein.)
function computeReachableExactSteps_NoBacktrack_NoOwn(startNodeId, steps, blockedNodes = new Set(), barricades = null){
  const targets = new Set();
  const paths = new Map(); // dest -> [start,...,dest]

  function dfs(node, depth, prevNode, visited, path){
    if(depth === steps){
      if(!blockedNodes.has(node)){
        targets.add(node);
        if(!paths.has(node)) paths.set(node, [...path]);
      }
      return;
    }
    const neigh = STATE.adj.get(node);
    if(!neigh) return;

    for(const nx of neigh){
      // nicht sofort zurück
      if(prevNode && nx === prevNode) continue;
      // keine Schleifen
      if(visited.has(nx)) continue;

      // "überspringen" ist erlaubt: belegte Felder dürfen durchlaufen werden,
      // ABER als Zielfeld (exact steps) darf ein belegtes Feld nicht gewählt werden.
      if(depth + 1 === steps && blockedNodes.has(nx)) continue;
      // Barikade: darf NICHT übersprungen werden. Nur darauf landen.
      if(barricades && barricades.has(nx) && (depth + 1) < steps) continue;


      visited.add(nx);
      path.push(nx);
      dfs(nx, depth + 1, node, visited, path);
      path.pop();
      visited.delete(nx);
    }
  }

  const visited = new Set([startNodeId]);
  dfs(startNodeId, 0, null, visited, [startNodeId]);

  return {targets, paths};
}



// ===== Animation (ease + pause + trail) =====

function easeInOutCubic(t){
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
}

async function animateAlongPath(piece, path){
  STATE.phase = "animating";
  setHint("Bewegung…");
  setAction("Animiert…");

  const stepDuration = 220; // ms per step (movement)
  const pauseDuration = 80; // ms pause on each node

  // build world positions for nodes
  const pts = path.map(id => {
    const n = STATE.nodes.get(id);
    return {x:n.x, y:n.y};
  });

  // trail reset
  STATE._trail = [];
  draw();

  // animate between successive points with interpolation + easing
  for(let i=1; i<pts.length; i++){
    const a = pts[i-1];
    const b = pts[i];

    const t0 = performance.now();
    while(true){
      const now = performance.now();
      const raw = (now - t0) / stepDuration;
      const t = clamp(raw, 0, 1);
      const e = easeInOutCubic(t);
      const ix = a.x + (b.x - a.x) * e;
      const iy = a.y + (b.y - a.y) * e;

      // render piece at interpolated position (without changing logical node yet)
      piece._animPos = {x: ix, y: iy};

      // trail: keep short list
      STATE._trail.push({x: ix, y: iy});
      if(STATE._trail.length > 18) STATE._trail.shift();

      drawWithAnim(piece);

      if(t >= 1) break;
      await new Promise(r => requestAnimationFrame(r));
    }

    // commit logical step
    piece._animPos = null;
    piece.posKind = "board";
    piece.nodeId = path[i];

    // add trail node and pause
    STATE._trail.push({x: b.x, y: b.y});
    if(STATE._trail.length > 18) STATE._trail.shift();

    draw();
    await new Promise(r => setTimeout(r, pauseDuration));
  }

  // fade trail out a bit
  for(let k=0;k<10;k++){
    if(STATE._trail.length) STATE._trail.shift();
    draw();
    await new Promise(r => setTimeout(r, 24));
  }

  // Start path flash (idea 9): show the full walked path briefly
  try{
    const flashPts = path.map(id => {
      const n = STATE.nodes.get(id);
      return {x:n.x, y:n.y};
    });
    STATE._pathFlash = { pts: flashPts, t0: performance.now(), dur: 650 };
    requestAnimationFrame(requestPathFlashFrame);
  }catch(_e){}
  STATE._trail = [];

  // After movement: if we landed on a barricade, pick it up and force placement
  const landed = piece.posKind==='board' ? piece.nodeId : null;
  if(landed && STATE.barricades.has(landed)){
    STATE.barricades.delete(landed);
    STATE.carryingBarricade = true;
    STATE.phase = 'place_barricade';
    ui.btnRoll.disabled = true; ui.btnRoll.classList.add('disabled');
    setHint('Barikade aufgenommen! Klick ein normales Feld, um sie zu platzieren.');
    setAction('Barikade platzieren');
    draw();
    return;
  }

  // reset turn (mit 6-Bonus-Regel)
  endTurnOrBonus();
}

function drawWithAnim(animPiece){
  // Draw scene, but render animPiece at custom position
  if(!STATE.board) return;
  clear();
  ctx.setTransform(STATE.view.dpr,0,0,STATE.view.dpr,0,0);

  drawEdges();
  drawNodes();
  drawBarricades();
  drawBarricadePlacementHints();
  drawTargets();

  // trail (uses STATE._trail already)
  // drawPieces, but override animPiece
  // (copy from drawPieces with override)
  if(STATE._trail && STATE._trail.length){
    ctx.lineCap = "round";
    for(let i=0;i<STATE._trail.length-1;i++){
      const a = STATE._trail[i];
      const b = STATE._trail[i+1];
      const pa = worldToScreen(a.x,a.y);
      const pb = worldToScreen(b.x,b.y);
      const t = i/(STATE._trail.length-1);
      ctx.strokeStyle = `rgba(255,255,255,${0.10*(1-t)})`;
      ctx.lineWidth = 10 * (1-t);
      ctx.beginPath();
      ctx.moveTo(pa.x,pa.y);
      ctx.lineTo(pb.x,pb.y);
      ctx.stroke();
    }
  }

  const baseR = nodeRadius() * 1.0; // Figur = Feldgröße
  for(const pc of STATE.pieces){
    let pos;
    if(pc.id === animPiece.id && pc._animPos){
      pos = pc._animPos;
    }else{
      pos = getPieceWorldPos(pc);
    }
    if(!pos) continue;
    const p = worldToScreen(pos.x, pos.y);
    const isSel = (STATE.selectedPieceId === pc.id);
    const r = isSel ? baseR*1.12 : baseR;

    ctx.save();
    if(pc.color !== STATE.turnColor){
}
    drawPieceToken(p.x, p.y, r, pieceColor(pc.color), (pc.color===STATE.turnColor) && isSel, pc.label);
    ctx.restore();
  }
}


async function animateDice(finalValue){
  // 3 seconds rolling in the CENTER overlay (layout stays stable)
  ui.btnRoll.disabled = true;

  if(ui.diceOverlay){
    ui.diceOverlay.classList.add('show','rolling');
  }

  // start visible
  setDicePips(ui.diceFloat || ui.dice, Math.floor(Math.random()*6)+1);

  const tStart = performance.now();
  let lastShown = -1;

  while(true){
    const now = performance.now();
    const t = (now - tStart) / 3000; // 0..1
    if(t >= 1) break;

    const delay = 45 + (t*t)*240; // easing-out
    const val = Math.floor(Math.random()*6)+1;
    const showVal = (val === lastShown) ? ((val % 6) + 1) : val;
    lastShown = showVal;

    setDicePips(ui.diceFloat || ui.dice, showVal);

    await new Promise(r => setTimeout(r, delay));
  }

  // final value on overlay + header
  setDicePips(ui.diceFloat || ui.dice, finalValue);
  setDicePips(ui.dice, finalValue);

  await new Promise(r => setTimeout(r, 900));

  if(ui.diceOverlay){
    ui.diceOverlay.classList.remove('rolling');
    await new Promise(r => setTimeout(r, 40));
    ui.diceOverlay.classList.remove('show');
  }
}

// ===== Game flow =====

function newGame(){
  // ===== Pieces: Rot + Blau (je 5) =====
  STATE.pieces = [];

  for(const color of ["red","blue"]){
    const houses = Array.from(STATE.nodes.values())
      .filter(n => n.kind==="house" && String(n.flags?.houseColor||"").toLowerCase()===color)
      .sort((a,b) => (a.flags.houseSlot ?? 0) - (b.flags.houseSlot ?? 0));

    for(let i=0; i<5; i++){
      STATE.pieces.push({
        id: `p_${color}_${i+1}`,
        label: i+1,
        color,
        posKind: "house",
        houseId: houses[i]?.id ?? houses[0]?.id,
        nodeId: null,
        _animPos: null,
      });
    }
  }

  // ===== Zufällig bestimmen, wer anfängt =====
  STATE.turnColor = PLAYERS[Math.floor(Math.random() * PLAYERS.length)] || "red";
  updateTurnUI();

  STATE.rolled = null;
  STATE.extraRoll = false;
  STATE.phase = "need_roll";
  ui.btnRoll.disabled = false; ui.btnRoll.classList.remove("disabled");
  STATE.selectedPieceId = null;
  STATE.targets = [];
  STATE.targetPaths.clear();
  STATE._trail = [];
  STATE._trailColor = STATE.turnColor;

  // ===== Barikaden: zu Spielbeginn auf ALLEN RUN-Feldern (insgesamt 11) =====
  STATE.barricades = new Set();
  STATE.carryingBarricade = false;

  // Initial-Barikaden: nach Original liegen zu Spielbeginn Barikaden auf ALLEN RUN-Feldern.
  // Du wolltest: insgesamt 11 Stück (typisch = 11 RUN-Felder).
  let runNodes = Array.from(STATE.nodes.values()).filter(n => n.kind==='board' && n.flags?.run);

  // Falls das Board weniger als 11 RUN-Felder markiert hat, markieren wir zusätzlich die besten "Kreuzungs"-Felder als RUN,
  // damit du trotzdem auf 11 Start-Barikaden kommst (ohne board.json manuell anfassen zu müssen).
  const TARGET_RUN_COUNT = 11;
  if(runNodes.length < TARGET_RUN_COUNT){
    const candidates = Array.from(STATE.nodes.values()).filter(n =>
      n.kind==='board' &&
      !n.flags?.run &&
      !n.flags?.goal &&
      !n.flags?.startColor &&
      !n.flags?.noBarricade
    );
    candidates.sort((a,b) => ((STATE.adj.get(b.id)?.size||0) - (STATE.adj.get(a.id)?.size||0)));
    for(const c of candidates){
      if(runNodes.length >= TARGET_RUN_COUNT) break;
      c.flags = c.flags || {};
      c.flags.run = true; // runtime only
      runNodes.push(c);
    }
  }

  for(const n of runNodes){
    STATE.barricades.add(n.id);
  }

  setDicePips(ui.dice, 0);
  ui.rollStats.textContent = "–";
  setHint(`Würfle. ${STATE.turnColor.toUpperCase()} ist dran. Dann klicke eine Figur.`);
  setAction("Neues Spiel");
  draw();
}




async function roll(){
  if(STATE.phase !== "need_roll"){
    setHint("Erst die aktuelle Aktion beenden.");
    return;
  }

  // Online: Server würfelt (authoritativ)
  if(STATE.net.enabled && STATE.net.connected && STATE.net.started){
    const act = canActNow();
    if(!act.ok){ setHint(act.reason); return; }
    netSend({type:"roll_request"});
    return;
  }
  const r = randInt(1,6);
  STATE.rolled = r;
  // 6 = Bonuswurf nach dem Zug
  STATE.extraRoll = (r === 6);
  if(STATE.extraRoll){
    setAction("🎲 6 gewürfelt – Bonuswurf nach dem Zug!");
  }
  await animateDice(r);
  ui.rollStats.textContent = `${r}`;
  STATE.phase = "need_piece";
  ui.btnRoll.disabled = true; ui.btnRoll.classList.add("disabled");
  setHint("Klicke eine Figur, die du bewegen willst.");
  setAction("Wurf gemacht");
  draw();
}

// ===== Input helpers =====

function getEventPosPx(ev){
  const rect = canvas.getBoundingClientRect();
  return { px: (ev.clientX - rect.left), py: (ev.clientY - rect.top) };
}

// ===== Pointer events (Pan + Click) =====

function onPointerDown(ev){
  // capture pointer for smooth drag
  canvas.setPointerCapture?.(ev.pointerId);
  STATE.pointer.dragging = true;
  STATE.pointer.lastPx = ev.clientX;
  STATE.pointer.lastPy = ev.clientY;
  canvas.style.cursor = "grabbing";
}

function onPointerMove(ev){
  if(!STATE.pointer.dragging) return;
  // Pan view
  const dx = ev.clientX - STATE.pointer.lastPx;
  const dy = ev.clientY - STATE.pointer.lastPy;
  STATE.pointer.lastPx = ev.clientX;
  STATE.pointer.lastPy = ev.clientY;
  STATE.view.tx += dx;
  STATE.view.ty += dy;
  draw();
}

function onPointerUp(_ev){
  STATE.pointer.dragging = false;
  canvas.style.cursor = "grab";
}

// ===== Wheel zoom =====

function onWheel(ev){
  ev.preventDefault();
  const { px, py } = getEventPosPx(ev);
  const delta = ev.deltaY;
  const factor = Math.exp(-delta * 0.0015); // smooth
  zoomAt(px, py, STATE.view.scale * factor);
}

// ===== Touch pinch zoom =====

function dist(a,b){
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx*dx + dy*dy);
}

function onTouchStart(ev){
  if(ev.touches.length === 1){
    STATE.pointer.touchMode = "pan";
    STATE.pointer.lastPx = ev.touches[0].clientX;
    STATE.pointer.lastPy = ev.touches[0].clientY;
  } else if(ev.touches.length === 2){
    STATE.pointer.touchMode = "pinch";
    STATE.pointer.pinchStartDist = dist(ev.touches[0], ev.touches[1]);
    STATE.pointer.pinchStartScale = STATE.view.scale;

    // anchor at midpoint
    const midX = (ev.touches[0].clientX + ev.touches[1].clientX)/2;
    const midY = (ev.touches[0].clientY + ev.touches[1].clientY)/2;
    const rect = canvas.getBoundingClientRect();
    const px = midX - rect.left;
    const py = midY - rect.top;
    STATE.pointer.pinchAnchorWorld = screenToWorld(px, py);
  }
}

function onTouchMove(ev){
  if(ev.touches.length === 1 && STATE.pointer.touchMode === "pan"){
    const t = ev.touches[0];
    const dx = t.clientX - STATE.pointer.lastPx;
    const dy = t.clientY - STATE.pointer.lastPy;
    STATE.pointer.lastPx = t.clientX;
    STATE.pointer.lastPy = t.clientY;
    STATE.view.tx += dx;
    STATE.view.ty += dy;
    draw();
  } else if(ev.touches.length === 2){
    // pinch zoom
    const d = dist(ev.touches[0], ev.touches[1]);
    const ratio = d / (STATE.pointer.pinchStartDist || d);
    const newScale = STATE.pointer.pinchStartScale * ratio;

    // zoom around anchor point world -> screen
    const rect = canvas.getBoundingClientRect();
    const midX = (ev.touches[0].clientX + ev.touches[1].clientX)/2;
    const midY = (ev.touches[0].clientY + ev.touches[1].clientY)/2;
    const px = midX - rect.left;
    const py = midY - rect.top;

    // Use zoomAt to keep point stable under fingers:
    zoomAt(px, py, newScale);
  }
  ev.preventDefault();
}

function onTouchEnd(ev){
  if(ev.touches.length === 0){
    STATE.pointer.touchMode = null;
  } else if(ev.touches.length === 1){
    STATE.pointer.touchMode = "pan";
    STATE.pointer.lastPx = ev.touches[0].clientX;
    STATE.pointer.lastPy = ev.touches[0].clientY;
  }
}

// ===== Game click handler (separate from pan) =====

function onCanvasClick(ev){
  // Ignore clicks while dragging (small movement threshold handled by pointer events inherently)
  if(STATE.phase === "animating") return;

  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left);
  const py = (ev.clientY - rect.top);
  const world = screenToWorld(px, py);

  // If we carry a barricade, we must place it now
  if(STATE.phase === 'place_barricade'){
    const n = pickNodeAtWorld(world);
    if(!n){ setHint('Klick auf ein Feld, um die Barikade zu platzieren.'); return; }
    if(!isPlacableBarricadeNode(n)){
      blinkInvalidNode(n);
      setHint('Hier darf keine Barikade hin. Nimm ein normales Feld.');
      return;
    }
    if(STATE.net.enabled && STATE.net.connected && STATE.net.started){
      netSend({type:"place_barricade", nodeId: n.id});
      return;
    }
    STATE.barricades.add(n.id);
    STATE.carryingBarricade = false;
    // turn ends after placement
    STATE.phase = 'need_roll';
    ui.btnRoll.disabled = false; ui.btnRoll.classList.remove('disabled');
    STATE.rolled = null;
    setDicePips(ui.dice, 0);
    ui.rollStats.textContent = '–';
    STATE.selectedPieceId = null;
    STATE.targets = [];
    STATE.targetPaths.clear();
    nextTurn();
    STATE.phase = 'need_roll';
    ui.btnRoll.disabled = false; ui.btnRoll.classList.remove('disabled');
    STATE.rolled = null;
    setDicePips(ui.dice, 0);
    ui.rollStats.textContent = '–';
    STATE.selectedPieceId = null;
    STATE.targets = [];
    STATE.targetPaths.clear();
    setHint(`Barikade platziert. Würfle. ${STATE.turnColor.toUpperCase()} ist dran.`);
    setAction('Zug beendet');
    draw();
    return;
  }

  if(STATE.phase === "need_piece"){
    const pc = pickPieceAtWorld(world);
    if(!pc){
      setHint("Keine Figur getroffen. Klick direkt auf eine Figur.");
      return;
    }
    STATE.selectedPieceId = pc.id;

    const rollVal = STATE.rolled ?? 0;
    if(rollVal <= 0){
      setHint("Bitte erst würfeln.");
      return;
    }

    const startId = STATE.board.meta?.starts?.[STATE.turnColor];
    if(!startId){
      setHint("Startfeld (rot) fehlt im board.json (meta.starts.red).");
      return;
    }

    // leaving house: start counts as 1 step
    if(pc.posKind === "house"){
  const blocked = getOccupiedBoardNodesByColor(STATE.turnColor);
  if(blocked.has(startId)){
    setHint("Startfeld ist durch eine eigene Figur blockiert – du kannst nicht raus.");
    setAction("Zug nicht möglich");
    // Zug zurücksetzen
    STATE.phase = "need_roll";
    ui.btnRoll.disabled = false; ui.btnRoll.classList.remove("disabled");
    STATE.rolled = null;
    setDicePips(ui.dice, 0);
    ui.rollStats.textContent = "–";
    STATE.selectedPieceId = null;
    STATE.targets = [];
    STATE.targetPaths.clear();
    draw();
    return;
  }

  const remaining = Math.max(0, rollVal - 1);

  if(remaining === 0){
    STATE.targets = [startId];
    STATE.targetPaths = new Map([[startId, [startId]]]);
  } else {
    const {targets, paths} = computeReachableExactSteps_NoBacktrack_NoOwn(startId, remaining, blocked, STATE.barricades);
    STATE.targets = Array.from(targets);
    STATE.targetPaths = paths;
  }

  if(!STATE.targets.length){
    setHint("Kein gültiges Ziel möglich.");
    setAction("Zug nicht möglich");
    STATE.phase = "need_roll";
    ui.btnRoll.disabled = false; ui.btnRoll.classList.remove("disabled");
    STATE.rolled = null;
    setDicePips(ui.dice, 0);
    ui.rollStats.textContent = "–";
    STATE.selectedPieceId = null;
    STATE.targets = [];
    STATE.targetPaths.clear();
    draw();
    return;
  }

  STATE.phase = "need_target";
  setHint("Wähle ein Ziel-Feld (blauer Ring).");
  setAction("Ziel wählen");
  draw();
  return;
}

    if(pc.posKind === "board"){
  const cur = pc.nodeId;
  const blocked = getOccupiedBoardNodesByColor(STATE.turnColor, pc.id); // aktuelles Feld zählt nicht als blockiert
  const {targets, paths} = computeReachableExactSteps_NoBacktrack_NoOwn(cur, rollVal, blocked, STATE.barricades);
  STATE.targets = Array.from(targets);
  STATE.targetPaths = paths;

  if(!STATE.targets.length){
    setHint("Kein gültiges Ziel möglich.");
    setAction("Zug nicht möglich");
    STATE.phase = "need_roll";
    ui.btnRoll.disabled = false; ui.btnRoll.classList.remove("disabled");
    STATE.rolled = null;
    setDicePips(ui.dice, 0);
    ui.rollStats.textContent = "–";
    STATE.selectedPieceId = null;
    STATE.targets = [];
    STATE.targetPaths.clear();
    draw();
    return;
  }

  STATE.phase = "need_target";
  setHint("Wähle ein Ziel-Feld (blauer Ring).");
  setAction("Ziel wählen");
  draw();
  return;
}

  }

  if(STATE.phase === "need_target"){
    // allow re-select piece while choosing target
    const maybePc = pickPieceAtWorld(world);
    if(maybePc){
      STATE.selectedPieceId = maybePc.id;
      const rollVal = STATE.rolled ?? 0;
      const startId = STATE.board.meta?.starts?.[STATE.turnColor];
      if(maybePc.posKind === "house"){
        const remaining = Math.max(0, rollVal - 1);
        const blocked = getOccupiedBoardNodesByColor(STATE.turnColor, maybePc.id);
        if(remaining === 0){
          STATE.targets = [startId];
          STATE.targetPaths = new Map([[startId, [startId]]]);
        } else {
          const {targets, paths} = computeReachableExactSteps_NoBacktrack_NoOwn(startId, remaining, blocked, STATE.barricades);
          STATE.targets = Array.from(targets);
          STATE.targetPaths = paths;
        }
      } else if(maybePc.posKind === "board"){
        const cur = maybePc.nodeId;
        const blocked = getOccupiedBoardNodesByColor(STATE.turnColor, maybePc.id);
        const {targets, paths} = computeReachableExactSteps_NoBacktrack_NoOwn(cur, rollVal, blocked, STATE.barricades);
        STATE.targets = Array.from(targets);
        STATE.targetPaths = paths;
      }
      setHint("Andere Figur gewählt. Wähle jetzt ein Ziel-Feld.");
      setAction("Ziel wählen");
      draw();
      return;
    }

    const n = pickNodeAtWorld(world);
    if(!n){
      setHint("Kein Feld getroffen. Klick auf ein Feld mit blauem Ring.");
      return;
    }
    const destId = n.id;
    if(!STATE.targetPaths.has(destId)){
      blinkInvalidNode(n);

      setHint("Dieses Feld ist kein gültiges Ziel. Klick auf ein Feld mit blauem Ring.");
      return;
    }
    const pc = STATE.pieces.find(p => p.id === STATE.selectedPieceId);
    if(!pc){
      setHint("Keine Figur ausgewählt.");
      return;
    }

    const path = STATE.targetPaths.get(destId);
    const startId = STATE.board.meta?.starts?.[STATE.turnColor];

    if(pc.posKind === "house"){
      // place to start immediately
      pc.posKind = "board";
      pc.nodeId = startId;
      draw();
    }

    // Online: Server entscheidet, Client schickt nur die Absicht
    if(STATE.net.enabled && STATE.net.connected && STATE.net.started){
      netSend({type:"move_commit", pieceId: pc.id, path});
      return;
    }

    animateAlongPath(pc, path).catch(err => {
      console.error(err);
      STATE.phase = "need_roll";
  ui.btnRoll.disabled = false; ui.btnRoll.classList.remove("disabled");
      setHint("Fehler bei Animation. Neues Spiel hilft.");
      setAction("Fehler");
      draw();
    });
  }
}

// ===== Load board =====

async function loadBoard(){
  const res = await fetch("./board.json", {cache:"no-store"});
  if(!res.ok) throw new Error("board.json konnte nicht geladen werden");
  const b = await res.json();
  STATE.board = b;

  STATE.nodes = new Map();
  for(const n of b.nodes){
    STATE.nodes.set(n.id, n);
  }
  STATE.edges = b.edges ?? [];
  STATE.adj = new Map();
  for(const [a,b2] of STATE.edges){
    if(!STATE.adj.has(a)) STATE.adj.set(a, new Set());
    if(!STATE.adj.has(b2)) STATE.adj.set(b2, new Set());
    STATE.adj.get(a).add(b2);
    STATE.adj.get(b2).add(a);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for(const n of STATE.nodes.values()){
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  STATE.bounds = {minX, minY, maxX, maxY};

  const countBoard = b.nodes.filter(n => n.kind==="board").length;
  const countHouse = b.nodes.filter(n => n.kind==="house").length;
  ui.boardStats.textContent = `${countBoard} Felder • ${countHouse} Häuser • ${STATE.edges.length} Verbindungen`;

  const start = b.meta?.starts?.red;
  const goal = b.meta?.goal;
  if(!start || !STATE.nodes.has(start)){
    setHint("⚠️ Startfeld rot fehlt oder ist ungültig.");
  } else if(!goal || !STATE.nodes.has(goal)){
    setHint("⚠️ Zielfeld fehlt oder ist ungültig.");
  } else {
    setHint("Würfle, dann klicke eine Figur vom aktiven Spieler (Rot/Blau).");
  }

  newGame();
  updateTurnUI();
  resizeCanvas();
}

function wireUI(){
  ui.btnNew.addEventListener("click", () => newGame());
  ui.btnRoll.addEventListener("click", () => roll());

  // Online Lobby
  if(ui.btnHost){
    ui.btnHost.addEventListener("click", ()=>{
      STATE.net.enabled = true;
      STATE.net.room = (ui.roomCode?.value || "").trim().toUpperCase();
      STATE.net.name = (ui.playerName?.value || "").trim() || "Spieler";
      if(!STATE.net.room){ netSetHint("Bitte Raumcode eingeben."); return; }
      localStorage.setItem("barikade_last_room", STATE.net.room);
      localStorage.setItem("barikade_last_name", STATE.net.name);
      if(!STATE.net.ws || STATE.net.ws.readyState !== 1) netConnect(false);
      setTimeout(()=>netSend({type:"join", room: STATE.net.room, name: STATE.net.name, sessionToken:getSessionToken(), asHost:true}), 150);
    });
  }
  if(ui.btnJoin){
    ui.btnJoin.addEventListener("click", ()=>{
      STATE.net.enabled = true;
      STATE.net.room = (ui.roomCode?.value || "").trim().toUpperCase();
      STATE.net.name = (ui.playerName?.value || "").trim() || "Spieler";
      if(!STATE.net.room){ netSetHint("Bitte Raumcode eingeben."); return; }
      localStorage.setItem("barikade_last_room", STATE.net.room);
      localStorage.setItem("barikade_last_name", STATE.net.name);
      if(!STATE.net.ws || STATE.net.ws.readyState !== 1) netConnect(false);
      setTimeout(()=>netSend({type:"join", room: STATE.net.room, name: STATE.net.name, sessionToken:getSessionToken(), asHost:false}), 150);
    });
  }
  if(ui.btnStart){
    ui.btnStart.addEventListener("click", ()=> netSend({type:"start"}));
  }
  if(ui.btnLeave){
    ui.btnLeave.addEventListener("click", ()=>{
      try{ netSend({type:"leave"}); }catch(_e){}
      netDisconnect();
      netSetHint("Offline-Modus.");
    });
  }
  if(ui.btnCopyDiag){
    ui.btnCopyDiag.addEventListener("click", ()=> copyDiagnosticsToClipboard());
  }
  if(ui.btnClearLog){
    ui.btnClearLog.addEventListener("click", ()=>{ NET_LOG=[]; if(ui.netLog) ui.netLog.textContent="–"; netSetHint("Log geleert."); });
  }


  // Pan (pointer) + click (separately)
  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  // zoom
  canvas.addEventListener("wheel", onWheel, {passive:false});

  // touch pinch (prevent browser scroll)
  canvas.addEventListener("touchstart", onTouchStart, {passive:false});
  canvas.addEventListener("touchmove", onTouchMove, {passive:false});
  canvas.addEventListener("touchend", onTouchEnd, {passive:false});

  // gameplay clicks
  canvas.addEventListener("click", onCanvasClick);

  window.addEventListener("resize", () => resizeCanvas(), {passive:true});
}

(async function main(){
  wireUI();
  // Online: sofort verbinden (Server fest integriert)
  if(ui.serverLabel) ui.serverLabel.textContent = STATE.net.url;
  netConnect(false);
  netSetHint('Raumcode eingeben → Host oder Beitreten.');
  setInterval(()=>{ if(STATE.net.ws && STATE.net.ws.readyState===1) netSend({type:'ping'}); }, 10000);
  try{ if(ui.roomCode) ui.roomCode.value = (localStorage.getItem('barikade_last_room')||'').toUpperCase(); }catch(_e){}
  try{ if(ui.playerName) ui.playerName.value = (localStorage.getItem('barikade_last_name')||''); }catch(_e){}

  try{
    await loadBoard();
  }catch(e){
    console.error(e);
    setHint("Fehler: board.json konnte nicht geladen werden. Starte über lokalen Server oder prüfe Dateien.");
    ui.boardStats.textContent = "Fehler beim Laden";
  }
})();


function blinkInvalidNode(node){
  const p = worldToScreen(node.x, node.y);
  const r = nodeRadius() * 1.15;
  let t = 0;
  const blink = () => {
    t++;
    clear();
    ctx.setTransform(STATE.view.dpr,0,0,STATE.view.dpr,0,0);
    drawEdges();
    drawNodes();
    drawPieces();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI*2);
    ctx.strokeStyle = `rgba(255,50,50,${0.9 - t*0.15})`;
    ctx.lineWidth = 4;
    ctx.stroke();
    if(t < 5) requestAnimationFrame(blink);
  };
  blink();
}
