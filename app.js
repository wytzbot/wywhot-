/* WYWHOT — client shell. Multiplayer + game rules are server-authoritative:
 * this file only ever (a) reads public state (game_states) and its own
 * hand (player_hands, RLS-restricted to the caller), and (b) sends move
 * *requests* to the game-engine Edge Function, which validates them.
 * Nothing here can fabricate a move, see another player's hand, or edit
 * whose turn it is — see supabase.sql and supabase/functions/game-engine.
 *
 * Still simplified (see game-engine/index.ts header for the full list):
 * no Pick-Two stacking, no Last-Card penalty, draw isn't restricted to
 * "no legal play available". Voice chat is a placeholder (no WebRTC).
 */
const A = document.getElementById("app");
const DB = window.WYWHOT_DB;
const AVATARS = ["avatar-fox", "avatar-panda", "avatar-lion", "avatar-frog"];
const SUIT_SYMBOL = { circle: "●", triangle: "▲", cross: "✚", square: "■" };
const MAX_PLAYERS = 4;

let playerId = null;
let name = localStorage.getItem("wywhot_name") || "";
let roomRow = null;        // {id, code, host_id, status}
let players = [];          // [{id, room_id, name, avatar, is_host}]
let lobbyChannel = null;   // players + rooms realtime (lobby phase)
let gameChannel = null;    // game_states + player_hands realtime (game phase)
let gameState = null;      // last row from game_states
let myHand = [];           // this player's private hand
let pendingWhotIndex = null;
let hints = 3, isPro = false;
let prefs = { sfx: true, cardAudio: true, voice: true };

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cardLabel(c) { return c.v === 20 ? "WHOT" : `${c.v}${SUIT_SYMBOL[c.s] || ""}`; }
function isHost() { return !!(roomRow && players.find(p => p.id === playerId)?.is_host); }

async function teardownChannels() {
  if (!lobbyChannel && !gameChannel) return;
  try {
    const sb = await DB.getSupabase();
    if (lobbyChannel) sb.removeChannel(lobbyChannel);
    if (gameChannel) sb.removeChannel(gameChannel);
  } catch (e) { /* nothing to tear down if Supabase never loaded */ }
  lobbyChannel = null; gameChannel = null;
}

// ---------- Home ----------

function home() {
  teardownChannels();
  roomRow = null; players = []; gameState = null; myHand = [];
  A.innerHTML = `<main class="shell"><section class="hero">
    <img class="logo" src="logo.svg" alt="WYWHOT">
    <p class="tag">PLAY. TALK. WIN.</p>
    <div class="fan"><i>20</i><i>WHOT</i><i>5</i></div>
    <section class="panel">
      <input id="name" placeholder="Your name" value="${esc(name)}">
      <div class="row">
        <button id="createBtn" onclick="create()">Create Room</button>
        <input id="room" placeholder="Room code">
        <button id="joinBtn" class="secondary" onclick="join()">Join</button>
      </div>
      <p class="muted err" id="homeErr"></p>
      <nav>
        <a onclick="how()">How to Play</a>
        <a onclick="pro()">WYWHOT Pro</a>
        <a onclick="settings()">Settings</a>
        <a onclick="bank()">Virtual Bank</a>
      </nav>
    </section>
  </section></main>`;
}

function busy(btnId, isBusy, label) {
  const b = document.getElementById(btnId);
  if (!b) return;
  b.disabled = isBusy;
  if (isBusy) { b.dataset.label = b.textContent; b.textContent = label || "…"; }
  else if (b.dataset.label) b.textContent = b.dataset.label;
}
function showHomeErr(msg) {
  const e = document.getElementById("homeErr");
  if (e) e.textContent = msg; else alert(msg);
}
function friendlyError(err, fallback) {
  const msg = (err && err.message) || "";
  if (msg.startsWith("NOT_CONFIGURED")) return "Multiplayer isn't set up yet (missing Supabase config) — see README.";
  if (msg.startsWith("AUTH_FAILED")) return "Couldn't start a session — see README (Anonymous Sign-ins must be enabled in Supabase).";
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) return "Network error — check your connection and try again.";
  return fallback;
}

