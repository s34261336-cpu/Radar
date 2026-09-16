CREATE TABLE IF NOT EXISTS public.radarmap_subscribers (
  chat_id TEXT NOT NULL PRIMARY KEY,
  username TEXT NULL,
  first_name TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.radarmap_subscribers ENABLE ROW LEVEL SECURITY;

-- The bot uses the server-side service_role key from Replit Secrets.
-- Do not expose SUPABASE_KEY in browser or mobile code.