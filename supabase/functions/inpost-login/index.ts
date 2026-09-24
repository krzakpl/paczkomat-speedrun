// Phone + SMS login through InPost.
//   { action: "send",   phone }        -> InPost texts a 6-digit code
//   { action: "verify", phone, code }  -> { token_hash } for supabase.auth.verifyOtp on the client

import { confirmSmsCode, sendSmsCode } from "../_shared/inpost.ts";
import { admin, HttpError, json, normalizePhone, serve, sha256 } from "../_shared/util.ts";

const PER_MINUTE = 1;
const PER_HOUR = 5;

serve(async (req) => {
  const { action, phone: rawPhone, code } = await req.json().catch(() => ({}));
  const phone = normalizePhone(rawPhone);
  const phoneHash = await sha256(phone);

  if (action === "send") {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { data: recent } = await admin
      .from("sms_requests")
      .select("created_at")
      .eq("phone_hash", phoneHash)
      .gte("created_at", hourAgo);
    const lastMinute = (recent ?? []).filter((r) => Date.parse(r.created_at) > Date.now() - 60_000);
    if (lastMinute.length >= PER_MINUTE || (recent ?? []).length >= PER_HOUR) {
      throw new HttpError(429, "Too many codes requested, try again later");
    }
    await admin.from("sms_requests").insert({ phone_hash: phoneHash });
    await sendSmsCode(phone);
    return json({ sent: true });
  }

  if (action === "verify") {
    const tokens = await confirmSmsCode(phone, String(code ?? "").trim());

    // Each phone number maps to one Supabase user with a placeholder address that is never mailed.
    const email = `${phoneHash.slice(0, 32)}@phone.paczkomat-speedrun.local`;
    const { error: createError } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createError && createError.code !== "email_exists") throw createError;

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (linkError) throw linkError;
    const userId = link.user.id;

    await admin.from("profiles").upsert(
      { id: userId, display_name: `Runner ${crypto.getRandomValues(new Uint16Array(1))[0] % 10000}` },
      { onConflict: "id", ignoreDuplicates: true },
    );
    const { error: credError } = await admin.from("inpost_credentials").upsert({
      user_id: userId,
      phone_hash: phoneHash,
      auth_token: tokens.authToken,
      refresh_token: tokens.refreshToken,
      updated_at: new Date().toISOString(),
    });
    if (credError) throw credError;

    return json({ token_hash: link.properties.hashed_token });
  }

  throw new HttpError(400, "Unknown action");
});
