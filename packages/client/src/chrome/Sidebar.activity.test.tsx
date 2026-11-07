import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import type { ChromePane, ChromeSidebarEntry, ChromeWorkspace } from './types';
import { workspaceActivity, WORKSPACE_DENSITY_KEY } from './workspace-activity';

afterEach(() => { cleanup(); window.localStorage.clear(); });
function pane(id: string, status: ChromePane['status'], agentKind: ChromePane['agentKind'] = 'codex'): ChromePane {
    return { id, status, agentKind, type: 'shell', label: null, title: null, workingDirectory: '/repo', gitBranch: 'main', agentSessionID: id, agentStartedAt: null, backgroundTaskCount: 0 };
}
function workspace(id: string, name: string, panes: ChromePane[]): ChromeWorkspace {
    return { id, name, panes, color: 'blue', icon: null, labels: [] };
}
const running = workspace('running', 'Validate the release', [pane('r', 'running')]);
const waiting = workspace('waiting', 'Review payment fixes', [pane('w', 'waitingForInput', 'claude'), pane('w2', 'running')]);
const idle = workspace('idle', 'Schema rollout', [pane('i', 'idle', 'claude')]);
const nested = workspace('nested', 'Check the schema', [pane('n', 'running')]);
function entries(): ChromeSidebarEntry[] {
    return [{ kind: 'workspace', workspace: running }, { kind: 'group', group: { id: 'group', name: 'Platform', color: 'blue', icon: null, isCollapsed: true }, workspaces: [waiting, idle], nested: new Map([['idle', [nested]]]) }];
}
const ids = () => screen.queryAllByTestId('workspace-row').map(row => row.dataset.workspaceId);
function props() { return { entries: entries(), activeWorkspaceID: 'running', filter: '', onFilterChange: vi.fn(), onActivateWorkspace: vi.fn(), onMoveWorkspace: vi.fn() }; }
function filter(state: string) { return screen.getByRole('group', { name: 'Filter workspace activity' }).querySelector(`[data-activity-filter="${state}"]`)!; }

