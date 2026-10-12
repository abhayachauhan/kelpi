/**
 * `auto-approve` (cli.md §21): answer "Yes" to Claude Code's permission prompts for a limited
 * time, in every Claude pane, for unattended runs.
 *
 * Driven by the agent's own `notification` hook (agent-lifecycle.md §5.3), the event Claude fires
 * when a permission prompt opens, so there is no polling. Turning it on also checks every Claude
 * pane once, for prompts already open. Each Enter goes out only after two fresh reads of the pane
 * show the same recognised prompt, so a key never lands on anything else. Commands on the
 * never-auto-approve list (`@kelpi/core/agent`) are left for the user. Nothing is persisted:
 * a daemon restart turns it off.
 */

import { neverAutoApprove, parsePermissionPrompt } from '@kelpi/core/agent';
import { AUTO_APPROVE_DEFAULT_MINUTES } from '@kelpi/protocol';

import type { TerminalStateService } from '../../seams.js';
import { findPaneAnywhere } from '../../store/index.js';
import type { AsyncTerminalReads } from '../pane/context.js';
import { forCommand, uuidOut } from './common.js';
import { ok, type AppContext, type AppDeps, type AppHandler } from './context.js';

/** The hook can beat Claude's redraw, so a pane showing no prompt yet is read again after these delays. */
export const AUTO_APPROVE_RETRY_MS: readonly number[] = [250, 1000, 3000];
/** A prompt still showing this soon after its Enter did not take the key, and is not sent another. */
export const SAME_PROMPT_GRACE_MS = 15_000;

export type AutoApproveOutcome =
    | 'approved'
    | 'off'
    | 'not-claude'
    | 'busy'
    | 'no-prompt'
    | 'unrecognised'
    | 'never'
    | 'repeat'
    | 'changed';

/** A prompt left for the user: its command and why. */
export interface LeftPrompt {
    readonly paneID: string;
    readonly command: string;
    readonly reason: string;
}

export interface AutoApproveStatus {
    readonly on: boolean;
    /** Epoch ms it turns itself off; null while off. */
    readonly until: number | null;
    readonly approved: number;
    /** Prompts left for the user while on: never-list commands and shapes not recognised. */
    readonly left: readonly LeftPrompt[];
}

export interface AutoApprover {
    turnOn(minutes: number, ctx: AppContext): void;
    turnOff(): void;
    status(): AutoApproveStatus;
    /** One check of one pane: read, decide, read again, Enter. */
    check(paneID: string, ctx: AppContext): Promise<AutoApproveOutcome>;
    /** The `notification` hook's entry: `check`, re-read on the retry delays while no prompt shows or the pane is busy. */
    onNotification(paneID: string, ctx: AppContext): void;
}

export interface AutoApproverDeps {
    readonly now: () => number;
    readonly schedule?: ((run: () => void, ms: number) => void) | undefined;
}

/** A shell pane with a live Claude session: SessionEnd clears the id, so a pane Claude has left does not pass. */
export function isClaudePane(ctx: AppContext, paneID: string): boolean {
    const pane = findPaneAnywhere(ctx.store.getState(), paneID)?.pane;
    if (pane === undefined || pane.type !== 'shell') return false;
    return pane.agentSessionID !== null && pane.agentKind !== 'codex';
}

async function readScreen(ctx: AppContext, paneID: string): Promise<string | null> {
    const term = ctx.term as TerminalStateService & Partial<AsyncTerminalReads>;
    try {
        return term.captureAsync !== undefined
            ? await term.captureAsync(paneID, { scrollback: false })
            : term.capture(paneID, { scrollback: false });
    } catch {
        return null;
    }
}

const defaultSchedule = (run: () => void, ms: number): void => {
    setTimeout(run, ms).unref?.();
};

