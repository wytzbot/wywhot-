// Vercel serverless function — GET /api/config
// Hands the browser the PUBLIC Supabase URL + anon key at runtime.
// This is safe to expose: the anon key has no power on its own, it's
// only as permissive as the RLS policies in supabase.sql allow.
// Never put FLW_CLIENT_SECRET or SUPABASE_SERVICE_ROLE_KEY here.
module.exports = (req, res) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const flwEncryptionKey = process.env.FLW_ENCRYPTION_KEY || "";

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(200).json({ configured: false, supabaseUrl: "", supabaseAnonKey: "", flwEncryptionKey });
    return;
  }
  res.status(200).json({ configured: true, supabaseUrl, supabaseAnonKey, flwEncryptionKey });
};
