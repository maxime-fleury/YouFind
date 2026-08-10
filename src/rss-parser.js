// Pure YouTube RSS parser.
// This module intentionally has no network or database dependencies.

function extractBetween(xml, startTag, endTag) {
  const start = xml.indexOf(startTag);
  if (start === -1) return "";
  const from = start + startTag.length;
  const end = xml.indexOf(endTag, from);
  if (end === -1) return xml.substring(from);
  return xml.substring(from, end);
}

function extractAttr(xml, tag, attr) {
  const tagStart = xml.indexOf(`<${tag}`);
  if (tagStart === -1) return "";
  const tagEnd = xml.indexOf(">", tagStart);
  const tagContent = xml.substring(tagStart, tagEnd + 1);
  const attrStart = tagContent.indexOf(`${attr}="`);
  if (attrStart === -1) return "";
  const valueStart = attrStart + attr.length + 2;
  const valueEnd = tagContent.indexOf('"', valueStart);
  return tagContent.substring(valueStart, valueEnd);
}

export function parseEntries(xml) {
  const entries = [];
  let pos = 0;

  while (true) {
    const entryStart = xml.indexOf("<entry>", pos);
    if (entryStart === -1) break;
    const entryEnd = xml.indexOf("</entry>", entryStart);
    if (entryEnd === -1) break;

    const entry = xml.substring(entryStart, entryEnd + 8);
    pos = entryEnd + 8;

    const videoId = extractBetween(entry, "<yt:videoId>", "</yt:videoId>");
    if (!videoId) continue;

    const title = extractBetween(entry, "<title>", "</title>")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');

    const link = extractBetween(entry, '<link rel="alternate" href="', '"');
    const published = extractBetween(entry, "<published>", "</published>");
    const description = extractBetween(entry, "<media:description>", "</media:description>")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n/g, " ")
      .trim();

    const thumbnail = extractAttr(entry, "media:thumbnail", "url");
    const viewsStr = extractBetween(entry, '<media:statistics views="', '"');
    const views = parseInt(viewsStr) || 0;

    entries.push({
      videoId,
      titre: title,
      url: link || `https://www.youtube.com/watch?v=${videoId}`,
      date_pub: published,
      description: description.substring(0, 2000),
      thumbnail,
      vues: views,
      duration: 0,
    });
  }

  return entries;
}
