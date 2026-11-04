export interface UniversePhoto {
  asset_id: string;
  caption: string;
}

export interface UniverseMemory {
  title: string;
  description: string;
}

export interface UniverseDesign {
  sender: string;
  receiver: string;
  nickname: string;
  headline: string;
  subheadline: string;
  mainMessage: string;
  startDate: string;
  theme: string;
  animation: string;
  memories: UniverseMemory[];
  photos: UniversePhoto[];
}

export interface ValidationResult<T> {
  value?: T;
  fields?: Record<string, string>;
}

const THEMES = new Set([
  "rose-nebula",
  "violet-dream",
  "blue-aurora",
  "golden-galaxy",
]);
const ANIMATIONS = new Set(["cinematic", "dreamy", "energetic", "minimal"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function boundedString(
  value: unknown,
  field: string,
  maxLength: number,
  errors: Record<string, string>,
  required = true,
): string | undefined {
  if (typeof value !== "string") {
    errors[field] = "Must be text";
    return;
  }
  if ((required && !value.trim()) || value.length > maxLength) {
    errors[field] = required && !value.trim()
      ? "This field is required"
      : `Must be ${maxLength} characters or fewer`;
    return;
  }
  return value;
}

export function validateUniverseDesign(value: unknown): ValidationResult<UniverseDesign> {
  if (!isRecord(value)) return { fields: { data: "Must be a JSON object" } };
  const expected = [
    "sender",
    "receiver",
    "nickname",
    "headline",
    "subheadline",
    "mainMessage",
    "startDate",
    "theme",
    "animation",
    "memories",
    "photos",
  ];
  if (!hasExactKeys(value, expected)) {
    return { fields: { data: "Must contain exactly the supported Our Universe fields" } };
  }

  const errors: Record<string, string> = {};
  const sender = boundedString(value.sender, "sender", 80, errors);
  const receiver = boundedString(value.receiver, "receiver", 80, errors);
  const nickname = boundedString(value.nickname, "nickname", 80, errors, false);
  const headline = boundedString(value.headline, "headline", 120, errors);
  const subheadline = boundedString(value.subheadline, "subheadline", 160, errors, false);
  const mainMessage = boundedString(value.mainMessage, "mainMessage", 2000, errors);
  const startDate = boundedString(value.startDate, "startDate", 10, errors);
  if (startDate) {
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate)
      ? new Date(`${startDate}T00:00:00.000Z`)
      : null;
    if (!parsedDate || Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== startDate) {
      errors.startDate = "Must be a valid calendar date in YYYY-MM-DD format";
    }
  }

  const theme = boundedString(value.theme, "theme", 40, errors);
  if (theme && !THEMES.has(theme)) errors.theme = "Unsupported theme";
  const animation = boundedString(value.animation, "animation", 40, errors);
  if (animation && !ANIMATIONS.has(animation)) errors.animation = "Unsupported animation";

  const memories: UniverseMemory[] = [];
  if (!Array.isArray(value.memories) || value.memories.length !== 3) {
    errors.memories = "Must contain exactly three memories";
  } else {
    value.memories.forEach((memory, index) => {
      if (!isRecord(memory) || !hasExactKeys(memory, ["title", "description"])) {
        errors[`memories.${index}`] = "Must contain a title and description";
        return;
      }
      const title = boundedString(memory.title, `memories.${index}.title`, 120, errors);
      const description = boundedString(
        memory.description,
        `memories.${index}.description`,
        500,
        errors,
        false,
      );
      if (title !== undefined && description !== undefined) memories.push({ title, description });
    });
  }

  const photos: UniversePhoto[] = [];
  if (!Array.isArray(value.photos) || value.photos.length > 6) {
    errors.photos = "Must contain at most six uploaded photos";
  } else {
    value.photos.forEach((photo, index) => {
      if (!isRecord(photo) || !hasExactKeys(photo, ["asset_id", "caption"])) {
        errors[`photos.${index}`] = "Must contain an asset ID and caption";
        return;
      }
      const assetId = boundedString(photo.asset_id, `photos.${index}.asset_id`, 36, errors);
      const caption = boundedString(photo.caption, `photos.${index}.caption`, 120, errors, false);
      if (assetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) {
        errors[`photos.${index}.asset_id`] = "Invalid asset reference";
      }
      if (assetId && caption !== undefined) photos.push({ asset_id: assetId, caption });
    });
  }

  if (Object.keys(errors).length) return { fields: errors };
  return {
    value: {
      sender: sender!,
      receiver: receiver!,
      nickname: nickname!,
      headline: headline!,
      subheadline: subheadline!,
      mainMessage: mainMessage!,
      startDate: startDate!,
      theme: theme!,
      animation: animation!,
      memories,
      photos,
    },
  };
}

export function isJsonWithinLimit(value: unknown, maxBytes: number): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
}
