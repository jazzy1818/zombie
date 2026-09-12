export function abortError(message = 'Teaching cancelled') {
  return new DOMException(message, 'AbortError');
}

export function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || abortError();
}

export function abortable(value, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason || abortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(
      result => { cleanup(); resolve(result); },
      error => { cleanup(); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

export function delay(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason || abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
