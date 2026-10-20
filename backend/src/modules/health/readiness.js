// A health probe is not a session and must not expose database details.
// Coalesce concurrent checks and cap upstream DB concurrency to ONE even when a
// query remains unresolved after an HTTP-facing timeout.
export function createReadinessProbe({
  check, now = () => Date.now(), ttlMs = 2000, timeoutMs = 1500
} = {}) {
  if (typeof check !== 'function' || !Number.isSafeInteger(ttlMs) ||
      !Number.isSafeInteger(timeoutMs) || ttlMs < 1 || ttlMs > 10000 ||
      timeoutMs < 1 || timeoutMs > 10000) {
    throw new TypeError('Invalid readiness probe configuration');
  }
  let cached = null;
  let expiry = 0;
  let responseInFlight = null;
  let databaseInFlight = null;

  function sharedDatabaseCheck() {
    if (!databaseInFlight) {
      databaseInFlight = Promise.resolve().then(check).then(
        () => true,
        () => false
      ).finally(() => { databaseInFlight = null; });
    }
    return databaseInFlight;
  }

  async function boundedCheck() {
    let timer;
    try {
      return await Promise.race([
        sharedDatabaseCheck(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return function probe() {
    if (responseInFlight) return responseInFlight;
    if (cached !== null && now() < expiry) return Promise.resolve(cached);
    responseInFlight = boundedCheck().then((ready) => {
      cached = ready;
      expiry = now() + ttlMs;
      responseInFlight = null;
      return ready;
    }, () => {
      cached = false;
      expiry = now() + ttlMs;
      responseInFlight = null;
      return false;
    });
    return responseInFlight;
  };
}
