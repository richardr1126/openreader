/**
 * TypeScript port of Misaki's NumberToWords, from the OpenReader iOS port
 * (itself vendored from kokoro-swift, a port of hexgrad/misaki). Apache-2.0;
 * see ../assets/LICENSE.txt. Behaviour is unchanged from the Swift source.
 */

const UNITS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS: Record<number, string> = {
  20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty',
  60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety',
};
const ORDINAL_UNITS = [
  'zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
  'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth',
  'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
];
const ORDINAL_TENS: Record<number, string> = {
  20: 'twentieth', 30: 'thirtieth', 40: 'fortieth', 50: 'fiftieth',
  60: 'sixtieth', 70: 'seventieth', 80: 'eightieth', 90: 'ninetieth',
};
const SCALES: [bigint, string][] = [
  [BigInt('1000000000000000000'), 'quintillion'],
  [BigInt('1000000000000000'), 'quadrillion'],
  [BigInt(1e12), 'trillion'],
  [BigInt(1e9), 'billion'],
  [BigInt(1e6), 'million'],
  [BigInt(1000), 'thousand'],
];
const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);

function cardinalMagnitude(value: bigint): string {
  if (value < BigInt(20)) return UNITS[Number(value)]!;
  if (value < BigInt(100)) {
    const tensValue = Number(value / BigInt(10)) * 10;
    const remainder = Number(value % BigInt(10));
    const tensWord = TENS[tensValue]!;
    return remainder === 0 ? tensWord : `${tensWord}-${UNITS[remainder]}`;
  }
  if (value < BigInt(1000)) {
    const base = `${UNITS[Number(value / BigInt(100))]} hundred`;
    const remainder = value % BigInt(100);
    return remainder === BigInt(0) ? base : `${base} ${cardinalMagnitude(remainder)}`;
  }
  for (const [scaleValue, scaleName] of SCALES) {
    if (value < scaleValue) continue;
    const base = `${cardinalMagnitude(value / scaleValue)} ${scaleName}`;
    const remainder = value % scaleValue;
    return remainder === BigInt(0) ? base : `${base} ${cardinalMagnitude(remainder)}`;
  }
  return value.toString();
}

function ordinalMagnitude(value: bigint): string {
  if (value < BigInt(20)) return ORDINAL_UNITS[Number(value)]!;
  if (value < BigInt(100)) {
    const tensValue = Number(value / BigInt(10)) * 10;
    const remainder = Number(value % BigInt(10));
    const tensWord = TENS[tensValue]!;
    return remainder === 0 ? (ORDINAL_TENS[tensValue] ?? `${tensWord}th`) : `${tensWord}-${ORDINAL_UNITS[remainder]}`;
  }
  if (value < BigInt(1000)) {
    const base = `${UNITS[Number(value / BigInt(100))]} hundred`;
    const remainder = value % BigInt(100);
    return remainder === BigInt(0) ? `${base}th` : `${base} ${ordinalMagnitude(remainder)}`;
  }
  for (const [scaleValue, scaleName] of SCALES) {
    if (value < scaleValue) continue;
    const base = `${cardinalMagnitude(value / scaleValue)} ${scaleName}`;
    const remainder = value % scaleValue;
    return remainder === BigInt(0) ? `${base}th` : `${base} ${ordinalMagnitude(remainder)}`;
  }
  return `${value}th`;
}

function yearMagnitude(value: bigint): string {
  if (value < BigInt(1000) || value > BigInt(9999)) return cardinalMagnitude(value);
  const high = value / BigInt(100);
  const low = value % BigInt(100);
  if (value >= BigInt(2000) && value <= BigInt(2009)) {
    return low === BigInt(0) ? 'two thousand' : `two thousand ${cardinalMagnitude(low)}`;
  }
  if (low === BigInt(0)) return `${cardinalMagnitude(high)} hundred`;
  if (low < BigInt(10)) return `${cardinalMagnitude(high)} oh-${cardinalMagnitude(low)}`;
  return `${cardinalMagnitude(high)} ${cardinalMagnitude(low)}`;
}

function signed(value: bigint, magnitude: (value: bigint) => string): string {
  return value < BigInt(0) ? `minus ${magnitude(-value)}` : magnitude(value);
}

/** Swift's `Int64(String)`: optional sign, ASCII digits, in range. */
function parseInt64(text: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(text)) return null;
  const value = BigInt(text);
  return value < INT64_MIN || value > INT64_MAX ? null : value;
}

function asBigInt(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
}

export const NumberToWords = {
  cardinal(value: number | bigint): string {
    return signed(asBigInt(value), cardinalMagnitude);
  },
  ordinal(value: number | bigint): string {
    return signed(asBigInt(value), ordinalMagnitude);
  },
  year(value: number | bigint): string {
    return signed(asBigInt(value), yearMagnitude);
  },
  cardinalText(text: string): string | null {
    const value = parseInt64(text);
    return value === null ? null : signed(value, cardinalMagnitude);
  },
  ordinalText(text: string): string | null {
    const value = parseInt64(text);
    return value === null ? null : signed(value, ordinalMagnitude);
  },
  yearText(text: string): string | null {
    const value = parseInt64(text);
    return value === null ? null : signed(value, yearMagnitude);
  },
};
