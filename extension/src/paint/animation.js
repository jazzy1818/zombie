// Cancellation resolves false internally; public Contract 3 methods resolve void.
export function tween(duration, update) {
  let frame = 0;
  let finished = false;
  let settle;
  const promise = new Promise(resolve => { settle = resolve; });
  const finish = completed => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    settle(completed);
  };
  const start = performance.now();
  const tick = now => {
    if (finished) return;
    const progress = duration ? Math.min(1, (now - start) / duration) : 1;
    if (update(progress) === false) return finish(false);
    if (progress === 1) finish(true);
    else frame = requestAnimationFrame(tick);
  };
  if (duration === 0) tick(start);
  else frame = requestAnimationFrame(tick);
  return { promise, cancel: () => finish(false) };
}

export const ease = t => 1 - (1 - t) ** 3;
