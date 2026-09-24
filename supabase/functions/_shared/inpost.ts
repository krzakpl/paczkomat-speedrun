// InPost access.
// - Mobile API (unofficial, the one the InPost app uses): SMS login and the list of the
//   user's own parcels. Proves a parcel belongs to the logged-in phone number.
// - ShipX public tracking: per-status timestamps used to time the run.

import { admin, HttpError } from "./util.ts";

const MOBILE = "https://api-inmobile-pl.easypack24.net";
const SHIPX = "https://api-shipx-pl.easypack24.net/v1";

async function mobile(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (init.token) headers.set("Authorization", `Bearer ${init.token.replace(/^Bearer\s+/i, "")}`);
  return await fetch(`${MOBILE}${path}`, { ...init, headers });
}

export async function sendSmsCode(phone: string): Promise<void> {
  const res = await mobile("/v1/sendSMSCode", {
    method: "POST",
    body: JSON.stringify({ phoneNumber: phone }),
  });
  if (!res.ok) {
    console.error("sendSMSCode", res.status, await res.text());
    throw new HttpError(502, "InPost did not accept this number");
  }
}

export async function confirmSmsCode(phone: string, code: string) {
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "The SMS code has 6 digits");
  const res = await mobile("/v1/confirmSMSCode", {
    method: "POST",
    body: JSON.stringify({ phoneNumber: phone, smsCode: code, phoneOS: "Android" }),
  });
  if (!res.ok) {
    console.error("confirmSMSCode", res.status, await res.text());
    throw new HttpError(401, "Wrong or expired SMS code");
  }
  const body = await res.json();
  return { authToken: body.authToken as string, refreshToken: body.refreshToken as string };
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
    .select("auth_token, refresh_token")
    .eq("user_id", userId)
    .single();
  if (!cred) throw new HttpError(401, "Log in with InPost again");

  let res = await mobile("/v3/parcels/tracked", { token: cred.auth_token });
  if (res.status === 401) {
    const refreshed = await mobile("/v1/authenticate", {
      method: "POST",
      body: JSON.stringify({ refreshToken: cred.refresh_token, phoneOS: "Android" }),
    });
    const body = refreshed.ok ? await refreshed.json() : null;
    if (!body || body.reauthenticationRequired || !body.authToken) {
      throw new HttpError(401, "Your InPost session expired, log in again");
    }
    await admin
      .from("inpost_credentials")
      .update({ auth_token: body.authToken, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    res = await mobile("/v3/parcels/tracked", { token: body.authToken });
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
