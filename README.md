# WYWHOT — final v4 monetization build

## Features
- Multiplayer WHOT rooms, player names and avatars
- Room creator and editable WHOT rules
- Pick 2, General Market, Hold On, Continue, Skip, Last Card, Check Up
- Free hint system
- Adsterra 300x250 free-user sponsor unit
- 10-second sponsor screen for +2 hints
- WYWHOT Pro: ₦1,000/month or $1/month
- Pro: unlimited hints and no ads
- Flutterwave v4 server-side verification blueprint for NGN 1000 and USD 1
- Supabase entitlement/payment-event schema
- Voice and sound UI
- Pro-only Virtual Bank
- Room creator activates virtual bank
- ₦10,000 / $10,000 / €10,000 fictional balance
- 24-hour renewal
- No cash value, withdrawal or conversion
- Standalone icons at project root

## v4.1 — bug/dead-flow audit fixes
- Draw Card, hand cards, and the in-game Voice button now do something (previously unwired).
- Added a Leave Room control and made the in-game logo tap-to-home; previously the game screen was a dead end reachable only via browser back.
- Empty room code on Join now shows an inline message instead of silently doing nothing.
- The rewarded-ad screen (`adReward`) was unreachable dead code — it's now linked from "Out of hints".
- Added a persistent free-user ad slot in-game (README described this; it wasn't actually rendered anywhere).
- Virtual Bank had no Pro gating in the client — any user could open it. Now it checks `isPro` and upsells non-Pro users instead.
- Settings checkboxes were cosmetic; they now write to an in-memory `prefs` object with on-screen confirmation.
- Pro checkout no longer accepts an empty/invalid email silently.
- Lobby's "Waiting…" player slots never changed state; added a placeholder timeout so the UI isn't visibly static (still not real presence — see below).
- Added `lang`, a description meta tag, and an icon `<link>` to `index.html`.

## Remaining gap (not fixed — needs a decision)
~~Create Room / Join Room / opponents / game state are local simulation only~~ — **fixed in v4.2, see below.** `flutterwave.js` and `adsterra.js` are still server-side blueprints with no `/api` routes wired to them yet — deploy those as serverless functions before going live. Voice chat is a placeholder alert with no WebRTC/provider behind it.

## v4.2 — real Supabase multiplayer
- Added `api/config.js`: a Vercel serverless function that hands the browser the public `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` at runtime, since this is a static site with no build step to inject env vars into the bundle. Set both in Vercel's env vars (see `.env.example`), then redeploy.
- Added `supabaseClient.js`: lazy-loads `@supabase/supabase-js` from a CDN only when a network action actually happens, so a failed/slow Supabase load can't kill every other button on the page (this bit a previous project — see WyteAI's static-top-level-import bug).
- **Create Room** now inserts a real `rooms` row (retries on room-code collision) and a `players` row for the host.
- **Join Room** looks up the room by code, checks it's still in `lobby` status and under 4 players, then inserts a `players` row. Rejoining after a refresh reuses the same locally-stored player id instead of creating a duplicate.
- **Lobby** subscribes to a Supabase Realtime channel: player list updates live via `postgres_changes` on `players`; "Start Game" updates `rooms.status`, which pushes every connected client into the game screen via the same channel.
- **In-game**, playing/drawing a card broadcasts a lightweight event on the same channel; other players see the pile update and the opponent's visible card count drop.
- Added Row Level Security policies (`supabase.sql`): `rooms`/`players`/`game_states` are open enough for the anon key to run the app; `pro_entitlements`, `payment_events`, and `virtual_bankrolls` intentionally have **no** anon policies — only server-side code with the service role key can touch money/entitlement data.

### v4.2 trust-model caveat — CLOSED in v4.3, see below
~~There is still no server-side rule engine...~~

## v4.3 — server-authoritative rule engine (closes the v4.2 caveat)
The game-engine Edge Function (`supabase/functions/game-engine/index.ts`) is now the only thing that deals cards, validates a move, or advances whose turn it is. The browser sends a *request* ("I want to play card index 2"); the function checks it's actually that player's turn, the card is actually in their hand, and the move is legal, then writes the result. A modified/hacked client can no longer fabricate a move or see another player's hand.

**Hidden hands are now real, not just hidden in the UI.** This needed actual identity, so anonymous Supabase Auth (`signInAnonymously()`, no signup form) replaced the old client-generated player id. `player_hands` RLS is `player_id = auth.uid()` — a client can only ever `select` its own hand; there's no way to query anyone else's, spoofed id or not.

