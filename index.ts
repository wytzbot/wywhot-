// supabase/functions/game-engine/index.ts
//
// Authoritative WHOT rule engine. Runs server-side (Deno, Supabase Edge
// Functions) so a modified client can no longer lie about what card it
// played or peek at other players' hands — see the v4.2 README caveat
// this was written to close.
//
// Deploy: supabase functions deploy game-engine
// Requires these Edge Function secrets (Supabase Dashboard → Edge
// Functions → game-engine → Secrets, or `supabase secrets set`):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// (SUPABASE_URL/SERVICE_ROLE_KEY are auto-provided by Supabase in most
// setups — set ANON_KEY yourself if it isn't already present.)
//
// KNOWN SIMPLIFICATIONS (documented, not bugs):
//   - Deck is 4 suits x 1-14 + 5 Whot(20) cards (61 cards). This is an
//     approximation, not the official tournament WHOT card distribution.
//   - Pick Two (card 2) does not "stack" (playing another 2 in reply to
//     avoid drawing) — the next player always just draws 2 and is skipped.
//   - Card 5 ("Pick Three" in some rule sets) is treated as a normal card.
//   - "Last Card" call-out and its penalty are not enforced.
//   - Drawing is allowed on your turn any time, not only when you have
//     no legal play — a real WHOT table enforces the latter.
// Tighten any of these in this file — it's the only place game logic lives.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUITS = ["circle", "triangle", "cross", "square"];
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (let v = 1; v <= 14; v++) deck.push({ v, s });
  for (let i = 0; i < 5; i++) deck.push({ v: 20, s: "whot" });
  // Fisher-Yates with crypto randomness
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function isLegalPlay(card, discardTop, calledShape) {
  if (card.v === 20) return true; // Whot is always playable
  if (calledShape) return card.s === calledShape;
  return card.v === discardTop.v || card.s === discardTop.s;
}

// Refill deck from the market pile (everything under the current
// discard top) if the draw pile runs dry, like shuffling a physical
// discard pile back into the deck.
function drawCards(state, n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0) {
      if (state.marketPile.length === 0) break; // truly nothing left
      state.deck = state.marketPile;
      state.marketPile = [];
      for (let j = state.deck.length - 1; j > 0; j--) {
        const k = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296) * (j + 1));
        [state.deck[j], state.deck[k]] = [state.deck[k], state.deck[j]];
      }
    }
    const c = state.deck.pop();
    if (c) drawn.push(c);
  }
  return drawn;
}

