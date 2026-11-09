/**
 * A small command line for the MCP tools, in the style of `gh <noun> <verb>`.
 * Each tool owns the commands one OAuth scope allows, so a client's permission
 * prompt still names what the call can do.
 */

export class CliUsageError extends Error {
  constructor(message: string, readonly usage?: string) {
    super(usage ? `${message}\nUsage: ${usage}` : message);
    this.name = 'CliUsageError';
  }
}

type FlagType = 'string' | 'number' | 'integer';

export type CliCommand<Context> = {
  /** Words that name the command, such as `['docs', 'list']`. */
  name: [string, string];
  /** Positional arguments, each required, in order. */
  args?: string[];
  flags?: Record<string, { type: FlagType; description: string }>;
  summary: string;
  run: (input: { args: Record<string, string>; flags: Record<string, string | number> }, context: Context) => Promise<unknown>;
};

/** Splits a command line the way a shell would, with quotes and backslash escapes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | '\'' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < line.length) current += line[++index];
      else current += char;
    } else if (char === '"' || char === '\'') {
      quote = char;
      started = true;
    } else if (char === '\\' && index + 1 < line.length) {
      current += line[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new CliUsageError(`Unclosed ${quote} quote.`);
  if (started) tokens.push(current);
  return tokens;
}

export function usage(command: CliCommand<unknown>): string {
  const flags = Object.keys(command.flags ?? {}).map(name => `[--${name} <${command.flags![name].type === 'string' ? 'value' : 'n'}>]`);
  return [...command.name, ...(command.args ?? []).map(arg => `<${arg}>`), ...flags].join(' ');
}

/** The help text for a tool, or for one of its commands. */
export function helpText<Context>(tool: string, commands: CliCommand<Context>[], topic: string[] = []): string {
  const matching = topic.length ? commands.filter(command => topic.every((word, index) => command.name[index] === word)) : commands;
  if (topic.length && matching.length === 0) throw new CliUsageError(`No ${tool} command is called "${topic.join(' ')}". Run "help" for the list.`);
  return matching.map((command) => {
    const flags = Object.entries(command.flags ?? {}).map(([name, flag]) => `\n    --${name}  ${flag.description}`).join('');
    return `${usage(command as CliCommand<unknown>)}\n    ${command.summary}${flags}`;
  }).join('\n');
}

function flagValue(name: string, type: FlagType, raw: string, command: CliCommand<unknown>): string | number {
  if (type === 'string') return raw;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) {
    throw new CliUsageError(`--${name} must be ${type === 'integer' ? 'a whole number' : 'a number'}.`, usage(command));
  }
  return value;
}

export type ParsedCommand<Context> =
  | { help: string }
  | { command: CliCommand<Context>; args: Record<string, string>; flags: Record<string, string | number> };

/**
 * Finds the command a line names and reads its arguments. A leading tool name
 * is ignored, so `openreader docs list` and `docs list` are the same.
 */
export function parseCommand<Context>(tool: string, commands: CliCommand<Context>[], line: string): ParsedCommand<Context> {
  const tokens = tokenize(line);
  if (tokens[0] === tool) tokens.shift();
  if (tokens.length === 0 || tokens[0] === 'help' || tokens[0] === '--help') return { help: helpText(tool, commands, tokens.slice(1)) };
  const command = commands.find(({ name }) => name[0] === tokens[0] && name[1] === tokens[1]);
  if (!command) {
    const known = commands.filter(({ name }) => name[0] === tokens[0]).map(({ name }) => name.join(' '));
    throw new CliUsageError(known.length
      ? `Unknown command "${tokens.slice(0, 2).join(' ')}". ${tool} has: ${known.join(', ')}.`
      : `Unknown command "${tokens[0]}". Run "help" for the commands ${tool} has.`);
  }
  const rest = tokens.slice(2);
  if (rest.includes('--help') || rest.includes('-h')) return { help: helpText(tool, commands, command.name) };
  const positional: string[] = [];
  const flags: Record<string, string | number> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const flag = command.flags?.[name];
    if (!flag) throw new CliUsageError(`Unknown flag --${name}.`, usage(command as CliCommand<unknown>));
    const raw = inline ?? rest[++index];
    if (raw === undefined) throw new CliUsageError(`--${name} needs a value.`, usage(command as CliCommand<unknown>));
    flags[name] = flagValue(name, flag.type, raw, command as CliCommand<unknown>);
  }
  const names = command.args ?? [];
  if (positional.length !== names.length) {
    throw new CliUsageError(positional.length < names.length ? `Missing <${names[positional.length]}>.` : `Unexpected argument "${positional[names.length]}".`,
      usage(command as CliCommand<unknown>));
  }
  return { command, args: Object.fromEntries(names.map((name, index) => [name, positional[index]])), flags };
}