async function create() {
  name = (document.getElementById("name").value || "").trim() || "Player";
  localStorage.setItem("wywhot_name", name);
  busy("createBtn", true, "Creating…");
  try {
    const sb = await DB.getSupabase();
    const user = await DB.ensureUser();
    playerId = user.id;

    let inserted = null, lastErr = null;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      const code = Math.random().toString(36).slice(2, 7).toUpperCase();
      const { data, error } = await sb.from("rooms").insert({ code, host_id: playerId, status: "lobby" }).select().single();
      if (!error) inserted = data; else lastErr = error;
    }
    if (!inserted) throw lastErr || new Error("Could not create a room.");
    roomRow = inserted;

    const { error: pErr } = await sb.from("players").insert({
      id: playerId, room_id: roomRow.id, name, avatar: AVATARS[0], connected: true, is_host: true
    });
    if (pErr) throw pErr;

    await enterLobby();
  } catch (err) {
    showHomeErr(friendlyError(err, "Couldn't create a room."));
  } finally {
    busy("createBtn", false);
  }
}

async function join() {
  name = (document.getElementById("name").value || "").trim() || "Player";
  localStorage.setItem("wywhot_name", name);
  const code = (document.getElementById("room").value || "").trim().toUpperCase();
  if (!code) { showHomeErr("Enter a room code to join, or tap Create Room to start a new one."); return; }

  busy("joinBtn", true, "Joining…");
  try {
    const sb = await DB.getSupabase();
    const user = await DB.ensureUser();
    playerId = user.id;

    const { data: room, error: rErr } = await sb.from("rooms").select("*").eq("code", code).maybeSingle();
    if (rErr) throw rErr;
    if (!room) { showHomeErr("No room found with that code."); return; }

    const { data: existing, error: cErr } = await sb.from("players").select("id,avatar").eq("room_id", room.id);
    if (cErr) throw cErr;

    if (existing.some(p => p.id === playerId)) {
      roomRow = room; await enterLobby(); return; // rejoining after a refresh
    }
    if (room.status !== "lobby") { showHomeErr("That game has already started."); return; }
    if (existing.length >= MAX_PLAYERS) { showHomeErr("That room is full."); return; }

    const takenAvatars = new Set(existing.map(p => p.avatar));
    const avatar = AVATARS.find(a => !takenAvatars.has(a)) || AVATARS[existing.length % AVATARS.length];

    const { error: pErr } = await sb.from("players").insert({
      id: playerId, room_id: room.id, name, avatar, connected: true, is_host: false
    });
    if (pErr) throw pErr;

    roomRow = room;
    await enterLobby();
  } catch (err) {
    showHomeErr(friendlyError(err, "Couldn't join that room."));
  } finally {
    busy("joinBtn", false);
  }
}

// ---------- Lobby (realtime) ----------

async function enterLobby() {
  await teardownChannels();
  const sb = await DB.getSupabase();

  const { data: initialPlayers } = await sb.from("players").select("*").eq("room_id", roomRow.id).order("is_host", { ascending: false });
  players = initialPlayers || [];

  lobbyChannel = sb.channel("lobby:" + roomRow.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomRow.id}` }, handlePlayersChange)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomRow.id}` }, handleRoomChange)
    .subscribe();

  if (roomRow.status === "active") await enterGame();
  else lobby();
}

function handlePlayersChange(payload) {
  if (payload.eventType === "INSERT") players.push(payload.new);
  else if (payload.eventType === "UPDATE") players = players.map(p => p.id === payload.new.id ? payload.new : p);
  else if (payload.eventType === "DELETE") players = players.filter(p => p.id !== payload.old.id);
  if (document.getElementById("players")) renderPlayers();
}

async function handleRoomChange(payload) {
  roomRow = payload.new;
  if (roomRow.status === "active" && !document.querySelector("main.game")) await enterGame();
}

