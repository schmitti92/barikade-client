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

const canvas = $("#boardCanvas");
const ctx = canvas.getContext("2d");

const ui = {
  btnNew: $("#btnNew"),
  btnRoll: $("#btnRoll"),
  dice: $("#dice"),
  hint: $("#hint"),
  boardStats: $("#boardStats"),
  rollStats: $("#rollStats"),
  actionStats: $("#actionStats"),
};

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
  phase: "need_roll",       // need_roll | need_piece | need_target | animating
  selectedPieceId: null,
  targets: [],              // list of target node ids (valid destinations)
  targetPaths: new Map(),   // destId -> [nodeId,...] including start

  pieces: [],               // {id,color,posKind:'house'|'board', nodeId?:string, houseId?:string}
  barricades: new Set(),     // Set<nodeId> current barricade positions
  carryingBarricade: false,  // if true, player must place it before turn ends
};

function randInt(min, max){
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function setHint(txt){ ui.hint.textContent = txt; }
function setAction(txt){ ui.actionStats.textContent = txt; }

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
  if(n.flags?.run) return false; // nach Original: nur am Anfang auf run, danach auf normale Felder
  if(n.flags?.noBarricade) return false;
  if(n.flags?.startColor) return false;
  if(STATE.barricades.has(n.id)) return false;
  if(isOccupiedAny(n.id)) return false;
  return true;
}
}

function drawPieces(){
  // trail behind moving piece
  if(STATE._trail && STATE._trail.length){
    ctx.lineCap = "round";
    for(let i=0;i<STATE._trail.length-1;i++){
      const a = STATE._trail[i];
      const b = STATE._trail[i+1];
      const pa = worldToScreen(a.x,a.y);
      const pb = worldToScreen(b.x,b.y);
      const t = i/(STATE._trail.length-1);
      ctx.strokeStyle = `rgba(255,77,109,${0.22*(1-t)})`;
      ctx.lineWidth = 10 * (1-t);
      ctx.beginPath();
      ctx.moveTo(pa.x,pa.y);
      ctx.lineTo(pb.x,pb.y);
      ctx.stroke();
    }
  }

  const baseR = nodeRadius() * 1.0; // Figur = Feldgröße
  for(const pc of STATE.pieces){
    if(pc.color !== "red") continue; // phase 1 only red
    const pos = getPieceWorldPos(pc);
    if(!pos) continue;
    const p = worldToScreen(pos.x, pos.y);
    const isSel = (STATE.selectedPieceId === pc.id);
    const r = isSel ? baseR*1.12 : baseR;

    drawPieceToken(p.x, p.y, r, pieceColor(pc.color), isSel, pc.label);
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
    if(pc.color !== "red") continue;
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

  // reset turn
  STATE.phase = 'need_roll';
  ui.btnRoll.disabled = false; ui.btnRoll.classList.remove('disabled');
  STATE.rolled = null;
  ui.dice.textContent = '–';
  ui.rollStats.textContent = '–';
  STATE.selectedPieceId = null;
  STATE.targets = [];
  STATE.targetPaths.clear();

  setHint('Würfle für den nächsten Zug.');
  setAction('Zug beendet');
  draw();
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
      ctx.strokeStyle = `rgba(255,77,109,${0.22*(1-t)})`;
      ctx.lineWidth = 10 * (1-t);
      ctx.beginPath();
      ctx.moveTo(pa.x,pa.y);
      ctx.lineTo(pb.x,pb.y);
      ctx.stroke();
    }
  }

  const baseR = nodeRadius() * 1.0; // Figur = Feldgröße
  for(const pc of STATE.pieces){
    if(pc.color !== "red") continue;
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

    drawPieceToken(p.x, p.y, r, pieceColor(pc.color), isSel, pc.label);
  }
}


function animateDice(finalValue){
  ui.btnRoll.disabled = true;
  ui.btnRoll.classList.add("disabled");
  let rolls = 0;
  const maxRolls = 12;
  const interval = setInterval(() => {
    ui.dice.textContent = Math.floor(Math.random()*6)+1;
    rolls++;
    if(rolls >= maxRolls){
      clearInterval(interval);
      ui.dice.textContent = finalValue;
      ui.dice.classList.remove("dice-low","dice-mid","dice-high");
      if(finalValue <= 2) ui.dice.classList.add("dice-low");
      else if(finalValue <= 4) ui.dice.classList.add("dice-mid");
      else ui.dice.classList.add("dice-high");
      ui.btnRoll.disabled = false;
      ui.btnRoll.classList.remove("disabled");
    }
  }, 80);
}

// ===== Game flow =====

