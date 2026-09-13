// SHARED — Contract 4. The panel supplies semantic targets; paint receives
// actual, current-document Elements. No method activates the host website.
import { createTeaching } from './teaching/controller.js';

window.__TEACH = createTeaching({
  paint: window.__PAINT,
  resolver: () => window.__RESOLVE,
});
