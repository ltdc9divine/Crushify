# Shared Template Engine

**Status:** shared integration design; Phase 2 backend adapter is connected only to Our Universe in the local Worker. Preserve all template-specific implementations.
**Goal:** share services/data lifecycle while keeping five distinct visual experiences.

## 1. Current state and gaps

The gallery links to five independent HTML applications; some CSS/JS are inline and others are separate. The editors currently use in-memory state, local browser storage in selected cases, temporary `blob:` URLs or data URLs for local images, JSON export in Our Memories/Say Yes!, and client-side share encoding in other templates. None of these create a server-persisted production draft or a complete purchasable recipient URL.

| Template ID (canonical proposal) | Existing app and current behavior | Commerce adapter work |
|---|---|---|
| `our-universe` | Editor fields update hero/story and theme/motion; 3D scene, exploration/story and mobile layout load. The local Worker supports email-link authentication, D1 draft restore/save, revision checks, private R2-compatible image upload/read/delete, and bearer-token preview including photos. | Only local D1 and local R2 emulation are verified; no real email provider or production bucket. No payment or published recipient slug. Three.js r128 is loaded from cdnjs; no scene fallback on CDN/WebGL failure. |
| `love-letter` | Browser-tested: editor updates letter; 3D opening reaches reading state and close returns sealed; Recipient preview, text-data link and local photo selection. | Shared link excludes uploaded photos; no server persistence, order or publication. Three.js r128 is loaded from cdnjs; no scene fallback on CDN/WebGL failure. |
| `our-memories` | Browser-tested: title/story editor updates album, opens/steps through chapters, local image upload and recipient preview; exports JSON. Has a 2D fallback path if 3D startup fails. | JSON import/share/persistent customer draft not implemented; data injection (`MEMORIES_DATA`) is a developer integration seam, not a customer publishing service. CDN dependency (Three.js); fallback vendor path is absent, though CDN paths are tried. |
| `say-yes` | Browser-tested: live question editor; yes celebration and no/back branches; local image upload, manual localStorage draft save/restore, JSON export; 2D fallback path. | No customer-data link/JSON import/backend persistence/publish or checkout. Recipient injection (`SAYYES_DATA`) is a developer seam. Three.js CDN fallback includes a vendor path not present in the repository. |
| `distance-means-nothing` | Browser-tested: live text editor, timezone clocks/countdown/distance logic, preview and copied hash-based data link; localStorage draft; 3D scene with a 2D fallback. | No image upload, server persistence, payment or published slug. The full data payload is in the URL hash (size/privacy limitations). Three.js 0.160.0, addon modules and fonts depend on external CDN/import-map hosts. |

Homepage is static. It has no real pricing catalog/checkout. Four templates retain their previous browser-side persistence/upload behavior; only Our Universe has server-side validation and persistence in the local prototype. Preview and upload semantics are not yet standardized across products. Browser checks establish tested local interactions, not production-scale reliability, physical-device behavior, CDN failure resilience, or payment/publishing readiness. No template uses webcam/camera capture.

## 2. Per-template manifest contract

Register each template in code/registry with:

```ts
type TemplateManifest<T> = {
  templateId: string;                  // stable, lowercase, immutable
  schemaVersion: number;               // data contract revision
  rendererVersion: string;             // version of recipient UI/assets
  defaultData: T;
  validate(data: unknown): ValidationResult<T>;
  migrate?(from: number, data: unknown): ValidationResult<T>;
  editor: {
    mount(root: HTMLElement, ctx: TemplateContext): void;
  };
  recipient: {
    mount(root: HTMLElement, data: T, ctx: TemplateContext): void;
    dispose?(): void;
  };
  preview?: {
    mount(root: HTMLElement, data: T, ctx: TemplateContext): void;
  };
};
```

The runtime context is deliberately small: `drafts`, `assets`, `preview`, `navigation`, and product-specific feature flags. Templates own their fields, validation limits, editor composition, recipient HTML, CSS, JS, animation and renderer. Shared services don't dictate a shared editor layout or flatten 3D behavior into generic components.

