import { createHash, randomUUID } from "node:crypto";
import { CloudinaryStorageAdapter } from "../src/storage/cloudinary.ts";

const syntheticPng = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

function createStorage(): CloudinaryStorageAdapter {
  if (process.env.ENVIRONMENT !== "staging" ||
      process.env.STORAGE_PROVIDER !== "cloudinary" ||
      process.env.CLOUDINARY_CLOUD_NAME !== "hgtcizux" ||
      process.env.CLOUDINARY_SMOKE_TEST !== "I_CONFIRM_SYNTHETIC_DATA" ||
      !process.env.CLOUDINARY_API_KEY?.trim() ||
      !process.env.CLOUDINARY_API_SECRET?.trim()) {
    throw new Error("Cloudinary smoke test requires the confirmed Test cloud and explicit synthetic-data opt-in");
  }
  return new CloudinaryStorageAdapter({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  });
}

async function main(): Promise<void> {
  const storage = createStorage();
  const id = randomUUID().replaceAll("-", "");
  const privateKey = `private/${id}-png`;
  const derivativeKey = `published/${id}-png`;
  const sha256 = createHash("sha256").update(syntheticPng).digest("hex");
  let failure: unknown;
  try {
    await storage.upload(privateKey, syntheticPng, {
      contentType: "image/png",
      sha256,
      width: 1,
      height: 1,
    });
    const privateObject = await storage.get(privateKey);
    if (!privateObject ||
        privateObject.contentType !== "image/png" ||
        privateObject.size !== syntheticPng.byteLength ||
        !Buffer.from(await privateObject.arrayBuffer()).equals(Buffer.from(syntheticPng))) {
      throw new Error("Cloudinary private read verification failed");
    }
    await storage.createPublishedDerivative(privateKey, derivativeKey);
    const derivative = await storage.getPublishedDerivative(derivativeKey);
    if (!derivative ||
        derivative.contentType !== "image/png" ||
        derivative.size !== syntheticPng.byteLength ||
        !Buffer.from(await derivative.arrayBuffer()).equals(Buffer.from(syntheticPng))) {
      throw new Error("Cloudinary derivative read verification failed");
    }
  } catch (error) {
    failure = error;
  } finally {
    const cleanupFailures: string[] = [];
    try {
      await storage.deletePublishedDerivative(derivativeKey);
    } catch {
      cleanupFailures.push("published derivative");
    }
    try {
      await storage.delete(privateKey);
    } catch {
      cleanupFailures.push("private source");
    }
    if (cleanupFailures.length > 0) {
      failure = new Error(
        `Synthetic Cloudinary cleanup failed for ${cleanupFailures.join(", ")}; inspect IDs ${privateKey} and ${derivativeKey}`,
      );
    }
  }
  if (failure) {
    const cleanupMessage = failure instanceof Error &&
      failure.message.startsWith("Synthetic Cloudinary cleanup failed")
      ? failure.message
      : null;
    throw new Error(cleanupMessage ??
      `Cloudinary operation failed (${failure instanceof Error ? failure.name : "UnknownError"})`);
  }
  console.info("Cloudinary synthetic private upload/read, public derivative read, and cleanup checks passed");
}

main().catch((error: unknown) => {
  console.error("Cloudinary smoke test failed", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
