// Logged-in player's parcels and run submission.
//   { action: "parcels" }                  -> collected parcels from the player's InPost account
//   { action: "submit", shipmentNumber }   -> verifies ownership, times the run, stores it

import { fetchOwnParcels, timeRun } from "../_shared/inpost.ts";
import { admin, HttpError, json, requireUser, serve } from "../_shared/util.ts";

serve(async (req) => {
  const user = await requireUser(req);
  const { action, shipmentNumber } = await req.json().catch(() => ({}));

  const parcels = (await fetchOwnParcels(user.id)).filter(
    (p) => p.status === "DELIVERED" && (p.ownershipStatus ?? "OWN") === "OWN",
  );

  if (action === "parcels") {
    const numbers = parcels.map((p) => p.shipmentNumber);
    const { data: taken } = numbers.length
      ? await admin.from("runs").select("shipment_number").in("shipment_number", numbers)
      : { data: [] };
    const submitted = new Set((taken ?? []).map((r) => r.shipment_number));
    return json({
      parcels: parcels.map((p) => ({
        shipmentNumber: p.shipmentNumber,
        paczkomat: p.pickUpPoint?.name ?? null,
        storedDate: p.storedDate ?? null,
        pickUpDate: p.pickUpDate ?? null,
        submitted: submitted.has(p.shipmentNumber),
      })),
    });
  }

  if (action === "submit") {
    const number = String(shipmentNumber ?? "").replace(/\s/g, "");
    const parcel = parcels.find((p) => p.shipmentNumber === number);
    if (!parcel) {
      throw new HttpError(403, "This parcel is not a collected parcel on your InPost account");
    }
    const timing = await timeRun(parcel);
    const { data, error } = await admin
      .from("runs")
      .insert({
        user_id: user.id,
        shipment_number: number,
        paczkomat: timing.paczkomat,
        placed_at: timing.placedAt,
        collected_at: timing.collectedAt,
        source: timing.source,
      })
      .select("shipment_number, paczkomat, placed_at, collected_at, duration_seconds")
      .single();
    if (error?.code === "23505") throw new HttpError(409, "This parcel is already on the leaderboard");
    if (error) throw error;
    return json({ run: data });
  }

  throw new HttpError(400, "Unknown action");
});
