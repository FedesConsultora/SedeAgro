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

// React state does not synchronously lock a submit event: two mobile taps in
// the same render can otherwise create two different offline UUIDs. The form
// holds successful writes until it closes; failed writes may retry. Identity
// comparison ensures an old Promise cannot unlock a newly opened form.
export function createMobileCaptureSubmitGate() {
  let active = null;
  return Object.freeze({
    acquire(ticket) {
      if (active || !ticket?.scope) return false;
      active = { ticket, committed: false };
      return true;
    },
    isHeld(ticket) {
      return Boolean(active && active.ticket === ticket);
    },
    settle(ticket, committed = false) {
      if (!active || active.ticket !== ticket) return false;
      if (committed) {
        active.committed = true;
      } else if (!active.committed) {
        active = null;
      }
      return true;
    },
    reset() {
      active = null;
    }
  });
}
