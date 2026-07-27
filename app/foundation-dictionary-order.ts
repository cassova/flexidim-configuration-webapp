// Reproduce the bucket enumeration used by the Darwin CoreFoundation
// CFBasicHash backing NSMutableDictionary. FlexiDim stores hardware under
// decimal NSString keys and later relies on dictionary enumeration as the final
// ordering tie-break. The constants and linear-probing behavior come from
// Apple's published CFBasicHash/CFNumber sources.

const TABLE_SIZES = [
  0, 3, 7, 13, 23, 41, 71, 127, 191, 251, 383, 631, 1087, 1723, 2803,
  4523, 7351, 11959, 19447, 31231, 50683, 81919, 132607, 214519, 346607,
  561109, 907759, 1468927, 2376191, 3845119, 6221311, 10066421,
];

const TABLE_CAPACITIES = [
  0, 3, 6, 11, 19, 32, 52, 85, 118, 155, 237, 390, 672, 1065, 1732,
  2795, 4543, 7391, 12019, 19302, 31324, 50629, 81956, 132580, 214215,
  346784, 561026, 907847, 1468567, 2376414, 3844982, 6221390,
];

function stringHash(value: number): bigint {
  const text = String(Math.trunc(value));
  let result = BigInt(text.length);
  let index = 0;
  for (; index + 4 <= text.length; index += 4)
    result = BigInt.asUintN(
      64,
      result * 67503105n +
        BigInt(text.charCodeAt(index)) * 16974593n +
        BigInt(text.charCodeAt(index + 1)) * 66049n +
        BigInt(text.charCodeAt(index + 2)) * 257n +
        BigInt(text.charCodeAt(index + 3)),
    );
  for (; index < text.length; index += 1)
    result = BigInt.asUintN(
      64,
      result * 257n + BigInt(text.charCodeAt(index)),
    );
  return BigInt.asUintN(
    64,
    result + (result << BigInt(text.length & 31)),
  );
}

function tableIndexForCapacity(capacity: number) {
  const index = TABLE_CAPACITIES.findIndex(
    (candidate) => capacity <= candidate,
  );
  if (index < 0)
    throw new Error("The hardware dictionary is too large to order safely");
  return index;
}

function findEmptyBucket<T>(
  buckets: Array<T | undefined>,
  hash: bigint,
): number {
  const start = Number(hash % BigInt(buckets.length));
  for (let offset = 0; offset < buckets.length; offset += 1) {
    const index = (start + offset) % buckets.length;
    if (buckets[index] === undefined) return index;
  }
  throw new Error("The hardware dictionary has no empty bucket");
}

/**
 * Return input indices in the order Darwin NSMutableDictionary enumerates
 * decimal NSString keys after inserting them in the supplied order.
 */
export function foundationDictionaryOrder(keys: number[]): number[] {
  type Entry = { key: number; inputIndex: number; hash: bigint };
  let bucketTableIndex = 0;
  let buckets: Array<Entry | undefined> = [];

  const rehash = (requiredCapacity: number) => {
    bucketTableIndex = tableIndexForCapacity(requiredCapacity);
    const previous = buckets;
    buckets = new Array(TABLE_SIZES[bucketTableIndex]);
    for (const entry of previous) {
      if (!entry) continue;
      buckets[findEmptyBucket(buckets, entry.hash)] = entry;
    }
  };

  keys.forEach((key, inputIndex) => {
    const existing = buckets.find((entry) => entry?.key === key);
    if (existing) return;
    const used = buckets.reduce(
      (count, entry) => count + Number(entry !== undefined),
      0,
    );
    if (TABLE_CAPACITIES[bucketTableIndex] < used + 1) rehash(used + 1);
    const entry = { key, inputIndex, hash: stringHash(key) };
    buckets[findEmptyBucket(buckets, entry.hash)] = entry;
  });

  return buckets.flatMap((entry) =>
    entry === undefined ? [] : [entry.inputIndex],
  );
}
