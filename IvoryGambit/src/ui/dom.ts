/**
 * A very small DOM helper.
 *
 * Not a framework. The interface here is a fixed set of panels whose contents change rarely —
 * a virtual DOM would be more code than the screens it renders, and would add a dependency to a
 * bundle whose whole selling point is that it loads instantly. `el()` and `setHtml()` cover
 * everything this game needs.
 */

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const $ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(selector);

export const $$ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(selector));

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Element, ...children: Child[]): void {
  clear(node);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** Escape text destined for an `innerHTML` template. */
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * Run a callback after the browser has laid out and painted.
 *
 * Two frames, not one. A single `requestAnimationFrame` fires *before* the paint that follows
 * the current style change, so adding a class in it lands in the same frame as the change it was
 * supposed to transition from — and the transition simply does not run.
 *
 * The timer is not a belt-and-braces extra; it is the only path that runs at all in a hidden
 * tab, where no animation frame is ever delivered. A page opened in a background tab — a
 * middle-clicked link, an iframe scrolled out of view on a portal page — would otherwise sit on
 * its loading screen forever, because the callback that removes it never fires. Whichever
 * arrives first wins, and the flag makes sure the work happens exactly once.
 */
export function afterPaint(fn: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 60);
}

/** Whether the visitor has asked for less motion. Honoured everywhere animations are optional. */
export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
