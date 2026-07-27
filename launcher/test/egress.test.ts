import { describe, expect, it } from "vitest";
import {
  BLOCKED_CIDRS,
  egressPolicyRules,
  isPrivateAddress,
} from "../src/core/egress";
import { repoFile } from "./repo-file";

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

describe("the Egress Policy's two copies", () => {
  // core/egress.ts is the tested source of truth for the rule ORDER and the
  // blocked ranges; box/egress/apply-egress.sh renders the same policy with the
  // real iptables binary, because a container's start-up cannot import
  // TypeScript. This is the wall of ADR 0001 (threat B) written twice, so
  // nothing but this test would notice the two drifting apart — and a reordering
  // (a DROP appended after the final default-ACCEPT, the DNS allowance moved
  // below the gateway DROP) silently opens or closes the Box without changing a
  // single value.
  const SCRIPT = repoFile("box", "egress", "apply-egress.sh");

  const GATEWAY = "192.168.5.1";
  const RESOLVER = "192.168.5.53";

  /** The script's own BLOCKED_CIDRS array, in the order it loops over them. */
  function shellCidrs(): string[] {
    const array = SCRIPT.match(/BLOCKED_CIDRS=\(([\s\S]*?)\)/);
    expect(array, "apply-egress.sh no longer declares BLOCKED_CIDRS").not.toBeNull();
    return [...array![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  /** One IPv4 rule line, and its arguments — the only shape `shellRules` reads. */
  const IPTABLES_CALL = /^\s*iptables\s+(.+?)\s*$/;

  /**
   * Lines that DO run a firewall command but sit outside the ordered comparison
   * on purpose: the flush appends no rule, and the v6 backstop has no IPv4
   * counterpart in egress.ts. Each is asserted separately below — this list is
   * what stops "outside the comparison" from meaning "unchecked".
   */
  const OUTSIDE_THE_COMPARISON = /^(iptables -F OUTPUT|if command -v ip6tables .*|ip6tables .*)$/;

  /**
   * Anything that could install a firewall rule, in any spelling — `/sbin/iptables`,
   * `sudo iptables`, `iptables-restore`, `ip6tables`, `nft`. `shellRules` only
   * reads bare `iptables` lines, so without this a rule added through any other
   * spelling would be invisible to the comparison that is the point of this file.
   */
  const FIREWALL_COMMAND = /(^|[\s|;&(])((\/\S*)?ip6?tables(-\S+)?|nft)(\s|$)/;

  /** The script's executable lines (comments run nothing), trimmed. */
  const scriptLines = () =>
    SCRIPT.split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

  /**
   * Every `iptables` rule the script runs, in order, with its loops unrolled:
   * one resolver, one gateway, and the script's own CIDR list. `ip6tables` lines
   * are skipped (the v6 backstop has no IPv4 counterpart in egress.ts) and so is
   * the flush, which appends no rule — both are asserted separately, and the
   * completeness test below is what proves nothing ELSE is skipped silently.
   */
  function shellRules(): string[] {
    const cidrs = shellCidrs();
    const rules: string[] = [];
    for (const line of SCRIPT.split("\n")) {
      const call = line.match(IPTABLES_CALL);
      if (!call) continue;
      const args = call[1].replace(/"/g, "").replace(/\s+/g, " ");
      if (args === "-F OUTPUT") continue;
      if (args.includes("${cidr}")) {
        for (const cidr of cidrs) rules.push(args.replace("${cidr}", cidr));
      } else if (args.includes("${ns}")) {
        rules.push(args.replace("${ns}", RESOLVER));
      } else if (args.includes("${GATEWAY}")) {
        rules.push(args.replace("${GATEWAY}", GATEWAY));
      } else {
        rules.push(args);
      }
    }
    return rules;
  }

  it("apply-egress.sh runs exactly the rules egressPolicyRules() generates, in order", () => {
    expect(shellRules()).toEqual(
      flat(egressPolicyRules({ gatewayIp: GATEWAY, dnsServers: [RESOLVER] })),
    );
  });

  it("blocks the same ranges, in the same order, as BLOCKED_CIDRS", () => {
    expect(shellCidrs()).toEqual([...BLOCKED_CIDRS]);
  });

  it("is fail-closed in the shell too: the default DROP is set BEFORE the flush", () => {
    // Only the script has a flush, so the ordered comparison above cannot see
    // this: `-F` before `-P` would leave the chain wide open mid-apply.
    //
    // Line-anchored, because the script explains itself in prose: a comment
    // mentioning `iptables -P OUTPUT DROP` would otherwise be what this reads,
    // and the real ordering could then be anything at all.
    const policy = SCRIPT.search(/^\s*iptables -P OUTPUT DROP\b/m);
    const flush = SCRIPT.search(/^\s*iptables -F OUTPUT\b/m);
    expect(policy).toBeGreaterThanOrEqual(0);
    expect(flush).toBeGreaterThan(policy);
  });

  it("runs no firewall command the ordered comparison cannot see", () => {
    // The comparison above reads bare `iptables …` lines only. That is a fine
    // extractor and a terrible guarantee on its own: `/sbin/iptables -P OUTPUT
    // ACCEPT`, `sudo iptables -I OUTPUT 1 -j ACCEPT`, an `iptables-restore`, or a
    // switch to `nft` would each open the Box while every test above stayed
    // green. So every firewall line must be accounted for — compared, or on the
    // short list that is asserted separately.
    const unaccounted = scriptLines().filter(
      (line) =>
        FIREWALL_COMMAND.test(line) &&
        !IPTABLES_CALL.test(line) &&
        !OUTSIDE_THE_COMPARISON.test(line),
    );
    expect(unaccounted).toEqual([]);
  });

  it("backstops IPv6 with a deny-all, best-effort, since egress.ts's rules are v4-only", () => {
    // The hard guarantee is the Launcher's `--sysctl disable_ipv6=1`; this is the
    // in-Box backstop for it, and until now nothing in the repo asserted it
    // existed at all. Compared as the WHOLE v6 block, so the allowlist above can
    // safely wave `ip6tables .*` through: a fourth v6 line lands here.
    const v6 = scriptLines()
      .filter((line) => line.startsWith("ip6tables"))
      .map((line) => line.replace(/\s+/g, " "));

    expect(v6).toEqual([
      "ip6tables -P OUTPUT DROP 2>/dev/null || true",
      "ip6tables -F OUTPUT 2>/dev/null || true",
      "ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true",
    ]);
  });

  it("never unrolls a loop that would reorder: many values AND more than one rule", () => {
    // `shellRules` unrolls a loop as A(v1..vn) then B(v1..vn); bash runs A(v1),
    // B(v1), A(v2)… The two coincide only when a loop has ONE value or ONE rule.
    // The CIDR loop has five values and one rule; the resolver loop has two rules
    // and is unrolled with a single resolver. A loop that grew both would make
    // the comparison above assert an order the Box never runs.
    const unrolled: Record<string, number> = { cidr: BLOCKED_CIDRS.length, ns: 1 };
    const loops = [...SCRIPT.matchAll(/^\s*for (\w+) in .*; do\n([\s\S]*?)^\s*done\s*$/gm)];
    expect(loops.length).toBeGreaterThan(0);

    for (const [, variable, body] of loops) {
      const values = unrolled[variable];
      expect(values, `apply-egress.sh now loops over an unknown '${variable}'`).toBeDefined();
      const rules = body.split("\n").filter((line) => IPTABLES_CALL.test(line));
      expect(values === 1 || rules.length <= 1).toBe(true);
    }
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
