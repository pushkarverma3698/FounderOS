import { describe, expect, it } from "vitest";
import { addedMailboxDir, isAddedMailbox, listGoogleMailboxes, mailboxNameProblem, type MailboxFs } from "../../../src/infra/google-mailboxes.js";

function fakeFs(dirs: string[], signedIn: string[]): MailboxFs {
  return {
    home: () => "/h",
    listDirs: (p) => (p === "/h/.founderos/accounts" ? dirs : []),
    exists: (p) => signedIn.some((n) => p === `/h/.founderos/accounts/${n}/gws/credentials.json`),
  };
}

describe("google mailboxes", () => {
  it("lists personal first, then every other signed-in account (turicks and naggar included), alphabetical", () => {
    const fs = fakeFs(["turicks", "wife", "oplify", "half-done", "Bad Name"], ["turicks", "wife", "oplify", "Bad Name"]);
    expect(listGoogleMailboxes(fs)).toEqual(["personal", "oplify", "turicks", "wife"]);
  });

  it("personal is always listed, even with no folder at all; turicks and naggar are not", () => {
    expect(listGoogleMailboxes(fakeFs([], []))).toEqual(["personal"]);
  });

  it("an added name resolves to its own folder; a built-in or unknown one does not", () => {
    const fs = fakeFs(["wife"], ["wife"]);
    expect(addedMailboxDir("wife", fs)).toEqual({ dir: "/h/.founderos/accounts/wife/gws" });
    expect(isAddedMailbox("personal", fs)).toBe(false);
    const unknown = addedMailboxDir("wfe", fs);
    expect("error" in unknown && unknown.error).toContain("Known: personal, wife");
  });

  it("refuses names that are not a plain slug or are command words", () => {
    expect(mailboxNameProblem("wife")).toBeUndefined();
    expect(mailboxNameProblem("oplify-2")).toBeUndefined();
    for (const bad of ["a", "../etc", "Wife", "1abc", "x".repeat(21), "all", "add", "remove"]) {
      expect(mailboxNameProblem(bad), bad).toBeDefined();
    }
  });
});
