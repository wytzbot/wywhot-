// Lazy Supabase client + anonymous auth. Nothing here runs at page
// load — app.js calls these only when a user actually triggers a
// network action (Create Room, Join, Play Card, etc). If any of this
// fails, only that action shows an error; every other button on the
// page stays wired (see the wyteai static-import bug this pattern
// was written to avoid).
let _client = null;
let _configPromise = null;
let _userPromise = null;

function fetchConfig() {
  if (!_configPromise) {
    _configPromise = fetch("/api/config")
      .then(r => { if (!r.ok) throw new Error("config endpoint returned " + r.status); return r.json(); })
      .catch(err => { _configPromise = null; throw err; });
  }
  return _configPromise;
}

async function getSupabase() {
  if (_client) return _client;
  const cfg = await fetchConfig();
  if (!cfg.configured) {
    throw new Error(
      "NOT_CONFIGURED: Supabase env vars are missing. Set NEXT_PUBLIC_SUPABASE_URL and " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel (see .env.example), then redeploy."
    );
  }
  const mod = await import("https://esm.sh/@supabase/supabase-js@2");
  _client = mod.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  return _client;
}

// Ensures the browser has a signed-in (anonymous) Supabase session and
// returns its user. This requires Anonymous Sign-ins to be turned on
// in the Supabase project (Dashboard → Authentication → Providers) —
// see supabase.sql for the note. The resulting auth.uid() is what RLS
// uses to guarantee a player can only ever read their own hand.
async function ensureUser() {
  if (_userPromise) return _userPromise;
  _userPromise = (async () => {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (session?.user) return session.user;
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) {
      throw new Error(
        "AUTH_FAILED: Couldn't start an anonymous session (" + error.message + "). " +
        "Make sure Anonymous Sign-ins is enabled for this Supabase project."
      );
    }
    return data.user;
  })();
  try { return await _userPromise; } catch (e) { _userPromise = null; throw e; }
}

window.WYWHOT_DB = { getSupabase, ensureUser };
