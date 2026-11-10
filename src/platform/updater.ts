/**
 * Mac app only: checks GitHub for a newer signed release when the app starts
 * and offers it with a small notice. Nothing is downloaded until the player
 * agrees. The check fails quietly when there is no network.
 */
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const NOTICE_STYLE =
  'position:fixed;left:16px;bottom:16px;z-index:2147483646;display:flex;align-items:center;gap:16px;' +
  'padding:12px 16px;background:#141413;border:1px solid rgba(242,240,234,.18);border-radius:6px;' +
  'color:rgba(242,240,234,.86);font:400 14px/1.4 Geist,system-ui,sans-serif';
const BUTTON_STYLE =
  'height:32px;padding:0 12px;border-radius:4px;border:0;cursor:pointer;font:500 14px/1 Geist,system-ui,sans-serif';

function button(label: string, primary: boolean): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.style.cssText =
    BUTTON_STYLE +
    (primary
      ? ';background:#F2F0EA;color:#0E0E0D'
      : ';background:transparent;color:rgba(242,240,234,.55)');
  return element;
}

export async function offerUpdate(): Promise<void> {
  const update = await check();
  if (!update) return;

  const notice = document.createElement('div');
  notice.setAttribute('role', 'status');
  notice.style.cssText = NOTICE_STYLE;
  const text = document.createElement('span');
  text.textContent = `Ironvale ${update.version} is available.`;
  const install = button('Update and restart', true);
  const later = button('Later', false);
  notice.append(text, install, later);
  document.body.append(notice);

  later.addEventListener('click', () => notice.remove());
  install.addEventListener('click', () => {
    install.disabled = true;
    later.remove();
    let total = 0;
    let done = 0;
    update
      .downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        if (event.event === 'Progress') {
          done += event.data.chunkLength;
          text.textContent = total > 0 ? `Downloading ${Math.round((done / total) * 100)}%` : 'Downloading';
        }
        if (event.event === 'Finished') text.textContent = 'Restarting';
      })
      .then(() => relaunch())
      .catch((error: unknown) => {
        console.error('The update could not be installed', error);
        text.textContent = 'The update could not be installed. Try again later.';
        install.remove();
      });
  });
}
