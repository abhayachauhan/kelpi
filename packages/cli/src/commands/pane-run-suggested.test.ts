import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every payload sent, and the replies the fake daemon gives per command. */
const state = vi.hoisted(() => ({
    sent: [] as Record<string, unknown>[],
    capture: '',
    statuses: [] as string[],
    screens: [] as string[],
    workspace: 'W' as string | undefined,
    answer: true
}));
vi.mock('../reply.js', async (original) => ({
    ...(await original<object>()),
    decodeReply: (payload: Record<string, unknown>) => {
        state.sent.push(payload);
        switch (payload['command']) {
            case 'pane-capture':
                // The first capture reads the suggestion; a later one of the source can show a new screen.
                return Promise.resolve({
                    ok: true,
                    pane_id: payload['target'] ?? SOURCE,
                    workspace_id: state.workspace,
                    text: payload['scrollback'] === true ? state.capture : (state.screens.shift() ?? state.capture)
                });
            case 'pane-list':
                if (payload['workspace'] === '') return Promise.resolve({ ok: false, error: 'workspace not found: ' });
                return Promise.resolve({
                    ok: true,
                    panes: [{ id: SOURCE, agent: 'claude', agent_session_id: 'S', status: state.statuses.shift() ?? 'idle', working_directory: '/repo' }]
                });
            case 'pane-split':
                return Promise.resolve({ ok: true, pane_id: 'NEW' });
            default:
                return Promise.resolve({ ok: true });
        }
    }
}));
vi.mock('../confirm.js', () => ({ confirm: () => Promise.resolve(state.answer) }));

import { ExitError, resetIO, setIO } from '../io.js';
import { handlePane } from './pane.js';

const SOURCE = 'AAAAAAAA-0000-4000-8000-0000000000C1';
const RULE = '─'.repeat(60);
const BANG = ['  Log in first:', '', '  ! aws sso login --profile', '  Serve-SuperAdmin-103639821168', '', '  Then retry.', RULE, '> ', RULE].join('\n');
const PERMISSION = [BANG, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', RULE].join('\n');
const FENCE = ['Run these:', '```bash', 'echo one', 'echo two', '```'].join('\n');

const run = (...args: string[]): Promise<void> => handlePane(['run-suggested', '--target', SOURCE, ...args]);
const sends = (): Record<string, unknown>[] => state.sent.filter((payload) => payload['command'] === 'pane-send');

describe('kelpi pane run-suggested', () => {
    let out: string[];

    beforeEach(() => {
        out = [];
        setIO({ out: (text) => out.push(text), err: () => undefined });
    });
    afterEach(() => {
        state.sent.length = 0;
        state.statuses.length = 0;
        state.screens.length = 0;
        state.workspace = 'W';
        state.answer = true;
        resetIO();
    });

    it('types a one-line ! command into the idle Claude session as "! <command>"', async () => {
        state.capture = BANG;
        await run();
        expect(out.join('')).toContain('aws sso login --profile Serve-SuperAdmin-103639821168\n');
        expect(sends()).toEqual([
            { command: 'pane-send', target: SOURCE, text: '! aws sso login --profile Serve-SuperAdmin-103639821168', bare: false }
        ]);
    });

    it('runs a multi-line command in a new shell pane in the same directory, never the session', async () => {
        state.capture = FENCE;
        await run();
        expect(state.sent).toContainEqual({ command: 'pane-split', target: SOURCE, focus: true, path: '/repo' });
        expect(sends()).toEqual([{ command: 'pane-send', target: 'NEW', text: 'echo one\necho two', bare: false }]);
    });

    it('runs a ! command continued with \\ in a new shell pane, whether it spans lines or not', async () => {
        state.capture = ['  ! docker run \\', '    --rm alpine', '', RULE, '> ', RULE].join('\n');
        await run();
        expect(sends()).toEqual([{ command: 'pane-send', target: 'NEW', text: 'docker run \\\n  --rm alpine', bare: false }]);

        state.sent.length = 0;
        state.capture = ['  ! docker run \\', '', RULE, '> ', RULE].join('\n');
        await run();
        expect(sends()).toEqual([{ command: 'pane-send', target: 'NEW', text: 'docker run \\', bare: false }]);
    });

    it('looks the pane up in every workspace when the capture names none', async () => {
        state.capture = BANG;
        state.workspace = undefined;
        await run();
        expect(state.sent).toContainEqual({ command: 'pane-list' });
        expect(sends()).toEqual([expect.objectContaining({ target: SOURCE })]);
    });

    it('runs a ! command in a new pane when Claude is busy', async () => {
        state.capture = BANG;
        state.statuses.push('running');
        await run();
        expect(sends()).toEqual([expect.objectContaining({ target: 'NEW' })]);
    });

    it('sends nothing when Claude starts working before the answer', async () => {
        state.capture = BANG;
        state.statuses.push('idle', 'running');
        await expect(run()).rejects.toThrow(ExitError);
        expect(sends()).toEqual([]);
    });

    it('never types into a permission prompt, before or after the answer', async () => {
        state.capture = PERMISSION;
        await run();
        expect(sends()).toEqual([expect.objectContaining({ target: 'NEW' })]);

        state.sent.length = 0;
        state.capture = BANG;
        state.screens.push(PERMISSION);
        await expect(run()).rejects.toThrow(ExitError);
        expect(sends()).toEqual([]);
    });

    it('sends nothing when the answer is no, and only prints with --print', async () => {
        state.capture = BANG;
        state.answer = false;
        await expect(run()).rejects.toThrow(ExitError);
        expect(sends()).toEqual([]);

        state.sent.length = 0;
        out.length = 0;
        await run('--print');
        expect(out.join('')).toBe('aws sso login --profile Serve-SuperAdmin-103639821168\n');
        expect(state.sent.map((payload) => payload['command'])).toEqual(['pane-capture']);
    });

    it('fails when the pane shows no suggested command', async () => {
        state.capture = 'All tests pass.';
        await expect(run()).rejects.toThrow(ExitError);
        expect(sends()).toEqual([]);
    });
});