function lobby() {
  A.innerHTML = `<main class="shell"><section class="panel wide">
    <button class="secondary backbtn" onclick="leaveRoom()"><img src="back.svg"> Home</button>
    <img class="mini" src="logo.svg" alt="WYWHOT">
    <p class="muted">ROOM CODE</p>
    <div class="room">${esc(roomRow.code)}</div>
    <button onclick="copyCode(this)"><img src="copy.svg"> Copy code</button>
    <h2>Players</h2>
    <div class="players" id="players"></div>
    <div class="rules"><b>Rules</b>
      <p>Pick 2 · General Market · Hold On · Skip · WHOT wildcard</p>
      <p>Hints: ${hints} · Voice: ${prefs.voice ? "On" : "Off"}</p>
    </div>
    ${isHost()
      ? `<button id="startBtn" onclick="startGame()">Start Game</button><p class="muted small">Share the room code with friends to have them join.</p>`
      : `<p class="muted small">Waiting for the host to start the game.</p>`}
  </section></main>`;
  renderPlayers();
}

function renderPlayers() {
  const el = document.getElementById("players");
  if (!el) return;
  const rows = players.map(p => `<div><img src="${p.avatar}.svg" alt=""> ${esc(p.name)}${p.is_host ? "<small>HOST</small>" : ""}</div>`);
  for (let i = players.length; i < MAX_PLAYERS; i++) rows.push(`<div class="muted"><img src="avatar-panda.svg" style="opacity:.3" alt=""> Waiting…</div>`);
  el.innerHTML = rows.join("");
  const startBtn = document.getElementById("startBtn");
  if (startBtn) startBtn.disabled = players.length < 2;
}

