import { describe, expect, it } from "vitest";
import {
  BLOCKED_CIDRS,
  egressPolicyRules,
  isPrivateAddress,
} from "../src/core/egress";

const flat = (rules: string[][]) => rules.map((r) => r.join(" "));

describe("BLOCKED_CIDRS", () => {
  it("covers every RFC-1918 range plus link-local (ticket 02 AC)", () => {
    expect(BLOCKED_CIDRS).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
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
    const firstDrop = lines.findIndex((l) => /DROP|REJECT/.test(l));
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

describe("isPrivateAddress", () => {
  it("recognises addresses inside the blocked ranges", () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.9")).toBe(true);
    expect(isPrivateAddress("172.31.255.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.10.10")).toBe(true);
  });

  it("treats public addresses as not private", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
  });
});
