import { describe, expect, it } from "vitest";
import { refuseBind } from "./server.js";

describe("refuseBind", () => {
  const ALLOWED = [
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.254",
    "localhost",
    "::1",
    "[::1]",
  ] as const;

  const REFUSED = [
    "0.0.0.0",
    "::",
    "[::]",
    "10.0.0.5",
    "192.168.1.4",
    "172.16.0.1",
    "8.8.8.8",
    "",
  ] as const;

  it("allows every loopback host with behindTlsProxy false", () => {
    for (const host of ALLOWED) {
      expect(refuseBind(host, false), host).toBeNull();
    }
  });

  it("refuses every non-loopback host with behindTlsProxy false", () => {
    for (const host of REFUSED) {
      expect(refuseBind(host, false), host).not.toBeNull();
    }
  });

  it("allows every refused host when behindTlsProxy is true", () => {
    for (const host of REFUSED) {
      expect(refuseBind(host, true), host).toBeNull();
    }
  });

  it("the refusal message names the host and the override flag", () => {
    for (const host of REFUSED) {
      const message = refuseBind(host, false);
      expect(message, host).not.toBeNull();
      expect(message, host).toContain(host);
      expect(message, host).toContain("--behind-tls-proxy");
    }
  });
});