function nextIndex(order, currentId, skip = 0) {
  const i = order.indexOf(currentId);
  return (i + 1 + skip) % order.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return json({ error: "Edge function is missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY secrets." }, 500);
  }

  // Verify the caller's identity from their own JWT — never trust a
  // client-supplied playerId for anything that matters.
  const authHeader = req.headers.get("Authorization") || "";
  const authed = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await authed.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not signed in." }, 401);
  const callerId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const { action, roomId } = body || {};
  if (!action || !roomId) return json({ error: "action and roomId are required." }, 400);

  const { data: room, error: roomErr } = await admin.from("rooms").select("*").eq("id", roomId).maybeSingle();
  if (roomErr) return json({ error: roomErr.message }, 500);
  if (!room) return json({ error: "Room not found." }, 404);

  // ---------------- start ----------------
  if (action === "start") {
    if (room.host_id !== callerId) return json({ error: "Only the host can start the game." }, 403);
    if (room.status !== "lobby") return json({ error: "Game already started." }, 409);

    const { data: players, error: pErr } = await admin.from("players").select("id").eq("room_id", roomId).order("is_host", { ascending: false });
    if (pErr) return json({ error: pErr.message }, 500);
    if (!players || players.length < 2) return json({ error: "Need at least 2 players to start." }, 400);

    const deck = buildDeck();
    const hands = {};
    for (const p of players) hands[p.id] = deck.splice(0, 5);

    // First discard: skip past any Whot so the game doesn't open on a
    // wildcard with no called shape.
    let discardTop = null;
    const setAside = [];
    while (deck.length) {
      const c = deck.pop();
      if (c.v !== 20) { discardTop = c; break; }
      setAside.push(c);
    }
    deck.push(...setAside);
    if (!discardTop) return json({ error: "Deck exhausted while flipping the opening card — try again." }, 500);

    const turnOrder = players.map(p => p.id);
    const handCounts = Object.fromEntries(players.map(p => [p.id, hands[p.id].length]));

    const { error: upsertHandsErr } = await admin.from("player_hands").upsert(
      players.map(p => ({ room_id: roomId, player_id: p.id, hand: hands[p.id] }))
    );
    if (upsertHandsErr) return json({ error: upsertHandsErr.message }, 500);

    const { error: deckErr } = await admin.from("game_decks").upsert({ room_id: roomId, deck });
    if (deckErr) return json({ error: deckErr.message }, 500);

    const { error: gsErr } = await admin.from("game_states").upsert({
      room_id: roomId,
      deck_count: deck.length,
      discard_top: discardTop,
      called_shape: null,
      market_pile: [],
      turn_order: turnOrder,
      current_turn: turnOrder[0],
      hand_counts: handCounts,
      last_action: { type: "game_started" },
      status: "active",
      winner: null,
      updated_at: new Date().toISOString(),
    });
    if (gsErr) return json({ error: gsErr.message }, 500);

    await admin.from("rooms").update({ status: "active" }).eq("id", roomId);
    return json({ ok: true });
  }

  // ---------------- play / draw ----------------
  if (action === "play" || action === "draw") {
    if (room.status !== "active") return json({ error: "Game is not active." }, 409);

    const { data: gs, error: gsErr } = await admin.from("game_states").select("*").eq("room_id", roomId).maybeSingle();
    if (gsErr) return json({ error: gsErr.message }, 500);
    if (!gs) return json({ error: "Game state not found." }, 404);
    if (gs.current_turn !== callerId) return json({ error: "It's not your turn." }, 409);

    const { data: deckRow, error: deckErr } = await admin.from("game_decks").select("deck").eq("room_id", roomId).maybeSingle();
    if (deckErr) return json({ error: deckErr.message }, 500);

    const { data: handRow, error: handErr } = await admin.from("player_hands").select("*").eq("room_id", roomId).eq("player_id", callerId).maybeSingle();
    if (handErr) return json({ error: handErr.message }, 500);
    if (!handRow) return json({ error: "No hand found for you in this room." }, 404);

    const state = {
      deck: (deckRow && Array.isArray(deckRow.deck)) ? deckRow.deck : [],
      marketPile: gs.market_pile || [],
      discardTop: gs.discard_top,
      calledShape: gs.called_shape,
      turnOrder: gs.turn_order || [],
      handCounts: { ...(gs.hand_counts || {}) },
    };

    let myHand = handRow.hand || [];
    const patches = { hands: {} }; // playerId -> new hand, for any player whose hand changes this turn
    let nextTurn = gs.current_turn;
    let lastAction;

    if (action === "draw") {
      const drawn = drawCards(state, 1);
      myHand = [...myHand, ...drawn];
      patches.hands[callerId] = myHand;
      nextTurn = state.turnOrder[nextIndex(state.turnOrder, callerId)];
      lastAction = { type: "card_drawn", playerId: callerId };
    } else {
      const { cardIndex, calledShape } = body;
      if (typeof cardIndex !== "number" || !myHand[cardIndex]) return json({ error: "Invalid card." }, 400);
      const card = myHand[cardIndex];

      if (!isLegalPlay(card, state.discardTop, state.calledShape)) {
        return json({ error: "That card doesn't match the pile — pick a matching number, shape, or a Whot." }, 400);
      }
      if (card.v === 20 && !SUITS.includes(calledShape)) {
        return json({ error: "Playing a Whot card requires calledShape (circle/triangle/cross/square)." }, 400);
      }

      myHand = myHand.filter((_, i) => i !== cardIndex);
      patches.hands[callerId] = myHand;
      state.marketPile.push(state.discardTop);
      state.discardTop = card;
      state.calledShape = card.v === 20 ? calledShape : null;
      lastAction = { type: "card_played", playerId: callerId, card };

      if (myHand.length === 0) {
        // Win — skip turn advancement/effects entirely.
        const { error: handWriteErr } = await admin.from("player_hands").update({ hand: myHand }).eq("room_id", roomId).eq("player_id", callerId);
        if (handWriteErr) return json({ error: handWriteErr.message }, 500);
        state.handCounts[callerId] = 0;
        await admin.from("game_decks").update({ deck: state.deck }).eq("room_id", roomId);
        const { error: finishErr } = await admin.from("game_states").update({
          deck_count: state.deck.length, discard_top: state.discardTop,
          called_shape: state.calledShape, market_pile: state.marketPile,
          hand_counts: state.handCounts, last_action: lastAction,
          status: "finished", winner: callerId, updated_at: new Date().toISOString(),
        }).eq("room_id", roomId);
        if (finishErr) return json({ error: finishErr.message }, 500);
        await admin.from("rooms").update({ status: "finished" }).eq("id", roomId);
        return json({ ok: true, won: true });
      }

      // Special-card effects (see file header for what's NOT implemented).
      if (card.v === 1) {
        nextTurn = callerId; // Hold On — go again
      } else if (card.v === 2) {
        const victim = state.turnOrder[nextIndex(state.turnOrder, callerId)];
        const { data: victimHandRow } = await admin.from("player_hands").select("hand").eq("room_id", roomId).eq("player_id", victim).maybeSingle();
        const victimHand = [...(victimHandRow?.hand || []), ...drawCards(state, 2)];
        patches.hands[victim] = victimHand;
        state.handCounts[victim] = victimHand.length;
        nextTurn = state.turnOrder[nextIndex(state.turnOrder, callerId, 1)]; // skip the victim
      } else if (card.v === 8) {
        nextTurn = state.turnOrder[nextIndex(state.turnOrder, callerId, 1)]; // skip next player, no draw
      } else if (card.v === 14) {
        for (const pid of state.turnOrder) {
          if (pid === callerId) continue;
          const { data: r } = await admin.from("player_hands").select("hand").eq("room_id", roomId).eq("player_id", pid).maybeSingle();
          const h = [...(r?.hand || []), ...drawCards(state, 1)];
          patches.hands[pid] = h;
          state.handCounts[pid] = h.length;
        }
        nextTurn = state.turnOrder[nextIndex(state.turnOrder, callerId)];
      } else {
        nextTurn = state.turnOrder[nextIndex(state.turnOrder, callerId)];
      }
    }

    // Persist every changed hand.
    for (const [pid, h] of Object.entries(patches.hands)) {
      const { error } = await admin.from("player_hands").update({ hand: h }).eq("room_id", roomId).eq("player_id", pid);
      if (error) return json({ error: error.message }, 500);
    }
    state.handCounts[callerId] = myHand.length;

    const { error: deckWriteErr } = await admin.from("game_decks").update({ deck: state.deck }).eq("room_id", roomId);
    if (deckWriteErr) return json({ error: deckWriteErr.message }, 500);

    const { error: writeErr } = await admin.from("game_states").update({
      deck_count: state.deck.length, discard_top: state.discardTop,
      called_shape: state.calledShape, market_pile: state.marketPile,
      hand_counts: state.handCounts, current_turn: nextTurn, last_action: lastAction,
      updated_at: new Date().toISOString(),
    }).eq("room_id", roomId);
    if (writeErr) return json({ error: writeErr.message }, 500);

    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
});
