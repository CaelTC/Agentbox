/**
 * The Egress Policy (CONTEXT.md / ADR 0001, threat B): the whole public
 * internet is reachable, but every private/local range is blocked.
 *
 * This module generates the ordered firewall rule-set as pure data so the
 * policy can be asserted in tests. `box/egress/apply-egress.sh` renders these
 * same rules with the real `iptables` binary inside the Box.
 */

/**
 * RFC-1918 private ranges + link-local, plus 100.64.0.0/10 (carrier-grade NAT,
 * the range Tailscale / mesh VPNs ride — a common path to company systems that
 * is NOT RFC-1918, threat B). The host gateway is blocked separately.
 */
export const BLOCKED_CIDRS: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
];

export interface EgressPolicyOptions {
  /** The host gateway IP (e.g. Colima's), blocked explicitly on top of the CIDRs. */
  gatewayIp?: string;
  /**
   * The container's configured DNS resolver IPs (from /etc/resolv.conf). Under
   * Docker Desktop the resolver is on loopback (127.0.0.11) and needs nothing
   * here, but under Colima it is the gateway (e.g. 192.168.5.1) — inside a
   * blocked private range — so DNS to it must be allowed explicitly (port 53
   * only) or every name lookup is dropped and the Box is offline.
   */
  dnsServers?: readonly string[];
}

/**
 * Ordered OUTPUT chain rules. Each entry is the argument list you would pass to
 * `iptables`. Order is load-bearing: allow loopback + established first, DROP
 * the private ranges next, and only then default-ACCEPT the public internet.
 */
export function egressPolicyRules(options: EgressPolicyOptions = {}): string[][] {
  const rules: string[][] = [];

  // 0. Default-DROP the OUTPUT chain BEFORE building the allow/deny rules, so the
  //    policy is fail-CLOSED: a partial, interrupted, or re-triggered apply denies
  //    egress rather than leaving the chain open (threat B). Load-bearing that this
  //    is first.
  rules.push(["-P", "OUTPUT", "DROP"]);

  // 1. Always allow loopback — under Docker Desktop the embedded DNS resolver
  //    (127.0.0.11) lives here, so DNS resolution keeps working.
  rules.push(["-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"]);

  // 2. Allow return traffic for connections we initiated.
  rules.push([
    "-A", "OUTPUT",
    "-m", "conntrack",
    "--ctstate", "ESTABLISHED,RELATED",
    "-j", "ACCEPT",
  ]);

  // 2b. Allow DNS (port 53) to the configured resolver(s) ONLY. Under Colima the
  //     resolver is the gateway (192.168.5.1), inside a blocked range below, so
  //     without this every lookup is dropped. Port 53 only: this opens no other
  //     access to that host, and the gateway/CIDR DROPs below still block all
  //     non-DNS traffic to it even when the resolver IS the gateway. Must come
  //     BEFORE those drops — first match wins.
  for (const ns of options.dnsServers ?? []) {
    rules.push(["-A", "OUTPUT", "-d", ns, "-p", "udp", "--dport", "53", "-j", "ACCEPT"]);
    rules.push(["-A", "OUTPUT", "-d", ns, "-p", "tcp", "--dport", "53", "-j", "ACCEPT"]);
  }

  // 3. Block the host gateway explicitly (defends against reaching the laptop).
  if (options.gatewayIp) {
    rules.push(["-A", "OUTPUT", "-d", options.gatewayIp, "-j", "DROP"]);
  }

  // 4. Drop egress to every private/reserved range.
  for (const cidr of BLOCKED_CIDRS) {
    rules.push(["-A", "OUTPUT", "-d", cidr, "-j", "DROP"]);
  }

  // 5. Everything else — the public internet — is allowed.
  rules.push(["-A", "OUTPUT", "-j", "ACCEPT"]);

  return rules;
}

/** True if an IPv4 address falls inside any blocked range. */
export function isPrivateAddress(ip: string): boolean {
  const octets = ip.split(".").map((o) => Number(o));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT / mesh VPN)
  return false;
}
