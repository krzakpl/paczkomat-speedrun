# Paczkomat Speedrun

vibecoded with Claude because I'm too lazy for this shit post

just visit the site https://krzakpl.github.io/paczkomat-speedrun/
and submit a time

maybe it will work this time



I don't even know why did he wrote all this ↓

A leaderboard for how fast people pick up InPost parcels. The clock starts when InPost puts the parcel in the paczkomat and stops when the recipient opens the locker.

- **Login:** the player signs in on InPost's own login page (the one the InPost app uses: phone, SMS code, captcha), then pastes the address of the page InPost redirects to back into the site. The `inpost-login` function exchanges the code in it (OAuth 2 with PKCE) for InPost tokens.
- **Verification:** only parcels on the logged-in InPost account (status `DELIVERED`, ownership `OWN`) can be submitted, and each parcel can go on the board once.
- **Timing:** the time between `ready_to_pickup` and `delivered` in InPost's public ShipX tracking. If that isn't available, the mobile API's `storedDate` → `pickUpDate` is used instead.

> The InPost app API is unofficial and undocumented. It can change without notice, and using it is likely against InPost's terms. The site is not affiliated with InPost.

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `assets/` | Static site served by GitHub Pages (`.github/workflows/jekyll.yml`) |
| `assets/config.js` | Supabase project URL and anon key |
| `supabase/migrations/0001_init.sql` | Tables, row-level security, `leaderboard` view |
| `supabase/functions/inpost-login` | Exchanges InPost's login code for InPost tokens and a Supabase session |
| `supabase/functions/runs` | Lists the player's collected parcels and submits a run |

## Setup

1. Create a project at [supabase.com](https://supabase.com) and install the [Supabase CLI](https://supabase.com/docs/guides/cli).
2. Link the project, apply the schema and deploy the functions:
   ```sh
   supabase link --project-ref <your-project-ref>
   supabase db push
   supabase functions deploy inpost-login --no-verify-jwt
   supabase functions deploy runs
   ```
3. Put the project URL and anon (publishable) key from **Project Settings → API** into `assets/config.js`.
4. In the repo on GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**. Every push to `main` deploys the site.

The site never sees phone numbers. Users are keyed by a SHA-256 hash of their InPost account id, and the InPost tokens sit in a table that only the Edge Functions (service role) can read.

## Local preview

```sh
python3 -m http.server 8000
```
