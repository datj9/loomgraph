import { describe, expect, it } from "vitest";
import { parseToken, resolveMember, type MemberLookup } from "./auth.js";
import { HubStore, hashSecret, type HubStoreDeps } from "./storage.js";

const FROZEN = "2026-08-25T00:00:00.000Z";
const frozenClock: HubStoreDeps = { now: () => FROZEN };

function openStore(): HubStore {
  return HubStore.open(":memory:", frozenClock);
}

const VALID_TOKEN = "Bearer lgt_01234567.FAKEfake0000FAKEfake0000FAKEfake";

function stubWith(
  tokenHash: string,
  o?: { revokedAt?: string | null; scopes?: string[] },
): MemberLookup {
  const rev = o?.revokedAt === undefined ? null : o.revokedAt;
  const scopes = o?.scopes === undefined ? ["read"] : o.scopes;
  return {
    memberByKeyId() {
      return { member: "alice", tokenHash, scopes, revokedAt: rev };
    },
  };
}

describe("parseToken", () => {
  it("parses a well-formed Bearer token into keyId and secret", () => {
    const t = parseToken(VALID_TOKEN);
    expect(t).toEqual({ keyId: "01234567", secret: "FAKEfake0000FAKEfake0000FAKEfake" });
  });

  it("accepts the Bearer scheme in all three case spellings", () => {
    expect(parseToken(VALID_TOKEN)).not.toBeNull();
    expect(parseToken("bearer" + VALID_TOKEN.slice("Bearer".length))).not.toBeNull();
    expect(parseToken("BEARER" + VALID_TOKEN.slice("Bearer".length))).not.toBeNull();
  });

  it("returns null without throwing for every malformed shape", () => {
    const bad = [
      undefined,
      "",
      "Bearer",
      "Bearer ",
      "Basic x",
      "lgt_01234567.FAKEfake0000FAKEfake0000FAKEfake",
      "Bearer lgt_01234567",
      "Bearer lgt_xyz.FAKEfake0000FAKEfake0000FAKEfake",
      "Bearer lgt_01234567.a.b",
    ];
    for (const h of bad) {
      expect(() => parseToken(h)).not.toThrow();
      expect(parseToken(h)).toBeNull();
    }
  });
});

describe("resolveMember", () => {
  it("resolves a valid token whose secret hashes to the stored tokenHash", () => {
    const secret = "FAKEfake0000FAKEfake0000FAKEfake";
    const stub = stubWith(hashSecret(secret), { scopes: ["ingest", "read"] });
    expect(resolveMember(stub, `Bearer lgt_01234567.${secret}`)).toEqual({
      member: "alice",
      keyId: "01234567",
      scopes: ["ingest", "read"],
    });
  });

  it("resolves an unknown keyId to null", () => {
    const stub: MemberLookup = { memberByKeyId: () => null };
    expect(resolveMember(stub, VALID_TOKEN)).toBeNull();
  });

  it("resolves a correct keyId with the wrong secret to null", () => {
    const stub = stubWith(hashSecret("a-different-secret"));
    expect(resolveMember(stub, VALID_TOKEN)).toBeNull();
  });

  it("resolves a valid keyId whose stored secret is only 3 characters to null, without throwing", () => {
    const stub = stubWith(hashSecret("a-much-longer-stored-secret"));
    expect(() => resolveMember(stub, "Bearer lgt_01234567.abc")).not.toThrow();
    expect(resolveMember(stub, "Bearer lgt_01234567.abc")).toBeNull();
  });

  it("resolves a stored tokenHash of the wrong length to null, without throwing", () => {
    const stub = stubWith("deadbeef");
    expect(() => resolveMember(stub, VALID_TOKEN)).not.toThrow();
    expect(resolveMember(stub, VALID_TOKEN)).toBeNull();
  });

  it("resolves a revoked member to null even with the correct secret", () => {
    const secret = "FAKEfake0000FAKEfake0000FAKEfake";
    const stub = stubWith(hashSecret(secret), { revokedAt: "2026-08-25T00:00:00.000Z" });
    expect(resolveMember(stub, `Bearer lgt_01234567.${secret}`)).toBeNull();
  });

  it("returns the stored scopes array unchanged", () => {
    const secret = "FAKEfake0000FAKEfake0000FAKEfake";
    const stub = stubWith(hashSecret(secret), { scopes: ["a", "b", "c"] });
    expect(resolveMember(stub, `Bearer lgt_01234567.${secret}`)?.scopes).toEqual(["a", "b", "c"]);
  });

  it("resolves malformed headers to null without throwing", () => {
    const stub = stubWith(hashSecret("whatever"));
    const bad = [undefined, "", "Bearer", "Basic x", "Bearer lgt_01234567"];
    for (const h of bad) {
      expect(() => resolveMember(stub, h)).not.toThrow();
      expect(resolveMember(stub, h)).toBeNull();
    }
  });
});

describe("resolveMember against a real HubStore", () => {
  it("resolves a token minted by HubStore.addMember end to end", () => {
    const store = openStore();
    const { keyId, token } = store.addMember("alice", ["ingest", "read"]);
    expect(resolveMember(store, `Bearer ${token}`)).toEqual({
      member: "alice",
      keyId,
      scopes: ["ingest", "read"],
    });
  });

  it("observes a revocation minted through the real store", () => {
    const store = openStore();
    const { keyId, token } = store.addMember("alice", ["ingest", "read"]);
    expect(store.revokeMember(keyId)).toBe(true);
    expect(resolveMember(store, `Bearer ${token}`)).toBeNull();
  });
});
