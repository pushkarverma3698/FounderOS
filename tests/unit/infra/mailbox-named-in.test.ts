/**
 * J1 (2026-10-08): "Anything important in my work inbox since yesterday?" reached read_emails with
 * account "turicks", a dead grant, because the model picked the account. mailboxNamedIn reads the
 * founder's own words, so the mailbox he names is the one that is read.
 */
import { describe, expect, it } from "vitest";
import { mailboxNamedIn } from "../../../src/infra/google-mailboxes.js";

const BOXES = ["turicks", "personal", "naggar", "work"];

describe("mailboxNamedIn", () => {
  it("maps 'my work inbox' to the work mailbox", () => {
    expect(mailboxNamedIn("Anything important in my work inbox since yesterday?", BOXES)).toBe("work");
  });

  it("reads mail, email, emails, gmail, mailbox and account after the name, any case", () => {
    expect(mailboxNamedIn("check my Personal email", BOXES)).toBe("personal");
    expect(mailboxNamedIn("any naggar mails today", BOXES)).toBe("naggar");
    expect(mailboxNamedIn("search the turicks gmail for invoices", BOXES)).toBe("turicks");
    expect(mailboxNamedIn("unread in my work account?", BOXES)).toBe("work");
    expect(mailboxNamedIn("Work mailbox: anything new?", BOXES)).toBe("work");
  });

  it("names nothing when no mailbox is named next to a mail word", () => {
    expect(mailboxNamedIn("anything important in my inbox?", BOXES)).toBeUndefined();
    expect(mailboxNamedIn("how is work going, check email", BOXES)).toBeUndefined();
    expect(mailboxNamedIn("my wife inbox", BOXES)).toBeUndefined();
  });

  it("names nothing when two different mailboxes are named, so the model's choice stands", () => {
    expect(mailboxNamedIn("compare my work inbox with my personal inbox", BOXES)).toBeUndefined();
  });

  it("the same mailbox named twice is still one", () => {
    expect(mailboxNamedIn("work inbox, then work email again", BOXES)).toBe("work");
  });
});
