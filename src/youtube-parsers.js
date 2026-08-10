// Pure YouTube input parsers.
// Keep this module free of database, DOM, and network dependencies.

export function parseChannelInput(input) {
  const trimmed = input.trim();

  const idMatch = trimmed.match(/\/channel\/(UC[\w-]+)/);
  if (idMatch) return { type: "id", channelId: idMatch[1] };

  const handleMatch = trimmed.match(/youtube\.com\/@([\w.-]+)/);
  if (handleMatch) return { type: "handle", handle: handleMatch[1] };

  const userMatch = trimmed.match(/youtube\.com\/user\/([\w.-]+)/);
  if (userMatch) return { type: "handle", handle: userMatch[1] };

  const customMatch = trimmed.match(/youtube\.com\/c\/([\w.-]+)/);
  if (customMatch) return { type: "handle", handle: customMatch[1] };

  if (/^UC[\w-]{22}$/.test(trimmed)) return { type: "id", channelId: trimmed };

  const videoPatterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
    /youtube\.com\/v\/([\w-]{11})/,
  ];
  for (const pattern of videoPatterns) {
    const match = trimmed.match(pattern);
    if (match) return { type: "video", videoUrl: trimmed };
  }

  const lastSegment = trimmed.split("/").pop()?.split("?")[0];
  if (lastSegment?.length === 11 && /^[\w-]{11}$/.test(lastSegment)) {
    return { type: "video", videoUrl: trimmed };
  }

  return { type: "query", query: trimmed };
}

export function isShortByText(title = "", description = "") {
  const text = `${title} ${description}`.toLowerCase();
  return /#shorts?\b|#short\b|shorts? video|youtube shorts?/.test(text);
}

export function extractChannelIdsFromText(text) {
  const channelIds = new Set();
  const handles = [];

  const channelPattern = /youtube\.com\/channel\/(UC[\w-]{22})/g;
  let match;
  while ((match = channelPattern.exec(text)) !== null) {
    channelIds.add(match[1]);
  }

  const handlePattern = /youtube\.com\/@([\w.-]+)/g;
  while ((match = handlePattern.exec(text)) !== null) {
    handles.push(match[1]);
  }

  const userPattern = /youtube\.com\/user\/([\w.-]+)/g;
  while ((match = userPattern.exec(text)) !== null) {
    handles.push(match[1]);
  }

  const customPattern = /youtube\.com\/c\/([\w.-]+)/g;
  while ((match = customPattern.exec(text)) !== null) {
    handles.push(match[1]);
  }

  const bareIdPattern = /\b(UC[\w-]{22})\b/g;
  while ((match = bareIdPattern.exec(text)) !== null) {
    channelIds.add(match[1]);
  }

  return { channelIds: [...channelIds], handles };
}