describe('readable workspace navigation', () => {
    it('summarises mixed agent activity, prioritises questions and never treats idle as done', () => {
        expect(workspaceActivity(waiting)).toEqual({ state: 'waiting', label: '1 waiting · 1 running', tools: 'Claude + Codex' });
        expect(workspaceActivity(idle)).toEqual({ state: 'idle', label: 'Idle', tools: 'Claude' });
        expect(workspaceActivity(workspace('shell', 'Shell', [pane('s', 'idle', null)]))).toEqual({ state: 'idle', label: 'Idle', tools: '' });
        const nonShell = { ...pane('web', 'running'), type: 'web' as const };
        expect(workspaceActivity(workspace('web', 'Web', [nonShell])).state).toBe('running');
    });
    it('counts all workspaces including collapsed groups and nested children without changing saved order', () => {
        const p = props(); render(<Sidebar {...p} />);
        expect(filter('all').textContent).toBe('All 4');
        expect(filter('waiting').textContent).toBe('Waiting 1');
        expect(filter('running').textContent).toBe('Running 2');
        expect(ids()).toEqual(['running']);
        fireEvent.click(filter('waiting'));
        expect(ids()).toEqual(['waiting']);
        expect(screen.getByTestId('row-group-caption').textContent).toBe('in Platform');
        expect(screen.getByTestId('workspace-row').textContent).toContain('1 waiting · 1 running');
        fireEvent.click(filter('running'));
        expect(ids()).toEqual(['running', 'nested']);
        expect(screen.getByTestId('row-group-caption').textContent).toBe('in Schema rollout');
        fireEvent.click(filter('all'));
        expect(ids()).toEqual(['running']);
        expect(p.onMoveWorkspace).not.toHaveBeenCalled();
    });
    it('combines text and activity filters and follows status updates without remounting', () => {
        const p = props(); const view = render(<Sidebar {...p} filter="Review" />);
        fireEvent.click(filter('waiting')); expect(ids()).toEqual(['waiting']);
        view.rerender(<Sidebar {...p} filter="Schema" />); expect(ids()).toEqual([]);
        view.rerender(<Sidebar {...p} entries={[{ kind: 'workspace', workspace: { ...idle, panes: [pane('i', 'waitingForInput')] } }]} filter="Schema" />);
        expect(ids()).toEqual(['idle']); expect(filter('waiting').textContent).toBe('Waiting 1');
    });
    it('activates the selected workspace and clears both filters with click or Enter', () => {
        const p = props(); render(<Sidebar {...p} />);
        fireEvent.click(filter('waiting')); fireEvent.click(screen.getByTestId('workspace-row'));
        expect(p.onActivateWorkspace.mock.calls).toEqual([['waiting']]); expect(p.onFilterChange).toHaveBeenLastCalledWith('');
        expect(filter('all').getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(filter('idle')); fireEvent.keyDown(screen.getByTestId('sidebar-filter'), { key: 'Enter' });
        expect(p.onActivateWorkspace).toHaveBeenLastCalledWith('idle'); expect(filter('all').getAttribute('aria-pressed')).toBe('true');
    });
    it('persists compact density and restores larger rows without touching workspace data', () => {
        const p = props(); const view = render(<Sidebar {...p} />);
        expect(screen.getByTestId('sidebar').dataset.workspaceDensity).toBe('comfortable');
        fireEvent.click(screen.getByRole('button', { name: 'Use compact workspace rows' }));
        expect(window.localStorage.getItem(WORKSPACE_DENSITY_KEY)).toBe('compact');
        view.unmount(); render(<Sidebar {...p} />);
        expect(screen.getByTestId('sidebar').dataset.workspaceDensity).toBe('compact');
        fireEvent.click(screen.getByRole('button', { name: 'Use larger workspace rows' }));
        expect(screen.getByTestId('sidebar').dataset.workspaceDensity).toBe('comfortable');
        expect(p.onMoveWorkspace).not.toHaveBeenCalled();
        expect(within(screen.getByRole('group', { name: 'Filter workspace activity' })).getAllByRole('button')).toHaveLength(4);
    });
    it('does not move or nest workspaces while an activity filter hides other rows', () => {
        const p = props(); const onNestWorkspaces = vi.fn();
        render(<Sidebar {...p} onNestWorkspaces={onNestWorkspaces} />);
        fireEvent.click(filter('running'));
        const row = screen.getAllByTestId('workspace-row')[0]!;
        fireEvent.mouseDown(row, { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 100 });
        fireEvent.mouseUp(window);
        expect(p.onMoveWorkspace.mock.calls).toEqual([]);
        expect(onNestWorkspaces.mock.calls).toEqual([]);
        expect(ids()).toEqual(['running', 'nested']);
    });
    it('Escape clears activity and text and still works when browser storage is unavailable', () => {
        const storage = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('Storage unavailable'); });
        try {
            const p = props(); render(<Sidebar {...p} filter="Review" />);
            fireEvent.click(screen.getByRole('button', { name: 'Use compact workspace rows' }));
            expect(screen.getByTestId('sidebar').dataset.workspaceDensity).toBe('compact');
            fireEvent.click(filter('waiting'));
            fireEvent.keyDown(screen.getByTestId('sidebar-filter'), { key: 'Escape' });
            expect(filter('all').getAttribute('aria-pressed')).toBe('true');
            expect(p.onFilterChange).toHaveBeenLastCalledWith('');
            expect(p.onActivateWorkspace.mock.calls).toEqual([]);
        } finally { storage.mockRestore(); }
    });

    it('matches native row dots for manually marked workspaces', () => {
        expect(workspaceActivity({ ...idle, status: 'waitingForInput' }).state).toBe('waiting');
        expect(workspaceActivity({ ...idle, status: 'running' }).state).toBe('running');
        const p = props(); render(<Sidebar {...p} entries={[{ kind: 'workspace', workspace: { ...idle, status: 'waitingForInput' } }]} />);
        fireEvent.click(filter('waiting')); expect(ids()).toEqual(['idle']);
        expect(filter('waiting').textContent).toBe('Waiting 1');
    });
    it('empty-search Enter preserves the active workspace instead of jumping to the first one', () => {
        const p = props(); render(<Sidebar {...p} activeWorkspaceID="idle" />);
        fireEvent.keyDown(screen.getByTestId('sidebar-filter'), { key: 'Enter' });
        expect(p.onActivateWorkspace.mock.calls).toEqual([]);
    });
    it('consumes reveal requests during activity filtering and never scrolls the wrong row', () => {
        const p = props(); const onScrollHandled = vi.fn();
        const view = render(<Sidebar {...p} onScrollHandled={onScrollHandled} />);
        fireEvent.click(filter('running'));
        view.rerender(<Sidebar {...p} onScrollHandled={onScrollHandled} scrollToWorkspaceID="idle" />);
        expect(onScrollHandled).toHaveBeenCalledTimes(1);
    });

    it.each(['comfortable', 'compact'] as const)('keeps %s text density on a portaled drag ghost', density => {
        window.localStorage.setItem(WORKSPACE_DENSITY_KEY, density);
        const p = props(); render(<Sidebar {...p} rowHeight={20} />);
        fireEvent.mouseDown(screen.getByTestId('workspace-row'), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 50 });
        const ghost = screen.getByTestId('sidebar-drag-ghost');
        expect(ghost.parentElement).toBe(document.body);
        expect(ghost.dataset.workspaceDensity).toBe(density);
        expect(ghost.querySelector('[data-workspace-name]')?.textContent).toBe('Validate the release');
        fireEvent.mouseUp(window);
    });

});