function newGame(){
  const redHouses = Array.from(STATE.nodes.values())
    .filter(n => n.kind==="house" && n.flags?.houseColor==="red")
    .sort((a,b) => (a.flags.houseSlot ?? 0) - (b.flags.houseSlot ?? 0));

  STATE.pieces = [];
  for(let i=0; i<5; i++){
    STATE.pieces.push({
      id: `p_red_${i+1}`,
      label: i+1,
      color: "red",
      posKind: "house",
      houseId: redHouses[i]?.id ?? redHouses[0]?.id,
      nodeId: null,
      _animPos: null,
    });
  }

  STATE.turnColor = "red";
  STATE.rolled = null;
  STATE.phase = "need_roll";
  ui.btnRoll.disabled = false; ui.btnRoll.classList.remove("disabled");
  STATE.selectedPieceId = null;
  STATE.targets = [];
  STATE.targetPaths.clear();
  STATE._trail = [];
  // Barikaden: 5 Stück zufällig auf RUN-Feldern platzieren
  STATE.barricades = new Set();
  STATE.carryingBarricade = false;
  const runNodes = Array.from(STATE.nodes.values()).filter(n => n.kind==='board' && n.flags?.run);
  // Defensive: wenn weniger als 5 RUN-Felder existieren, nimm so viele wie möglich
  const want = Math.min(5, runNodes.length);
  // shuffle
  for(let i=runNodes.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    const tmp = runNodes[i]; runNodes[i] = runNodes[j]; runNodes[j] = tmp;
  }
  for(let i=0;i<want;i++) STATE.barricades.add(runNodes[i].id);

  ui.dice.textContent = "–";
  ui.rollStats.textContent = "–";
  setHint("Würfle, dann klicke eine rote Figur (Haus oder Brett).");
  setAction("Neues Spiel");
  draw();
}


function roll(){
  if(STATE.phase !== "need_roll"){
    setHint("Erst die aktuelle Aktion beenden.");
    return;
  }
  const r = randInt(1,6);
  STATE.rolled = r;
  animateDice(r);
  ui.rollStats.textContent = `${r}`;
  STATE.phase = "need_piece";
  ui.btnRoll.disabled = true; ui.btnRoll.classList.add("disabled");
  setHint("Klicke eine rote Figur, die du bewegen willst.");
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
    STATE.barricades.add(n.id);
    STATE.carryingBarricade = false;
    // turn ends after placement
    STATE.phase = 'need_roll';
    ui.btnRoll.disabled = false; ui.btnRoll.classList.remove('disabled');
    STATE.rolled = null;
    ui.dice.textContent = '–';
    ui.rollStats.textContent = '–';
    STATE.selectedPieceId = null;
    STATE.targets = [];
    STATE.targetPaths.clear();
    setHint('Barikade platziert. Würfle für den nächsten Zug.');
    setAction('Zug beendet');
    draw();
    return;
  }

  if(STATE.phase === "need_piece"){
    const pc = pickPieceAtWorld(world);
    if(!pc){
      setHint("Keine rote Figur getroffen. Klick direkt auf eine Figur.");
      return;
    }
    STATE.selectedPieceId = pc.id;

    const rollVal = STATE.rolled ?? 0;
    if(rollVal <= 0){
      setHint("Bitte erst würfeln.");
      return;
    }

    const startId = STATE.board.meta?.starts?.red;
    if(!startId){
      setHint("Startfeld (rot) fehlt im board.json (meta.starts.red).");
      return;
    }

    // leaving house: start counts as 1 step
    if(pc.posKind === "house"){
  const blocked = getOccupiedBoardNodesByColor("red");
  if(blocked.has(startId)){
    setHint("Startfeld ist durch eine eigene Figur blockiert – du kannst nicht raus.");
    setAction("Zug nicht möglich");
    // Zug zurücksetzen
    STATE.phase = "need_roll";
    ui.btnRoll.disabled = false; ui.btnRoll.classList.remove("disabled");
    STATE.rolled = null;
    ui.dice.textContent = "–";
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
    ui.dice.textContent = "–";
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
  const blocked = getOccupiedBoardNodesByColor("red", pc.id); // aktuelles Feld zählt nicht als blockiert
  const {targets, paths} = computeReachableExactSteps_NoBacktrack_NoOwn(cur, rollVal, blocked, STATE.barricades);
  STATE.targets = Array.from(targets);
  STATE.targetPaths = paths;

  if(!STATE.targets.length){
    setHint("Kein gültiges Ziel möglich.");
    setAction("Zug nicht möglich");
    STATE.phase = "need_roll";
    ui.btnRoll.disabled = false; ui.btnRoll.classList.remove("disabled");
    STATE.rolled = null;
    ui.dice.textContent = "–";
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
      const startId = STATE.board.meta?.starts?.red;
      if(maybePc.posKind === "house"){
        const remaining = Math.max(0, rollVal - 1);
        const blocked = getOccupiedBoardNodesByColor("red", maybePc.id);
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
        const blocked = getOccupiedBoardNodesByColor("red", maybePc.id);
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
    const startId = STATE.board.meta?.starts?.red;

    if(pc.posKind === "house"){
      // place to start immediately
      pc.posKind = "board";
      pc.nodeId = startId;
      draw();
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
    setHint("Würfle, dann klicke eine rote Figur (Haus oder Brett).");
  }

  newGame();
  resizeCanvas();
}

function wireUI(){
  ui.btnNew.addEventListener("click", () => newGame());
  ui.btnRoll.addEventListener("click", () => roll());

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
