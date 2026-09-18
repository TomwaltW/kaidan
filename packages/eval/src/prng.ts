// 纯函数 PRNG（mulberry32）：同一种子永远得到同一序列；不依赖 Math.random / Date.now。

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [min, max] 闭区间整数 */
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: readonly T[]): T[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const at = <T>(arr: readonly T[], i: number): T => {
    const v = arr[i];
    if (v === undefined) throw new Error(`索引越界：${i}/${arr.length}`);
    return v;
  };
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (arr) => {
      if (arr.length === 0) throw new Error("pick：空数组");
      return at(arr, int(0, arr.length - 1));
    },
    shuffle: (arr) => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        const tmp = at(out, i);
        out[i] = at(out, j);
        out[j] = tmp;
      }
      return out;
    },
  };
}
