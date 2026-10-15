// Fence for lengthy mobile photo preparation. The current React identity/run
// can be invalidated while Canvas decodes an image or IndexedDB is opening.
// Tokens are local to one form instance and never contain credentials or GPS.
export function createMobileCaptureFence(scope = null) {
  let generation = 0;
  let currentScope = scope;
  return Object.freeze({
    setScope(nextScope) {
      if (nextScope !== currentScope) {
        currentScope = nextScope;
        generation += 1;
      }
    },
    invalidate() {
      generation += 1;
      currentScope = null;
    },
    ticket() {
      return Object.freeze({ generation, scope: currentScope });
    },
    isCurrent(ticket) {
      return Boolean(ticket && ticket.scope && ticket.scope === currentScope &&
        ticket.generation === generation);
    }
  });
}
