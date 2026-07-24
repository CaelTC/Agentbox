import { describe, expect, it } from "vitest";
import {
  BLOCKED_CIDRS,
  egressPolicyRules,
  isPrivateAddress,
} from "../src/core/egress";

const flat = (rules: string[][]) => rules.map((r) => r.join(" "));

describe("BLOCKED_CIDRS", () => {
  it("covers every RFC-1918 range, link-local, and CGNAT/mesh-VPN (100.64/10)", () => {
    expect(BLOCKED_CIDRS).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
      "100.64.0.0/10",
    ]);
  });
});

describe("egressPolicyRules", () => {
  const rules = egressPolicyRules({ gatewayIp: "192.168.5.1" });
  const lines = flat(rules);

  it("drops egress to each blocked private/reserved range", () => {
    for (const cidr of BLOCKED_CIDRS) {
      expect(lines.some((l) => l.includes(cidr) && /DROP|REJECT/.test(l))).toBe(true);
    }
  });

  it("explicitly blocks the host gateway", () => {
    expect(lines.some((l) => l.includes("192.168.5.1") && /DROP|REJECT/.test(l))).toBe(true);
  });

  it("is fail-closed: the FIRST rule sets the OUTPUT policy to DROP, before any ACCEPT", () => {
    expect(lines[0]).toBe("-P OUTPUT DROP");
    const firstAccept = lines.findIndex((l) => /ACCEPT/.test(l));
    const defaultDrop = lines.indexOf("-P OUTPUT DROP");
    expect(defaultDrop).toBe(0);
    expect(defaultDrop).toBeLessThan(firstAccept);
  });

  it("blocks CGNAT / mesh-VPN space (100.64.0.0/10 — a non-RFC-1918 path to company systems)", () => {
    expect(lines.some((l) => l.includes("100.64.0.0/10") && /DROP|REJECT/.test(l))).toBe(true);
  });

  it("allows loopback so the container's embedded DNS resolver keeps working", () => {
    expect(lines).toContain("-A OUTPUT -o lo -j ACCEPT");
  });

  it("allows established/related return traffic", () => {
    expect(lines.some((l) => l.includes("ESTABLISHED"))).toBe(true);
  });

  it("still permits the public internet (a default-accept for everything else)", () => {
    expect(lines.some((l) => /-A OUTPUT -j ACCEPT$/.test(l))).toBe(true);
  });

  it("orders loopback/established ACCEPTs before the private-range DROPs", () => {
    // The default-policy DROP (-P) is separate from the appended drop RULES (-A).
    const firstDrop = lines.findIndex((l) => /^-A .*(DROP|REJECT)/.test(l));
    const loopback = lines.indexOf("-A OUTPUT -o lo -j ACCEPT");
    expect(loopback).toBeGreaterThanOrEqual(0);
    expect(loopback).toBeLessThan(firstDrop);
  });

  it("never ACCEPTs a private range (which would defeat the policy)", () => {
    for (const cidr of BLOCKED_CIDRS) {
      expect(lines.some((l) => l.includes(cidr) && /ACCEPT/.test(l))).toBe(false);
    }
  });

  it("puts the final default-accept AFTER all the drops", () => {
    const lastDrop = lines.map((l) => /DROP|REJECT/.test(l)).lastIndexOf(true);
    const defaultAccept = lines.findIndex((l) => /-A OUTPUT -j ACCEPT$/.test(l));
    expect(defaultAccept).toBeGreaterThan(lastDrop);
  });
});

describe("egressPolicyRules DNS allowance (Colima)", () => {
  // On Colima the resolver IS the gateway and sits in a blocked private range.
  const rules = egressPolicyRules({
    gatewayIp: "192.168.5.1",
    dnsServers: ["192.168.5.1"],
  });
  const lines = flat(rules);

  it("allows port 53 (udp+tcp) to the configured resolver", () => {
    expect(lines).toContain("-A OUTPUT -d 192.168.5.1 -p udp --dport 53 -j ACCEPT");
    expect(lines).toContain("-A OUTPUT -d 192.168.5.1 -p tcp --dport 53 -j ACCEPT");
  });

  it("permits ONLY port 53 to the resolver — never a blanket ACCEPT", () => {
    expect(lines).not.toContain("-A OUTPUT -d 192.168.5.1 -j ACCEPT");
  });

  it("allows DNS BEFORE the gateway/private-range drops (first match wins)", () => {
    const dnsAllow = lines.findIndex((l) => l.includes("--dport 53"));
    const firstDrop = lines.findIndex((l) => /^-A .*(DROP|REJECT)/.test(l));
    expect(dnsAllow).toBeGreaterThanOrEqual(0);
    expect(dnsAllow).toBeLessThan(firstDrop);
  });

  it("still DROPs all non-DNS traffic to the resolver/gateway", () => {
    expect(lines).toContain("-A OUTPUT -d 192.168.5.1 -j DROP");
  });

  it("adds no DNS rules when no resolvers are given (Docker Desktop path)", () => {
    const noDns = flat(egressPolicyRules({ gatewayIp: "192.168.5.1" }));
    expect(noDns.some((l) => l.includes("--dport 53"))).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("recognises addresses inside the blocked ranges", () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.9")).toBe(true);
    expect(isPrivateAddress("172.31.255.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.10.10")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true); // CGNAT / Tailscale
    expect(isPrivateAddress("100.127.255.254")).toBe(true); // top of 100.64/10
  });

  it("treats public addresses as not private", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
    expect(isPrivateAddress("100.63.255.255")).toBe(false); // just below 100.64/10
    expect(isPrivateAddress("100.128.0.0")).toBe(false); // just above 100.64/10
  });
});
