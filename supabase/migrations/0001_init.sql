-- Paczkomat Speedrun schema.
-- Writes to runs and inpost_credentials happen only from Edge Functions (service role).

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 32),
  created_at timestamptz not null default now()
);

create table public.runs (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  shipment_number text not null unique,
  paczkomat text,
  placed_at timestamptz not null,
  collected_at timestamptz not null,
  duration_seconds integer generated always as (extract(epoch from (collected_at - placed_at))::integer) stored,
  source text not null check (source in ('shipx', 'mobile')),
  submitted_at timestamptz not null default now(),
  check (collected_at > placed_at)
);

create index runs_duration_idx on public.runs (duration_seconds);

-- InPost mobile tokens. RLS on with no policies: only the service role can read them.
create table public.inpost_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  phone_hash text not null unique,
  auth_token text not null,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);

-- Throttles SMS code requests so the login function can't be used to spam numbers.
create table public.sms_requests (
  id bigint generated always as identity primary key,
  phone_hash text not null,
  created_at timestamptz not null default now()
);

create index sms_requests_phone_idx on public.sms_requests (phone_hash, created_at);

alter table public.profiles enable row level security;
alter table public.runs enable row level security;
alter table public.inpost_credentials enable row level security;
alter table public.sms_requests enable row level security;

create policy "profiles are public" on public.profiles for select using (true);
create policy "users rename themselves" on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

create policy "runs are public" on public.runs for select using (true);

-- Best run per player, fastest first.
create view public.leaderboard with (security_invoker = true) as
select distinct on (r.user_id)
  r.user_id,
  p.display_name,
  r.shipment_number,
  r.paczkomat,
  r.placed_at,
  r.collected_at,
  r.duration_seconds
from public.runs r
join public.profiles p on p.id = r.user_id
order by r.user_id, r.duration_seconds asc;

grant select on public.leaderboard to anon, authenticated;
