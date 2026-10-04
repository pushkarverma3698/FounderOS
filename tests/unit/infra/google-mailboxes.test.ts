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
  it("lists built-ins first, then added accounts that are signed in, alphabetical", () => {
    const fs = fakeFs(["turicks", "wife", "oplify", "half-done", "Bad Name"], ["turicks", "wife", "oplify", "Bad Name"]);
    expect(listGoogleMailboxes(fs)).toEqual(["turicks", "personal", "naggar", "oplify", "wife"]);
  });

  it("built-ins are always listed, even with no folder at all", () => {
    expect(listGoogleMailboxes(fakeFs([], []))).toEqual(["turicks", "personal", "naggar"]);
  });

  it("an added name resolves to its own folder; a built-in or unknown one does not", () => {
    const fs = fakeFs(["wife"], ["wife"]);
    expect(addedMailboxDir("wife", fs)).toEqual({ dir: "/h/.founderos/accounts/wife/gws" });
    expect(isAddedMailbox("personal", fs)).toBe(false);
    const unknown = addedMailboxDir("wfe", fs);
    expect("error" in unknown && unknown.error).toContain("Known: turicks, personal, naggar, wife");
  });

  it("refuses names that are not a plain slug or are command words", () => {
    expect(mailboxNameProblem("wife")).toBeUndefined();
    expect(mailboxNameProblem("oplify-2")).toBeUndefined();
    for (const bad of ["a", "../etc", "Wife", "1abc", "x".repeat(21), "all", "add", "remove"]) {
      expect(mailboxNameProblem(bad), bad).toBeDefined();
    }
  });
});
