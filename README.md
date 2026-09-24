# Paczkomat Speedrun

A leaderboard for how fast people pick up InPost parcels. The clock starts when InPost puts the parcel in the paczkomat and stops when the recipient opens the locker.

- **Login:** phone number + SMS code, sent by InPost through its mobile app API.
- **Verification:** only parcels on the logged-in InPost account (status `DELIVERED`, ownership `OWN`) can be submitted, and each parcel can go on the board once.
- **Timing:** the time between `ready_to_pickup` and `delivered` in InPost's public ShipX tracking. If that isn't available, the mobile API's `storedDate` → `pickUpDate` is used instead.

> The InPost mobile API is unofficial and undocumented. It can change without notice, and using it is likely against InPost's terms. The site is not affiliated with InPost.

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `assets/` | Static site served by GitHub Pages (`.github/workflows/jekyll.yml`) |
| `assets/config.js` | Supabase project URL and anon key |
| `supabase/migrations/0001_init.sql` | Tables, row-level security, `leaderboard` view |
| `supabase/functions/inpost-login` | Sends the SMS code and exchanges it for a Supabase session |
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

Phone numbers are never stored in plain text. Users are keyed by a SHA-256 hash of the number, and the InPost tokens sit in a table that only the Edge Functions (service role) can read.

## Local preview

```sh
python3 -m http.server 8000
```
