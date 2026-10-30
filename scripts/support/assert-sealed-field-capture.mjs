import assert from 'node:assert/strict';

// The test attaches a real browser File to the actual observation form. The
// source JPEG carries a bounded synthetic APP1 metadata marker which must be
// absent from the sanitized stored/uploaded JPEG.
export const SOURCE_GPS_EXIF_SENTINEL = 'PILOT_SOURCE_GPS_EXIF_MUST_NOT_SURVIVE';

export async function attachTestCameraJpeg(page, marker = SOURCE_GPS_EXIF_SENTINEL) {
  return page.evaluate(async privateMarker => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Real Canvas JPEG encoding unavailable');
    const pixels = context.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = (i * 7) % 255;
      pixels.data[i + 1] = (i * 13) % 255;
      pixels.data[i + 2] = (i * 19) % 255;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.93));
    if (!image || image.type !== 'image/jpeg') throw new Error('No JPEG from actual canvas');
    const original = new Uint8Array(await image.arrayBuffer());
    if (original[0] !== 255 || original[1] !== 216) throw new Error('Invalid JPEG fixture');
    const marker = new TextEncoder().encode('Exif\0\0' + privateMarker);
    const segmentLength = marker.length + 2;
    if (segmentLength > 65535) throw new Error('Oversized JPEG metadata fixture');
    const source = new Uint8Array(original.length + 4 + marker.length);
    source.set(original.slice(0, 2));
    source.set([255, 225, segmentLength >> 8, segmentLength & 255], 2);
    source.set(marker, 6);
    source.set(original.slice(2), 6 + marker.length);
    const file = new File([source], 'campo-ubicacion-privada.jpg', { type: 'image/jpeg' });
    const input = document.querySelector('input[aria-label="Elegir fotografía del dispositivo"]');
    if (!input) throw new Error('Actual React photo input missing');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { name: file.name, size: file.size };
  }, marker);
}

export async function inspectSealedFieldDraft(page, { note, point, scopeId = null }) {
  const snapshot = await page.evaluate(async () => {
    const req = indexedDB.open('sedeagro-offline-sync', 2);
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => reject(new Error('Expected existing encrypted queue'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('pending-observations', 'readonly');
        const get = tx.objectStore('pending-observations').getAll();
        get.onsuccess = () => resolve(get.result.map(row => ({
          id: row.id, scope: row.scope, ivLength: row.sealed?.iv?.length,
          ciphertext: row.sealed?.ciphertext instanceof ArrayBuffer,
          sealedVersion: row.sealed?.version,
          keys: Object.keys(row).sort(),
          metadata: JSON.stringify({ id: row.id, scope: row.scope, createdAt: row.createdAt })
        })));
        get.onerror = () => reject(get.error);
      });
    } finally { db.close(); }
  });
  assert.equal(snapshot.length, 1, 'one field capture pending');
  const [row] = snapshot;
  assert.equal(row.sealedVersion, 1);
  assert.equal(row.ciphertext, true);
  assert.equal(row.ivLength, 12);
  assert.deepEqual(row.keys, ['createdAt', 'id', 'scope', 'sealed']);
  assert.ok(!row.metadata.includes(note) && !row.metadata.includes(String(point.coordinates[0])),
    'unencrypted metadata must exclude notes, GPS and image');
  if (scopeId) assert.equal(row.id, scopeId);
  return row.id;
}
