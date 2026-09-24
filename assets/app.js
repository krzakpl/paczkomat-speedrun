import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const $ = (id) => document.getElementById(id);
const { supabaseUrl, supabaseAnonKey } = window.PACZKOMAT_CONFIG ?? {};

function notice(text, kind = "info") {
  const el = $("notice");
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = !text;
}

if (!supabaseUrl || !supabaseAnonKey) {
  notice("The site isn't connected to Supabase yet. Fill in assets/config.js (see README).", "error");
  $("board-body").innerHTML = `<tr><td colspan="5" class="muted">No backend configured.</td></tr>`;
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (d) return `${d}d ${h}h ${pad(m)}m`;
  if (h) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  return `${m}m ${pad(sec)}s`;
}

const dateFmt = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : "–");

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function call(fn, body) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  return data;
}

function busy(form, on) {
  for (const el of form.querySelectorAll("button, input")) el.disabled = on;
}

// ---- Leaderboard ----

async function loadBoard() {
  const { data, error } = await supabase
    .from("leaderboard")
    .select("user_id, display_name, paczkomat, collected_at, duration_seconds")
    .order("duration_seconds", { ascending: true })
    .limit(100);
  const body = $("board-body");
  if (error) {
    body.innerHTML = `<tr><td colspan="5" class="muted">Couldn't load the leaderboard.</td></tr>`;
    return;
  }
  if (!data.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">No runs yet. Be the first!</td></tr>`;
    return;
  }
  const me = (await supabase.auth.getSession()).data.session?.user.id;
  body.innerHTML = data
    .map(
      (r, i) => `<tr${r.user_id === me ? ' class="me"' : ""}>
        <td class="num">${i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}</td>
        <td>${escapeHtml(r.display_name)}</td>
        <td class="time">${formatDuration(r.duration_seconds)}</td>
        <td class="hide-sm mono">${escapeHtml(r.paczkomat ?? "–")}</td>
        <td class="hide-sm muted">${fmtDate(r.collected_at)}</td>
      </tr>`,
    )
    .join("");
}

// ---- Session ----

async function render(session) {
  const loggedIn = Boolean(session);
  $("login-card").hidden = loggedIn;
  $("submit-card").hidden = !loggedIn;
  $("session").innerHTML = loggedIn ? `<button type="button" id="logout" class="link">Log out</button>` : "";
  if (loggedIn) {
    $("logout").onclick = () => supabase.auth.signOut();
    const { data } = await supabase.from("profiles").select("display_name").eq("id", session.user.id).single();
    $("display-name").value = data?.display_name ?? "";
    loadParcels();
  }
  loadBoard();
}

supabase.auth.onAuthStateChange((_event, session) => {
  // Defer so Supabase finishes its own auth bookkeeping before we query.
  setTimeout(() => render(session), 0);
});

// ---- Login ----

// OAuth with PKCE against the InPost app's login. InPost only redirects to its own callback
// page, so the player copies that URL back here and the server exchanges the code.
const INPOST_AUTHORIZE = "https://account.inpost-group.com/oauth2/authorize";
const PKCE_KEY = "inpost-pkce";
const PKCE_MAX_AGE_MS = 15 * 60_000;

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readPkce() {
  try {
    const saved = JSON.parse(localStorage.getItem(PKCE_KEY));
    if (saved && Date.now() - saved.created < PKCE_MAX_AGE_MS) return saved;
  } catch {
    // storage unavailable or corrupt
  }
  return null;
}

let pkce;

