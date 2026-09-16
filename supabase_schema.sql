create table if not exists public.radarmap_subscribers (
  chat_id text primary key,
  username text,
  first_name text,
  updated_at timestamptz not null default now()
);

alter table public.radarmap_subscribers enable row level security;

-- The bot uses the server-side service_role key from Replit Secrets.
-- Do not expose SUPABASE_KEY in browser or mobile code.