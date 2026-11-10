type Child = Node | string | null | undefined | false;

/** Create an element with a class and children. Strings become text nodes. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

export function setAttrs<T extends Element>(element: T, attrs: Readonly<Record<string, string>>): T {
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  return element;
}

/**
 * A text slot that only touches the DOM when the value changes. The HUD gets
 * snapshots twenty times a second and most of them repeat the last one.
 */
export interface TextSlot {
  readonly element: HTMLElement;
  set(value: string): void;
}

export function textSlot<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, initial = ''): TextSlot {
  const node = document.createTextNode(initial);
  const element = h(tag, className, node);
  let current = initial;
  return {
    element,
    set(value: string): void {
      if (value === current) return;
      current = value;
      node.data = value;
    },
  };
}

/** Toggle a class or attribute only when the state changes. */
export function flag(apply: (on: boolean) => void, initial = false): (on: boolean) => void {
  let current = initial;
  return (on: boolean): void => {
    if (on === current) return;
    current = on;
    apply(on);
  };
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Small JSON store in localStorage for interface state. Falls back to memory when storage is blocked. */
export function readStored<T extends object>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaults;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return defaults;
    const merged: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
    for (const [name, fallback] of Object.entries(defaults)) {
      const value = (data as Record<string, unknown>)[name];
      if (value !== undefined && typeof value === typeof fallback) merged[name] = value;
    }
    return merged as T;
  } catch {
    return defaults;
  }
}

export function writeStored(key: string, value: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn('Could not save interface state', error);
  }
}
