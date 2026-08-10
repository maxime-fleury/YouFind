export function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function readJsonBody(req, maxBytes) {
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw httpError("Request body too large", 413);

  let text;
  try {
    text = await req.text();
  } catch {
    throw httpError("Unable to read request body", 400);
  }
  if (text.length > maxBytes) throw httpError("Request body too large", 413);
  if (!text.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw httpError("Invalid JSON body", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw httpError("JSON body must be an object", 400);
  }
  return parsed;
}

export function parsePositiveId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function isYoutubeChannelId(value) {
  return typeof value === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(value.trim());
}
