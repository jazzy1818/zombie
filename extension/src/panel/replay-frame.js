import { cloudRecordingUrl } from './cloud-viewer.js';

// This page runs as the extension, so its iframe can reach the loopback bridge
// from an HTTPS website. Never turn this web-accessible page into a general
// local-network navigator: only the configured bridge's recording routes work.
const source = cloudRecordingUrl(new URL(location.href).searchParams.get('url'));
const message = document.querySelector('#message');
if (!source) {
  message.textContent = 'This recording link is not valid.';
} else {
  const player = document.createElement('iframe');
  player.title = 'Recording player';
  player.referrerPolicy = 'no-referrer';
  player.setAttribute('allow', 'autoplay; fullscreen');
  player.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  const origin = new URL(source).origin;
  window.addEventListener('message', event => {
    if (event.source !== player.contentWindow || event.origin !== origin) return;
    if (event.data?.type === 'browser-teacher-replay' && event.data.status === 'minimize') {
      parent.postMessage({ type: 'browser-teacher-replay', status: 'minimize' }, '*');
    }
  });
  player.addEventListener('load', () => { message.hidden = true; });
  player.addEventListener('error', () => {
    message.hidden = false;
    message.textContent = 'The recording player could not load. Check that the lesson service is running, or open the session in Steel.';
  });
  player.src = source;
  document.body.appendChild(player);
}
