// InPost access.
// - Mobile API (unofficial, the one the InPost app uses): OAuth login through
//   account.inpost-group.com and the list of the user's own parcels. Proves a parcel
//   belongs to the logged-in InPost account.
// - ShipX public tracking: per-status timestamps used to time the run.

import { admin, HttpError } from "./util.ts";

const MOBILE = "https://api-inmobile-pl.easypack24.net";
const SHIPX = "https://api-shipx-pl.easypack24.net/v1";
const TOKEN_URL = `${MOBILE}/global/oauth2/token`;
// Same client and redirect as the InPost app; the redirect page just shows the code in its URL.
const CLIENT_ID = "inpost-mobile";
const REDIRECT_URI = "https://account.inpost-group.com/callback";
// InPost answers 500 to API calls without an app User-Agent.
const USER_AGENT = "InPost-Mobile/4.4.2 (1)-release (iOS 26.2; iPhone15,3; pl)";

async function mobile(path: string, token: string) {
  return await fetch(`${MOBILE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, Authorization: `Bearer ${token}` },
  });
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens | null> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!res.ok) {
    console.error("oauth2/token", params.grant_type, res.status, await res.text());
    return null;
  }
  const body = await res.json();
  return { accessToken: body.access_token, refreshToken: body.refresh_token, idToken: body.id_token };
}

/** Exchanges the code from InPost's login redirect (PKCE) for tokens. */
export async function exchangeCode(code: string, verifier: string): Promise<Tokens> {
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  if (!tokens?.accessToken) {
    throw new HttpError(401, "InPost rejected the login. Codes expire quickly, so log in again and paste the new link");
  }
  return tokens;
}

/** Stable InPost account id: the `sub` claim of the ID token (or access token). */
export function accountId(tokens: Tokens): string {
  for (const jwt of [tokens.idToken, tokens.accessToken]) {
    try {
      const payload = JSON.parse(atob(jwt!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload.sub) return String(payload.sub);
    } catch {
      // not a JWT, try the next one
    }
  }
  throw new Error("InPost tokens carry no account id");
}

export interface MobileParcel {
  shipmentNumber: string;
  status: string;
  ownershipStatus?: string;
  storedDate?: string;
  pickUpDate?: string;
  pickUpPoint?: { name?: string; addressDetails?: { city?: string; street?: string } };
}

/** Lists the user's tracked parcels, refreshing the stored InPost token when it has expired. */
export async function fetchOwnParcels(userId: string): Promise<MobileParcel[]> {
  const { data: cred } = await admin
    .from("inpost_credentials")
    .select("access_token, refresh_token")
    .eq("user_id", userId)
    .single();
  if (!cred) throw new HttpError(401, "Log in with InPost again");

  let res = await mobile("/v4/parcels/tracked", cred.access_token);
  if (res.status === 401 || res.status === 403) {
    const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: cred.refresh_token });
    if (!tokens?.accessToken) throw new HttpError(401, "Your InPost session expired, log in again");
    await admin
      .from("inpost_credentials")
      .update({
        access_token: tokens.accessToken,
        // InPost may or may not rotate the refresh token.
        refresh_token: tokens.refreshToken || cred.refresh_token,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
    res = await mobile("/v4/parcels/tracked", tokens.accessToken);
  }
  if (!res.ok) {
    console.error("parcels/tracked", res.status, await res.text());
    throw new HttpError(502, "Could not load parcels from InPost");
  }
  return ((await res.json()).parcels ?? []) as MobileParcel[];
}

export interface RunTiming {
  placedAt: string;
  collectedAt: string;
  paczkomat: string | null;
  source: "shipx" | "mobile";
}

/**
 * Time from "placed in the paczkomat" to "collected".
 * Prefers ShipX tracking events; falls back to the mobile API's storedDate/pickUpDate.
 */
export async function timeRun(parcel: MobileParcel): Promise<RunTiming> {
  const res = await fetch(`${SHIPX}/tracking/${encodeURIComponent(parcel.shipmentNumber)}`);
  if (res.ok) {
    const t = await res.json();
    const events: { status: string; datetime: string }[] = t.tracking_details ?? [];
    const times = (names: string[]) =>
      events.filter((e) => names.includes(e.status)).map((e) => Date.parse(e.datetime)).sort((a, b) => a - b);
    // A parcel moved to a temporary machine starts its clock when it first became collectable.
    const placed = times(["ready_to_pickup", "stack_in_box_machine"]);
    const delivered = times(["delivered"]);
    if (placed.length && delivered.length) {
      return {
        placedAt: new Date(placed[0]).toISOString(),
        collectedAt: new Date(delivered[delivered.length - 1]).toISOString(),
        paczkomat: t.custom_attributes?.target_machine_id ?? parcel.pickUpPoint?.name ?? null,
        source: "shipx",
      };
    }
    if (delivered.length && !placed.length) {
      throw new HttpError(422, "This parcel was not collected from a paczkomat");
    }
  }
  if (parcel.storedDate && parcel.pickUpDate) {
    return {
      placedAt: new Date(parcel.storedDate).toISOString(),
      collectedAt: new Date(parcel.pickUpDate).toISOString(),
      paczkomat: parcel.pickUpPoint?.name ?? null,
      source: "mobile",
    };
  }
  throw new HttpError(422, "InPost has no locker drop-off and pickup times for this parcel");
}
