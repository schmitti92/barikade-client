// Barikade Online – Rebuild (Client)
// Ziel: simpler Flow + weniger Sync-Fehler
// Architektur: Server = Room+Roster, Host = authoritative game-state, Clients senden nur "intents".

const $ = (id) => document.getElementById(id);

// ===== UI =====
const ui = {
  canvas: $("board"),
  ctx: $("board").getContext("2d"),
  connPill: $("connPill"),
  connDot: $("connDot"),
  connText: $("connText"),
  serverUrl: $("serverUrl"),
  room: $("room"),
  btnHost: $("btnHost"),
  btnJoin: $("btnJoin"),
  btnLeave: $("btnLeave"),
  btnStart: $("btnStart"),

  myColor: $("myColor"),
  turnDot: $("turnDot"),
  turnText: $("turnText"),
  dice: $("dice"),
  phase: $("phase"),
  hint: $("hint"),

  btnRoll: $("btnRoll"),
  btnEnd: $("btnEnd"),
  btnSkip: $("btnSkip"),
  btnReset: $("btnReset"),

  players: $("players"),
  toast: $("toast"),

  btnHelp: $("btnHelp"),
  helpDlg: $("helpDlg"),
};

// ===== Config =====
const SERVER_URL = "wss://barikade-server.onrender.com";
ui.serverUrl.textContent = SERVER_URL;

const COLORS = ["red","blue","green","yellow"];
const COLOR_NAME = {red:"Rot", blue:"Blau", green:"Grün", yellow:"Gelb"};

const STYLE = {
  bgNode: "rgba(255,255,255,0.90)",
  stroke: "rgba(15,26,46,1)",
  edge: "rgba(255,255,255,0.20)",
  run: "rgba(255,226,154,0.95)",
  goal: "rgba(199,166,255,0.95)",
  barricade: "rgba(255,93,108,0.95)",
};

