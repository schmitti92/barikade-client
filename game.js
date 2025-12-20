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
    btnSkip: $("btnSkip"),
    centerHint: $("centerHint"),
  };

  const LS_KEY = "barikade_clientId_v1";
  const LS_ROOM = "barikade_room_v1";
  const LS_SERVER = "barikade_server_v1";
  const LS_NAME = "barikade_name_v1";

  let clientId = localStorage.getItem(LS_KEY);
  if(!clientId){
    clientId = (crypto?.randomUUID ? crypto.randomUUID() : (Math.random().toString(16).slice(2)+Date.now().toString(16)));
    localStorage.setItem(LS_KEY, clientId);
  }

  if(localStorage.getItem(LS_NAME)) ui.name.value = localStorage.getItem(LS_NAME);
  if(localStorage.getItem(LS_SERVER)) ui.server.value = localStorage.getItem(LS_SERVER);
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
    
    // Start-Button nur für Host, nur wenn Spieleranzahl passt
    const selectedMax = parseInt(ui.maxPlayers.value||"2",10);
    const amHost = !!(room.me && room.me.isHost);
    ui.btnStart.disabled = !(joined && amHost && playerCount === selectedMax && !gameStarted);
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
    const url = ui.server.value.trim();
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
      gameStarted = true;
      ui.btnStart.disabled = true;
      const hint = document.getElementById("centerHint");
      if(hint) hint.textContent = "Spiel gestartet – Spielbrett/Logik kommt als nächster Schritt.";
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

  ui.btnStart.onclick = () => {
    if(!ws || ws.readyState !== 1 || !joined) return;
    if(!lastRoomState || !lastRoomState.me || !lastRoomState.me.isHost) return;
    const selectedMax = parseInt(ui.maxPlayers.value||"2",10);
    const playerCount = (lastRoomState.players||[]).filter(p=>p.role==="player").length;
    if(playerCount !== selectedMax) return;

    gameStarted = true;
    ui.btnStart.disabled = true;

    const hint = document.getElementById("centerHint");
    if(hint) hint.textContent = "Spiel gestartet – Spielbrett/Logik kommt als nächster Schritt.";

    try{
      ws.send(JSON.stringify({ type:"start" }));
    }catch(e){}
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
