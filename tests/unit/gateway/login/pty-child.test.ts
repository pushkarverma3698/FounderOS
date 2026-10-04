import { describe, expect, it } from "vitest";
import { extractHyperlink, ptyCommand, spawnPty, stripAnsi } from "../../../../src/gateway/login/pty-child.js";
import { ESC, osc8 } from "./fake-pty.js";

describe("pty helpers", () => {
  it("stripAnsi removes colours, cursor moves and hyperlinks", () => {
    expect(stripAnsi(`${ESC}[1mhello${ESC}[0m ${osc8("https://x.test/a", "link")}\r\n${ESC}[2K${ESC}[1Aok`)).toBe("hello link\nok");
  });

  it("extractHyperlink returns the full URL from the OSC target, not the wrapped visible text", () => {
    const raw = `${ESC}[2Jnoise ${osc8("https://accounts.google.com/o/oauth2/auth?client_id=1&state=2", "https://accounts.google.com/o/oauth2/au")}`;
    expect(extractHyperlink(raw, /^https:\/\/accounts\.google\.com\//)).toBe("https://accounts.google.com/o/oauth2/auth?client_id=1&state=2");
  });

  it("extractHyperlink ignores other hosts and returns null when there is none", () => {
    expect(extractHyperlink(osc8("https://evil.test/x"), /^https:\/\/claude\.com\//)).toBeNull();
    expect(extractHyperlink("plain text", /./)).toBeNull();
  });

  it("ptyCommand quotes argv and sets the window size", () => {
    const [cmd, args] = ptyCommand(["env", "HOME=/a b", "agy"]);
    expect(cmd).toBe("script");
    expect(args).toEqual(["-qfec", "stty -echo cols 500 rows 50; exec 'env' 'HOME=/a b' 'agy'", "/dev/null"]);
  });

  it("a quote in an argument cannot break out", () => {
    expect(ptyCommand(["a'; rm x; '"])[1][1]).toBe("stty -echo cols 500 rows 50; exec 'a'\\''; rm x; '\\'''");
  });

  it.skipIf(process.platform !== "linux")("spawnPty: a real child under script reads stdin, waitFor sees output, kill ends it", async () => {
    const child = spawnPty(["sh", "-c", "echo ready; read x; echo got-$x; sleep 30"], { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/tmp", TERM: "dumb" });
    await child.waitFor((raw) => (raw.includes("ready") ? true : null), 5_000);
    child.write("hello\n");
    const seen = await child.waitFor((raw) => (stripAnsi(raw).includes("got-hello") ? true : null), 5_000);
    expect(seen).toBe(true);
    child.kill();
    expect(await child.waitFor(() => null, 5_000)).toBeNull(); // returns once the child exits
    expect(child.exited).toBe(true);
  });
});
