import { validateUniverseDesign } from "./universe.ts";

export const TEMPLATE_RENDERERS = {
  "our-universe": { schemaVersion: 1, rendererVersion: "1.0.0" },
  "love-letter": { schemaVersion: 2, rendererVersion: "1.0.0" },
  "our-memories": { schemaVersion: 1, rendererVersion: "1.0.0" },
  "say-yes": { schemaVersion: 1, rendererVersion: "1.0.0" },
  "distance-means-nothing": { schemaVersion: 1, rendererVersion: "1.0.0" },
} as const;

export type TemplateId = keyof typeof TEMPLATE_RENDERERS;
export type TemplateData = Record<string, unknown>;

export function supportsTemplateVersion(templateId: string, schemaVersion: number): boolean {
  if (!Object.hasOwn(TEMPLATE_RENDERERS, templateId)) return false;
  return templateId === "love-letter"
    ? schemaVersion === 1 || schemaVersion === 2
    : schemaVersion === 1;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THEMES: Record<Exclude<TemplateId, "our-universe">, Set<string>> = {
  "love-letter": new Set(["rose", "mid", "lav", "ivory"]),
  "our-memories": new Set(["rose-memories", "midnight-diary", "lavender-dreams", "vintage-ivory"]),
  "say-yes": new Set(["rose-proposal", "midnight-romance", "lavender-dream", "golden-promise"]),
  "distance-means-nothing": new Set(["midnight-distance", "blue-aurora", "rose-galaxy", "golden-horizon"]),
};
const ANIMATIONS: Record<Exclude<TemplateId, "our-universe">, Set<string>> = {
  "love-letter": new Set(["1", "2"]),
  "our-memories": new Set(["cinematic", "dreamy", "nostalgic", "minimal"]),
  "say-yes": new Set(["cinematic", "magical", "dreamy", "minimal"]),
  "distance-means-nothing": new Set(["cinematic", "dreamy", "cosmic", "minimal"]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, max: number, optional = false): value is string {
  return typeof value === "string" && value.length <= max && (optional || Boolean(value.trim()));
}

function date(value: unknown, optional = false): value is string {
  return text(value, 10, optional) &&
    (value === "" && optional ||
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
}

function assetId(value: unknown, optional = false): value is string {
  return typeof value === "string" && (optional && value === "" || ID.test(value));
}

function photoList(value: unknown, max: number): value is Array<{ asset_id: string; caption: string }> {
  return Array.isArray(value) && value.length <= max && value.every((photo) =>
    isRecord(photo) && exact(photo, ["asset_id", "caption"]) &&
    assetId(photo.asset_id) && text(photo.caption, 120, true));
}

function validateLetter(value: unknown, schemaVersion: number): value is TemplateData {
  const keys = ["from", "to", "title", "msg", "secret", "theme", "spd"];
  if (schemaVersion === 2) keys.push("photos");
  return isRecord(value) && exact(value, keys) &&
    text(value.from, 80) && text(value.to, 80) && text(value.title, 120, true) &&
    text(value.msg, 2000) && text(value.secret, 200, true) &&
    text(value.theme, 20) && THEMES["love-letter"].has(value.theme) &&
    text(value.spd, 2) && ANIMATIONS["love-letter"].has(value.spd) &&
    (schemaVersion === 1 || photoList(value.photos, 4));
}

function validateProposal(value: unknown): value is TemplateData {
  const keys = [
    "templateId", "sender", "receiver", "nickname", "question", "subtitle", "yesLabel", "noLabel",
    "yesHeadline", "yesMessage", "letter", "signature", "specialDate", "noMessage", "noBackLabel",
    "showNoMessage", "theme", "animation", "particles", "autoRotate", "music", "photos",
  ];
  return isRecord(value) && exact(value, keys) &&
    ["sender", "receiver", "nickname", "question", "subtitle", "yesLabel", "noLabel", "yesHeadline",
      "yesMessage", "letter", "signature", "noMessage", "noBackLabel", "music"]
      .every((key) => text(value[key], key === "letter" || key === "yesMessage" || key === "noMessage" ? 2000 : 160,
        key === "nickname" || key === "subtitle" || key === "music")) &&
    value.templateId === "say-yes" && date(value.specialDate, true) &&
    typeof value.showNoMessage === "boolean" && typeof value.particles === "boolean" &&
    typeof value.autoRotate === "boolean" && text(value.theme, 40) &&
    THEMES["say-yes"].has(value.theme) && text(value.animation, 40) &&
    ANIMATIONS["say-yes"].has(value.animation) && photoList(value.photos, 6);
}

function validateMemories(value: unknown): value is TemplateData {
  if (!isRecord(value) || !exact(value, [
    "templateId", "sender", "receiver", "nickname", "albumTitle", "subtitle", "anniversary", "theme",
    "animation", "coverImage", "introduction", "story", "chapters", "closingMessage", "signature", "music",
  ])) return false;
  if (value.templateId !== "our-memories" ||
      !["sender", "receiver", "nickname", "albumTitle", "subtitle", "introduction", "story",
        "closingMessage", "signature", "music"].every((key) =>
        text(value[key], key === "introduction" || key === "story" || key === "closingMessage" ? 2000 : 200,
          key === "nickname" || key === "subtitle" || key === "music")) ||
      !date(value.anniversary, true) || !assetId(value.coverImage, true) ||
      !text(value.theme, 40) || !THEMES["our-memories"].has(value.theme) ||
      !text(value.animation, 40) || !ANIMATIONS["our-memories"].has(value.animation) ||
      !Array.isArray(value.chapters) || value.chapters.length !== 3) return false;
  let photoCount = 0;
  return value.chapters.every((chapter) => {
    if (!isRecord(chapter) || !exact(chapter, ["id", "title", "date", "description", "photos"]) ||
        !text(chapter.id, 80) || !text(chapter.title, 160) || !date(chapter.date, true) ||
        !text(chapter.description, 1000, true) || !photoList(chapter.photos, 12)) return false;
    photoCount += chapter.photos.length;
    return photoCount <= 12;
  });
}

function validTimezone(value: unknown): value is string {
  if (!text(value, 80, true)) return false;
  if (!value) return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validPerson(value: unknown): value is TemplateData {
  return isRecord(value) && exact(value, ["name", "city", "timezone", "lat", "lon"]) &&
    text(value.name, 80, true) && text(value.city, 120, true) &&
    validTimezone(value.timezone) &&
    (value.lat === null || typeof value.lat === "number" && Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90) &&
    (value.lon === null || typeof value.lon === "number" && Number.isFinite(value.lon) && value.lon >= -180 && value.lon <= 180);
}

function validateDistance(value: unknown): value is TemplateData {
  const distanceKm = isRecord(value) && isRecord(value.distance) ? value.distance.distanceKm : undefined;
  if (!isRecord(value) || !exact(value, [
    "templateId", "sender", "receiver", "anniversary", "nextMeeting", "headline", "message", "theme",
    "animation", "distance", "messages", "memories",
  ]) || value.templateId !== "distance" || !validPerson(value.sender) || !validPerson(value.receiver) ||
      !date(value.anniversary, true) || !isRecord(value.nextMeeting) ||
      !exact(value.nextMeeting, ["date", "time", "timezone"]) ||
      !date(value.nextMeeting.date, true) || !text(value.nextMeeting.time, 5, true) ||
      !validTimezone(value.nextMeeting.timezone) || !text(value.headline, 160) ||
      !text(value.message, 2000, true) || !text(value.theme, 40) ||
      !THEMES["distance-means-nothing"].has(value.theme) || !text(value.animation, 40) ||
      !ANIMATIONS["distance-means-nothing"].has(value.animation) ||
      !isRecord(value.distance) || !exact(value.distance, ["mode", "distanceKm"]) ||
      (value.distance.mode !== "manual" && value.distance.mode !== "coordinates") ||
      (distanceKm !== null && distanceKm !== undefined &&
        (typeof distanceKm !== "number" || !Number.isSafeInteger(distanceKm) || distanceKm < 1 || distanceKm > 50_000)) ||
      distanceKm === undefined ||
      !Array.isArray(value.messages) || value.messages.length > 12 ||
      !value.messages.every((message) => isRecord(message) &&
        exact(message, ["emoji", "title", "body"]) && text(message.emoji, 16, true) &&
        text(message.title, 120, true) && text(message.body, 1000, true)) ||
      !Array.isArray(value.memories) || value.memories.length > 12 ||
      !value.memories.every((memory) => isRecord(memory) &&
        exact(memory, ["title", "body"]) && text(memory.title, 120, true) && text(memory.body, 1000, true))) return false;
  return true;
}

export function validateTemplateData(
  templateId: string,
  schemaVersion: number,
  value: unknown,
): { value?: TemplateData; fields?: Record<string, string> } {
  if (!supportsTemplateVersion(templateId, schemaVersion)) {
    return { fields: { template_id: "Unsupported template or schema version" } };
  }
  if (templateId === "our-universe") {
    const result = validateUniverseDesign(value);
    return result.value
      ? { value: result.value as unknown as TemplateData }
      : { fields: result.fields ?? { data: "Invalid template data" } };
  }
  const valid = templateId === "love-letter" ? validateLetter(value, schemaVersion)
    : templateId === "our-memories" ? validateMemories(value)
      : templateId === "say-yes" ? validateProposal(value)
        : validateDistance(value);
  return valid
    ? { value: value as TemplateData }
    : { fields: { data: "Data does not match the template schema" } };
}

export function assetReferences(templateId: string, value: TemplateData): string[] {
  const references = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && ID.test(value)) references.add(value);
  };
  if (templateId === "our-universe" || templateId === "say-yes" ||
      templateId === "love-letter" && Array.isArray(value.photos)) {
    if (Array.isArray(value.photos)) {
      for (const photo of value.photos) if (isRecord(photo)) add(photo.asset_id);
    }
  } else if (templateId === "our-memories") {
    add(value.coverImage);
    if (Array.isArray(value.chapters)) {
      for (const chapter of value.chapters) {
        if (isRecord(chapter) && Array.isArray(chapter.photos)) {
          for (const photo of chapter.photos) if (isRecord(photo)) add(photo.asset_id);
        }
      }
    }
  }
  return [...references];
}

export function publicTemplateData(
  templateId: string,
  value: TemplateData,
  publicAssetUrl: (assetId: string) => string,
): TemplateData {
  const copy = structuredClone(value);
  const photo = (entry: unknown): unknown => {
    if (!isRecord(entry) || typeof entry.asset_id !== "string") return entry;
    return { url: publicAssetUrl(entry.asset_id), caption: entry.caption };
  };
  if ((templateId === "our-universe" || templateId === "say-yes" || templateId === "love-letter") &&
      Array.isArray(copy.photos)) {
    copy.photos = copy.photos.map(photo);
  } else if (templateId === "our-memories") {
    if (typeof copy.coverImage === "string" && ID.test(copy.coverImage)) {
      copy.coverImage = publicAssetUrl(copy.coverImage);
    }
    if (Array.isArray(copy.chapters)) {
      copy.chapters = copy.chapters.map((chapter) => {
        if (!isRecord(chapter) || !Array.isArray(chapter.photos)) return chapter;
        return { ...chapter, photos: chapter.photos.map(photo) };
      });
    }
  }
  return copy;
}