**Deploy steps (in order):**
1. Supabase Dashboard → Authentication → Sign In / Providers → enable **Anonymous**. Nothing below works without this.
2. Run the updated `supabase.sql` (adds `game_states`/`game_decks`/`player_hands` and their RLS policies; `rooms.host_id`/`players.id` are now `uuid`, matching `auth.uid()`).
3. Deploy the function: `supabase functions deploy game-engine`.
4. Set its secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Dashboard → Edge Functions → game-engine → Secrets, or `supabase secrets set`). The first and third are usually already present in a Supabase project; add the anon key if it isn't.
5. Vercel env vars (`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`) are unchanged from v4.2.

**What's implemented:** matching by number/shape, WHOT(20) wildcard with a called shape, 1 (Hold On), 2 (Pick Two, next player draws 2 and is skipped), 8 (Suspension, next player skipped), 14 (General Market, everyone else draws 1), win-on-empty-hand, deck reshuffle-from-discard when the draw pile runs out.

**What's still simplified** (see the header comment in `game-engine/index.ts` — that's the one place to change any of these):
- Deck is an approximation (4 suits × 1–14 + 5 Whot cards, 61 total), not the official tournament WHOT card distribution.
- Pick Two doesn't stack (can't counter with your own 2 to pass the draw on).
- Card 5 ("Pick Three" in some rule sets) is treated as a normal card.
- The Last-Card call-out penalty isn't enforced.
- You can draw on your turn any time, not only when you have no legal play.

None of these are bugs — they're scope choices, listed so you know exactly what to harden before running real-money or competitive games on this.

### Local testing
`npm run dev` (`npx serve .`) serves static files only — it runs neither `/api/config.js` nor the Edge Function. Use `vercel dev` (with `.env.local` from `.env.example`) for the API route, and `supabase functions serve game-engine` for the engine, or just test against a deployed Vercel preview + deployed Edge Function.

## Important
The supplied Adsterra 300x250 unit is used as a timed sponsor experience. It is not a provider-verified rewarded-ad callback. Do not treat a normal banner impression as a verified ad completion.

Flutterwave secrets remain server-side. Before production, deploy the v4 charge initialization and webhook/verification endpoints and add real Vercel environment variables. The browser must never contain FLW_CLIENT_SECRET.


## Flutterwave v4 wired flow
The Pro checkout is now wired through server-side Vercel functions. The browser encrypts card fields with the Flutterwave AES-256-GCM encryption key, then sends only encrypted fields to `/api/flutterwave/create-payment`. The server creates/finds the customer, creates the payment method, creates the v4 charge, and redirects to any `next_action.redirect_url` returned by Flutterwave. Flutterwave v4 uses OAuth 2.0 at the documented token endpoint and the sandbox base `https://developersandbox-api.flutterwave.com`; production uses `https://f4bexperience.flutterwave.com`. The v4 charge API requires an idempotency key and supports redirect-based authorization. 

Webhook endpoint: `/api/flutterwave/webhook`. It verifies the `flutterwave-signature` HMAC-SHA256 signature over the raw request body, re-queries the charge, validates reference/amount/currency/status, then activates `pro_entitlements` for 30 days. The payment result page polls `/api/flutterwave/verify-payment` as a backup. Pro status can be restored by email through `/api/flutterwave/pro-status`.

#
## Shared Flutterwave webhook with MedWord

This build intentionally does **not** require you to replace the Flutterwave webhook already used by MedWord. WYWHOT Pro payment references start with `WYH-`, and the v4 charge metadata includes `app: "WYWHOT"`. When the MedWord webhook code is available, merge the WYWHOT branch into that existing webhook so one account-level Flutterwave webhook can safely process both apps.

Until that merge is done, do not change the Flutterwave account webhook from the existing MedWord URL. The included `/api/flutterwave/webhook.js` remains available for isolated WYWHOT testing, but it should not be registered as the account webhook while MedWord is using the account.

The shared webhook must verify the Flutterwave signature, use the payment reference/metadata to route the event, re-query the charge, enforce amount/currency/reference checks, and record the event idempotently before activating `pro_entitlements`.

## Vercel environment variables
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FLW_CLIENT_ID`
- `FLW_CLIENT_SECRET`
- `FLW_ENCRYPTION_KEY`
- `FLW_SECRET_HASH`
- `FLW_ENV=sandbox` (change to `production` for live)
- `FLW_API_BASE_URL=https://developersandbox-api.flutterwave.com` (use the production base when live)
- `NEXT_PUBLIC_APP_URL=https://your-domain.example`

Do not expose `FLW_CLIENT_SECRET`, `FLW_SECRET_HASH`, or `SUPABASE_SERVICE_ROLE_KEY` to the browser. The encryption key is intentionally delivered to the browser because v4 card encryption occurs client-side; it is not a replacement for server-side credentials.
