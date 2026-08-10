import { describe, expect, test } from "bun:test";
import {
  extractChannelIdsFromText,
  isShortByText,
  parseChannelInput,
} from "../src/youtube-parsers.js";
import { parseEntries } from "../src/rss-parser.js";

const channelId = `UC${"a".repeat(22)}`;
const videoId = "dQw4w9WgXcQ";

describe("YouTube pure parsers", () => {
  test("classifies channel IDs, handles, video URLs, and free-text queries", () => {
    expect(parseChannelInput(`  ${channelId} `)).toEqual({ type: "id", channelId });
    expect(parseChannelInput("https://www.youtube.com/@creator.name")).toEqual({
      type: "handle",
      handle: "creator.name",
    });
    expect(parseChannelInput("https://youtube.com/user/legacy_creator")).toEqual({
      type: "handle",
      handle: "legacy_creator",
    });
    expect(parseChannelInput(`https://youtu.be/${videoId}?t=42`)).toEqual({
      type: "video",
      videoUrl: `https://youtu.be/${videoId}?t=42`,
    });
    expect(parseChannelInput("photographie animalière")).toEqual({
      type: "query",
      query: "photographie animalière",
    });
  });

  test("extracts unique channel IDs and preserves handle order", () => {
    const secondChannelId = `UC${"b".repeat(22)}`;
    const input = [
      `https://youtube.com/channel/${channelId}`,
      `https://youtube.com/@first_creator`,
      `https://youtube.com/user/legacy_creator`,
      `duplicate ${channelId}`,
      `bare ${secondChannelId}`,
      `https://youtube.com/c/custom.creator`,
    ].join("\n");

    expect(extractChannelIdsFromText(input)).toEqual({
      channelIds: [channelId, secondChannelId],
      handles: ["first_creator", "legacy_creator", "custom.creator"],
    });
  });

  test("detects Shorts markers without rejecting ordinary long-form videos", () => {
    expect(isShortByText("Une vidéo #shorts", "")).toBe(true);
    expect(isShortByText("My Shorts video", "youtube shorts")).toBe(true);
    expect(isShortByText("Cours complet de JavaScript", "Une conférence de 45 minutes")).toBe(false);
  });
});

describe("YouTube RSS parser", () => {
  test("parses entries, decodes entities, limits descriptions, and skips incomplete entries", () => {
    const longDescription = "x".repeat(2_100);
    const xml = `
      <feed>
        <entry>
          <yt:videoId>${videoId}</yt:videoId>
          <title>Découvrir &amp; tester</title>
          <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}" />
          <published>2026-08-10T10:00:00+00:00</published>
          <media:description>Une ligne &lt;utile&gt;\navec détails</media:description>
          <media:thumbnail url="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg" />
          <media:statistics views="12345" />
        </entry>
        <entry>
          <yt:videoId>secondVideo</yt:videoId>
          <title>Sans lien</title>
          <published>2026-08-09T10:00:00+00:00</published>
          <media:description>${longDescription}</media:description>
        </entry>
        <entry><title>Entrée sans identifiant vidéo</title></entry>
      </feed>`;

    expect(parseEntries(xml)).toEqual([
      {
        videoId,
        titre: "Découvrir & tester",
        url: `https://www.youtube.com/watch?v=${videoId}`,
        date_pub: "2026-08-10T10:00:00+00:00",
        description: "Une ligne <utile> avec détails",
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        vues: 12345,
        duration: 0,
      },
      {
        videoId: "secondVideo",
        titre: "Sans lien",
        url: "https://www.youtube.com/watch?v=secondVideo",
        date_pub: "2026-08-09T10:00:00+00:00",
        description: longDescription.slice(0, 2000),
        thumbnail: "",
        vues: 0,
        duration: 0,
      },
    ]);
  });

  test("returns an empty list for malformed or empty feeds", () => {
    expect(parseEntries("")).toEqual([]);
    expect(parseEntries("<feed><entry><yt:videoId>unfinished")).toEqual([]);
  });
});
