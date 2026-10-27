interface Entry {
  name: string;
  value: string;
}

/**
 * The document's view of its session cookies: seeded from the background's snapshot for this
 * URL, updated optimistically on writes so `document.cookie` reads back immediately.
 */
export class CookieView {
  private entries: Entry[] = [];

  constructor(snapshot: string) {
    this.reset(snapshot);
  }

  reset(snapshot: string): void {
    this.entries = snapshot
      ? snapshot.split('; ').map((pair) => {
          const i = pair.indexOf('=');
          return i < 0 ? { name: '', value: pair } : { name: pair.slice(0, i), value: pair.slice(i + 1) };
        })
      : [];
  }

  toString(): string {
    return this.entries.map((e) => (e.name ? `${e.name}=${e.value}` : e.value)).join('; ');
  }

  get(name: string): string | undefined {
    return this.entries.find((e) => e.name === name)?.value;
  }

  list(): Entry[] {
    return [...this.entries];
  }

  /** Apply a `document.cookie = ...` write. Path/domain scoping is left to the background jar. */
  apply(setCookie: string): void {
    const [pair = '', ...attrs] = setCookie.split(';');
    const i = pair.indexOf('=');
    const name = (i < 0 ? '' : pair.slice(0, i)).trim();
    const value = (i < 0 ? pair : pair.slice(i + 1)).trim();
    let expired = false;
    for (const attr of attrs) {
      const [k = '', v = ''] = attr.split('=').map((s) => s.trim());
      const key = k.toLowerCase();
      if (key === 'max-age' && Number(v) <= 0) expired = true;
      if (key === 'expires' && Date.parse(v) <= Date.now()) expired = true;
      if (key === 'httponly') return; // not settable from script
    }
    this.entries = this.entries.filter((e) => e.name !== name);
    if (!expired) this.entries.push({ name, value });
  }
}
