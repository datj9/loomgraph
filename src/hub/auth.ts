import { timingSafeEqual } from "node:crypto";
import { hashSecret } from "./storage.js";

/**
 * A structural subset of HubStore so a test can carry a deliberately corrupt
 * tokenHash without inserting a corrupt row into a real database. HubStore
 * satisfies it as-is, so every caller that would have taken HubStore still
 * compiles against this wider type.
 */
export interface MemberLookup {
  memberByKeyId(
    keyId: string,
  ): { member: string; tokenHash: string; scopes: string[]; revokedAt: string | null } | null;
}

/**
 * Accepts `Bearer lgt_<8 hex>.<base64url secret>`. The scheme match is
 * case-insensitive per RFC 7235. Returns null, never throws, for any other shape.
 */
export function parseToken(header: string | undefined): { keyId: string; secret: string } | null {
  if (header === undefined) return null;
  const m = /^Bearer\s+lgt_([0-9a-fA-F]{8})\.([A-Za-z0-9_-]+)$/i.exec(header);
  if (m === null) return null;
  return { keyId: m[1]!, secret: m[2]! };
}

/**
 * Resolves a Bearer token to a member, or null (=> 401). Compares
 * `hashSecret(secret)` against the stored hash with `crypto.timingSafeEqual`
 * over two equal-length hex digests; a stored hash of the wrong length resolves
 * to null rather than throwing, because timingSafeEqual throws on a length
 * mismatch and that would turn a bad credential into a 500.
 */
export function resolveMember(
  store: MemberLookup,
  header: string | undefined,
): { member: string; keyId: string; scopes: string[] } | null {
  const token = parseToken(header);
  if (token === null) return null;
  const row = store.memberByKeyId(token.keyId);
  if (row === null || row.revokedAt !== null) return null;
  const candidate = Buffer.from(hashSecret(token.secret), "hex");
  const stored = Buffer.from(row.tokenHash, "hex");
  if (candidate.length !== stored.length) return null;
  return timingSafeEqual(candidate, stored)
    ? { member: row.member, keyId: token.keyId, scopes: row.scopes }
    : null;
}