export function createAutoApprover(deps: AutoApproverDeps): AutoApprover {
    const schedule = deps.schedule ?? defaultSchedule;
    let until: number | null = null;
    let approved = 0;
    let left: LeftPrompt[] = [];
    // Bumped by every on/off, so a check that awaited across a switch types nothing.
    let generation = 0;
    const leftKeys = new Set<string>();
    const lastApproved = new Map<string, { block: string; at: number }>();
    const inFlight = new Set<string>();

    const isOn = (): boolean => {
        if (until !== null && deps.now() >= until) until = null;
        return until !== null;
    };
    const leave = (paneID: string, block: string, command: string, reason: string): void => {
        const key = `${paneID}\n${block}`;
        if (leftKeys.has(key)) return;
        leftKeys.add(key);
        left.push({ paneID, command, reason });
    };

    const decide = async (paneID: string, ctx: AppContext): Promise<AutoApproveOutcome> => {
        const started = generation;
        const first = await readScreen(ctx, paneID);
        const prompt = first === null ? null : parsePermissionPrompt(first);
        if (prompt === null) return 'no-prompt';
        if (!prompt.approvable) {
            leave(paneID, prompt.block, '', 'prompt not recognised');
            return 'unrecognised';
        }
        const rule = neverAutoApprove(prompt.command);
        if (rule !== null) {
            leave(paneID, prompt.block, prompt.command, `never auto-approved: ${rule}`);
            return 'never';
        }
        const last = lastApproved.get(paneID);
        if (last !== undefined && last.block === prompt.block && deps.now() - last.at < SAME_PROMPT_GRACE_MS) return 'repeat';
        // The second read sits right before the key: the prompt must not have changed while the first one awaited.
        const second = await readScreen(ctx, paneID);
        const again = second === null ? null : parsePermissionPrompt(second);
        if (again === null || !again.approvable || again.block !== prompt.block) return 'changed';
        if (generation !== started || !isOn() || !isClaudePane(ctx, paneID)) return 'off';
        ctx.input.sendNamedKey(paneID, 'enter');
        approved += 1;
        lastApproved.set(paneID, { block: prompt.block, at: deps.now() });
        return 'approved';
    };

    const check = async (paneID: string, ctx: AppContext): Promise<AutoApproveOutcome> => {
        if (!isOn()) return 'off';
        if (!isClaudePane(ctx, paneID)) return 'not-claude';
        // One check per pane at a time: two reads racing could each send an Enter.
        if (inFlight.has(paneID)) return 'busy';
        inFlight.add(paneID);
        try {
            return await decide(paneID, ctx);
        } finally {
            inFlight.delete(paneID);
        }
    };

    const attempt = (paneID: string, ctx: AppContext, retry: number): void => {
        void check(paneID, ctx).then((outcome) => {
            const delay = AUTO_APPROVE_RETRY_MS[retry];
            // A busy pane is mid-read by another check, which may have read the screen before this prompt opened.
            if ((outcome === 'no-prompt' || outcome === 'busy') && delay !== undefined) {
                schedule(() => attempt(paneID, ctx, retry + 1), delay);
            }
        });
    };

    return {
        turnOn(minutes, ctx) {
            until = deps.now() + minutes * 60_000;
            generation += 1;
            approved = 0;
            left = [];
            leftKeys.clear();
            lastApproved.clear();
            for (const workspace of ctx.store.getState().workspaces) {
                for (const pane of [...workspace.panes, ...workspace.parkedPanes]) {
                    if (isClaudePane(ctx, pane.id)) void check(pane.id, ctx);
                }
            }
        },
        turnOff() {
            until = null;
            generation += 1;
        },
        status() {
            const on = isOn();
            return { on, until: on ? until : null, approved, left: [...left] };
        },
        check,
        onNotification(paneID, ctx) {
            if (isOn()) attempt(paneID, ctx, 0);
        }
    };
}

export function autoApproveHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('auto-approve', (msg, ctx, reply) => {
            const approver = deps.autoApprover;
            if (msg.action === 'on') approver.turnOn(msg.minutes ?? AUTO_APPROVE_DEFAULT_MINUTES, ctx);
            else if (msg.action === 'off') approver.turnOff();
            const status = approver.status();
            ok(reply, {
                on: status.on,
                until: status.until === null ? null : new Date(status.until).toISOString(),
                approved: status.approved,
                left: status.left.map((entry) => ({ pane_id: uuidOut(entry.paneID), command: entry.command, reason: entry.reason }))
            });
        })
    ];
}