// Reuses a pending login (the page may reload while the player is on InPost's page).
async function preparePkce(fresh = false) {
  pkce = (!fresh && readPkce()) || {
    // Alphanumeric only, like the InPost app's own verifiers.
    verifier: base64url(crypto.getRandomValues(new Uint8Array(64))).replace(/[^A-Za-z0-9]/g, "").slice(0, 64),
    state: base64url(crypto.getRandomValues(new Uint8Array(12))),
    created: Date.now(),
  };
  try {
    localStorage.setItem(PKCE_KEY, JSON.stringify(pkce));
  } catch {
    // login still works as long as this tab stays open
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.verifier));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "inpost-mobile",
    redirect_uri: "https://account.inpost-group.com/callback",
    scope: "openid",
    code_challenge: base64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    state: pkce.state,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(8))),
    lang: "pl",
    response_mode: "query",
  });
  const link = $("inpost-login-link");
  link.href = `${INPOST_AUTHORIZE}?${params}`;
  link.removeAttribute("aria-disabled");
}

function parseCallback(input) {
  const text = input.trim();
  if (!/[?&]code=/.test(text)) return { code: text };
  const params = new URLSearchParams(text.slice(text.indexOf("?") + 1).split("#")[0]);
  return { code: params.get("code"), state: params.get("state") };
}

preparePkce();

$("callback-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  busy(e.target, true);
  try {
    const { code, state } = parseCallback($("callback").value);
    if (!code) throw new Error("That link has no login code in it. Copy the whole address of InPost's last page.");
    if (state && state !== pkce.state) {
      throw new Error("That link is from an older login attempt. Open InPost login again.");
    }
    const { token_hash } = await call("inpost-login", { code, verifier: pkce.verifier });
    const { error } = await supabase.auth.verifyOtp({ token_hash, type: "magiclink" });
    if (error) throw error;
    notice("");
    e.target.reset();
    await preparePkce(true);
  } catch (err) {
    notice(err.message, "error");
  } finally {
    busy(e.target, false);
  }
});

// ---- Profile ----

$("name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  busy(e.target, true);
  const { data } = await supabase.auth.getSession();
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: $("display-name").value.trim() })
    .eq("id", data.session.user.id);
  notice(error ? "Couldn't save your name (2–32 characters)." : "Name saved.", error ? "error" : "info");
  busy(e.target, false);
  if (!error) loadBoard();
});

// ---- Parcels & submission ----

async function loadParcels() {
  const list = $("parcels");
  list.innerHTML = `<li class="muted small">Loading…</li>`;
  try {
    const { parcels } = await call("runs", { action: "parcels" });
    if (!parcels.length) {
      list.innerHTML = `<li class="muted small">No collected parcels on your InPost account.</li>`;
      return;
    }
    list.innerHTML = parcels
      .map((p) => {
        const est =
          p.storedDate && p.pickUpDate
            ? formatDuration((Date.parse(p.pickUpDate) - Date.parse(p.storedDate)) / 1000)
            : "–";
        return `<li>
          <div>
            <div class="mono">${escapeHtml(p.shipmentNumber)}</div>
            <div class="muted small">${escapeHtml(p.paczkomat ?? "")} · ${fmtDate(p.pickUpDate)} · ~${est}</div>
          </div>
          ${
            p.submitted
              ? `<span class="tag">On board</span>`
              : `<button type="button" class="secondary" data-submit="${escapeHtml(p.shipmentNumber)}">Submit</button>`
          }
        </li>`;
      })
      .join("");
  } catch (err) {
    list.innerHTML = `<li class="muted small">${escapeHtml(err.message)}</li>`;
    if (/log in again/i.test(err.message)) supabase.auth.signOut();
  }
}

async function submitRun(shipmentNumber, control) {
  control.disabled = true;
  try {
    const { run } = await call("runs", { action: "submit", shipmentNumber });
    notice(`Run recorded: ${formatDuration(run.duration_seconds)} at ${run.paczkomat ?? "your paczkomat"}.`);
    await Promise.all([loadParcels(), loadBoard()]);
    return true;
  } catch (err) {
    notice(err.message, "error");
    return false;
  } finally {
    control.disabled = false;
  }
}

$("parcels").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-submit]");
  if (btn) submitRun(btn.dataset.submit, btn);
});

$("manual-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await submitRun($("shipment").value, e.submitter ?? e.target)) e.target.reset();
});

$("reload-parcels").addEventListener("click", loadParcels);
