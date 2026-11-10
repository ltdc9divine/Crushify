(() => {
  "use strict";

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

  window.crushifyDataImageBlob = (source) => {
    if (typeof source !== "string" || !source.startsWith("data:")) return null;

    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(source);
    if (!match || match[2].length === 0 || match[2].length > MAX_BASE64_LENGTH) {
      throw new Error("Ảnh dữ liệu không hợp lệ hoặc vượt quá 5 MB.");
    }

    let decoded;
    try {
      decoded = atob(match[2]);
    } catch {
      throw new Error("Ảnh dữ liệu không hợp lệ hoặc vượt quá 5 MB.");
    }
    if (decoded.length === 0 || decoded.length > MAX_IMAGE_BYTES) {
      throw new Error("Ảnh dữ liệu không hợp lệ hoặc vượt quá 5 MB.");
    }

    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return new Blob([bytes], { type: match[1].toLowerCase() });
  };
})();
