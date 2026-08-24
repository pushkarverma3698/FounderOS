import { AtsAdapter, NormalizedJob, parsePostedAt, decodeJobBody } from "./types.js";
import { FreeBoard } from "../free-boards.js";

interface PersonioPosition {
  readonly id: string;
  readonly name: string;
  readonly office: string;
  readonly department: string;
  readonly subcompany: string;
  readonly employmentType: string;
  readonly seniority: string;
  readonly yearsOfExperience: string;
  readonly schedule: string;
  readonly createdAt: string;
  readonly body: string;
}

function tagText(scope: string, tag: string): string {
  const match = scope.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeXml(match[1] ?? "") : "";
}

function unescapeXml(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .trim();
}

function sectionsToBody(subtree: string): string {
  const parts: string[] = [];
  for (const section of subtree.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)) {
    const inner = section[1] ?? "";
    const heading = tagText(inner, "name");
    const value = tagText(inner, "value");
    if (heading.length > 0) parts.push(heading);
    if (value.length > 0) parts.push(value);
  }
  return parts.join("\n\n").trim();
}

function parsePersonioPositions(xml: string): PersonioPosition[] {
  if (typeof xml !== "string" || xml.length === 0) return [];
  const positions: PersonioPosition[] = [];
  const blocks = xml.matchAll(/<position>([\s\S]*?)<\/position>/g);

  for (const block of blocks) {
    const raw = block[1] ?? "";
    const descriptions = raw.match(/<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/);
    const scalars = (descriptions ? raw.replace(descriptions[0], "") : raw).replace(
      /<additionalOffices>[\s\S]*?<\/additionalOffices>/,
      "",
    );
    const id = tagText(scalars, "id");
    if (id.length === 0) continue;

    positions.push({
      id,
      name: tagText(scalars, "name"),
      office: tagText(scalars, "office"),
      department: tagText(scalars, "department"),
      subcompany: tagText(scalars, "subcompany"),
      employmentType: tagText(scalars, "employmentType"),
      seniority: tagText(scalars, "seniority"),
      yearsOfExperience: tagText(scalars, "yearsOfExperience"),
      schedule: tagText(scalars, "schedule"),
      createdAt: tagText(scalars, "createdAt"),
      body: sectionsToBody(descriptions?.[1] ?? ""),
    });
  }
  return positions;
}

export const personioAdapter: AtsAdapter = {
  platformName: "personio",

  getBoardUrl(board: FreeBoard): string {
    const token = encodeURIComponent(board.token);
    return `https://${token}.jobs.personio.com/xml`;
  },

  getWireFormat(): "xml" {
    return "xml";
  },

  listJobs(payload: unknown, board: FreeBoard): NormalizedJob[] {
    if (typeof payload !== "string") return [];
    const token = encodeURIComponent(board.token);

    return parsePersonioPositions(payload).flatMap((position) => {
      if (position.name.length === 0) return [];
      return [
        {
          board,
          externalId: position.id,
          title: position.name,
          url: `https://${token}.jobs.personio.com/job/${encodeURIComponent(position.id)}`,
          location: position.office,
          postedAt: parsePostedAt(position.createdAt),
          description: decodeJobBody(position.body) || null,
        },
      ];
    });
  },

  getJobUrl(_board: FreeBoard, _externalId: string): string | null {
    return null;
  },

  extractBody(_payload: Record<string, unknown>): string {
    return "";
  },

  applyUrlFor(postingUrl: string, _board: FreeBoard): string | null {
    if (typeof postingUrl !== "string" || postingUrl.trim().length === 0) return null;
    return postingUrl.replace(/\/+$/, "");
  },
};
