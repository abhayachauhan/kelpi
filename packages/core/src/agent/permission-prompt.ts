/**
 * Claude Code's permission prompt, read from a pane's screen text, and the commands auto-approve
 * never answers. Pure: the daemon's auto-approver captures the pane and decides with these.
 */

export interface PermissionPrompt {
    /** The command lines between the header and the question; '' when not approvable. */
    readonly command: string;
    /** The whole prompt, frame through the last option: two reads agree when these are equal. */
    readonly block: string;
    /** False for any shape not recognised exactly, or a cursor not on "1. Yes". */
    readonly approvable: boolean;
}

// CSI and OSC sequences; an unterminated escape stays in and fails the printable check.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const BOX_LEFT = /^\s*[│┃║] ?/u;
const BOX_RIGHT = /\s*[│┃║]\s*$/u;
const FRAME = /^(?:[╭┌┏╔╒]?[─━═]{3,}[╮┐┓╗╕]?|[╭┌┏╔╒][─━═]+[╮┐┓╗╕])$/u;
const PRINTABLE = /^[\x20-\x7e\t]*$/;
const QUESTION = /^(?:do you want to|would you like to|allow\b|do you trust)/i;
const OPTION_YES = /^[❯>›]?\s*1[.)]\s*yes\b/i;
const CURSOR_YES = /^[❯›]\s*1[.)]\s*yes\b/i;
const CURSOR = /^[❯>›]\s*\d+[.)]\s/;
const OPTION_LINE = /^[❯>›]?\s*\d+[.)]\s/;
// Exact header strings only, so a command line such as `echo run command` never acts as one.
const HEADER = /^(?:bash command|edit file|create file|write file|read file|fetch|web fetch|tool use)(?: · from the [\w .-]{1,40} agent)?$/i;
// The dashed rules newer Claude versions draw above and below the command.
const RULE = /^[╌╍┄┅┈┉]{3,}$/u;
const DECOR = /^[\s─━┌┐└┘├┤┬┴┼╭╮╯╰═╔╗╚╝-]*$/u;
/** A live prompt is the bottom of the screen: its question sits within this many non-empty lines of the end. */
const PROMPT_WINDOW = 12;
const HEADER_REACH = 60;
const MAX_DESC = 6;
const MAX_NOTES = 10;

const blank = (line: string): boolean => !line || DECOR.test(line);
const at = (lines: readonly string[], i: number): string => lines[i] ?? '';

/**
 * The permission prompt at the bottom of `text`, or null when none is showing. Only the exact
 * shapes Claude Code draws are approvable: header, one run of command lines, question, options.
 */
export function parsePermissionPrompt(text: string): PermissionPrompt | null {
    const lines = text.replace(ANSI, '').split('\n').map((line) => line.replace(BOX_LEFT, '').replace(BOX_RIGHT, '').trim());
    const filled = lines.flatMap((line, i) => (line ? [i] : []));
    const windowStart = filled[Math.max(0, filled.length - PROMPT_WINDOW)] ?? 0;
    let q = -1;
    for (let i = lines.length - 1; i >= windowStart; i -= 1) {
        if (QUESTION.test(at(lines, i))) {
            q = i;
            break;
        }
    }
    if (q < 0) return null;
    const optionRows = lines.slice(q + 1, q + 8);
    if (!optionRows.some((line) => OPTION_YES.test(line))) return null;
    let lastOption = q;
    optionRows.forEach((line, k) => {
        if (OPTION_LINE.test(line)) lastOption = q + 1 + k;
    });

    // The topmost header in reach: a header-looking line inside a command then lands in the command run.
    let headerAt = -1;
    for (let i = Math.max(0, q - HEADER_REACH); i < q; i += 1) {
        if (HEADER.test(at(lines, i))) {
            headerAt = i;
            break;
        }
    }
    const frameAt = headerAt >= 1 && FRAME.test(at(lines, headerAt - 1)) ? headerAt - 1 : -1;
    let approvable = false;
    let commandLines: readonly string[] = [];
    if (frameAt >= 0) {
        let i = headerAt + 1;
        if (i < q && blank(at(lines, i))) i += 1;
        const runStart = i;
        while (i < q && !blank(at(lines, i))) i += 1;
        const runEnd = i;
        if (i < q && blank(at(lines, i))) i += 1;
        const ruled = ruledCommand(lines, headerAt, q);
        if ((i === q && runEnd > runStart) || ruled !== null) {
            commandLines = ruled ?? lines.slice(runStart, runEnd);
            const cursorRow = optionRows.find((line) => CURSOR.test(line));
            approvable =
                !commandLines.some((line) => HEADER.test(line) || FRAME.test(line) || RULE.test(line)) &&
                commandLines.every((line) => PRINTABLE.test(line)) &&
                cursorRow !== undefined &&
                CURSOR_YES.test(cursorRow);
        }
    }
    const start = frameAt >= 0 ? frameAt : headerAt >= 0 ? headerAt : q;
    // The frame is canonicalised so a resize does not change the block; other decor lines are dropped.
    const block = lines
        .slice(start, lastOption + 1)
        .flatMap((line, k) => (start + k === frameAt ? ['╭─╮'] : blank(line) ? [] : [line]))
        .join('\n');
    return { command: approvable ? commandLines.join('\n') : '', block, approvable };
}

