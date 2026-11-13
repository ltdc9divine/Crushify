# Shared Template Engine

**Status:** all five publication validators, recipient payload adapters, shared customer editor controls, server-backed draft/preview adapters, and publication bootstrap are wired. Customer draft APIs, payment, and publication are local-test only. The shared catalog exposes all five standard designs and approved prices; checkout authorization remains separate and is disabled in Production and Preview.
**Goal:** share services/data lifecycle while keeping five distinct visual experiences.

## 1. Current state and gaps

The gallery links to five independent HTML applications; some CSS/JS are inline and others are separate. The five template experiences retain their own schemas, controls, media limits, animations and renderers. Their shared customer tools persist drafts and preview capabilities through the local Worker APIs; that does not make production order creation or publishing available.

| Template ID (canonical proposal) | Existing app and current behavior | Commerce adapter work |
|---|---|---|
| `our-universe` | 3D universe editor and existing local interactions. The local Worker supports email-link authentication, D1 draft restore/save, revision checks, private image upload/read/delete, and bearer-token preview. | Schema-v1 validation, safe publication data, media consent, customer checkout entry point and recipient hydration. Three.js r128 is loaded from cdnjs with a jsDelivr fallback. |
| `love-letter` | 3D envelope, letter editor, recipient preview and local photo selection. | Schema-v2 draft save/restore, private photo upload and bearer-token preview through the shared customer tools; schema-v1 drafts remain readable. Three.js r128 is loaded from cdnjs; no scene fallback on CDN/WebGL failure. |
| `our-memories` | Album/chapters editor, local image selection and 2D fallback. | Schema-v1 draft save/restore, chapter photo upload and bearer-token preview through the shared customer tools. CDN dependency (Three.js); fallback vendor path is absent, though CDN paths are tried. |
| `say-yes` | Proposal editor, YES/NO interactions, local image selection and 2D fallback. | Schema-v1 draft save/restore, photo upload and bearer-token preview through the shared customer tools. Three.js CDN fallback includes a vendor path not present in the repository. |
| `distance-means-nothing` | Names, dates, time-zone clocks/countdown/distance editor and 3D/2D scene; no image upload. | Schema-v1 draft save/restore and bearer-token preview through the shared customer tools. Existing hash-based sharing remains separate. Three.js 0.160.0, addon modules and fonts depend on external CDN/import-map hosts. |

The registry validates and converts recipient data for all five templates, and each template's own page loads the published payload through the shared bootstrap without merging its CSS, JavaScript, or 3D scene. Shared server-backed editing, authentication, preview and checkout navigation exist for all five in local Worker mode. The approved standard price is 59,000 VND including the first month, plus 10,000 VND per additional month, or 199,000 VND Lifetime. Production and Preview checkout remain disabled independently of catalog visibility. Browser checks establish local behavior, not production-scale reliability, physical-device behavior, CDN-failure resilience, or commercial readiness. No template uses webcam/camera capture.

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

API contracts in [API_SPECIFICATION.md](API_SPECIFICATION.md) are authoritative. Draft/asset/preview interfaces are not fully adopted by the four non-Universe editors; publication APIs and recipient adapters are present but fail closed outside local test mode.

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

1. **Done locally:** inventory/default data, canonical IDs, schema-v1 validators and fixtures for all five templates.
2. **Done for recipient path:** safe payload conversion, consented media URLs, and template-specific hydration through the shared publication bootstrap.
3. **Partial:** Our Universe has local Worker autosave/restore/upload/preview; remaining four editor adapters are not connected to backend drafts or uploads.
4. **Local test only:** paid-order-gated publication lifecycle and customer websites dashboard; no production payment, price catalog, or remote publishing service.
5. **Still required:** cross-template editor save/reload/upload, deployed staging flow, and browser/accessibility/device QA before purchase activation.

## 8. Acceptance criteria

- Each manifest has validated defaults, schema/version fixtures, recipient renderer and testable preview entry.
- Creator can reload a draft on another authenticated device and photos resolve through asset references for every template.
- Recipient sees only the purchased/published revision; unlisted draft IDs/tokens do not reveal content.
- A template-specific visual or animation change cannot silently alter another template; shared service tests run across all five.

Current status: schema validation, recipient payload handling and local publication lifecycle tests cover all five templates. The all-template creator reload criterion is not met; only Our Universe currently uses the server draft/upload APIs, and no remote deployment has been tested.
