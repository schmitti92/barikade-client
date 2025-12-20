(() => {
  const $ = (id) => document.getElementById(id);

  const ui = {
    connPill: $("connPill"),
    connText: $("connText"),
    playersList: $("playersList"),
    reconnInfo: $("reconnInfo"),
    name: $("name"),
    server: $("server"),
    room: $("room"),
    maxPlayers: $("maxPlayers"),
    btnHost: $("btnHost"),
    btnJoin: $("btnJoin"),
    btnLeave: $("btnLeave"),
    btnStart: $("btnStart"),
    canvas: $("boardCanvas"),
    btnSkip: $("btnSkip"),
    centerHint: $("centerHint"),
  };
  // ===== Brett laden & zeichnen =====
  let boardData = null;
  let boardBounds = null;

  async function loadBoard() {
    if(boardData) return boardData;
    const res = await fetch("./board.json", { cache: "no-store" });
    boardData = await res.json();
    boardBounds = computeBounds(boardData);
    return boardData;
  }

  function computeBounds(bd) {
    const xs = bd.nodes.map(n=>n.x);
    const ys = bd.nodes.map(n=>n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    return {minX,maxX,minY,maxY};
  }

  function fitTransform(ctx, canvas, bounds) {
    const pad = 30;
    const w = canvas.width, h = canvas.height;
    const bw = (bounds.maxX - bounds.minX) || 1;
    const bh = (bounds.maxY - bounds.minY) || 1;
    const sx = (w - pad*2) / bw;
    const sy = (h - pad*2) / bh;
    const s = Math.min(sx, sy);
    const tx = pad + (w - pad*2 - bw*s)/2 - bounds.minX*s;
    const ty = pad + (h - pad*2 - bh*s)/2 - bounds.minY*s;
    ctx.setTransform(s, 0, 0, s, tx, ty);
    return s;
  }

  function resizeCanvas() {
    const c = ui.canvas;
    if(!c) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if(c.width !== w || c.height !== h) {
      c.width = w; c.height = h;
      if(gameStarted) renderBoard();
    }
  }

  function renderBoard() {
    if(!ui.canvas || !boardData) return;
    const ctx = ui.canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    // Clear in device pixels
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,ui.canvas.width, ui.canvas.height);

    // Draw in board coordinate transform
    fitTransform(ctx, ui.canvas, boardBounds);

    const nodeById = new Map(boardData.nodes.map(n=>[n.id,n]));
    // edges
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(215,227,255,.25)";
    for(const [a,b] of boardData.edges){
      const na = nodeById.get(a), nb = nodeById.get(b);
      if(!na || !nb) continue;
      ctx.beginPath();
      ctx.moveTo(na.x, na.y);
      ctx.lineTo(nb.x, nb.y);
      ctx.stroke();
    }

    // nodes
    const R = 12;
    for(const n of boardData.nodes){
      const run = !!(n.flags && n.flags.run);
      const goal = !!(n.flags && n.flags.goal);
      ctx.beginPath();
      ctx.arc(n.x, n.y, R, 0, Math.PI*2);
      if(goal){
        ctx.fillStyle = "rgba(199,166,255,.85)";
      } else if(run){
        ctx.fillStyle = "rgba(255,209,102,.85)";
      } else {
        ctx.fillStyle = "rgba(215,227,255,.75)";
      }
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.35)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // start markers (ring)
    if(boardData.meta && boardData.meta.starts){
      const starts = boardData.meta.starts;
      const colors = { red:"#ff5d6c", blue:"#6aa9ff", green:"#4fe3b5", yellow:"#ffd166" };
      for(const [color, nid] of Object.entries(starts)){
        const n = nodeById.get(nid);
        if(!n) continue;
        ctx.beginPath();
        ctx.arc(n.x, n.y, R+6, 0, Math.PI*2);
        ctx.strokeStyle = colors[color] || "rgba(255,255,255,.8)";
        ctx.lineWidth = 5;
        ctx.stroke();
      }
    }
  }

  async function startGameAndShowBoard() {
    await loadBoard();
    // hint weg
    const hint = document.getElementById("centerHint");
    if(hint) hint.style.display = "none";
    gameStarted = true;
    resizeCanvas();
    renderBoard();
  }

  window.addEventListener("resize", () => resizeCanvas());
  // ===== Ende Brett =====


  const LS_KEY = "barikade_clientId_v1";
  const LS_ROOM = "barikade_room_v1";
  const LS_SERVER = "barikade_server_v1";
  const LS_NAME = "barikade_name_v1";

  
  const FIXED_SERVER_URL = "wss://barikade-server.onrender.com/ws";
let clientId = localStorage.getItem(LS_KEY);
  if(!clientId){
    clientId = (crypto?.randomUUID ? crypto.randomUUID() : (Math.random().toString(16).slice(2)+Date.now().toString(16)));
    localStorage.setItem(LS_KEY, clientId);
  }

  if(localStorage.getItem(LS_NAME)) ui.name.value = localStorage.getItem(LS_NAME);
    ui.server.value = FIXED_SERVER_URL;
  localStorage.setItem(LS_SERVER, FIXED_SERVER_URL);
if(localStorage.getItem(LS_ROOM)) ui.room.value = localStorage.getItem(LS_ROOM);

  let ws = null;
  let joined = false;
  let wantRole = "player";
  let reconnectTimer = null;
  let reconnectBackoff = 1000;
  let lastRoomState = null;
  let gameStarted = false;


  function setConn(state, extra=""){
    const map = {
      offline: { pill:"● Offline", txt:"Offline" },
      connecting:{ pill:"● Verbinde…", txt:"Verbinde…" },
      online:{ pill:"● Online", txt:"Online" },
      retry:{ pill:"● Reconnect…", txt:"Verbindung verloren – versuche neu zu verbinden…" },
    };
    const s = map[state] || map.offline;
    ui.connPill.textContent = s.pill;
    ui.connText.textContent = s.txt + (extra ? ("\n"+extra) : "");
  }

  function renderPlayers(room){
    if(!room || !room.players){
      ui.playersList.textContent = "—";
      return;
    }
    const players = room.players.slice().sort((a,b)=>{
      if(a.isHost && !b.isHost) return -1;
      if(!a.isHost && b.isHost) return 1;
      if(a.role!==b.role) return a.role==="player" ? -1 : 1;
      return (a.name||"").localeCompare(b.name||"");
    });

    ui.playersList.innerHTML = "";
    const header = document.createElement("div");
    const playerCount = players.filter(p=>p.role==="player").length;
    header.className = "small";
    header.textContent = `🟢 Spieler im Raum (${playerCount}/${room.maxPlayers || "?"})`;
    ui.playersList.appendChild(header);

    players.forEach(p=>{
      const row = document.createElement("div");
      row.className = "pitem";
      const left = document.createElement("div");
      left.className = "pname";

      const dot = document.createElement("div");
      dot.className = "dot";
      dot.style.background = p.connected ? "var(--good)" : "var(--muted)";
      left.appendChild(dot);

      const name = document.createElement("div");
      const isTurn = room.turnClientId && room.turnClientId === p.clientId;
      const prefix = isTurn ? "▶️ " : "";
      name.textContent = `${prefix}${p.name || "Spieler"}`;
      name.className = isTurn ? "turn" : "";
      left.appendChild(name);

      const right = document.createElement("div");
      right.className = "badge";
      const tags = [];
      if(p.isHost) tags.push("Host");
      if(p.role==="spectator") tags.push("Zuschauer");
      if(p.color && p.color!=="spectator") tags.push(p.color);
      right.textContent = tags.join(" · ");

      row.appendChild(left);
      row.appendChild(right);
      ui.playersList.appendChild(row);
    });
  }

  function scheduleReconnect(reason=""){
    if(reconnectTimer) return;
    setConn("retry", reason);
    ui.reconnInfo.textContent = `Auto-Reconnect aktiv.\nNächster Versuch in ${Math.round(reconnectBackoff/1000)}s`;
    reconnectTimer = setTimeout(()=>{
      reconnectTimer = null;
      connectAndHello(true);
      reconnectBackoff = Math.min(8000, reconnectBackoff * 1.7);
    }, reconnectBackoff);
  }

  function connectAndHello(auto=false){
    const url = FIXED_SERVER_URL;
    const room = ui.room.value.trim();
    const name = ui.name.value.trim() || "Spieler";
    const maxPlayers = parseInt(ui.maxPlayers.value,10) || 2;

    if(!url){
      setConn("offline","Server fehlt.");
      return;
    }

    localStorage.setItem(LS_NAME, name);
    localStorage.setItem(LS_SERVER, url);
    localStorage.setItem(LS_ROOM, room);

    if(ws && (ws.readyState===0 || ws.readyState===1)){
      try{ ws.close(); }catch(e){}
    }

    setConn(auto ? "retry" : "connecting");
    ui.centerHint.textContent = "Verbinde…";

    try{
      ws = new WebSocket(url);
    }catch(e){
      scheduleReconnect("Ungültige Server-Adresse");
      return;
    }

    ws.onopen = () => {
      reconnectBackoff = 1000;
      ws.send(JSON.stringify({
        type:"hello",
        room,
        name,
        clientId,
        wantRole,
        maxPlayers
      }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try{ msg = JSON.parse(ev.data); }catch(e){ return; }

      if(msg.type === "hello_ok"){
        joined = true;
        lastRoomState = msg.room;
        setConn("online");
        ui.btnLeave.disabled = false;
        ui.centerHint.textContent = "Online verbunden.";
        renderPlayers(lastRoomState);
        return;
      }

          if(msg.type === "event" && msg.event && msg.event.type === "start"){
      ui.btnStart.disabled = true;
      await startGameAndShowBoard();
      return;
    }

if(msg.type === "room_state"){
        lastRoomState = msg.room;
        renderPlayers(lastRoomState);
        return;
      }
    };

    ws.onclose = () => {
      setConn("offline");
      ui.centerHint.textContent = "Offline";
      if(joined){
        scheduleReconnect("Server getrennt");
      }
    };
  }

  function leave(){
    joined = false;
    lastRoomState = null;
    renderPlayers(null);
    ui.btnLeave.disabled = true;
    if(reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer=null; }
    reconnectBackoff = 1000;
    try{ if(ws) ws.close(); }catch(e){}
    ws = null;
    setConn("offline");
    ui.centerHint.textContent = "Online: Host oder Join";
  }

  ui.btnHost.onclick = () => { wantRole="player"; connectAndHello(false); };
  ui.btnJoin.onclick = () => { wantRole="player"; connectAndHello(false); };
  ui.btnLeave.onclick = () => leave();

  ui.btnStart.onclick = async () => {
    if(!ws || ws.readyState !== 1 || !joined) return;
    if(!lastRoomState || !lastRoomState.me || !lastRoomState.me.isHost) return;
    const selectedMax = parseInt(ui.maxPlayers.value||"2",10);
    const playerCount = (lastRoomState.players||[]).filter(p=>p.role==="player").length;
    if(playerCount !== selectedMax) return;
    ui.btnStart.disabled = true;
    try{ ws.send(JSON.stringify({ type:"start" })); }catch(e){}
    await startGameAndShowBoard();
  };


  ui.btnSkip.onclick = () => {
    if(ws && ws.readyState===1){
      ws.send(JSON.stringify({type:"skip"}));
    }
  };

  setInterval(()=>{
    if(ws && ws.readyState===1){
      try{ ws.send(JSON.stringify({type:"ping", t:Date.now()})); }catch(e){}
    }
  }, 15000);

})();