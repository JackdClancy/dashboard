// Exposes the Supabase URL and anon key to the browser. This is the
// standard Supabase pattern for client-side apps - the anon key is meant
// to be public (security comes from Row Level Security on the tables,
// not from hiding this key). Reading it from env vars here just keeps
// the literal value out of the repo's source.

export default function handler(req, res) {
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
}