/**
 * The newer layout: header, a few description lines, a dashed rule, the command, a rule, a few
 * note lines, then the question. Returns the command lines, or null when the shape differs.
 */
function ruledCommand(lines: readonly string[], headerAt: number, q: number): readonly string[] | null {
    if (lines.slice(headerAt + 1, q).filter((line) => RULE.test(line)).length !== 2) return null;
    const structural = (line: string): boolean =>
        HEADER.test(line) || FRAME.test(line) || QUESTION.test(line) || OPTION_LINE.test(line);
    let i = headerAt + 1;
    for (let desc = 0; i < q && !blank(at(lines, i)) && !RULE.test(at(lines, i)) && desc < MAX_DESC; desc += 1, i += 1) {
        if (structural(at(lines, i))) return null;
    }
    if (!RULE.test(at(lines, i))) return null;
    const runStart = ++i;
    while (i < q && !blank(at(lines, i)) && !RULE.test(at(lines, i))) i += 1;
    if (i === runStart || !RULE.test(at(lines, i))) return null;
    const command = lines.slice(runStart, i);
    i += 1;
    for (let notes = 0; i < q && !blank(at(lines, i)) && notes < MAX_NOTES; notes += 1, i += 1) {
        if (structural(at(lines, i)) || RULE.test(at(lines, i))) return null;
    }
    if (i < q && blank(at(lines, i))) i += 1;
    return i === q ? command : null;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = /^(?:python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)$/;
const AWS_WRITE = /^(?:delete|put|create|update|terminate|modify|remove)-/;
const WRAPPERS = new Set(['command', 'exec', 'env', 'nohup', 'time', 'builtin']);
const base = (token: string): string => token.split('/').pop() ?? token;
const after = (tokens: readonly string[], name: string): readonly string[] | null => {
    const i = tokens.findIndex((token) => base(token) === name);
    return i < 0 ? null : tokens.slice(i + 1);
};
const sub = (tokens: readonly string[], name: string, verbs: readonly string[]): boolean =>
    after(tokens, name)?.some((token) => verbs.includes(token)) ?? false;
const commandWord = (tokens: readonly string[]): string | undefined =>
    tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !WRAPPERS.has(base(token)));

interface NeverRule {
    readonly name: string;
    readonly test: (tokens: readonly string[], all: string) => boolean;
}

/**
 * Commands auto-approve never answers: the prompt is left for the user. Each rule sees one
 * segment's tokens and the whole text. Broad on purpose: a false match only costs a manual answer.
 */
