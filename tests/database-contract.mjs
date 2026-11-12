import assert from "node:assert/strict";

function makePng() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const kind = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([length, kind, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.from([120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function runDatabaseContract({
  request,
  getMagicToken,
  label,
  beforeAssetDelete,
  emailPrefix = "adapter",
}) {
  async function signIn(email) {
    const requested = await request("/customers/session", null, {
      method: "POST",
      json: { email },
    });
    assert.equal(requested.response.status, 202, `${label}: magic-link request`);
    const token = await getMagicToken();
    assert.ok(token, `${label}: captured magic-link token`);

    const verified = await request("/customers/session/verify", null, {
      method: "POST",
      json: { token },
    });
    assert.equal(verified.response.status, 200, `${label}: token verification`);
    const cookies = verified.response.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
    const csrf = cookies.find((value) => value.startsWith("crushify_csrf="))?.split("=", 2)[1];
    assert.ok(cookies.some((value) => value.startsWith("crushify_session=")), `${label}: session cookie`);
    assert.ok(csrf, `${label}: CSRF cookie`);
    const session = { cookies, csrf };

    const me = await request("/customers/me", session);
    assert.equal(me.response.status, 200, `${label}: authenticated customer`);
    assert.equal(me.body.email, email, `${label}: customer record`);
    const replay = await request("/customers/session/verify", null, {
      method: "POST",
      json: { token },
    });
    assert.equal(replay.response.status, 401, `${label}: one-time login token`);
    return session;
  }

  const owner = await signIn(`${emailPrefix}-${crypto.randomUUID()}@example.test`);
  const created = await request("/designs", owner, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-universe", schema_version: 1 },
  });
  assert.equal(created.response.status, 201, `${label}: create design`);
  const designId = created.body.design_id;
  assert.equal(created.body.revision, 1);

  const memories = await request("/designs", owner, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-memories", schema_version: 1 },
  });
  assert.equal(memories.response.status, 201, `${label}: create memories design`);
  for (let index = 0; index < 13; index++) {
    const grant = await request("/assets/upload-url", owner, {
      method: "POST",
      mutating: true,
      json: {
        design_id: memories.body.design_id,
        media_type: "image/png",
        size: 1,
      },
    });
    assert.equal(grant.response.status, 201, `${label}: memories asset ${index + 1} of 13`);
  }
  const tooManyMemoriesAssets = await request("/assets/upload-url", owner, {
    method: "POST",
    mutating: true,
    json: {
      design_id: memories.body.design_id,
      media_type: "image/png",
      size: 1,
    },
  });
  assert.equal(tooManyMemoriesAssets.response.status, 409, `${label}: reject memories asset 14`);

  const tooManyStandardAssets = await request("/designs", owner, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-universe", schema_version: 1 },
  });
  assert.equal(tooManyStandardAssets.response.status, 201, `${label}: create standard design for photo limit`);
  for (let index = 0; index < 6; index++) {
    const grant = await request("/assets/upload-url", owner, {
      method: "POST",
      mutating: true,
      json: {
        design_id: tooManyStandardAssets.body.design_id,
        media_type: "image/png",
        size: 1,
      },
    });
    assert.equal(grant.response.status, 201, `${label}: standard asset ${index + 1} of 6`);
  }
  const tooManyStandardAssetsResult = await request("/assets/upload-url", owner, {
    method: "POST",
    mutating: true,
    json: {
      design_id: tooManyStandardAssets.body.design_id,
      media_type: "image/png",
      size: 1,
    },
  });
  assert.equal(tooManyStandardAssetsResult.response.status, 409, `${label}: reject standard asset 7`);

  const firstRead = await request(`/designs/${designId}`, owner);
  assert.equal(firstRead.response.status, 200, `${label}: read design`);
  assert.equal(firstRead.body.data.sender, created.body.data.sender);

  const changed = { ...created.body.data, sender: "Kiểm thử DB", headline: "Bản lưu dùng chung" };
  const updated = await request(`/designs/${designId}`, owner, {
    method: "PUT",
    mutating: true,
    json: { schema_version: 1, expected_revision: 1, data: changed },
  });
  assert.equal(updated.response.status, 200, `${label}: update design`);
  assert.equal(updated.body.revision, 2);

  const conflict = await request(`/designs/${designId}`, owner, {
    method: "PUT",
    mutating: true,
    json: { schema_version: 1, expected_revision: 1, data: changed },
  });
  assert.equal(conflict.response.status, 409, `${label}: stale revision conflict`);

  const reloaded = await request(`/designs/${designId}`, owner);
  assert.equal(reloaded.response.status, 200, `${label}: reload design`);
  assert.equal(reloaded.body.revision, 2);
  assert.equal(reloaded.body.data.sender, changed.sender);

  const previewCreated = await request(`/designs/${designId}/preview`, owner, {
    method: "POST",
    mutating: true,
  });
  assert.equal(previewCreated.response.status, 201, `${label}: create preview token`);
  assert.equal(previewCreated.response.headers.get("cache-control"), "no-store",
    `${label}: preview token response is not cacheable`);
  assert.equal(previewCreated.response.headers.get("referrer-policy"), "no-referrer",
    `${label}: preview token response does not leak through referrers`);
  assert.equal(previewCreated.body.token.length, 43,
    `${label}: preview capability contains 256 bits of token material`);
  const previewUrl = new URL(previewCreated.body.url, "https://crushify.example");
  assert.equal(previewUrl.hash.slice(1), previewCreated.body.token,
    `${label}: preview capability is carried in the fragment`);
  assert.equal(previewUrl.search, "?preview",
    `${label}: preview capability is not in the query string`);
  const preview = await request("/previews", null, { token: previewCreated.body.token });
  assert.equal(preview.response.status, 200, `${label}: read preview by bearer token`);
  assert.equal(preview.body.revision, 2);
  assert.equal(preview.body.data.sender, changed.sender);
  const invalidPreview = await request("/previews", null, {
    token: "invalid-synthetic-preview-capability",
  });
  assert.equal(invalidPreview.response.status, 404, `${label}: reject invalid preview capability`);

  const other = await signIn(`${emailPrefix}-other-${crypto.randomUUID()}@example.test`);
  const sharedPreview = await request("/previews", other, {
    token: previewCreated.body.token,
  });
  assert.equal(sharedPreview.response.status, 200,
    `${label}: another authenticated customer can use a shared preview capability`);
  assert.equal(sharedPreview.body.revision, 2);
  assert.equal(sharedPreview.body.data.sender, changed.sender);
  const replacementPreview = await request(`/designs/${designId}/preview`, owner, {
    method: "POST",
    mutating: true,
  });
  assert.equal(replacementPreview.response.status, 201,
    `${label}: owner can issue another preview capability`);
  assert.notEqual(replacementPreview.body.token, previewCreated.body.token,
    `${label}: reissued preview uses a distinct capability`);
  const priorCapabilityAfterReissue = await request("/previews", null, {
    token: previewCreated.body.token,
  });
  assert.equal(priorCapabilityAfterReissue.response.status, 200,
    `${label}: reissuing a preview does not revoke the previous capability`);

  const previewIdentity = await request("/customers/me", null, {
    token: previewCreated.body.token,
  });
  assert.equal(previewIdentity.response.status, 401,
    `${label}: preview capability is not customer authentication`);
  const previewUploadGrant = await request("/assets/upload-url", null, {
    method: "POST",
    token: previewCreated.body.token,
    mutating: true,
    json: { design_id: designId, media_type: "image/png", size: makePng().length },
  });
  assert.equal(previewUploadGrant.response.status, 401,
    `${label}: preview capability cannot create an upload grant`);
  const otherUploadGrantForOwnerDesign = await request("/assets/upload-url", other, {
    method: "POST",
    token: previewCreated.body.token,
    mutating: true,
    json: { design_id: designId, media_type: "image/png", size: makePng().length },
  });
  assert.equal(otherUploadGrantForOwnerDesign.response.status, 404,
    `${label}: shared preview does not let another customer upload to the design`);
  const previewMutationWithoutSession = await request(`/designs/${designId}`, null, {
    method: "PUT",
    token: previewCreated.body.token,
    mutating: true,
    json: { schema_version: 1, expected_revision: 2, data: changed },
  });
  assert.equal(previewMutationWithoutSession.response.status, 401,
    `${label}: preview capability cannot mutate a design`);
  const previewMutationAsOther = await request(`/designs/${designId}`, other, {
    method: "PUT",
    token: previewCreated.body.token,
    mutating: true,
    json: { schema_version: 1, expected_revision: 2, data: changed },
  });
  assert.equal(previewMutationAsOther.response.status, 404,
    `${label}: preview capability does not bypass design ownership`);

  const privateDesign = await request(`/designs/${designId}`, other);
  assert.equal(privateDesign.response.status, 404, `${label}: design owner isolation`);

  const grant = await request("/assets/upload-url", owner, {
    method: "POST",
    mutating: true,
    json: { design_id: designId, media_type: "image/png", size: makePng().length },
  });
  assert.equal(grant.response.status, 201, `${label}: create private asset metadata`);
  const privatePendingAsset = await request(`/assets/${grant.body.asset_id}`, owner);
  assert.equal(privatePendingAsset.response.status, 404, `${label}: pending asset is not readable`);

  const png = makePng();
  const uploaded = await request(`/assets/${grant.body.asset_id}/content`, null, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${grant.body.upload_token}`,
      "Content-Type": "image/png",
    },
    body: png,
  });
  assert.equal(uploaded.response.status, 204, `${label}: upload asset content`);
  const completed = await request(`/assets/${grant.body.asset_id}/complete`, owner, {
    method: "POST",
    mutating: true,
  });
  assert.equal(completed.response.status, 200, `${label}: finalize asset metadata`);

  const ownerAsset = await request(`/assets/${grant.body.asset_id}`, owner);
  assert.equal(ownerAsset.response.status, 200, `${label}: owner reads asset metadata/content`);
  assert.deepEqual(Buffer.from(await ownerAsset.response.arrayBuffer()), png);
  const otherAsset = await request(`/assets/${grant.body.asset_id}`, other);
  assert.equal(otherAsset.response.status, 404, `${label}: asset owner isolation`);
  const previewPrivateAsset = await request(`/assets/${grant.body.asset_id}`, null, {
    token: previewCreated.body.token,
  });
  assert.equal(previewPrivateAsset.response.status, 401,
    `${label}: preview capability cannot retrieve an original private asset`);

  const withPhoto = { ...changed, photos: [{ asset_id: grant.body.asset_id, caption: "Kỷ niệm" }] };
  const attached = await request(`/designs/${designId}`, owner, {
    method: "PUT",
    mutating: true,
    json: { schema_version: 1, expected_revision: 2, data: withPhoto },
  });
  assert.equal(attached.response.status, 200, `${label}: update design revision with asset`);
  assert.equal(attached.body.revision, 3);
  const revokedPreview = await request("/previews", null, {
    token: previewCreated.body.token,
  });
  assert.equal(revokedPreview.response.status, 404,
    `${label}: editing the design revokes the previous revision preview`);
  const revokedReplacementPreview = await request("/previews", null, {
    token: replacementPreview.body.token,
  });
  assert.equal(revokedReplacementPreview.response.status, 404,
    `${label}: editing the design revokes all capabilities for the previous revision`);
  const revokedPreviewAsset = await request(`/previews/assets/${grant.body.asset_id}`, null, {
    token: previewCreated.body.token,
  });
  assert.equal(revokedPreviewAsset.response.status, 404,
    `${label}: editing the design revokes access to assets through its previous preview`);

  const refreshedPreview = await request(`/designs/${designId}/preview`, owner, {
    method: "POST",
    mutating: true,
  });
  assert.equal(refreshedPreview.response.status, 201, `${label}: create updated preview token`);
  const previewWithPhoto = await request("/previews", null, {
    token: refreshedPreview.body.token,
  });
  assert.equal(previewWithPhoto.response.status, 200, `${label}: preview new revision`);
  assert.equal(previewWithPhoto.body.data.photos[0].caption, "Kỷ niệm");
  const sharedPreviewWithPhoto = await request("/previews", other, {
    token: refreshedPreview.body.token,
  });
  assert.equal(sharedPreviewWithPhoto.response.status, 200,
    `${label}: shared refreshed preview remains readable by another customer`);
  const sharedPreviewAsset = await request(
    `/previews/assets/${grant.body.asset_id}`,
    other,
    { token: refreshedPreview.body.token },
  );
  assert.equal(sharedPreviewAsset.response.status, 200,
    `${label}: shared preview exposes its referenced photo through the capability`);
  assert.deepEqual(Buffer.from(await sharedPreviewAsset.response.arrayBuffer()), png);

  const otherDesign = await request("/designs", other, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-universe", schema_version: 1 },
  });
  assert.equal(otherDesign.response.status, 201, `${label}: create second customer's design`);
  const otherGrant = await request("/assets/upload-url", other, {
    method: "POST",
    mutating: true,
    json: {
      design_id: otherDesign.body.design_id,
      media_type: "image/png",
      size: png.length,
    },
  });
  assert.equal(otherGrant.response.status, 201, `${label}: create second customer's private asset`);
  const previewAsUploadCapability = await request(
    `/assets/${otherGrant.body.asset_id}/content`,
    null,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${previewCreated.body.token}`,
        "Content-Type": "image/png",
      },
      body: png,
    },
  );
  assert.equal(previewAsUploadCapability.response.status, 401,
    `${label}: preview capability is not an asset-upload capability`);
  const otherUploaded = await request(`/assets/${otherGrant.body.asset_id}/content`, null, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${otherGrant.body.upload_token}`,
      "Content-Type": "image/png",
    },
    body: png,
  });
  assert.equal(otherUploaded.response.status, 204, `${label}: upload second customer's private asset`);
  const otherCompleted = await request(`/assets/${otherGrant.body.asset_id}/complete`, other, {
    method: "POST",
    mutating: true,
  });
  assert.equal(otherCompleted.response.status, 200, `${label}: complete second customer's private asset`);
  const unrelatedPreviewAsset = await request(
    `/previews/assets/${otherGrant.body.asset_id}`,
    other,
    { token: refreshedPreview.body.token },
  );
  assert.equal(unrelatedPreviewAsset.response.status, 404,
    `${label}: shared preview cannot retrieve an asset from another design`);

  const linkedDelete = await request(`/assets/${grant.body.asset_id}`, owner, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(linkedDelete.response.status, 409, `${label}: prevent deleting linked asset`);
  const detached = await request(`/designs/${designId}`, owner, {
    method: "PUT",
    mutating: true,
    json: {
      schema_version: 1,
      expected_revision: 3,
      data: { ...withPhoto, photos: [] },
    },
  });
  assert.equal(detached.response.status, 200, `${label}: detach asset`);
  if (beforeAssetDelete) await beforeAssetDelete(grant.body.asset_id);
  const deleted = await request(`/assets/${grant.body.asset_id}`, owner, {
    method: "DELETE",
    mutating: true,
  });
  if (beforeAssetDelete) {
    assert.equal(deleted.response.status, 503, `${label}: preserve metadata on binary-delete failure`);
    const retriedDelete = await request(`/assets/${grant.body.asset_id}`, owner, {
      method: "DELETE",
      mutating: true,
    });
    assert.equal(retriedDelete.response.status, 200, `${label}: retry binary and metadata deletion`);
  } else {
    assert.equal(deleted.response.status, 200, `${label}: delete asset metadata`);
  }
  const deletedAssetRead = await request(`/assets/${grant.body.asset_id}`, owner);
  assert.equal(deletedAssetRead.response.status, 404, `${label}: deleted asset is not readable`);

  return { designId, revision: detached.body.revision, owner, other };
}
