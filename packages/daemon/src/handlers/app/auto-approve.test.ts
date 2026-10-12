import { describe, expect, it } from 'vitest';

import type { AppContext } from './context.js';
import { AUTO_APPROVE_RETRY_MS, createAutoApprover, SAME_PROMPT_GRACE_MS, SECOND_READ_DELAY_MS } from './auto-approve.js';
import { flush, harness, id, NOW, seeded } from './testing.js';

const P1 = id('dddddddd', 1);
const P2 = id('dddddddd', 2);
const FRAME = '╭──────────────────╮';
const prompt = (command: string): string =>
    [FRAME, ' Bash command', '', `   ${command}`, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');

/** A harness whose panes show `screens` (one read each, the last repeating) and record every key sent. */
function rig(options: { readonly agent?: 'claude' | 'codex' | null } = {}) {
    let clock = NOW;
    let mono = 1_000;
    const h = harness({ initial: seeded(2), now: () => clock });
    if (options.agent !== null) {
        for (const pane of [P1, P2]) {
            h.send({ command: 'session-start', pane_id: pane, session_id: `s-${pane}`, agent: options.agent ?? 'claude' });
            // Kelpi's agent state shows the pane waiting, as Claude's hooks leave it while a prompt is open.
            h.send({ command: 'stop', pane_id: pane, background_tasks: 0 });
        }
    }
    const screens = new Map<string, string[]>();
    const keys: string[] = [];
    const ctx: AppContext = {
        ...h.ctx,
        term: {
            ...h.ctx.term,
            capture: (paneID) => {
                const queue = screens.get(paneID) ?? [];
                return (queue.length > 1 ? queue.shift() : queue[0]) ?? '$ ';
            }
        },
        input: {
            sendText: () => {},
            sendNamedKey: (paneID, key) => {
                keys.push(`${paneID}:${key}`);
            }
        }
    };
    const scheduled: { run: () => void; ms: number }[] = [];
    const approver = createAutoApprover({
        now: () => clock,
        monotonic: () => mono,
        schedule: (run, ms) => scheduled.push({ run, ms }),
        secondReadDelayMs: 0
    });
    return {
        h,
        ctx,
        keys,
        approver,
        scheduled,
        show: (paneID: string, ...texts: string[]) => screens.set(paneID, texts),
        /** Turn on and let its first check of every Claude pane finish. */
        on: async (minutes: number) => {
            approver.turnOn(minutes, ctx);
            await flush();
        },
        advance: (ms: number) => {
            clock += ms;
            mono += ms;
        },
        /** The wall clock alone moves, as when the system time is changed. */
        jumpWall: (ms: number) => {
            clock += ms;
        }
    };
}

describe('createAutoApprover', () => {
    it('presses Enter on a recognised prompt only while on', async () => {
        const r = rig();
        r.show(P1, prompt('git status'));
        expect(await r.approver.check(P1, r.ctx)).toBe('off');
        await r.on(10);
        expect(r.keys).toEqual([`${P1}:enter`]);
        expect(r.approver.status()).toMatchObject({ on: true, until: NOW + 600_000, approved: 1, left: [] });
    });

    it('leaves a never-auto-approve command for the user, once', async () => {
        const r = rig();
        await r.on(10);
        r.show(P1, prompt('rm -rf /tmp/kelpi-aa-test'));
        expect(await r.approver.check(P1, r.ctx)).toBe('never');
        expect(await r.approver.check(P1, r.ctx)).toBe('never');
        expect(r.keys).toEqual([]);
        expect(r.approver.status().left).toEqual([
            { paneID: P1, command: 'rm -rf /tmp/kelpi-aa-test', reason: 'never auto-approved: rm -r' }
        ]);
    });

    it('sends nothing when the prompt changed between the two reads', async () => {
        const r = rig();
        await r.on(10);
        r.show(P1, prompt('git status'), prompt('git push'));
        expect(await r.approver.check(P1, r.ctx)).toBe('changed');
        r.show(P1, prompt('git status'), '$ ');
        expect(await r.approver.check(P1, r.ctx)).toBe('changed');
        expect(r.keys).toEqual([]);
    });

    it('leaves a prompt it does not recognise', async () => {
        const r = rig();
        await r.on(10);
        r.show(P1, prompt('ls').replace(' ❯ 1. Yes', '   1. Yes').replace('   2. No', ' ❯ 2. No'));
        expect(await r.approver.check(P1, r.ctx)).toBe('unrecognised');
        expect(r.keys).toEqual([]);
        expect(r.approver.status().left).toEqual([{ paneID: P1, command: '', reason: 'prompt not recognised' }]);
    });

    it('answers only Bash prompts: MCP, Fetch and Edit prompts are left for the user', async () => {
        const r = rig();
        await r.on(10);
        const other = (header: string, body: string, question: string): string =>
            [FRAME, ` ${header}`, '', `   ${body}`, '', ` ${question}`, ' ❯ 1. Yes', '   2. No'].join('\n');
        r.show(P1, other('Tool use', 'github - create_issue(title: "x") (MCP)', 'Do you want to proceed?'));
        r.show(P2, other('Fetch', 'https://example.com', 'Do you want to proceed?'));
        r.approver.onNotification(P1, r.ctx);
        r.approver.onNotification(P2, r.ctx);
        await flush();
        r.show(P1, other('Edit file', 'src/a.ts', 'Do you want to make this edit to a.ts?'));
        expect(await r.approver.check(P1, r.ctx)).toBe('unrecognised');
        expect(r.keys).toEqual([]);
    });

    it('stops at expiry and on off', async () => {
        const r = rig();
        r.show(P1, prompt('git status'));
        r.approver.turnOn(1, r.ctx);
        await flush();
        r.advance(60_000);
        r.show(P1, prompt('git diff'));
        expect(await r.approver.check(P1, r.ctx)).toBe('off');
        expect(r.approver.status()).toMatchObject({ on: false, until: null, approved: 1 });
        // Off while turning on is mid-read: that read types nothing either.
        r.approver.turnOn(10, r.ctx);
        r.approver.turnOff();
        await flush();
        r.show(P1, prompt('git log'));
        expect(await r.approver.check(P1, r.ctx)).toBe('off');
        expect(r.keys).toEqual([`${P1}:enter`]);
    });

    it('skips panes without a live Claude session', async () => {
        const plain = rig({ agent: null });
        plain.approver.turnOn(10, plain.ctx);
        plain.show(P1, prompt('git status'));
        expect(await plain.approver.check(P1, plain.ctx)).toBe('not-claude');
        const ended = rig();
        await ended.on(10);
        ended.h.send({ command: 'session-end', pane_id: P1, session_id: `s-${P1}` });
        ended.show(P1, prompt('git status'));
        expect(await ended.approver.check(P1, ended.ctx)).toBe('not-claude');
        const codex = rig({ agent: 'codex' });
        codex.approver.turnOn(10, codex.ctx);
        codex.show(P1, prompt('git status'));
        expect(await codex.approver.check(P1, codex.ctx)).toBe('not-claude');
        // A live session whose agent kind is unknown (null, as older saved state holds) is not taken for Claude.
        const unknown = rig();
        const store = unknown.ctx.store;
        const real = store.getState.bind(store);
        const nullKind: AppContext = {
            ...unknown.ctx,
            store: Object.assign(Object.create(store) as typeof store, {
                getState: () => {
                    const state = real();
                    return { ...state, workspaces: state.workspaces.map((w) => ({ ...w, panes: w.panes.map((p) => ({ ...p, agentKind: null })) })) };
                }
            })
        };
        unknown.approver.turnOn(10, nullKind);
        await flush();
        unknown.show(P1, prompt('git status'));
        expect(await unknown.approver.check(P1, nullKind)).toBe('not-claude');
        expect(unknown.keys).toEqual([]);
    });

    it('acts only on a pane Kelpi shows waiting, never on a prompt drawn in output alone', async () => {
        const r = rig();
        for (const pane of [P1, P2]) r.h.send({ command: 'start', pane_id: pane, agent: 'claude' });
        // A file Claude printed looks exactly like a prompt, and turning on reads every Claude pane.
        r.show(P1, prompt('git status'));
        await r.on(10);
        expect(await r.approver.check(P1, r.ctx)).toBe('not-waiting');
        expect(r.keys).toEqual([]);
        // The prompt's own notification hook is agent state, so that prompt is answered.
        r.approver.onNotification(P1, r.ctx);
        await flush();
        expect(r.keys).toEqual([`${P1}:enter`]);
    });

    it('expires on the monotonic clock, whatever the wall clock does', async () => {
        const r = rig();
        await r.on(10);
        r.jumpWall(-3_600_000);
        r.advance(10 * 60_000);
        expect(r.approver.status().on).toBe(false);
        await r.on(10);
        r.jumpWall(24 * 3_600_000);
        expect(r.approver.status()).toMatchObject({ on: true, until: NOW - 40 * 60_000 });
        r.show(P1, prompt('git status'));
        expect(await r.approver.check(P1, r.ctx)).toBe('approved');
    });

    it('does not press Enter again on the same prompt straight after approving it', async () => {
        const r = rig();
        await r.on(10);
        r.show(P1, prompt('git status'));
        expect(await r.approver.check(P1, r.ctx)).toBe('approved');
        expect(await r.approver.check(P1, r.ctx)).toBe('repeat');
        r.advance(SAME_PROMPT_GRACE_MS);
        expect(await r.approver.check(P1, r.ctx)).toBe('approved');
    });

    it('answers the same command asked again, since a new notification means a new prompt', async () => {
        const r = rig();
        await r.on(10);
        r.show(P1, prompt('npm test'));
        r.approver.onNotification(P1, r.ctx);
        await flush();
        r.approver.onNotification(P1, r.ctx);
        await flush();
        expect(r.keys).toEqual([`${P1}:enter`, `${P1}:enter`]);
    });

    it('re-reads a half-drawn prompt instead of leaving it for the user', async () => {
        const r = rig();
        await r.on(10);
        r.show(P1, prompt('ls').replace(' ❯ 1. Yes', '   1. Yes'), prompt('ls'));
        r.approver.onNotification(P1, r.ctx);
        await flush();
        expect(r.keys).toEqual([]);
        r.scheduled.shift()?.run();
        await flush();
        expect(r.keys).toEqual([`${P1}:enter`]);
        expect(r.approver.status().left).toEqual([]);
    });

    it('re-reads a pane whose prompt is not drawn yet when the notification arrives', async () => {
        const r = rig();
        await r.on(10);
        r.approver.onNotification(P2, r.ctx);
        await flush();
        expect(r.scheduled.map((entry) => entry.ms)).toEqual([AUTO_APPROVE_RETRY_MS[0]]);
        r.show(P2, prompt('npm test'));
        r.scheduled.shift()?.run();
        await flush();
        expect(r.keys).toEqual([`${P2}:enter`]);
        expect(r.scheduled).toEqual([]);
    });
});

describe('auto-approve command', () => {
    it('turns on for the default 10 minutes, reports, and turns off', () => {
        const h = harness({ initial: seeded(1) });
        expect(h.reply({ command: 'auto-approve', action: 'status' })).toEqual({ ok: true, on: false, until: null, approved: 0, left: [] });
        expect(h.reply({ command: 'auto-approve', action: 'on' })).toMatchObject({ on: true, until: new Date(NOW + 600_000).toISOString() });
        expect(h.reply({ command: 'auto-approve', action: 'on', minutes: 90 })).toMatchObject({ until: new Date(NOW + 90 * 60_000).toISOString() });
        expect(h.reply({ command: 'auto-approve', action: 'off' })).toMatchObject({ on: false, until: null });
    });

    it('is fed by the notification hook, even while turning on is still reading the pane', async () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'session-start', pane_id: P1, session_id: 's-1', agent: 'claude' });
        let screen = '$ ';
        const keys: string[] = [];
        const ctx: AppContext = {
            ...h.ctx,
            term: { ...h.ctx.term, capture: () => screen },
            input: { sendText: () => {}, sendNamedKey: (paneID, key) => keys.push(`${paneID}:${key}`) }
        };
        h.table.get('auto-approve')?.({ command: 'auto-approve', action: 'on', minutes: 5 }, ctx, null);
        screen = prompt('git status');
        h.table.get('notification')?.({ command: 'notification', pane_id: P1, title: 'Claude Code', body: 'Claude needs your permission to use Bash', background_tasks: 0 }, ctx, null);
        await flush();
        expect(keys).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, (AUTO_APPROVE_RETRY_MS[0] ?? 0) + 2 * SECOND_READ_DELAY_MS + 100));
        expect(keys).toEqual([`${P1}:enter`]);
    });
});