// ===== Helpers =====
function toast(msg){
  ui.toast.textContent = msg;
  ui.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>ui.toast.classList.remove("show"), 1200);
}
function randRoom(len=6){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s=""; for(let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function normRoom(s){ return (s||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,10); }
function safeParse(s){ try{ return JSON.parse(s);}catch{ return null; } }

// ===== Board data =====
let board=null;
let nodeById=new Map();
let adj=new Map();
let runNodes=new Set();
let startByColor={red:null,blue:null,green:null,yellow:null};
let goalId=null;

async function loadBoard(){
  if(board) return board;
  const res = await fetch("board.json", {cache:"no-store"});
  if(!res.ok) throw new Error("board.json fehlt");
  board = await res.json();
  buildGraph();
  return board;
}
function buildGraph(){
  nodeById = new Map();
  adj = new Map();
  runNodes = new Set();
  startByColor={red:null,blue:null,green:null,yellow:null};
  goalId=null;

  for(const n of board.nodes){
    nodeById.set(n.id, n);
    if(n.kind==="board"){
      adj.set(n.id, []);
      if(n.flags?.run) runNodes.add(n.id);
      if(n.flags?.goal) goalId = n.id;
      if(n.flags?.startColor) startByColor[n.flags.startColor]=n.id;
    }
  }
  for(const e of (board.edges||[])){
    const a=String(e[0]), b=String(e[1]);
    if(!adj.has(a)||!adj.has(b)) continue;
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  // optional meta
  if(board.meta?.goal) goalId = board.meta.goal;
  if(board.meta?.starts){
    for(const c of COLORS) if(board.meta.starts[c]) startByColor[c]=board.meta.starts[c];
  }
}

// ===== View / Camera =====
let dpr=1;
let view={x:0,y:0,s:1};
let isPanning=false;
let panStart=null;

function fitToBoard(){
  const nodes = board.nodes.filter(n=>n.kind==="board");
  const xs = nodes.map(n=>n.x), ys = nodes.map(n=>n.y);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const pad=90;
  const w=(maxX-minX)+pad*2, h=(maxY-minY)+pad*2;

  const cw=ui.canvas.clientWidth, ch=ui.canvas.clientHeight;
  const s=Math.min(cw/w, ch/h);
  view.s = s;
  view.x = -minX + pad;
  view.y = -minY + pad;
}

function worldToScreen(pt){
  return {x:(pt.x+view.x)*view.s, y:(pt.y+view.y)*view.s};
}
function screenToWorld(pt){
  return {x:pt.x/view.s - view.x, y:pt.y/view.s - view.y};
}

// ===== Game state (host authoritative) =====
let netMode="offline"; // offline|host|client
let ws=null;
let roomCode="";
let clientId = (localStorage.getItem("barikade_rebuild_clientId")||"");
if(!clientId){
  clientId = "c_" + Math.random().toString(36).slice(2,10);
  localStorage.setItem("barikade_rebuild_clientId", clientId);
}

let roster=[]; // [{clientId,name,role,connected,color,isHost}]
let myColor=null;

let state=null;
// state = {
//   gamePhase: "lobby"|"running",
//   players: ["red","blue",...],  // active colors
//   currentPlayer: "red",
//   dice: number|null,
//   phase: "need_roll"|"need_move"|"placing_barricade"|"game_over",
//   pieces: { red:[{pos:"house"|nodeId|"goal"} x5], ... },
//   barricades: Set(nodeId),
//   placingChoices: [nodeId],
//   winner: color|null
// }

function defaultState(activeColors=["red","blue"]){
  const players = activeColors.slice(0,4);
  const pieces = {};
  for(const c of players) pieces[c]=Array.from({length:5},()=>({pos:"house"}));
  const barr = new Set();
  // start with barricades on all run-nodes (except goal) – simple and deterministic
  for(const id of runNodes){
    if(id===goalId) continue;
    barr.add(id);
  }
  return {
    gamePhase:"lobby",
    players,
    currentPlayer: players[0],
    dice: null,
    phase: "need_roll",
    pieces,
    barricades: barr,
    placingChoices: [],
    winner: null
  };
}

function serializeState(){
  const st = JSON.parse(JSON.stringify(state));
  st.barricades = Array.from(state.barricades || []);
  return st;
}
function applyState(remote){
  const st = (typeof remote==="string") ? safeParse(remote) : remote;
  if(!st || typeof st!=="object") return;

  if(Array.isArray(st.barricades)) st.barricades = new Set(st.barricades);
  state = st;

  // safety defaults
  if(!state.players || state.players.length<2) state.players=["red","blue"];
  if(!state.pieces) state.pieces = Object.fromEntries(state.players.map(c=>[c, Array.from({length:5},()=>({pos:"house"}))]));
  if(!state.phase) state.phase = state.winner ? "game_over" : (state.dice==null ? "need_roll" : "need_move");
  if(!Array.isArray(state.placingChoices)) state.placingChoices = [];

  updateUI();
  draw();
}

// ===== Rules (client-side, host validates and broadcasts) =====
function isMyTurn(){
  if(netMode==="offline") return true;
  return !!myColor && state && myColor===state.currentPlayer;
}

function enumeratePaths(startId, steps){
  const results=[];
  const visited=new Set([startId]);
  function dfs(curr, remaining, path){
    if(remaining===0){ results.push([...path]); return; }
    for(const nb of (adj.get(curr)||[])){
      if(visited.has(nb)) continue;
      if(state.barricades.has(nb) && remaining>1) continue; // cannot pass through barricade
      visited.add(nb); path.push(nb);
      dfs(nb, remaining-1, path);
      path.pop(); visited.delete(nb);
    }
  }
  dfs(startId, steps, [startId]);
  return results;
}

function computeMoves(color, dice){
  const moves=[];
  // pieces on board
  for(let i=0;i<5;i++){
    const p=state.pieces[color]?.[i];
    if(!p) continue;
    if(typeof p.pos==="string" && adj.has(p.pos)){
      for(const path of enumeratePaths(p.pos, dice)){
        moves.push({piece:{color,index:i}, from:p.pos, to:path[path.length-1], path, fromHouse:false});
      }
    }
  }
  // from house via start
  const start = startByColor[color];
  const hasHouse = (state.pieces[color]||[]).some(p=>p.pos==="house");
  if(hasHouse && start && !state.barricades.has(start)){
    const remaining = dice-1;
    if(remaining===0){
      for(let i=0;i<5;i++){
        if(state.pieces[color][i].pos==="house"){
          moves.push({piece:{color,index:i}, from:"house", to:start, path:[start], fromHouse:true});
        }
      }
    }else{
      for(let i=0;i<5;i++){
        if(state.pieces[color][i].pos!=="house") continue;
        for(const path of enumeratePaths(start, remaining)){
          moves.push({piece:{color,index:i}, from:"house", to:path[path.length-1], path, fromHouse:true});
        }
      }
    }
  }
  // uniq
  const seen=new Set(), out=[];
  for(const m of moves){
    const k=`${m.piece.color}:${m.piece.index}->${m.to}:${m.fromHouse?'H':'B'}`;
    if(seen.has(k)) continue;
    seen.add(k); out.push(m);
  }
  return out;
}

function anyPiecesAt(nodeId){
  const res=[];
  for(const c of state.players){
    for(let i=0;i<5;i++){
      if(state.pieces[c][i].pos===nodeId) res.push({color:c,index:i});
    }
  }
  return res;
}

function computeBarricadeChoices(){
  const choices=[];
  for(const id of adj.keys()){
    if(id===goalId) continue;
    if(state.barricades.has(id)) continue;
    choices.push(id);
  }
  return choices;
}

function checkWin(){
  for(const c of state.players){
    const done = state.pieces[c].filter(p=>p.pos==="goal").length;
    if(done===5){
      state.winner=c;
      state.phase="game_over";
      state.gamePhase="running";
      return true;
    }
  }
  return false;
}

function nextPlayer(){
  const order = state.players;
  const idx = order.indexOf(state.currentPlayer);
  state.currentPlayer = order[(idx+1)%order.length];
  state.dice=null;
  state.phase="need_roll";
  state.placingChoices=[];
}

function endTurn(){
  if(state.dice===6 && !state.winner){
    // extra roll
    state.dice=null;
    state.phase="need_roll";
    state.placingChoices=[];
    toast("6! Nochmal würfeln");
    return;
  }
  nextPlayer();
}

function applyMove(move){
  // move = {piece:{color,index}, to, path}
  const {color,index} = move.piece;
  const toId = move.to;

  // hit enemies
  const enemies = anyPiecesAt(toId).filter(p=>p.color!==color);
  for(const e of enemies) state.pieces[e.color][e.index].pos="house";

  const landsOnBarr = state.barricades.has(toId);

  state.pieces[color][index].pos = toId;

  if(toId===goalId){
    state.pieces[color][index].pos="goal";
    toast("Ziel erreicht!");
    if(checkWin()) return;
    endTurn();
    return;
  }

  if(landsOnBarr){
    state.barricades.delete(toId);
    state.phase="placing_barricade";
    state.placingChoices = computeBarricadeChoices();
    toast("Barikade eingesammelt – neu platzieren");
    return;
  }

  endTurn();
}

// ===== Animation =====
let anim = null; // {color,index, points:[{x,y}], t, dur}
function startAnimForMove(move){
  const {color,index} = move.piece;
  const pts = [];
  for(const id of move.path){
    const n = nodeById.get(id);
    if(n) pts.push({x:n.x, y:n.y});
  }
  if(!pts.length){
    anim=null; return;
  }
  anim = {color,index, points: pts, t:0, dur: 360 + pts.length*110};
  requestAnimationFrame(tickAnim);
}
function tickAnim(ts){
  if(!anim) return;
  if(!anim._last) anim._last = ts;
  const dt = ts - anim._last;
  anim._last = ts;
  anim.t += dt;
  if(anim.t >= anim.dur){
    anim = null;
    draw();
    return;
  }
  draw();
  requestAnimationFrame(tickAnim);
}
function animPos(){
  if(!anim) return null;
  const u = Math.min(1, Math.max(0, anim.t/anim.dur));
  const segs = anim.points.length-1;
  if(segs<=0) return anim.points[0];
  const x = u*segs;
  const i = Math.min(segs-1, Math.floor(x));
  const f = x - i;
  const a = anim.points[i], b = anim.points[i+1];
  return {x:a.x + (b.x-a.x)*f, y:a.y + (b.y-a.y)*f, color: anim.color, index: anim.index};
}

// ===== Selection / clicks =====
let selected=null; // {color,index} (only current player pieces)
let legalMoves=[]; // moves for current player after roll
let legalByPiece=new Map();
let hoverNodeId=null;

function recalcLegals(){
  legalMoves=[];
  legalByPiece=new Map();
  if(!state || state.gamePhase!=="running") return;
  if(state.phase!=="need_move") return;
  if(state.dice==null) return;

  legalMoves = computeMoves(state.currentPlayer, state.dice);
  for(const m of legalMoves){
    const idx=m.piece.index;
    if(!legalByPiece.has(idx)) legalByPiece.set(idx, []);
    legalByPiece.get(idx).push(m);
  }
  // auto-select first movable piece (nice UX)
  if(!selected && legalMoves.length){
    selected = legalMoves[0].piece;
  }
}

function nodeAtWorld(x,y){
  // nearest node within radius
  const r = 22;
  let best=null, bestD=1e9;
  for(const n of board.nodes){
    if(n.kind!=="board") continue;
    const dx=n.x-x, dy=n.y-y;
    const d=Math.hypot(dx,dy);
    if(d<r && d<bestD){ best=n; bestD=d; }
  }
  return best;
}

function canSelectPieceAt(nodeId){
  const c=state.currentPlayer;
  for(let i=0;i<5;i++){
    if(state.pieces[c][i].pos===nodeId){
      return true;
    }
  }
  return false;
}

function pickPieceAt(nodeId){
  const c=state.currentPlayer;
  for(let i=0;i<5;i++){
    if(state.pieces[c][i].pos===nodeId){
      selected={color:c,index:i};
      toast(`Figur ${i+1} gewählt`);
      return true;
    }
  }
  return false;
}

function tryMoveTo(nodeId){
  if(state.phase==="placing_barricade"){
    if(!state.placingChoices.includes(nodeId)) return;
    // host applies, or send intent
    doIntent({type:"place_barricade", nodeId});
    return;
  }

  if(state.phase!=="need_move") return;
  if(!selected) return;

  const list = legalByPiece.get(selected.index) || [];
  const move = list.find(m=>m.to===nodeId);
  if(!move) return;

  doIntent({type:"move", move});
}

function handleCanvasTap(worldPt){
  const n=nodeAtWorld(worldPt.x, worldPt.y);
  if(!n) return;

  if(state.gamePhase!=="running"){ toast("Erst starten"); return; }

  if(!isMyTurn()){ toast("Du bist nicht dran"); return; }

  if(state.phase==="need_roll"){ toast("Erst würfeln"); return; }

  if(state.phase==="placing_barricade"){
    tryMoveTo(n.id);
    return;
  }

  if(state.phase==="need_move"){
    // tap own piece selects it; otherwise try move
    if(canSelectPieceAt(n.id)){
      pickPieceAt(n.id);
      draw();
      return;
    }
    tryMoveTo(n.id);
  }
}

// ===== Networking =====
function setConn(text, good){
  ui.connText.textContent = text;
  ui.connDot.style.background = good ? "var(--green)" : "var(--muted)";
}

function wsSend(obj){
  if(!ws || ws.readyState!==1) return false;
  try{ ws.send(JSON.stringify(obj)); return true; }catch{ return false; }
}

function connect(mode){
  roomCode = normRoom(ui.room.value);
  if(mode==="host" && !roomCode) roomCode = randRoom(6);
  ui.room.value = roomCode;

  if(!roomCode){ toast("Raumcode fehlt"); return; }

  netMode = mode;
  localStorage.setItem("barikade_rebuild_room", roomCode);
  localStorage.setItem("barikade_rebuild_mode", netMode);

  if(ws && (ws.readyState===0 || ws.readyState===1)) ws.close();

  setConn("Verbinden…", false);
  ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    setConn("Verbunden", true);
    wsSend({type:"join", room:roomCode, role:netMode, clientId, name:(netMode==="host"?"Host":"Client"), ts:Date.now()});
    wsSend({type:"need_state", room:roomCode, clientId, ts:Date.now()});
    wsSend({type:"need_snapshot", room:roomCode, clientId, ts:Date.now()});
  };

  ws.onmessage = (ev) => {
    const msg = (typeof ev.data==="string") ? safeParse(ev.data) : null;
    if(!msg) return;
    const t = msg.type;

    if(t==="players" || t==="roster"){
      roster = msg.players || msg.list || [];
      // normalize server field names
      roster = roster.map(p=>({
        clientId: p.clientId || p.id || p.client_id,
        name: p.name || "",
        role: p.role || "client",
        connected: p.connected !== false,
        color: p.color || null,
        isHost: !!p.isHost || (msg.hostClientId && (p.clientId===msg.hostClientId))
      }));
      renderRoster();
      const me = roster.find(p=>p.clientId===clientId);
      myColor = me?.color || null;
      renderMyColor();
      if(netMode==="host" && (!state || state.gamePhase==="lobby")){
        // keep player list synced to active colors in lobby
        syncPlayersToRoster();
      }
      updateUI();
      draw();
      return;
    }

    if(t==="joined"){
      if(msg.room) roomCode = normRoom(msg.room);
      ui.room.value = roomCode;
      return;
    }

    if(t==="snapshot" || t==="state"){
      const st = msg.snapshot || msg.state;
      if(st) applyState(st);
      return;
    }

    if(t==="intent"){
      if(netMode!=="host") return;
      const intent = msg.intent || msg.payload;
      const sender = msg.clientId;
      if(intent) handleRemoteIntent(intent, sender);
      return;
    }

    if(t==="color_denied"){
      toast("Farbe belegt – neu verbinden");
      return;
    }
  };

  ws.onclose = () => {
    setConn("Getrennt", false);
  };
  ws.onerror = () => setConn("Fehler", false);
}

function disconnect(){
  netMode="offline";
  roster=[];
  myColor=null;
  if(ws){ try{ ws.close(); }catch{} }
  ws=null;
  setConn("Offline", false);
  renderRoster();
  renderMyColor();
  updateUI();
  draw();
}

function renderRoster(){
  if(!roster.length){ ui.players.textContent="–"; return; }
  const parts = roster.map(p=>{
    const col = p.color ? COLOR_NAME[p.color] : "–";
    const dot = p.connected ? "✔" : "✖";
    const isH = p.isHost ? " Host" : "";
    const badge = `<span class="badge"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--${p.color||"muted"});"></span>${col}${isH} ${dot}</span>`;
    const name = (p.name||p.clientId||"Spieler").replace(/</g,"&lt;");
    return `${badge}<b>${name}</b>`;
  });
  ui.players.innerHTML = parts.join("<br>");
}

function renderMyColor(){
  if(!myColor){
    ui.myColor.textContent = "–";
    ui.myColor.style.color = "var(--muted)";
    return;
  }
  ui.myColor.textContent = COLOR_NAME[myColor];
  ui.myColor.style.color = `var(--${myColor})`;
}

function broadcastState(kind="state"){
  if(netMode!=="host") return;
  const payload = serializeState();
  wsSend({type: kind==="snapshot" ? "snapshot" : "state", room:roomCode, [kind==="snapshot"?"snapshot":"state"]: payload, ts:Date.now()});
}

function doIntent(intent){
  if(netMode==="offline"){
    applyIntentLocal(intent, clientId);
    return;
  }
  if(netMode==="host"){
    applyIntentLocal(intent, clientId);
    broadcastState("state");
    return;
  }
  // client -> host
  wsSend({type:"intent", room:roomCode, clientId, intent, ts:Date.now()});
}

function handleRemoteIntent(intent, senderId){
  applyIntentLocal(intent, senderId);
  broadcastState("state");
}

function activeColorsFromRoster(){
  const order={red:0,blue:1,green:2,yellow:3};
  const set=new Set();
  for(const p of roster){
    if(p.color) set.add(p.color);
  }
  return Array.from(set).sort((a,b)=>order[a]-order[b]);
}

function syncPlayersToRoster(){
  if(!state) return;
  if(state.gamePhase!=="lobby") return;
  const active = activeColorsFromRoster();
  if(active.length>=2){
    state.players = active;
    // ensure pieces structure
    state.pieces = state.pieces || {};
    for(const c of active){
      if(!state.pieces[c]) state.pieces[c]=Array.from({length:5},()=>({pos:"house"}));
    }
    // drop inactive colors
    for(const c of Object.keys(state.pieces)){
      if(!active.includes(c)) delete state.pieces[c];
    }
    if(!active.includes(state.currentPlayer)){
      state.currentPlayer = active[0];
      state.dice=null;
      state.phase="need_roll";
    }
  }
}

function canStart(){
  const active = activeColorsFromRoster();
  return (netMode==="host") && active.length>=2 && state && state.gamePhase==="lobby";
}

// ===== Intent reducer =====
function applyIntentLocal(intent, senderId){
  if(!state){
    // offline first init
    state = defaultState(["red","blue"]);
  }

  // who can act?
  const senderColor = (netMode==="offline") ? state.currentPlayer : (roster.find(p=>p.clientId===senderId)?.color || null);

  if(intent.type==="reset"){
    if(netMode!=="offline" && netMode!=="host") return;
    state = defaultState(activeColorsFromRoster().length?activeColorsFromRoster():["red","blue"]);
    state.gamePhase="lobby";
    state.phase="need_roll";
    state.dice=null;
    selected=null;
    anim=null;
    return;
  }

  if(intent.type==="start"){
    if(netMode!=="offline" && netMode!=="host") return;
    syncPlayersToRoster();
    if(state.players.length<2){ toast("Mindestens 2 Spieler"); return; }
    state.gamePhase="running";
    state.winner=null;
    state.dice=null;
    state.phase="need_roll";
    state.currentPlayer = state.players[0];
    selected=null;
    anim=null;
    return;
  }

  if(state.gamePhase!=="running"){
    // ignore game actions if not running
    return;
  }

  // Turn ownership
  if(netMode!=="offline"){
    if(!senderColor) return;
    if(senderColor !== state.currentPlayer) return;
  }

  if(intent.type==="roll"){
    if(state.phase!=="need_roll") return;
    state.dice = 1 + Math.floor(Math.random()*6);
    state.phase = "need_move";
    state.placingChoices=[];
    selected=null;
    recalcLegals();
    if(!legalMoves.length){
      toast("Kein Zug möglich – Zug verfällt");
      endTurn();
      state.dice = null;
      state.phase = "need_roll";
    }
    return;
  }

  if(intent.type==="skip"){
    if(state.phase==="placing_barricade" || state.phase==="game_over") return;
    nextPlayer();
    return;
  }

  if(intent.type==="end"){
    if(state.phase!=="need_move") return;
    endTurn();
    return;
  }

  if(intent.type==="move"){
    if(state.phase!=="need_move") return;
    if(state.dice==null) return;

    // validate that move is legal
    const moves = computeMoves(state.currentPlayer, state.dice);
    const ok = moves.find(m=>m.piece.index===intent.move?.piece?.index && m.to===intent.move?.to);
    if(!ok) return;

    startAnimForMove(ok);
    applyMove(ok);

    // after move: if need move again (6) -> dice null etc handled by endTurn()
    state.phase = state.winner ? "game_over" : state.phase;
    state.placingChoices = Array.isArray(state.placingChoices) ? state.placingChoices : [];
    return;
  }

  if(intent.type==="place_barricade"){
    if(state.phase!=="placing_barricade") return;
    const id = intent.nodeId;
    if(!state.placingChoices.includes(id)) return;
    state.barricades.add(id);
    state.placingChoices=[];
    // after placement: end turn (but keep 6 rule? in Barikade rule: placement counts as after landing; still your turn ends. We'll end turn normally.)
    nextPlayer();
    return;
  }
}

// ===== UI actions =====
ui.btnHost.addEventListener("click", async ()=>{
  ui.room.value = normRoom(ui.room.value);
  connect("host");
});
ui.btnJoin.addEventListener("click", async ()=>{
  ui.room.value = normRoom(ui.room.value);
  connect("client");
});
ui.btnLeave.addEventListener("click", ()=>disconnect());

ui.btnStart.addEventListener("click", ()=>{
  if(netMode==="offline"){ toast("Online: Host starten"); return; }
  if(netMode!=="host"){ toast("Nur Host kann starten"); return; }
  doIntent({type:"start"});
  broadcastState("snapshot");
});

ui.btnRoll.addEventListener("click", ()=>{
  if(!state || state.gamePhase!=="running") return toast("Erst starten");
  if(!isMyTurn()) return toast("Du bist nicht dran");
  doIntent({type:"roll"});
});
ui.btnEnd.addEventListener("click", ()=>{
  if(!state || state.gamePhase!=="running") return;
  if(!isMyTurn()) return toast("Du bist nicht dran");
  doIntent({type:"end"});
});
ui.btnSkip.addEventListener("click", ()=>{
  if(!state || state.gamePhase!=="running") return;
  if(!isMyTurn()) return toast("Du bist nicht dran");
  doIntent({type:"skip"});
});
ui.btnReset.addEventListener("click", ()=>{
  if(netMode==="offline" || netMode==="host"){
    doIntent({type:"reset"});
    if(netMode==="host") broadcastState("snapshot");
  }else{
    toast("Reset nur Host");
  }
});

ui.btnHelp.addEventListener("click", ()=>ui.helpDlg.showModal());

// ===== Canvas interactions =====
function resizeCanvas(){
  dpr = Math.max(1, Math.floor(window.devicePixelRatio||1));
  ui.canvas.width = Math.floor(ui.canvas.clientWidth * dpr);
  ui.canvas.height = Math.floor(ui.canvas.clientHeight * dpr);
  ui.ctx.setTransform(dpr,0,0,dpr,0,0);
  if(board) fitToBoard();
  draw();
}
window.addEventListener("resize", resizeCanvas);

function pointerPos(ev){
  const r = ui.canvas.getBoundingClientRect();
  return {x: ev.clientX - r.left, y: ev.clientY - r.top};
}

ui.canvas.addEventListener("pointerdown", (ev)=>{
  ui.canvas.setPointerCapture(ev.pointerId);
  const p = pointerPos(ev);
  const w = screenToWorld(p);
  // if 2 fingers? we keep simple: 1 finger pans when space around, tap selects on release
  isPanning = true;
  panStart = {sx:p.x, sy:p.y, vx:view.x, vy:view.y, moved:false};
});
ui.canvas.addEventListener("pointermove", (ev)=>{
  if(!isPanning || !panStart) return;
  const p = pointerPos(ev);
  const dx = (p.x - panStart.sx)/view.s;
  const dy = (p.y - panStart.sy)/view.s;
  if(Math.hypot(dx,dy) > 4/view.s) panStart.moved=true;
  view.x = panStart.vx + dx;
  view.y = panStart.vy + dy;

  const w = screenToWorld(p);
  const n = board ? nodeAtWorld(w.x,w.y) : null;
  hoverNodeId = n ? n.id : null;

  draw();
});
ui.canvas.addEventListener("pointerup", (ev)=>{
  if(!isPanning || !panStart) return;
  const p = pointerPos(ev);
  const w = screenToWorld(p);
  const moved = panStart.moved;
  isPanning=false;
  panStart=null;
  if(!moved){
    handleCanvasTap(w);
  }
  draw();
});
ui.canvas.addEventListener("pointercancel", ()=>{
  isPanning=false; panStart=null;
});

// Zoom (wheel)
ui.canvas.addEventListener("wheel", (ev)=>{
  ev.preventDefault();
  const p = pointerPos(ev);
  const before = screenToWorld(p);
  const delta = Math.sign(ev.deltaY);
  const factor = delta>0 ? 0.92 : 1.08;
  view.s = Math.max(0.2, Math.min(2.5, view.s*factor));
  const after = screenToWorld(p);
  view.x += (before.x - after.x);
  view.y += (before.y - after.y);
  draw();
}, {passive:false});

// ===== Drawing =====
function colorVar(c){ return `var(--${c})`; }

function draw(){
  const ctx = ui.ctx;
  const w = ui.canvas.clientWidth;
  const h = ui.canvas.clientHeight;
  ctx.clearRect(0,0,w,h);

  if(!board){
    ctx.fillStyle="rgba(255,255,255,.7)";
    ctx.font="600 16px system-ui";
    ctx.fillText("Lade Board…", 14, 28);
    return;
  }

  // edges
  ctx.lineWidth=3;
  ctx.lineCap="round";
  ctx.strokeStyle = STYLE.edge;
  for(const e of (board.edges||[])){
    const a=nodeById.get(String(e[0]));
    const b=nodeById.get(String(e[1]));
    if(!a||!b) continue;
    const A=worldToScreen(a), B=worldToScreen(b);
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
  }

  // nodes
  const radius=18;
  for(const n of board.nodes){
    if(n.kind!=="board") continue;
    const P=worldToScreen(n);

    // base fill
    let fill=STYLE.bgNode;
    if(n.id===goalId) fill=STYLE.goal;
    else if(runNodes.has(n.id)) fill=STYLE.run;

    // barricade
    const isBarr = state && state.barricades?.has?.(n.id);
    if(isBarr) fill = STYLE.barricade;

    // highlight hover / legal
    let ring=null;
    if(state && state.gamePhase==="running" && isMyTurn()){
      if(state.phase==="placing_barricade"){
        if(state.placingChoices.includes(n.id)) ring="rgba(255,255,255,.70)";
      }else if(state.phase==="need_move" && selected){
        const list = legalByPiece.get(selected.index) || [];
        if(list.some(m=>m.to===n.id)) ring="rgba(255,255,255,.70)";
      }
    }
    if(hoverNodeId===n.id) ring="rgba(255,255,255,.85)";

    ctx.beginPath();
    ctx.arc(P.x, P.y, radius, 0, Math.PI*2);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.lineWidth = 2;
    ctx.strokeStyle = ring || "rgba(15,26,46,1)";
    ctx.stroke();
  }

  // pieces
  if(state){
    const ap = animPos();
    for(const c of state.players){
      for(let i=0;i<5;i++){
        let pos = state.pieces[c][i].pos;
        if(pos==="house" || pos==="goal") continue;
        const node = nodeById.get(pos);
        if(!node) continue;
        let P=worldToScreen(node);

        // override with anim position
        if(ap && ap.color===c && ap.index===i){
          P = worldToScreen(ap);
        }

        // offset per piece index so stacks are visible
        const off = (i-2)*4;
        ctx.beginPath();
        ctx.arc(P.x + off, P.y - off, 10, 0, Math.PI*2);
        ctx.fillStyle = colorVar(c);
        ctx.fill();

        ctx.lineWidth=2;
        ctx.strokeStyle="rgba(15,26,46,1)";
        ctx.stroke();

        // selected ring
        if(selected && selected.color===c && selected.index===i){
          ctx.beginPath();
          ctx.arc(P.x + off, P.y - off, 14, 0, Math.PI*2);
          ctx.strokeStyle="rgba(255,255,255,.9)";
          ctx.lineWidth=2;
          ctx.stroke();
        }
      }
    }
  }
}

// ===== UI state =====
function updateUI(){
  if(!state){
    ui.turnText.textContent="–";
    ui.turnDot.style.background="var(--muted)";
    ui.dice.textContent="–";
    ui.phase.textContent="–";
    ui.hint.textContent="Host oder Beitreten, dann Start.";
    ui.btnStart.disabled = !(netMode==="host" && roster.length>=2);
    ui.btnRoll.disabled = true;
    ui.btnEnd.disabled = true;
    ui.btnSkip.disabled = true;
    ui.btnReset.disabled = (netMode==="client");
    return;
  }

  renderMyColor();

  const turn = state.currentPlayer;
  ui.turnText.textContent = state.winner ? `${COLOR_NAME[state.winner]} gewinnt!` :
    (state.gamePhase==="running" ? `${COLOR_NAME[turn]} ist dran` : "Lobby");
  ui.turnDot.style.background = state.winner ? `var(--${state.winner})` : (turn ? `var(--${turn})` : "var(--muted)");
  ui.dice.textContent = state.dice==null ? "–" : String(state.dice);
  ui.phase.textContent = state.gamePhase==="running" ? state.phase : "lobby";

  // compute legal moves when needed
  if(state.gamePhase==="running" && state.phase==="need_move") recalcLegals();
  else { legalMoves=[]; legalByPiece=new Map(); if(state.phase!=="need_move") selected=null; }

  // Start only for host
  ui.btnStart.disabled = !canStart();

  const myTurn = isMyTurn();
  const running = state.gamePhase==="running" && !state.winner;

  ui.btnRoll.disabled = !(running && myTurn && state.phase==="need_roll");
  ui.btnEnd.disabled  = !(running && myTurn && state.phase==="need_move");
  ui.btnSkip.disabled = !(running && myTurn && state.phase!=="placing_barricade");
  ui.btnReset.disabled= (netMode==="client");

  // hints
  if(state.winner){
    ui.hint.textContent = "Spiel vorbei. Host kann Reset drücken.";
  }else if(state.gamePhase!=="running"){
    ui.hint.textContent = (netMode==="host") ? "Warte bis mind. 2 Spieler da sind, dann Start." : "Warte auf Start vom Host.";
  }else if(!myTurn){
    ui.hint.textContent = "Warte… du bist nicht dran.";
  }else{
    if(state.phase==="need_roll") ui.hint.textContent = "Würfeln.";
    else if(state.phase==="need_move") ui.hint.textContent = "Figur klicken, dann Ziel-Feld klicken.";
    else if(state.phase==="placing_barricade") ui.hint.textContent = "Wähle ein Feld für die Barikade.";
    else ui.hint.textContent = "–";
  }
}

// ===== Boot =====
(async function init(){
  await loadBoard();
  resizeCanvas();
  // init local state offline
  state = defaultState(["red","blue"]);
  applyState(state);

  // restore session
  const savedRoom = localStorage.getItem("barikade_rebuild_room")||"";
  const savedMode = localStorage.getItem("barikade_rebuild_mode")||"offline";
  if(savedRoom) ui.room.value = savedRoom;

  // auto-connect only if user wants? keep safe: only if mode not offline AND room present
  if(savedRoom && (savedMode==="host" || savedMode==="client")){
    connect(savedMode);
  }else{
    setConn("Offline", false);
  }
})();
