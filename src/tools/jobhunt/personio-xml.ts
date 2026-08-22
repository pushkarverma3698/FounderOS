/**
 * FounderOS — reading a Personio board's XML feed
 * ================================================
 * Personio is the first free-lane platform whose complete feed is XML, and the
 * only one where the choice was forced rather than preferred.
 *
 * WHY NOT `search.json`. It answers 200 with the whole board and looks like the
 * obvious source. Measured live on 2026-08-22 against `1komma5grad` (318
 * postings): every `description` is the empty string, and there is no date field
 * and no URL field at all. A posting with no date is of unknown age, which the
 * freshness filter must treat as unusable — so `search.json` can tell us a job
 * exists and nothing the gates actually read.
 *
 * `/xml` carries `createdAt`, the full body, `seniority` and `yearsOfExperience`.
 * It costs 2.26 MB per board, which is affordable only because the feed
 * revalidates — see free-ats-cache.ts.
 *
 * WHY NO XML PARSER DEPENDENCY. This feed is one flat, regular shape:
 * `<workzag-jobs>` containing `<position>` elements of scalar children plus one
 * `<jobDescriptions>` subtree. A general parser would add a runtime dependency
 * (the repo already carries open findings for three unused ones) and an XXE
 * surface, to read a document we can describe exactly. Everything here is pure
 * and total: a malformed feed yields fewer positions, never a throw, because one
 * bad board must not cost the other 77 their sweep.
 */

/** One posting, exactly as the feed states it — no interpretation yet. */
export interface PersonioPosition {
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
  /** Every description section, joined — still HTML, decoded by the caller. */
  readonly body: string;
}

/**
 * Text of the first `<tag>` in `scope`.
 *
 * Correct only because callers hand it a scope with the nested containers already
 * removed. Relying on "the position's own comes first" instead would be relying
 * on Personio's element ORDER: `<additionalOffices>` sits between `<office>` and
 * `<department>` today, so a reordering would silently retitle a Hamburg role as
 * Remote — a wrong value, which is worse than a missing one.
 */
function tagText(scope: string, tag: string): string {
  const match = scope.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeXml(match[1] ?? "") : "";
}

/**
 * Unwrap CDATA, then resolve the predefined entities.
 *
 * NOT a strict XML reader, and the difference is deliberate. Strictly, CDATA
 * content is literal, so `&amp;` inside one should stay four characters. Here it
 * is unwrapped first and then decoded with everything else, so it becomes `&`.
 * That is benign for the one thing this feeds: the body goes on to decodeJobBody,
 * which performs the same decode anyway. Stated plainly rather than claimed
 * otherwise, because a comment promising strictness the code does not implement
 * is how the next reader gets surprised.
 *
 * `&amp;` decodes last for the reason it does in decodeJobBody — otherwise
 * `&amp;lt;` decodes twice and becomes a real tag.
 */
export function unescapeXml(raw: string): string {
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

/**
 * Every `<position>` in a Personio feed.
 *
 * THE TRAP THIS FUNCTION EXISTS TO AVOID. `<name>` is both the job title and the
 * heading of every description section, and the section headings come first in
 * document order for some boards. A single regex over the position block
 * therefore has a real chance of titling the row "Your responsibilities". So the
 * `<jobDescriptions>` subtree is CUT OUT of the block before any scalar is read:
 * afterwards `<name>` is unambiguous because there is only one left.
 */
export function parsePersonioPositions(xml: string): PersonioPosition[] {
  if (typeof xml !== "string" || xml.length === 0) return [];

  const positions: PersonioPosition[] = [];
  const blocks = xml.matchAll(/<position>([\s\S]*?)<\/position>/g);

  for (const block of blocks) {
    const raw = block[1] ?? "";

    const descriptions = raw.match(/<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/);
    // The scalar scope: the block with every nested container removed, so a
    // scalar lookup cannot reach into one. Both subtrees repeat tag names the
    // position itself uses — `<name>` in jobDescriptions, `<office>` in
    // additionalOffices — and order is Personio's to change, not ours to trust.
    const scalars = (descriptions ? raw.replace(descriptions[0], "") : raw).replace(
      /<additionalOffices>[\s\S]*?<\/additionalOffices>/,
      "",
    );

    const id = tagText(scalars, "id");
    // A position with no id cannot be deduplicated or linked to its posting URL,
    // and a row we cannot link is a row the founder cannot act on.
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

/**
 * Flatten the description sections into one body.
 *
 * Section headings are KEPT, not discarded. Personio splits an ad into named
 * sections and the heading is often the only thing marking where requirements
 * begin — dropping "Your profile" runs the responsibilities straight into the
 * qualifications, and the years bar and language requirement the gates read live
 * in the second half.
 */
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
