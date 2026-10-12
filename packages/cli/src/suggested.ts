/**
 * `kelpi pane run-suggested` (cli.md §9.12.1): find the last shell command Claude Code suggested in a
 * pane capture and undo the line wraps Claude Code drew itself (a real newline plus the block's
 * indent and two more spaces). Everything here is pure; the command in commands/pane.ts does the I/O.
 */

export type SuggestedKind = 'bang' | 'inline' | 'fence' | 'run' | 'bare';

export interface Suggested {
    readonly command: string;
    readonly kind: SuggestedKind;
}

/** Lines of scrollback the command reads from the pane. */
export const SUGGESTED_CAPTURE_LINES = 200;

const width = (line: string): number => [...line].length;
const lead = (line: string): number => line.length - line.trimStart().length;
// Claude Code draws its input box with full-width rules; their length is the pane width.
const RULE = /^\s*[─━═╌┄]{20,}\s*$/;
const BANG = /^(\s*(?:[⏺●]\s+)?)! (\S.*)$/;
const FENCE_OPEN = /^(\s*)```\s*(?:bash|sh|shell|zsh)?\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const RUN = /^(\s*(?:[⏺●]\s+)?)Run\b/;
// A paragraph that starts with a common CLI and reads like shell (a flag, pipe, redirect or quote),
// so prose that merely starts with "git" or "make" is left alone.
const CLI =
    '(?:sudo\\s+)?(?:curl|wget|ssh|scp|rsync|git|gh|kubectl|helm|aws|terraform|docker|npm|npx|yarn|pnpm|node|python3?|pip3?|uv|brew|make|ls|cat|grep|rg|jq|kelpi|claude|open)\\s';
const BARE = new RegExp(`^\\s*${CLI}`);
// `! <command>` inside a sentence ("Log in again with ! aws sso login --profile x. Then ..."): it runs to the
// sentence end, a closing backtick, or a "then" that goes on to the next step.
const INLINE = new RegExp(`[\\s\`]! (${CLI}.*)$`);
const SENTENCE_END = /`|[.;](?=\s+[A-Z(])|,?\s+(?=then\s)|,(?=\s+(?:and|or|which)\b)|[.,;:]?\s*$/;
const SHELLISH = /\s--?\w|[|<>]|['"]/;
const lastToken = (line: string): string => line.trimEnd().split(/\s+/).at(-1) ?? '';
const firstToken = (line: string): string => line.trim().split(/\s+/)[0] ?? '';
const at = (lines: readonly string[], index: number): string => lines[index] ?? '';

/** The pane width the capture shows (its widest rule line), or 0 when there is none. */
export function wrapWidth(lines: readonly string[]): number {
    return lines.filter((line) => RULE.test(line)).reduce((max, line) => Math.max(max, width(line.trimEnd())), 0);
}

/**
 * Rejoin a block's lines. A line indented by exactly `indent + 2` continues the line before it
 * (unless that one ends with a shell `\`); any other line starts a new command. The break was at a
 * space unless the line before filled the wrap width without a trailing space, which means the wrap
 * split a token (join with nothing). Unknown width (0) never counts as filled.
 */
export function joinWraps(lines: readonly string[], indent: number, wrap = 0): string {
    const commands: string[] = [];
    let previous: string | null = null;
    for (const line of lines) {
        if (!line.trim()) {
            previous = null;
            continue;
        }
        const current = commands.at(-1);
        if (previous !== null && current !== undefined && lead(line) === indent + 2 && !current.trimEnd().endsWith('\\')) {
            // Claude Code splits only a word too long for the line, so a filled line is a mid-token
            // break only when the two halves together are a long word.
            const filled = wrap > 0 && width(previous) >= wrap - 1 && width(lastToken(previous) + firstToken(line)) > wrap / 2;
            const separator = !previous.endsWith(' ') && filled ? '' : ' ';
            commands[commands.length - 1] = current.trimEnd() + separator + line.trim();
        } else {
            commands.push(line.slice(Math.min(lead(line), indent)).trimEnd());
        }
        previous = line;
    }
    return commands.join('\n');
}

/** Lines after `from` that continue a one-line command at `indent` (indented by exactly indent + 2). */
function continuation(lines: readonly string[], from: number, indent: number): number {
    let end = from + 1;
    while (end < lines.length && at(lines, end).trim() && lead(at(lines, end)) === indent + 2) end += 1;
    return end;
}

/**
 * Lines after `from` that continue a `! ` command at `indent`. Claude Code wraps them under the text
 * after `! ` (indent + 2) or, in reply text, back at the `!` column; another `! ` line or a fence there
 * starts a new block.
 */
function bangContinuation(lines: readonly string[], from: number, indent: number): number {
    let end = from + 1;
    for (; end < lines.length; end += 1) {
        const line = at(lines, end);
        if (!line.trim()) break;
        const wraps = lead(line) === indent + 2 || (lead(line) === indent && !BANG.test(line) && !FENCE_OPEN.test(line));
        if (!wraps) break;
    }
    return end;
}

/** Wrapped lines drawn at the block's own column, re-indented by two so joinWraps sees them as wraps. */
const reindent = (lines: readonly string[], indent: number): string[] =>
    lines.map((line) => (lead(line) === indent ? `  ${line}` : line));

/** Every suggested command in the capture, in order. */
function candidates(lines: readonly string[], wrap: number): Suggested[] {
    const found: Suggested[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = at(lines, i);
        const bang = BANG.exec(line);
        if (bang) {
            // The block's indent is the column of `!`; `! ` becomes two spaces so the width check
            // still sees the line as wide as it was drawn.
            const indent = width(bang[1] ?? '');
            const end = bangContinuation(lines, i, indent);
            const block = [' '.repeat(indent + 2) + (bang[2] ?? ''), ...reindent(lines.slice(i + 1, end), indent)];
            found.push({ kind: 'bang', command: joinWraps(block, indent, wrap).trim() });
            i = end - 1;
            continue;
        }
        if (FENCE_OPEN.test(line)) {
            let close = i + 1;
            while (close < lines.length && !FENCE_CLOSE.test(at(lines, close))) close += 1;
            if (close >= lines.length) break; // still being written
            const body = lines.slice(i + 1, close);
            const filled = body.filter((l) => l.trim());
            if (filled.length) found.push({ kind: 'fence', command: joinWraps(body, Math.min(...filled.map(lead)), wrap) });
            i = close;
            continue;
        }
        const run = RUN.exec(line);
        if (run) {
            const textIndent = width(run[1] ?? '');
            let next = i + 1;
            if (next < lines.length && !at(lines, next).trim()) next += 1; // one blank line allowed
            const body = at(lines, next);
            if (body.trim() && lead(body) > textIndent && !BANG.test(body) && !FENCE_OPEN.test(body)) {
                const end = continuation(lines, next, lead(body));
                found.push({ kind: 'run', command: joinWraps(lines.slice(next, end), lead(body), wrap) });
                i = end - 1;
                continue;
            }
        }
        const inline = INLINE.exec(line);
        if (inline) {
            // The sentence may wrap onto lines two deeper (a bullet's text); join them, then cut at its end.
            const end = continuation(lines, i, lead(line));
            const block = [' '.repeat(lead(line) + 2) + (inline[1] ?? ''), ...lines.slice(i + 1, end)];
            const text = joinWraps(block, lead(line), wrap).trim();
            const command = text.slice(0, text.search(SENTENCE_END)).trim();
            if (command && !command.includes('\n')) found.push({ kind: 'inline', command });
            continue;
        }
        if (BARE.test(line) && (i === 0 || !at(lines, i - 1).trim())) {
            // A paragraph: its wraps sit at its own indent (or two deeper) and a blank line ends it.
            const indent = lead(line);
            const end = bangContinuation(lines, i, indent);
            const block = [' '.repeat(indent + 2) + line.trim(), ...reindent(lines.slice(i + 1, end), indent)];
            const command = joinWraps(block, indent, wrap).trim();
            if (SHELLISH.test(command) && !command.includes('\n')) found.push({ kind: 'bare', command });
            i = end - 1;
        }
    }
    return found;
}

/** The last command Claude Code suggested in `capture`, rejoined, or null. */
export function findSuggested(capture: string): Suggested | null {
    const lines = capture.replace(/\r/g, '').split('\n');
    return candidates(lines, wrapWidth(lines)).filter((c) => c.command.trim()).at(-1) ?? null;
}

// Tab, ESC, CR and the rest: anything that could act as a keystroke instead of text.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** Why `command` may not be typed into a pane, or null. */
export function commandProblem(command: string): string | null {
    if (!command.trim()) return 'the command is empty';
    // Invisible format characters (bidi overrides, zero-width) could make the text shown differ from what runs.
    if (/\p{Cf}/u.test(command)) return 'the command contains an invisible formatting character';
    if (CONTROL.test(command)) return 'the command contains a control character';
    return null;
}

/** The fields of a `pane-list` entry the routing decision reads. */
export interface SourcePane {
    readonly agent?: string | undefined;
    readonly agent_session_id?: string | undefined;
    readonly status?: string | undefined;
}

const PROMPT_EMPTY = /^\s*[>❯]\s*$/;

/**
 * True when the capture ends with Claude Code's input box empty: a bare `>` prompt between two rules.
 * A permission prompt, a menu or a half-typed draft replaces it, and typing there would answer it.
 */
export function promptReady(capture: string): boolean {
    const lines = capture.replace(/\r/g, '').split('\n');
    const rules = lines.flatMap((line, index) => (RULE.test(line) ? [index] : []));
    const below = rules.at(-1);
    const above = rules.at(-2);
    return below !== undefined && above === below - 2 && PROMPT_EMPTY.test(at(lines, below - 1));
}

/**
 * True when the command should be typed into the Claude session it came from: Claude wrote it with
 * `!` (meant for the user to run there), it is one line, and the pane is a live Claude session that
 * is not mid-reply and shows its empty input box. Anything else runs in a new shell pane.
 */
export function runsInSession(found: Suggested, pane: SourcePane, capture: string): boolean {
    const bang = found.kind === 'bang' || found.kind === 'inline';
    const live = pane.agent === 'claude' && !!pane.agent_session_id && pane.status !== 'running';
    return bang && !found.command.includes('\n') && live && promptReady(capture);
}
