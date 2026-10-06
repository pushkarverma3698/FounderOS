import { describe, expect, it } from "vitest";
import { probePeerFor } from "../../../scripts/lib/probe-peer.js";

describe("probePeerFor", () => {
  it("defaults to the bot's own chat when no test chat is configured", () => {
    expect(probePeerFor("Raggae3698_bot", {})).toBe("Raggae3698_bot");
    expect(probePeerFor("Raggae3698_bot", { TELEGRAM_TEST_CHAT_ID: "  " })).toBe("Raggae3698_bot");
  });

  it("uses the test chat when TELEGRAM_TEST_CHAT_ID is set, as a number for a group id", () => {
    expect(probePeerFor("Raggae3698_bot", { TELEGRAM_TEST_CHAT_ID: "-100123456" })).toBe(-100123456);
  });

  it("keeps a @username test chat as text", () => {
    expect(probePeerFor("Raggae3698_bot", { TELEGRAM_TEST_CHAT_ID: "@my_test_room" })).toBe("@my_test_room");
  });

  it("refuses the founder's real chats as a test chat", () => {
    const real = { TELEGRAM_CHAT_ID: "42", TELEGRAM_TEST_CHAT_ID: "42" };
    expect(() => probePeerFor("Raggae3698_bot", real)).toThrow(/TELEGRAM_CHAT_ID/);
    const jobs = { JOBHUNT_CHAT_ID: "-5319642142", TELEGRAM_TEST_CHAT_ID: "-5319642142" };
    expect(() => probePeerFor("Raggae3698_bot", jobs)).toThrow(/JOBHUNT_CHAT_ID/);
  });
});
