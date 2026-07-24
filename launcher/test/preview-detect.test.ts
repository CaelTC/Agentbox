import { describe, expect, it } from "vitest";
import { parseListeningPorts } from "../src/main/preview";
import { detectServedPort } from "../src/core/preview";

describe("parseListeningPorts", () => {
  it("extracts ports from `ss -tlnH` output", () => {
    const ss = [
      "LISTEN 0 128 0.0.0.0:5173 0.0.0.0:* ",
      "LISTEN 0 128 [::]:8080 [::]:* ",
    ].join("\n");
    expect(parseListeningPorts(ss).sort((a, b) => a - b)).toEqual([5173, 8080]);
  });

  it("extracts ports from `netstat` output", () => {
    const netstat = "tcp 0 0 127.0.0.1:3000 0.0.0.0:* LISTEN 1/node ";
    expect(parseListeningPorts(netstat)).toContain(3000);
  });

  it("feeds cleanly into detectServedPort", () => {
    const ports = parseListeningPorts("LISTEN 0 128 0.0.0.0:5173 0.0.0.0:* ");
    expect(detectServedPort(ports)).toBe(5173);
  });

  it("returns nothing when nothing is listening", () => {
    expect(parseListeningPorts("")).toEqual([]);
  });
});
