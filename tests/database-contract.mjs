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

export async function runDatabaseContract({ request, getMagicToken, label }) {
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

  const owner = await signIn(`adapter-${crypto.randomUUID()}@example.test`);
  const created = await request("/designs", owner, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-universe", schema_version: 1 },
  });
  assert.equal(created.response.status, 201, `${label}: create design`);
  const designId = created.body.design_id;
  assert.equal(created.body.revision, 1);

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
  const preview = await request("/previews", null, { token: previewCreated.body.token });
  assert.equal(preview.response.status, 200, `${label}: read preview by bearer token`);
  assert.equal(preview.body.revision, 2);
  assert.equal(preview.body.data.sender, changed.sender);

  const other = await signIn(`adapter-other-${crypto.randomUUID()}@example.test`);
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

  const withPhoto = { ...changed, photos: [{ asset_id: grant.body.asset_id, caption: "Kỷ niệm" }] };
  const attached = await request(`/designs/${designId}`, owner, {
    method: "PUT",
    mutating: true,
    json: { schema_version: 1, expected_revision: 2, data: withPhoto },
  });
  assert.equal(attached.response.status, 200, `${label}: update design revision with asset`);
  assert.equal(attached.body.revision, 3);

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
  const deleted = await request(`/assets/${grant.body.asset_id}`, owner, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(deleted.response.status, 200, `${label}: delete asset metadata`);
  const deletedAssetRead = await request(`/assets/${grant.body.asset_id}`, owner);
  assert.equal(deletedAssetRead.response.status, 404, `${label}: deleted asset is not readable`);

  return { designId, revision: detached.body.revision, owner };
}
