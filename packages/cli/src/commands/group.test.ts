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
import { handleGroup } from './group.js';
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

describe('kelpi group <subcommand> --help', () => {
    it.each([['create'], ['rename'], ['delete']])('should print help for %s and send nothing', async (action) => {
        await expect(handleGroup([action, '--help'])).rejects.toMatchObject({ code: 0 });
        expect(out).toContain(`kelpi group ${action}`);
        expect(sent).toEqual([]);
    });

    it('should print help for -h after a name', async () => {
        await expect(handleGroup(['create', 'work', '-h'])).rejects.toMatchObject({ code: 0 });
        expect(out).toContain('kelpi group create');
        expect(sent).toEqual([]);
    });

    it('should still create a group from a plain name', async () => {
        await handleGroup(['create', 'work', '--color', 'blue']);
        expect(sent).toEqual([{ command: 'group-create', name: 'work', color: 'blue' }]);
    });

    it('should treat a name after -- as a name, so a group called --help can be deleted', async () => {
        await handleGroup(['delete', '--', '--help']);
        expect(sent).toEqual([{ command: 'group-delete', name: '--help', cascade: false }]);
    });
});

describe('kelpi layout select --help', () => {
    it('should print help and send nothing', async () => {
        await expect(handleLayout(['select', '--help'])).rejects.toMatchObject({ code: 0 });
        expect(out).toContain('kelpi layout select');
        expect(sent).toEqual([]);
    });

    it('should print help outside a Kelpi pane', async () => {
        pane.id = null;
        await expect(handleLayout(['select', '--help'])).rejects.toMatchObject({ code: 0 });
        expect(out).toContain('kelpi layout select');
    });
});
