import type { ChromeWorkspace } from './types';

export interface AgentCounts {
    readonly running: number;
    readonly waiting: number;
}

export function agentCounts(workspaces: readonly ChromeWorkspace[]): AgentCounts {
    let running = 0;
    let waiting = 0;
    for (const workspace of workspaces) {
        if (workspace.status === 'running') running += 1;
        else if (workspace.status === 'waitingForInput') waiting += 1;
        for (const pane of workspace.panes) {
            if (pane.status === 'running') running += 1;
            else if (pane.status === 'waitingForInput') waiting += 1;
        }
    }
    return { running, waiting };
}

export type WorkspaceActivity = 'waiting' | 'running' | 'idle';

/** A live activity summary, never a claim that a task has completed. */
export function workspaceActivity(workspace: ChromeWorkspace): {
    state: WorkspaceActivity;
    label: string;
    tools: string;
} {
    const panes = workspace.panes.filter(pane => pane.type === 'shell');
    const { waiting, running } = agentCounts([workspace]);
    const tools = [...new Set(panes.flatMap(pane => pane.agentKind === 'claude' ? ['Claude'] : pane.agentKind === 'codex' ? ['Codex'] : []))].join(' + ');
    return {
        state: waiting > 0 ? 'waiting' : running > 0 ? 'running' : 'idle',
        label: waiting > 0 ? `${waiting} waiting${running > 0 ? ` · ${running} running` : ''}` : running > 0 ? `${running} running` : 'Idle',
        tools
    };
}

export const WORKSPACE_DENSITY_KEY = 'kelpi.workspace-sidebar.density';
export function readWorkspaceDensity(): 'comfortable' | 'compact' {
    try { return window.localStorage.getItem(WORKSPACE_DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'; }
    catch { return 'comfortable'; }
}
