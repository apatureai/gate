import { describe, expect, it } from "vitest";
import { scrubTail, scrubText } from "../src/index.js";

describe("scrubText (#78)", () => {
  it("masks a PEM private-key block", () => {
    const out = scrubText("-----BEGIN RSA PRIVATE KEY-----\nMIIBderp+secret\n-----END RSA PRIVATE KEY-----");
    expect(out).toBe("[REDACTED private-key]");
  });

  it("masks JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(scrubText(`token=${jwt}`)).toContain("[REDACTED");
    expect(scrubText(`here is ${jwt} ok`)).not.toContain(jwt);
  });

  it("masks provider tokens (GitHub, Slack, Google, sk-, AWS key id)", () => {
    expect(scrubText("ghp_" + "a".repeat(36))).toBe("[REDACTED github-token]");
    expect(scrubText("xoxb-123456789012-abcdef")).toBe("[REDACTED slack-token]");
    expect(scrubText("AIza" + "b".repeat(35))).toBe("[REDACTED google-api-key]");
    expect(scrubText("sk-ant-" + "c".repeat(40))).toBe("[REDACTED llm-key]");
    expect(scrubText("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED aws-access-key-id]");
  });

  it("masks Authorization headers and signed-URL query params (keeping the param name)", () => {
    const auth = scrubText("Authorization: Bearer abcdef0123456789ABCDEF");
    expect(auth).toContain("[REDACTED auth-header]");
    expect(auth).not.toContain("abcdef0123456789ABCDEF");
    const url = scrubText("GET https://x.r2.dev/a.png?X-Amz-Signature=deadbeefcafe1234 200");
    expect(url).toContain("X-Amz-Signature=[REDACTED signed-url]");
    expect(url).not.toContain("deadbeefcafe1234");
  });

  it("masks explicit secret assignments but keeps the key name", () => {
    expect(scrubText('API_KEY="s3cr3tValue123"')).toBe('API_KEY="[REDACTED secret]"');
    expect(scrubText("password: hunter2hunter")).toBe("password: [REDACTED secret]");
    expect(scrubText("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY")).toContain("[REDACTED secret]");
  });

  it("leaves ordinary build output untouched (readable for DX)", () => {
    const log = "vite v5 ready in 320ms\n  ➜  Local: http://localhost:3000/\nbuilt 42 modules";
    expect(scrubText(log)).toBe(log);
  });
});

describe("scrubTail (#78)", () => {
  it("scrubs then keeps the last maxLen chars with a truncation marker", () => {
    const tail = scrubTail("x".repeat(5000) + "\nerror at end", 100);
    expect(tail.startsWith("…(truncated)")).toBe(true);
    expect(tail).toContain("error at end");
    expect(tail.length).toBeLessThan(200);
  });

  it("does not truncate short text", () => {
    expect(scrubTail("short")).toBe("short");
  });

  it("scrubs before capping so a secret straddling the cut cannot survive", () => {
    const secret = "ghp_" + "z".repeat(36);
    const tail = scrubTail(`${secret}\n` + "ok line ".repeat(10), 40);
    expect(tail).not.toContain(secret);
  });
});
