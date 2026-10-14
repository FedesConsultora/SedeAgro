// Storage estimates are advisory; IndexedDB is authoritative and can reject
// a write even with apparently sufficient available space.
export async function browserStorageStatus(browserNavigator = typeof navigator === 'undefined' ? null : navigator) {
  const storage = browserNavigator?.storage;
  if (!storage?.estimate) return { supported: false, quota: null, usage: null, persisted: null };
  const [estimate, persisted] = await Promise.all([
    storage.estimate(), storage.persisted?.() ?? Promise.resolve(null)
  ]);
  return {
    supported: true,
    quota: Number.isFinite(estimate.quota) ? estimate.quota : null,
    usage: Number.isFinite(estimate.usage) ? estimate.usage : null,
    persisted
  };
}

export async function requestDurableStorage(browserNavigator = typeof navigator === 'undefined' ? null : navigator) {
  if (!browserNavigator?.storage?.persist) {
    throw new Error('El navegador no admite protección contra eliminación automática de datos.');
  }
  // Called ONLY from an explicit "Proteger almacenamiento" button.
  return browserNavigator.storage.persist();
}

export function assertStorageCapacity(info, reservedBytes = 128 * 1024) {
  if (info.quota !== null && info.usage !== null &&
      info.quota - info.usage < reservedBytes) {
    throw new Error('Queda muy poco espacio en este dispositivo para guardar observaciones. Liberá almacenamiento o enviá pendientes.');
  }
}