async function startGame() {
  if (!isHost()) return;
  busy("startBtn", true, "Starting…");
  try {
    const sb = await DB.getSupabase();
    const { data, error } = await sb.functions.invoke("game-engine", { body: { action: "start", roomId: roomRow.id } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    // roomRow.status flips to "active" via the rooms realtime subscription (handleRoomChange),
    // which calls enterGame() for every client including this one.
  } catch (err) {
    alert(friendlyError(err, err?.message || "Couldn't start the game — try again."));
    busy("startBtn", false);
  }
}

async function leaveRoom() {
  if (roomRow && !confirm("Leave this room?")) return;
  if (roomRow) {
    try { const sb = await DB.getSupabase(); await sb.from("players").delete().eq("id", playerId); } catch (e) { /* best effort */ }
  }
  home();
}

function copyCode(btn) {
  const original = btn.innerHTML;
  const done = () => { btn.textContent = "Copied!"; setTimeout(() => btn.innerHTML = original, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(roomRow.code).then(done).catch(() => alert("Room code: " + roomRow.code));
  else alert("Room code: " + roomRow.code);
}

// ---------- Game (server-authoritative) ----------

async function enterGame() {
  const sb = await DB.getSupabase();

  const [{ data: gs }, { data: hr }] = await Promise.all([
    sb.from("game_states").select("*").eq("room_id", roomRow.id).maybeSingle(),
    sb.from("player_hands").select("hand").eq("room_id", roomRow.id).eq("player_id", playerId).maybeSingle(),
  ]);
  gameState = gs; myHand = hr?.hand || [];

  if (gameChannel) sb.removeChannel(gameChannel);
  gameChannel = sb.channel("game:" + roomRow.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "game_states", filter: `room_id=eq.${roomRow.id}` },
      payload => { gameState = payload.new; renderGame(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "player_hands", filter: `room_id=eq.${roomRow.id}` },
      payload => {
        // RLS means this only ever fires for OUR OWN row — a real
        // guarantee, not just "the UI doesn't show it".
        if (payload.new && payload.new.player_id === playerId) { myHand = payload.new.hand || []; renderGame(); }
      })
    .subscribe();

  renderGame();
}

function renderGame() {
  if (!gameState) { A.innerHTML = `<main class="shell"><section class="panel"><p>Loading game…</p></section></main>`; return; }

  if (gameState.status === "finished") { renderGameOver(); return; }

  const myTurn = gameState.current_turn === playerId;
  const opponents = players.filter(p => p.id !== playerId);
  const top = gameState.discard_top;

  A.innerHTML = `<main class="game">
    <header>
      <img src="logo.svg" alt="WYWHOT" onclick="leaveRoom()" style="cursor:pointer">
      <span>ROOM ${esc(roomRow.code)}</span>
      <button onclick="toggleVoice()"><img src="microphone.svg" id="micIcon"></button>
    </header>
    <section class="table">
      <div class="opponents" id="opponents">${opponents.map(p => {
        const n = (gameState.hand_counts || {})[p.id] ?? "?";
        const turn = gameState.current_turn === p.id ? " ▶" : "";
        return `<span>${avatarEmoji(p.avatar)} ${esc(p.name)} · ${n}${turn}</span>`;
      }).join("")}</div>
      <div class="pile"><i>${top ? cardLabel(top) : "—"}</i>${gameState.called_shape ? `<i>Called: ${gameState.called_shape}</i>` : ""}</div>
      <b class="turn">${myTurn ? "YOUR TURN" : "Waiting…"}</b>
    </section>
    <div class="controls">
      <button onclick="getHint()">💡 Get Hint (${hints})</button>
      <button id="drawBtn" ${myTurn ? "" : "disabled"} onclick="drawCard()">Draw Card</button>
      <button onclick="toggleVoice()">🎙️ Voice: ${prefs.voice ? "On" : "Off"}</button>
      <button class="secondary" onclick="leaveRoom()">Leave Room</button>
    </div>
    <div class="hand" id="hand">${myHand.map((c, i) => `<i onclick="selectCard(${i})">${cardLabel(c)}</i>`).join("")}</div>
    <div id="whotPicker"></div>
    ${isPro ? "" : `<section class="panel adpanel freeadslot"><p class="muted">Sponsor</p><div class="adbox" id="persistentAd"></div></section>`}
    <div class="hintbar" id="hintbar">${myTurn ? "Choose a valid card to play, or draw." : "Waiting for your turn…"}</div>
  </main>`;

  if (!isPro) loadPersistentAd();
}

function renderGameOver() {
  const winner = players.find(p => p.id === gameState.winner);
  A.innerHTML = `<main class="shell"><section class="panel">
    <h1>${gameState.winner === playerId ? "🏆 You win!" : `${winner ? esc(winner.name) : "A player"} wins!`}</h1>
    <button onclick="leaveRoom()">Home</button>
  </section></main>`;
}

function avatarEmoji(avatar) {
  return { "avatar-fox": "🦊", "avatar-panda": "🐼", "avatar-lion": "🦁", "avatar-frog": "🐸" }[avatar] || "🎴";
}

function loadPersistentAd() {
  const box = document.getElementById("persistentAd");
  if (!box) return;
  const s1 = document.createElement("script");
  s1.textContent = "atOptions={key:'616ee3451e0b1cbb1549cef05f777afd',format:'iframe',height:250,width:300,params:{}};";
  const s2 = document.createElement("script");
  s2.src = "https://potterynaggingformerly.com/616ee3451e0b1cbb1549cef05f777afd/invoke.js";
  box.appendChild(s1); box.appendChild(s2);
}

function selectCard(i) {
  if (gameState.current_turn !== playerId) return;
  const card = myHand[i];
  if (!card) return;
  if (card.v === 20) {
    pendingWhotIndex = i;
    const picker = document.getElementById("whotPicker");
    if (picker) picker.innerHTML = `<p class="muted">Call a shape:</p>
      <div class="row">
        <button onclick="submitPlay(${i}, 'circle')">● Circle</button>
        <button onclick="submitPlay(${i}, 'triangle')">▲ Triangle</button>
        <button onclick="submitPlay(${i}, 'cross')">✚ Cross</button>
        <button onclick="submitPlay(${i}, 'square')">■ Square</button>
      </div>`;
    return;
  }
  submitPlay(i, null);
}

async function submitPlay(cardIndex, calledShape) {
  pendingWhotIndex = null;
  const picker = document.getElementById("whotPicker");
  if (picker) picker.innerHTML = "";
  const bar = document.getElementById("hintbar");
  if (bar) bar.textContent = "Sending move…";
  try {
    const sb = await DB.getSupabase();
    const { data, error } = await sb.functions.invoke("game-engine", {
      body: { action: "play", roomId: roomRow.id, cardIndex, calledShape }
    });
    if (error) throw error;
    if (data?.error) { if (bar) bar.textContent = data.error; return; }
    // Success: game_states/player_hands realtime pushes will re-render.
  } catch (err) {
    if (bar) bar.textContent = friendlyError(err, err?.message || "Couldn't send that move — try again.");
  }
}

async function drawCard() {
  const bar = document.getElementById("hintbar");
  if (bar) bar.textContent = "Drawing…";
  try {
    const sb = await DB.getSupabase();
    const { data, error } = await sb.functions.invoke("game-engine", { body: { action: "draw", roomId: roomRow.id } });
    if (error) throw error;
    if (data?.error) { if (bar) bar.textContent = data.error; return; }
  } catch (err) {
    if (bar) bar.textContent = friendlyError(err, err?.message || "Couldn't draw — try again.");
  }
}

function toggleVoice() {
  prefs.voice = !prefs.voice;
  const icon = document.getElementById("micIcon");
  if (icon) icon.src = prefs.voice ? "microphone.svg" : "mute.svg";
  const bar = document.getElementById("hintbar");
  if (bar) bar.textContent = prefs.voice
    ? "Voice chat on — requires WebRTC/provider configuration before it will carry real audio."
    : "Voice chat muted.";
  const voiceBtn = [...document.querySelectorAll(".controls button")].find(b => b.textContent.includes("Voice"));
  if (voiceBtn) voiceBtn.textContent = `🎙️ Voice: ${prefs.voice ? "On" : "Off"}`;
}

function getHint() {
  const bar = document.getElementById("hintbar");
  if (hints > 0) {
    hints--;
    if (bar) bar.textContent = "Hint: try a card matching the current number or shape, or a WHOT.";
    const hintBtn = [...document.querySelectorAll(".controls button")].find(b => b.textContent.includes("Get Hint"));
    if (hintBtn) hintBtn.textContent = `💡 Get Hint (${hints})`;
  } else if (isPro) {
    if (bar) bar.textContent = "You're out of hints for this hand.";
  } else {
    if (bar) bar.innerHTML = `Out of hints. <a onclick="adReward()">Watch a sponsor message for +2</a>, or <a onclick="pro()">go Pro</a> for unlimited.`;
  }
}

function adReward() {
  A.innerHTML = `<main class="shell"><section class="panel adpanel">
    <h1>🎁 +2 Hints</h1>
    <p>Watch this sponsor message for 10 seconds.</p>
    <div class="adbox" id="adslot"></div>
    <div id="adcount">10</div>
    <button id="claim" disabled onclick="claimAdReward()">Claim +2 Hints</button>
    <p class="muted">Free-player sponsor reward. This is a timed sponsor screen, not a provider-verified rewarded-ad completion.</p>
    <button class="secondary" onclick="renderGame()">Back to Game</button>
  </section></main>`;

  const slot = document.getElementById("adslot");
  const s1 = document.createElement("script");
  s1.textContent = "atOptions={key:'616ee3451e0b1cbb1549cef05f777afd',format:'iframe',height:250,width:300,params:{}};";
  const s2 = document.createElement("script");
  s2.src = "https://potterynaggingformerly.com/616ee3451e0b1cbb1549cef05f777afd/invoke.js";
  slot.appendChild(s1); slot.appendChild(s2);

  let n = 10;
  const t = setInterval(() => {
    n--;
    const e = document.getElementById("adcount");
    if (e) e.textContent = n; else clearInterval(t);
    if (n <= 0) { clearInterval(t); const b = document.getElementById("claim"); if (b) b.disabled = false; }
  }, 1000);
}

function claimAdReward() { hints += 2; renderGame(); }

// ---------- Static pages ----------

function how() {
  A.innerHTML = `<main class="shell"><section class="panel wide">
    <h1>How to Play</h1>
    <p>Match the current card by number or shape, or play a WHOT card any time and call a shape.</p>
    <div class="rules">
      <p><b>1 — Hold On</b>: play again.</p>
      <p><b>2 — Pick Two</b>: next player draws two and is skipped.</p>
      <p><b>8 — Suspension</b>: next player is skipped.</p>
      <p><b>14 — General Market</b>: everyone else draws one.</p>
      <p><b>20 — WHOT</b>: wildcard, call the next required shape.</p>
      <p class="muted small">First to empty their hand wins. (Pick-Two stacking and the Last-Card call-out aren't enforced in this build.)</p>
    </div>
    <button onclick="home()">Home</button>
  </section></main>`;
}

function bank() {
  if (!isPro) {
    A.innerHTML = `<main class="shell"><section class="panel pro">
      <h1>Virtual Bank</h1>
      <p>The Virtual Bank is a WYWHOT Pro feature. Upgrade to unlock it, then have the room creator activate it for the table.</p>
      <button onclick="pro()">See WYWHOT Pro</button>
      <button class="secondary" onclick="home()">Home</button>
    </section></main>`;
    return;
  }
  A.innerHTML = `<main class="shell"><section class="panel pro">
    <h1>Virtual Bank</h1>
    <p>Pro-only fictional currency. Room creator activates it.</p>
    <div class="rules">
      <p>₦10,000 · $10,000 · €10,000</p>
      <p>Renews every 24 hours.</p>
      <p>No cash value, withdrawal or conversion.</p>
    </div>
    <button onclick="home()">Home</button>
  </section></main>`;
}

async function getPaymentConfig() {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('Unable to load payment configuration');
  const cfg = await r.json();
  if (!cfg.flwEncryptionKey) throw new Error('Flutterwave encryption key is not configured');
  return cfg;
}

function b64ToBytes(b64) {
  const raw = atob(b64); const out = new Uint8Array(raw.length);
  for (let i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i); return out;
}
function randomNonce() {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a=new Uint8Array(12); crypto.getRandomValues(a);
  return Array.from(a,v=>chars[v%chars.length]).join('');
}
async function flwEncrypt(value,key,nonce) {
  const k=await crypto.subtle.importKey('raw',b64ToBytes(key),{name:'AES-GCM'},false,['encrypt']);
  const data=new TextEncoder().encode(String(value));
  const iv=new TextEncoder().encode(nonce);
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},k,data);
  const bytes=new Uint8Array(encrypted); let out='';
  for(const b of bytes) out+=String.fromCharCode(b);
  return btoa(out);
}

function pro() {
  A.innerHTML = `<main class="shell"><section class="panel pro">
    <img src="pro.svg" class="proicon" alt="">
    <h1>WYWHOT Pro</h1>
    <h2>₦1,000 / month · $1 / month</h2>
    <p>Unlimited hints. No ads. Virtual Bank access.</p>
    <label class="muted">Email</label><input id="proEmail" type="email" placeholder="you@example.com" value="${esc(localStorage.getItem('wywhot_pro_email')||'')}">
    <label class="muted">Currency</label><select id="proCurrency"><option value="NGN">NGN — ₦1,000</option><option value="USD">USD — $1</option></select>
    <input id="proName" placeholder="Name on account (optional)">
    <input id="proCard" inputmode="numeric" autocomplete="cc-number" placeholder="Card number">
    <div class="row"><input id="proMonth" inputmode="numeric" autocomplete="cc-exp-month" placeholder="MM"><input id="proYear" inputmode="numeric" autocomplete="cc-exp-year" placeholder="YY"><input id="proCvv" inputmode="numeric" autocomplete="cc-csc" placeholder="CVV"></div>
    <p class="muted small">Card data is encrypted in your browser before it is sent to Flutterwave. WYWHOT does not store your card details.</p>
    <p class="muted err" id="proErr"></p>
    <button id="payBtn" onclick="startCheckout()">Pay & Activate Pro</button>
    <button class="secondary" onclick="restorePro()">Check / Restore Pro</button>
    <button class="secondary" onclick="home()">Home</button>
  </section></main>`;
}

async function startCheckout() {
  const email=document.getElementById('proEmail').value.trim().toLowerCase();
  const nameValue=document.getElementById('proName').value.trim();
  const currency=document.getElementById('proCurrency').value;
  const card=document.getElementById('proCard').value.replace(/\D/g,'');
  const month=document.getElementById('proMonth').value.trim().padStart(2,'0');
  const year=document.getElementById('proYear').value.trim().slice(-2);
  const cvv=document.getElementById('proCvv').value.replace(/\D/g,'');
  const err=document.getElementById('proErr'); const btn=document.getElementById('payBtn');
  err.textContent='';
  if(!/^\S+@\S+\.\S+$/.test(email)) return err.textContent='Enter a valid email address.';
  if(card.length<12 || card.length>19) return err.textContent='Enter a valid card number.';
  if(!/^\d{2}$/.test(month) || Number(month)<1 || Number(month)>12) return err.textContent='Enter a valid expiry month.';
  if(!/^\d{2}$/.test(year)) return err.textContent='Enter a valid expiry year.';
  if(cvv.length<3 || cvv.length>4) return err.textContent='Enter a valid CVV.';
  btn.disabled=true; btn.textContent='Starting secure payment…';
  try{
    const cfg=await getPaymentConfig(); const nonce=randomNonce();
    const encrypted_card_number=await flwEncrypt(card,cfg.flwEncryptionKey,nonce);
    const encrypted_expiry_month=await flwEncrypt(month,cfg.flwEncryptionKey,nonce);
    const encrypted_expiry_year=await flwEncrypt(year,cfg.flwEncryptionKey,nonce);
    const encrypted_cvv=await flwEncrypt(cvv,cfg.flwEncryptionKey,nonce);
    localStorage.setItem('wywhot_pro_email',email);
    const r=await fetch('/api/flutterwave/create-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,name:nameValue,currency,card:{nonce,encrypted_card_number,encrypted_expiry_month,encrypted_expiry_year,encrypted_cvv}})});
    const body=await r.json(); if(!r.ok) throw new Error(body.error||'Unable to start payment');
    localStorage.setItem('wywhot_pending_reference',body.reference||'');
    if(body.redirect_url){ window.location.href=body.redirect_url; return; }
    if(body.status==='succeeded'){ window.location.href=`/?payment=return&reference=${encodeURIComponent(body.reference)}&charge_id=${encodeURIComponent(body.charge_id)}`; return; }
    if(body.next_action?.type==='requires_otp'){ return showPaymentAuth(body.charge_id, 'otp', localStorage.getItem('wywhot_pro_email')||email); }
    if(body.next_action?.type==='requires_pin'){ return showPaymentAuth(body.charge_id, 'pin', localStorage.getItem('wywhot_pro_email')||email); }
    throw new Error('Flutterwave returned an unsupported authorization step.');
  }catch(e){ err.textContent=e.message||'Payment could not be started.'; btn.disabled=false; btn.textContent='Pay & Activate Pro'; }
}

function showPaymentAuth(chargeId,type,email){
  const label=type==='otp'?'Bank OTP':'Card PIN';
  A.innerHTML=`<main class="shell"><section class="panel pro"><h1>Authorize Payment</h1><p>Flutterwave requires ${label} to complete your Pro payment.</p><input id="authValue" inputmode="numeric" type="password" placeholder="${label}"><p class="muted err" id="authErr"></p><button onclick="submitPaymentAuth('${chargeId}','${type}','${encodeURIComponent(email)}')">Continue</button><button class="secondary" onclick="home()">Cancel</button></section></main>`;
}
async function submitPaymentAuth(chargeId,type,emailEncoded){
  const err=document.getElementById('authErr'); const value=(document.getElementById('authValue').value||'').trim(); err.textContent='';
  if(!value){err.textContent='Enter the requested authorization value.';return;}
  try{
    const body={charge_id:chargeId,type};
    if(type==='otp') body.otp=value;
    else { const cfg=await getPaymentConfig(); const nonce=randomNonce(); body.nonce=nonce; body.encrypted_pin=await flwEncrypt(value,cfg.flwEncryptionKey,nonce); }
    const r=await fetch('/api/flutterwave/authorize-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const b=await r.json(); if(!r.ok) throw new Error(b.error||'Authorization failed');
    if(b.redirect_url){window.location.href=b.redirect_url;return;}
    window.location.href=`/?payment=return&reference=${encodeURIComponent(localStorage.getItem('wywhot_pending_reference')||'')}&charge_id=${encodeURIComponent(chargeId)}&email=${emailEncoded}`;
  }catch(e){err.textContent=e.message||'Authorization failed.';}
}

async function restorePro() {
  const email=(document.getElementById('proEmail')?.value||localStorage.getItem('wywhot_pro_email')||'').trim().toLowerCase();
  const err=document.getElementById('proErr'); if(!/^\S+@\S+\.\S+$/.test(email)){err.textContent='Enter the email used for Pro.';return;}
  try{
    const r=await fetch('/api/flutterwave/pro-status?email='+encodeURIComponent(email)); const b=await r.json();
    if(!r.ok) throw new Error(b.error||'Unable to check Pro status');
    if(b.active){isPro=true;localStorage.setItem('wywhot_pro_email',email);err.textContent='Pro is active until '+new Date(b.expires_at).toLocaleDateString()+'.';}
    else err.textContent='No active Pro entitlement found for this email.';
  }catch(e){err.textContent=e.message||'Unable to check Pro status.';}
}

async function paymentReturn() {
  const params=new URLSearchParams(location.search); const reference=params.get('reference'); const chargeId=params.get('charge_id');
  A.innerHTML=`<main class="shell"><section class="panel pro"><h1>Checking payment…</h1><p id="paymentStatus">Please wait while WYWHOT verifies your Flutterwave payment.</p></section></main>`;
  if(!reference){document.getElementById('paymentStatus').textContent='Payment reference was not returned. Open WYWHOT Pro and use Check / Restore Pro.';return;}
  for(let i=0;i<10;i++){
    try{
      const qs=new URLSearchParams({reference}); if(chargeId) qs.set('charge_id',chargeId);
      const r=await fetch('/api/flutterwave/verify-payment?'+qs.toString()); const b=await r.json();
      if(b.paid){isPro=true;localStorage.setItem('wywhot_pro_email',b.email||localStorage.getItem('wywhot_pro_email')||''); A.innerHTML=`<main class="shell"><section class="panel pro"><h1>🎉 Pro Activated</h1><p>Unlimited hints, no ads and Virtual Bank access are now enabled.</p><p class="muted">Active until ${new Date(b.expires_at).toLocaleDateString()}.</p><button onclick="home()">Continue to WYWHOT</button></section></main>`;return;}
      document.getElementById('paymentStatus').textContent=`Payment status: ${b.status||'pending'}…`;
    }catch(e){document.getElementById('paymentStatus').textContent=e.message||'Still checking payment…';}
    await new Promise(r=>setTimeout(r,2500));
  }
  document.getElementById('paymentStatus').textContent='Payment is still pending. Your Pro will activate automatically when Flutterwave confirms it. You can return to Pro and use Check / Restore Pro later.';
}

function settings() {
  A.innerHTML = `<main class="shell"><section class="panel">
    <h1>Settings</h1>
    <label><input type="checkbox" id="sfx" ${prefs.sfx ? "checked" : ""} onchange="setPref('sfx', this.checked)"> Sound effects</label>
    <label><input type="checkbox" id="cardAudio" ${prefs.cardAudio ? "checked" : ""} onchange="setPref('cardAudio', this.checked)"> Special-card audio</label>
    <label><input type="checkbox" id="voice" ${prefs.voice ? "checked" : ""} onchange="setPref('voice', this.checked)"> Voice chat</label>
    <p class="muted small" id="prefStatus">Preferences apply for this session.</p>
    <button onclick="home()">Home</button>
  </section></main>`;
}

function setPref(key, val) {
  prefs[key] = val;
  const s = document.getElementById("prefStatus");
  if (s) s.textContent = `Saved: ${key} ${val ? "on" : "off"} for this session.`;
}

(async function boot(){
  const params=new URLSearchParams(location.search);
  if(params.get("payment")==="return") return paymentReturn();
  const email=localStorage.getItem("wywhot_pro_email");
  if(email){ try{ const r=await fetch("/api/flutterwave/pro-status?email="+encodeURIComponent(email)); const b=await r.json(); if(b.active) isPro=true; }catch(e){} }
  home();
})();