The codebase does not need to adopt React or another frontend framework. It can start with one vanilla-JS adapter interface and a registry mapping `template_id` to a manifest. TypeScript is appropriate for backend and optionally for build-time contract validation, not a prerequisite to migrate existing UIs.

## 3. Shared service interfaces

```ts
interface DraftService {
  load(designId: string): Promise<{ revision: number; data: unknown }>;
  save(input: { designId: string; expectedRevision: number; data: unknown; assetIds: string[] }): Promise<{ revision: number }>;
}
interface AssetService {
  beginUpload(input: { designId: string; name: string; mediaType: string; size: number }): Promise<UploadSession>;
  completeUpload(assetId: string, checksum: string): Promise<AssetRef>;
  remove(assetId: string): Promise<void>;
}
interface PreviewService {
  create(designId: string, revision: number): Promise<{ url: string; expiresAt: string }>;
}
interface CommerceService {
  createCheckout(input: { sku: string; designId: string; revision: number; coupon?: string }): Promise<{ checkoutUrl: string }>;
}
interface PublishingService {
  status(designId: string): Promise<{ state: string; publicUrl?: string }>;
}
```

API contracts in [API_SPECIFICATION.md](API_SPECIFICATION.md) are authoritative; interfaces above illustrate boundaries, not a promise that endpoints exist.

## 4. Schema validation and compatibility

- Validate on both client (fast UX) and server (security/authority). Only server validation determines what is saved/published.
- Use versioned, explicit allowlists and maximum length/array/image-reference limits. Validate all URLs/IDs against authorized asset records; reject executable markup/event handlers.
- A save declares `template_id`, `schema_version`, `expected_revision`, data, and asset IDs. Server loads registered schema; never accept a client-supplied validator.
- Older drafts migrate only through tested deterministic migrations. Preserve original snapshots for published designs; don't auto-migrate a live recipient page.
- Each publication pins `template_id`, `schema_version`, renderer version, immutable design revision and referenced public asset renditions.
- Removing/retiring a template stops new purchases but does not break published content; retain compatible renderer bundles or an explicit migration plan.

## 5. Creator, preview and recipient modes

- **Creator:** authorized draft; autosave with revision/ETag conflict detection and clear saved/error indicators. Local temporary images are not considered uploaded until server finalization succeeds.
- **Preview:** same recipient renderer and saved revision, but behind short-lived token; `noindex`, no public cache, revoke/expire capability. Preview should not include arbitrary admin-only tooling.
- **Recipient:** public renderer loads only published payload by high-entropy slug. It receives no creator/editor mode, customer identity, order metadata, or private media URL.
- Custom design previews use the same preview service but can be authorized for the project customer/reviewer; each revision invalidates or supersedes older preview capabilities.

## 6. Asset references in templates

Templates store only references such as `{ asset_id, caption, position }`. During save/publish the backend verifies ownership, moderation state, allowed count, and design binding. The renderer gets a safe, scoped published asset URL. The current base64/data-URL and browser `blob:` flows are editor prototypes and must not be used as durable customer storage.

## 7. Incremental adoption

1. Inventory/default-data and fixture-test each template; assign canonical IDs and schema v1.
2. Build adapter shims around existing state objects; preserve UI/animation. Do not unify CSS or scene loops.
3. Add autosave/restore first for a single pilot, with local-only fallback clearly marked.
4. Add R2 asset IDs and upload service to templates that have photo fields.
5. Integrate preview and then publish resolution. Run snapshot/manual regression tests for desktop/mobile and reduced-motion behavior.
6. Migrate remaining templates one by one; use version compatibility tests before purchase activation.

## 8. Acceptance criteria

- Each manifest has validated defaults, schema/version fixtures, recipient renderer and testable preview entry.
- Creator can reload a draft on another authenticated device and photos resolve through asset references.
- Recipient sees only the purchased/published revision; unlisted draft IDs/tokens do not reveal content.
- A template-specific visual or animation change cannot silently alter another template; shared service tests run across all five.
