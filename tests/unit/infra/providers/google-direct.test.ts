/**
 * googleapis (service-account) provider adapter — drop-in for gws.
 * Verifies the ToolResult mappings match the gws contract and that an
 * unconfigured account fails loud with the exact env var to set (rule #22).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
const listMock = vi.fn();
const getMock = vi.fn();
const insertMock = vi.fn();
const authorizeMock = vi.fn();
const getGoogleAccountMock = vi.fn();

vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() =>
      JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "KEY" }),
    ),
  };
});

vi.mock("google-auth-library", () => ({
  JWT: vi.fn().mockImplementation(() => ({ authorize: authorizeMock })),
}));

vi.mock("@googleapis/gmail", () => ({
  gmail: () => ({ users: { messages: { send: sendMock, list: listMock, get: getMock } } }),
}));

vi.mock("@googleapis/calendar", () => ({
  calendar: () => ({ events: { insert: insertMock } }),
}));

vi.mock("../../../../src/infra/account-registry.js", () => ({
  getGoogleAccount: (...args: unknown[]) => getGoogleAccountMock(...args),
}));

import {
  directSendEmail,
  directReadEmails,
  directCreateCalendarEvent,
} from "../../../../src/infra/providers/google-direct.js";

const CONFIGURED = {
  ctx: { account_key: "turicks" },
  credentials: {
    service_account_path: "/fake/sa.json",
    impersonate_subject: "hello@turicks.com",
    gws_profile_dir: "/x",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizeMock.mockResolvedValue(undefined);
  getGoogleAccountMock.mockResolvedValue(CONFIGURED);
});

describe("googleapis adapter — send", () => {
  it("maps a sent message to { message_id, to, subject }", async () => {
    sendMock.mockResolvedValue({ data: { id: "msg-123" } });
    const r = await directSendEmail({ to: "a@b.com", subject: "Hi", body: "Body" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ message_id: "msg-123", to: "a@b.com", subject: "Hi" });
  });

  it("fails loud when the API returns no message id", async () => {
    sendMock.mockResolvedValue({ data: {} });
    const r = await directSendEmail({ to: "a@b.com", subject: "Hi", body: "Body" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("no message id");
  });

  it("maps an API throw to a stage-tagged error", async () => {
    sendMock.mockRejectedValue(new Error("quota exceeded"));
    const r = await directSendEmail({ to: "a@b.com", subject: "Hi", body: "Body" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("googleapis Gmail send failed: quota exceeded");
  });
});

describe("googleapis adapter — read", () => {
  it("formats fetched messages via the shared formatter", async () => {
    listMock.mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    getMock.mockResolvedValue({
      data: {
        id: "m1",
        snippet: "hello world",
        payload: {
          headers: [
            { name: "From", value: "x@y.com" },
            { name: "Subject", value: "Subj" },
            { name: "Date", value: "2026-06-27" },
          ],
        },
      },
    });
    const r = await directReadEmails({ query: "is:unread", max_results: 5 });
    expect(r.success).toBe(true);
    expect(String(r.data)).toContain("x@y.com");
    expect(String(r.data)).toContain("Subj");
  });

  it("returns the empty-inbox message when no results", async () => {
    listMock.mockResolvedValue({ data: { messages: [] } });
    const r = await directReadEmails({ query: "none", max_results: 5 });
    expect(r.success).toBe(true);
    expect(String(r.data)).toContain("No emails found");
  });
});

describe("googleapis adapter — calendar", () => {
  it("maps an inserted event to { event_id, title, date, html_link }", async () => {
    insertMock.mockResolvedValue({ data: { id: "ev-1", htmlLink: "http://cal/ev-1" } });
    const r = await directCreateCalendarEvent({
      title: "Mtg",
      start_datetime: "2026-06-27T10:00:00",
      end_datetime: "2026-06-27T11:00:00",
      timezone: "UTC",
    });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({
      event_id: "ev-1",
      title: "Mtg",
      date: "2026-06-27T10:00:00",
      html_link: "http://cal/ev-1",
    });
  });
});

describe("googleapis adapter — unconfigured fails loud (rule #22)", () => {
  it("names GOOGLE_APPLICATION_CREDENTIALS when the SA path is unset", async () => {
    getGoogleAccountMock.mockResolvedValue({
      ctx: { account_key: "turicks" },
      credentials: { gws_profile_dir: "/x" },
    });
    const r = await directSendEmail({ to: "a@b.com", subject: "Hi", body: "Body" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("names the per-account subject var when the subject is unset", async () => {
    getGoogleAccountMock.mockResolvedValue({
      ctx: { account_key: "naggar" },
      credentials: { service_account_path: "/fake/sa.json", gws_profile_dir: "/x" },
    });
    const r = await directSendEmail({ to: "a@b.com", subject: "Hi", body: "Body", account_key: "naggar" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("GOOGLE_SUBJECT_NAGGAR");
  });
});