export const NEVER_AUTO_APPROVE: readonly NeverRule[] = [
    { name: 'rm -r', test: (t) => t.some((x, i) => base(x) === 'rm' && t.slice(i + 1).some((f) => f === '--recursive' || /^-[A-Za-z]*[rR]/.test(f))) },
    { name: 'git push', test: (t) => after(t, 'git')?.includes('push') ?? false },
    { name: 'sudo', test: (t) => t.some((x) => base(x) === 'sudo') },
    { name: 'download piped into a shell', test: (t, all) => /\b(?:curl|wget)\b/.test(all) && t.some((x) => SHELLS.has(base(x))) },
    { name: 'download piped into an interpreter', test: (t, all) => /\b(?:curl|wget)\b/.test(all) && t.some((x) => INTERPRETERS.test(base(x))) },
    // Code fed to a shell or interpreter on stdin is hidden from every other rule: `… | base64 -d | sh`, `python3 <<EOF`.
    {
        name: 'piped or heredoc into a shell or interpreter',
        test: (t) => {
            const word = commandWord(t);
            if (word === undefined || (!SHELLS.has(base(word)) && !INTERPRETERS.test(base(word)))) return false;
            // No script file to run means it reads its code from stdin, wherever that comes from.
            const args = t.slice(t.indexOf(word) + 1);
            const files = args.filter((f) => !f.startsWith('-') && !f.startsWith('<'));
            return files.length === 0 || args.some((f) => f.startsWith('<<') || ['-', '-s', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'].includes(f));
        }
    },
    // `python -c '…'` hides its command from every rule below; so does `bash -c` with quotes in the way.
    {
        name: 'shell or interpreter running inline code',
        test: (t) =>
            t.some(
                (x, i) =>
                    (SHELLS.has(base(x)) || INTERPRETERS.test(base(x))) &&
                    t.slice(i + 1).some((f) => /^-[A-Za-z]*[ceE][A-Za-z]*$/.test(f) || ['--eval', '--print', '--command', 'eval'].includes(f))
            )
    },
    // Auto-approve must not be able to extend or restart itself, by the CLI or a raw socket write.
    { name: 'auto-approve itself', test: (_t, all) => /auto-?approve/i.test(all.replace(/["'\\]/g, '')) },
    { name: 'mkfs', test: (t) => t.some((x) => /^mkfs(?:\.|$)/.test(base(x))) },
    { name: 'dd of=', test: (t) => after(t, 'dd')?.some((f) => f.startsWith('of=')) ?? false },
    {
        name: 'find -delete or -exec rm',
        test: (t) => {
            const rest = after(t, 'find');
            return rest !== null && (rest.includes('-delete') || rest.some((x, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(x) && base(rest[i + 1] ?? '') === 'rm'));
        }
    },
    { name: 'git clean -f', test: (t) => { const rest = after(t, 'git'); return rest !== null && rest.includes('clean') && rest.some((f) => f === '--force' || /^-[A-Za-z]*f/.test(f)); } },
    { name: 'git reset --hard', test: (t) => { const rest = after(t, 'git'); return rest !== null && rest.includes('reset') && rest.includes('--hard'); } },
    {
        name: 'git checkout -- . or git restore .',
        test: (t) => {
            const rest = after(t, 'git');
            return rest !== null && ((rest.includes('checkout') && rest.includes('--') && rest.includes('.')) || (rest.includes('restore') && rest.includes('.')));
        }
    },
    { name: 'rsync --delete', test: (t) => after(t, 'rsync')?.some((f) => f.startsWith('--delete') || f.startsWith('--remove-source-files')) ?? false },
    {
        name: 'gh pr merge or gh repo delete',
        test: (t) => {
            const rest = after(t, 'gh');
            return rest !== null && ((rest.includes('pr') && rest.includes('merge')) || (rest.includes('repo') && rest.includes('delete')));
        }
    },
    { name: 'npm publish', test: (t) => ['npm', 'yarn', 'pnpm'].some((tool) => sub(t, tool, ['publish'])) },
    { name: 'kubectl write', test: (t) => sub(t, 'kubectl', ['delete', 'apply', 'replace', 'scale', 'drain', 'patch', 'edit', 'create']) },
    { name: 'terraform apply or destroy', test: (t) => ['terraform', 'terragrunt', 'tofu'].some((tool) => sub(t, tool, ['apply', 'destroy'])) },
    { name: 'helm install, upgrade or uninstall', test: (t) => sub(t, 'helm', ['install', 'upgrade', 'uninstall', 'delete', 'rollback']) },
    {
        name: 'aws write',
        test: (t) => {
            const rest = after(t, 'aws');
            if (rest === null) return false;
            if (rest.some((x) => AWS_WRITE.test(x))) return true;
            const s3 = rest.indexOf('s3');
            const verb = s3 < 0 ? undefined : rest[s3 + 1];
            return verb === 'rm' || verb === 'mv' || verb === 'rb' || (verb === 'sync' && rest.some((f) => f.startsWith('--delete')));
        }
    },
    // `R=rm; $R -rf x`: the real command word is only known when the shell runs it.
    { name: 'command word is a variable', test: (t) => /^\$/.test(commandWord(t) ?? '') },
    { name: 'alias or eval', test: (t) => t.some((x) => base(x) === 'alias' || base(x) === 'eval') }
];

// Quotes and backslashes are deleted, not spaced, so r"m" -rf and r\m -rf read as rm -rf, as the shell runs them.
const segments = (text: string): string[][] =>
    text
        .replace(/["'\\]/g, '')
        .split(/&&|\|\||[;|&\n`]|\$\(|[()]/)
        .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
        .filter((tokens) => tokens.length > 0);

/** The never-auto-approve rule `command` breaks, or null. A wrapped command is also read with its lines joined. */
export function neverAutoApprove(command: string): string | null {
    if (!command) return null;
    const lines = command.split('\n').map((line) => line.trim());
    for (const text of [command, lines.join(' '), lines.join('')]) {
        for (const tokens of segments(text)) {
            const rule = NEVER_AUTO_APPROVE.find((candidate) => candidate.test(tokens, text));
            if (rule !== undefined) return rule.name;
        }
    }
    return null;
}
