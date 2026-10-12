import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every payload sent to the daemon: a help request must send none. */
const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
/** The calling pane, or null outside Kelpi (where `requirePaneID` exits 0 silently). */
const pane = vi.hoisted(() => ({ id: 'DDDDDDDD-0000-4000-8000-0000000000C5' as string | null }));
vi.mock('../transport.js', async (original) => ({
    ...(await original<object>()),
    sendJSON: (payload: Record<string, unknown>) => {
        sent.push(payload);
        return Promise.resolve();
    }
}));
vi.mock('../env.js', async (original) => ({
    ...(await original<object>()),
    requirePaneID: () => {
        if (pane.id === null) exit(0);
        return pane.id;
    }
}));

import { exit, resetIO, setIO } from '../io.js';
import { handleLayout } from './layout.js';

let out = '';

beforeEach(() => {
    out = '';
    setIO({ out: (text) => (out += text), err: () => undefined });
});
afterEach(() => {
    sent.length = 0;
    pane.id = 'DDDDDDDD-0000-4000-8000-0000000000C5';
    resetIO();
});

describe('kelpi layout --help', () => {
    it.each([['--help'], ['-h'], ['help']])('should print the layout help for %s', async (token) => {
        await expect(handleLayout([token])).rejects.toMatchObject({ code: 0 });
        expect(out).toContain('kelpi layout cycle|select');
        expect(sent).toEqual([]);
    });

    it.each([['cycle'], ['select']])('should print help for %s and send nothing', async (action) => {
        await expect(handleLayout([action, '--help'])).rejects.toMatchObject({ code: 0 });
        expect(out).toContain(`kelpi layout ${action}`);
        expect(sent).toEqual([]);
    });

    it.each([[['--help']], [['cycle', '--help']], [['select', '--help']]])(
        'should print help for %j outside a Kelpi pane',
        async (args) => {
            pane.id = null;
            await expect(handleLayout(args)).rejects.toMatchObject({ code: 0 });
            expect(out).toContain('kelpi layout');
        }
    );

    it('should still cycle without a help flag', async () => {
        await handleLayout(['cycle']);
        expect(sent).toEqual([{ command: 'layout-cycle', pane_id: 'DDDDDDDD-0000-4000-8000-0000000000C5' }]);
    });
});
