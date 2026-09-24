// Login through InPost's own login page (phone, SMS code, captcha).
//   { code, verifier } -> { token_hash } for supabase.auth.verifyOtp on the client
// `code` comes from the URL InPost redirects to after login; `verifier` is the PKCE
// verifier the browser generated when it opened that login page.

import { accountId, exchangeCode } from "../_shared/inpost.ts";
import { admin, HttpError, json, serve, sha256 } from "../_shared/util.ts";

serve(async (req) => {
  const { code, verifier } = await req.json().catch(() => ({}));
  if (typeof code !== "string" || !code || typeof verifier !== "string" || verifier.length < 43) {
    throw new HttpError(400, "Start the InPost login again");
  }

  const tokens = await exchangeCode(code, verifier);
  const accountHash = await sha256(accountId(tokens));

  // Each InPost account maps to one Supabase user with a placeholder address that is never mailed.
  const email = `${accountHash.slice(0, 32)}@inpost.paczkomat-speedrun.local`;
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
    account_hash: accountHash,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    updated_at: new Date().toISOString(),
  });
  if (credError) throw credError;

  return json({ token_hash: link.properties.hashed_token });
});
