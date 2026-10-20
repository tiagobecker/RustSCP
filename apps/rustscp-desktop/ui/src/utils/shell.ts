/**
 * POSIX shell quoting for commands that the UI builds and sends to a remote shell.
 * Wraps the value in single quotes and encodes embedded quotes as '\'' so file names
 * such as `a'b; rm -rf ~` stay one literal argument.
 */
export function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Quotes every argument and joins them with spaces. */
export function shJoin(args: string[]): string {
  return args.map(shQuote).join(' ');
}

/** Prefix that runs a command inside `dir` (and fails instead of running elsewhere if `cd` fails). */
export function inDir(dir: string, command: string): string {
  return dir ? `cd ${shQuote(dir)} && ${command}` : command;
}
