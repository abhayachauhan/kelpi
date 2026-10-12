/**
 * `kelpi auto-approve on [minutes]|off|status [--json]` (cli.md §21). Request/response; works
 * from any shell, since it covers every Claude pane rather than the caller's.
 */

import { AUTO_APPROVE_MAX_MINUTES } from '@kelpi/protocol';

import { isHelpToken, popSwitch, parseUIntStrict, rejectLeftoverArgs } from '../args.js';
import { errLine, exit, printLine } from '../io.js';
import { asInt, asObjectArray, asString, stableStringify, type JsonObject } from '../json.js';
import { decodeReply } from '../reply.js';
import { autoApproveUsage } from '../usage.js';

const clock = (iso: string): string => {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

export async function handleAutoApprove(args: string[]): Promise<void> {
    const action = args.shift();
    if (action !== undefined && isHelpToken(action)) {
        printLine(autoApproveUsage.trimEnd());
        return;
    }
    if (action !== 'on' && action !== 'off' && action !== 'status') {
        errLine(action === undefined ? 'Usage: kelpi auto-approve on [minutes]|off|status' : `Unknown auto-approve action: ${action}`);
        errLine('Valid actions: on, off, status');
        exit(1);
    }
    const asJSON = popSwitch('--json', args);
    const payload: JsonObject = { command: 'auto-approve', action };
    if (action === 'on' && args.length > 0) {
        const minutes = parseUIntStrict(args.shift() ?? '');
        if (minutes === null || minutes < 1 || minutes > AUTO_APPROVE_MAX_MINUTES) {
            errLine(`Minutes must be a whole number from 1 to ${String(AUTO_APPROVE_MAX_MINUTES)}`);
            exit(1);
        }
        payload['minutes'] = minutes;
    }
    rejectLeftoverArgs(args, `auto-approve ${action}`);

    const reply = await decodeReply(payload, 'kelpi auto-approve');
    if (asJSON) {
        printLine(stableStringify(reply));
        return;
    }
    const until = asString(reply['until']);
    const approved = asInt(reply['approved']) ?? 0;
    const left = asObjectArray(reply['left']);
    printLine(
        until === undefined
            ? `Auto-approve is off. ${String(approved)} approved, ${String(left.length)} left for you.`
            : `Auto-approve is on until ${clock(until)}. ${String(approved)} approved, ${String(left.length)} left for you.`
    );
    for (const entry of left) {
        const command = asString(entry['command']) ?? '';
        printLine(`  ${asString(entry['pane_id']) ?? '?'}: ${asString(entry['reason']) ?? '?'}${command ? `: ${command.replace(/\n/g, ' ')}` : ''}`);
    }
}
