import { browser } from 'wxt/browser';
import type { Session, SessionColor } from '../../core/types';

type GroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

const GROUP_COLORS: Record<SessionColor, GroupColor> = {
  blue: 'blue',
  turquoise: 'cyan',
  green: 'green',
  yellow: 'yellow',
  orange: 'orange',
  red: 'red',
  pink: 'pink',
  purple: 'purple',
};

const KEY = 'tabGroups';

/**
 * Keeps each session's tabs in a Chrome tab group titled with the session name, one group per
 * window. Only groups created here are ever changed or emptied; the user's own groups are left
 * alone. The window/session → group map lives in session storage to survive worker restarts.
 */
export class TabGrouper {
  private map: Promise<Record<string, number>> = browser.storage.session
    .get(KEY)
    .then((r) => (r[KEY] as Record<string, number> | undefined) ?? {});

  private async save(map: Record<string, number>) {
    this.map = Promise.resolve(map);
    await browser.storage.session.set({ [KEY]: map });
  }

  /** Our group for `session` in `windowId`, if it still exists. */
  private async groupFor(windowId: number, session: Session): Promise<number | undefined> {
    const map = await this.map;
    const id = map[`${windowId}:${session.id}`];
    if (id === undefined) return undefined;
    const group = await browser.tabGroups.get(id).catch(() => null);
    if (group?.windowId === windowId) return id;
    delete map[`${windowId}:${session.id}`];
    await this.save(map);
    return undefined;
  }

  private async ours(groupId: number): Promise<boolean> {
    return Object.values(await this.map).includes(groupId);
  }

  /** The session whose group this is, or null for a group we didn't make. */
  async sessionOf(groupId: number): Promise<string | null> {
    const entry = Object.entries(await this.map).find(([, id]) => id === groupId);
    return entry ? entry[0].split(':')[1]! : null;
  }

  /** Tabs we just took out of one of our groups, so the background doesn't read it as a user drag. */
  private released = new Set<number>();

  /** True (once) if the tab's last ungroup was ours. */
  releasedByUs(tabId: number): boolean {
    return this.released.delete(tabId);
  }

  // Syncs run one at a time, so two tabs of a new session don't each create a group.
  private queue: Promise<unknown> = Promise.resolve();

  /** Put the tab in its session's group, or take it out of ours when it has no session. */
  sync(tabId: number, session: Session | undefined, enabled: boolean): Promise<void> {
    const run = this.queue.then(() => this.syncNow(tabId, session, enabled));
    this.queue = run.catch(() => {});
    return run;
  }

  private async syncNow(tabId: number, session: Session | undefined, enabled: boolean) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || tab.pinned || tab.windowId === undefined) return;
    const inGroup = tab.groupId !== undefined && tab.groupId !== -1;

    if (!session || !enabled) {
      if (inGroup && (await this.ours(tab.groupId!))) {
        this.released.add(tabId);
        await browser.tabs.ungroup(tabId).catch(() => this.released.delete(tabId));
      }
      return;
    }

    let groupId = await this.groupFor(tab.windowId, session);
    if (groupId === undefined) {
      groupId = await browser.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } }).catch(() => undefined);
      if (groupId === undefined) return;
      const map = await this.map;
      map[`${tab.windowId}:${session.id}`] = groupId;
      await this.save(map);
    } else if (tab.groupId !== groupId) {
      await browser.tabs.group({ tabIds: tabId, groupId }).catch(() => {});
    }
    await this.label(groupId, session);
  }

  private async label(groupId: number, session: Session) {
    const group = await browser.tabGroups.get(groupId).catch(() => null);
    const color = GROUP_COLORS[session.color];
    if (group && (group.title !== session.name || group.color !== color)) {
      await browser.tabGroups.update(groupId, { title: session.name, color }).catch(() => {});
    }
  }

  /** Drop map entries for deleted sessions (their tabs are ungrouped by `sync`). */
  async prune(sessions: Session[]) {
    const live = new Set(sessions.map((s) => s.id));
    const map = await this.map;
    const kept = Object.fromEntries(Object.entries(map).filter(([k]) => live.has(k.split(':')[1]!)));
    if (Object.keys(kept).length !== Object.keys(map).length) await this.save(kept);
  }
}
