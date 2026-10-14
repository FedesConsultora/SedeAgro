// A scoped request must not transmit HTTP success until its database transaction commits.
// The app currently returns small buffered JSON payloads; streaming is deliberately rejected.
export function deferResponseUntilTransactionSettles(req, res, next, transaction, logger) {
  const originals = {
    end: res.end,
    write: res.write,
    writeHead: res.writeHead,
    flushHeaders: res.flushHeaders
  };
  let state = 'open';

  function restore() {
    res.end = originals.end;
    res.write = originals.write;
    res.writeHead = originals.writeHead;
    res.flushHeaders = originals.flushHeaders;
  }

  function resetUnsentResponse() {
    if (res.headersSent) return;
    for (const header of ['content-length', 'content-type', 'content-encoding', 'etag']) {
      res.removeHeader(header);
    }
    res.statusCode = 500;
  }

  function reportFailure(error, stage) {
    logger.error('db.tenant_transaction_finalize_failed', {
      request_id: req.requestId,
      stage,
      error
    });
  }

  async function settle(mode, args = [], blockedError = null) {
    try {
      if (mode === 'commit') await transaction.commit();
      else await transaction.rollback();

      state = 'settled';
      restore();

      if (res.destroyed) return;
      if (blockedError) {
        resetUnsentResponse();
        next(blockedError);
      } else {
        originals.end.apply(res, args);
      }
    } catch (error) {
      reportFailure(error, mode);
      if (!transaction.finished) {
        await transaction.rollback().catch((rollbackError) => reportFailure(rollbackError, 'rollback_after_failure'));
      }
      state = 'settled';
      restore();
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      resetUnsentResponse();
      next(error);
    }
  }

  function initiate(mode, args = [], blockedError = null) {
    if (state !== 'open') return;
    state = 'settling';
    void settle(mode, args, blockedError);
  }

  function blockStreaming(operation) {
    const error = new Error(`Tenant-scoped HTTP responses cannot use ${operation} before commit.`);
    initiate('rollback', [], error);
  }

  res.end = function transactionalEnd(...args) {
    if (state === 'open') {
      initiate(res.statusCode < 400 ? 'commit' : 'rollback', args);
    }
    return this;
  };

  res.write = function transactionalWrite() {
    blockStreaming('res.write');
    return false;
  };

  res.writeHead = function transactionalWriteHead() {
    blockStreaming('res.writeHead');
    return this;
  };

  res.flushHeaders = function transactionalFlushHeaders() {
    blockStreaming('res.flushHeaders');
  };

  // If the client disconnects before response finalization, discard the transaction.
  res.once('close', () => {
    if (state === 'open') initiate('rollback');
  });
}
