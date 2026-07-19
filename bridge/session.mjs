/**
 * Build the plaintext site-type-0 login record emitted by the iOS app before
 * it permits any controller command to be written.
 *
 * Wire format: <16 ASCII key><six decimal digits><0xff>
 */
export function authenticationRecord(securityCode, nonce = Math.floor(Math.random() * 1_000_000)) {
  const key = String(securityCode ?? "");
  if (key.length !== 16 || !/^[\x20-\x7e]{16}$/.test(key)) {
    throw new Error("The controller security code must be exactly 16 ASCII characters");
  }
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 999_999) {
    throw new Error("The authentication nonce must be an integer from 0 to 999999");
  }
  return Buffer.concat([
    Buffer.from(`${key}${String(nonce).padStart(6, "0")}`, "ascii"),
    Buffer.from([0xff]),
  ]);
}
