const enabled =
  process.env.FORCE_COLOR !== undefined
    ? process.env.FORCE_COLOR !== '0'
    : process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

const wrap = (open: number, close: number) => (text: string) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};
