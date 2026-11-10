import type { GameContext } from '../../game/contracts';
import { button, section } from '../controls';
import { buildCredits, CC_BY_URL, creditSentence, type CreditGroup, type CreditThanks } from '../credits-model';
import { h, setAttrs } from '../dom';
import '../styles/sheet.css';
import '../styles/credits.css';

const URL_PATTERN = /(https?:\/\/[^\s),;]*[^\s),;.])/;
/** Distance one press of an arrow key scrolls the list. */
const LINE_SCROLL = 80;

export interface CreditsScreen {
  readonly element: HTMLElement;
}

function link(url: string, label = url.replace(/^https?:\/\//, '').replace(/\/$/, '')): HTMLAnchorElement {
  return setAttrs(h('a', 'iv-credits__link', label), { href: url, target: '_blank', rel: 'noopener noreferrer' });
}

/** Text with every web address in it turned into a link. */
function linked(text: string): (HTMLElement | string)[] {
  return text.split(URL_PATTERN).map((part, index) => (index % 2 === 1 ? link(part) : part));
}

function thanksRow(row: CreditThanks): HTMLElement {
  return h(
    'li',
    'iv-credits__row',
    h('span', 'iv-credits__name', row.url ? link(row.url, row.name) : row.name),
    h('span', 'iv-credits__note', row.note),
    h('span', 'iv-credits__licence', row.licence),
  );
}

function groupSection(group: CreditGroup): HTMLElement {
  const credited = group.credited.map((line) => h('li', 'iv-credits__line', ...linked(creditSentence(line))));
  const list = h('ul', 'iv-credits__list', ...credited, ...group.thanks.map(thanksRow));
  const { element, meta } = section(group.title, list);
  meta.textContent = String(group.count);
  return element;
}

/** Everyone whose work is in the game, built from the asset manifests so it cannot fall out of date. */
export function createCredits(ctx: GameContext, actions: { close(): void }): CreditsScreen {
  const groups = buildCredits(ctx.assets.manifest);
  const body = setAttrs(
    h(
      'div',
      'iv-sheet__body iv-credits',
      h(
        'p',
        'iv-credits__intro',
        'Ironvale is built from work other people gave away. Models and recordings under ',
        link(CC_BY_URL, 'CC BY 4.0'),
        ' are credited in full below, with the changes made to each. Sources that ask for no credit are thanked by site.',
      ),
      ...groups.map(groupSection),
    ),
    { tabindex: '0', role: 'region', 'aria-label': 'Credits list', 'data-nav': '' },
  );
  // Arrow keys scroll the list while it has focus, and move on to Back once it reaches an end.
  body.addEventListener('keydown', (event) => {
    if (event.target !== body || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    const down = event.key === 'ArrowDown';
    const atEnd = down ? body.scrollTop + body.clientHeight >= body.scrollHeight - 1 : body.scrollTop <= 0;
    if (atEnd) return;
    event.preventDefault();
    body.scrollBy({ top: down ? LINE_SCROLL : -LINE_SCROLL });
  });

  const back = button('Back', 'ghost', actions.close);
  back.setAttribute('data-nav-default', '');
  const element = h(
    'div',
    'iv-screen iv-sheet',
    h(
      'div',
      'iv-sheet__panel',
      h('header', 'iv-sheet__head', h('h2', 'iv-headline', 'Credits')),
      body,
      h(
        'footer',
        'iv-sheet__foot',
        back,
        h('span', 'iv-keys', h('span', '', h('b', '', 'Up'), ' and ', h('b', '', 'Down'), ' scroll'), h('span', '', h('b', '', 'Esc'), ' back')),
      ),
    ),
  );
  return { element };
}
