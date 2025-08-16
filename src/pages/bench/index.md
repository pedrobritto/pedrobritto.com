1. Install volta (https://volta.sh/) and node

```sh
# install Volta
curl https://get.volta.sh | bash

# install Node
volta install node@22

# start using Node
node
```

2. On the terminal, do
```sh
vim iter-bench.js
```

3. Paste the following script:


```js
// sort_iter_bench.js
// Heap-sort benchmark with fixed iteration count (no time limit).
// Measures per-iteration duration and aggregates stats across workers.
//
// CLI:
//   --iters=<N>      (required) iterations PER WORKER
//   --threads=<T>    number of worker threads (default: logical CPUs)
//   --size=<S>       array size per iteration (default: 131072)
//   --seed=<int>     base RNG seed to make runs more comparable (default: random)
//
// Example:
//   node sort_iter_bench.js --iters=10 --threads=8 --size=200000

const os = require("os");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const crypto = require("crypto");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { iters: null, threads: os.cpus().length, size: 131072, seed: null };
  for (const a of args) {
    const [k, v] = a.replace(/^--/, "").split("=");
    if (k === "iters") out.iters = parseInt(v, 10);
    else if (k === "threads") out.threads = Math.max(1, parseInt(v, 10));
    else if (k === "size") out.size = Math.max(1024, parseInt(v, 10));
    else if (k === "seed") out.seed = parseInt(v, 10);
  }
  if (!Number.isFinite(out.iters) || out.iters <= 0) {
    console.error("Error: --iters=<positive integer> is required.");
    process.exit(1);
  }
  return out;
}

// --------- Deterministic, fast PRNG (xorshift32) for reproducible arrays ---------
function makePRNG(seed) {
  let x = seed >>> 0;
  if (x === 0) x = 0x9e3779b9; // avoid zero
  return function rand32() {
    // xorshift32
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return x;
  };
}

// --------- In-place heap sort on a JS array (branchy, cache-sensitive) ----------
function heapSort(a) {
  const n = a.length;
  const heapify = (n, i) => {
    for (;;) {
      let largest = i;
      const l = (i << 1) + 1;
      const r = l + 1;
      if (l < n && a[l] > a[largest]) largest = l;
      if (r < n && a[r] > a[largest]) largest = r;
      if (largest === i) break;
      const t = a[i]; a[i] = a[largest]; a[largest] = t;
      i = largest;
    }
  };
  for (let i = (n >> 1) - 1; i >= 0; i--) heapify(n, i);
  for (let i = n - 1; i > 0; i--) {
    const t = a[0]; a[0] = a[i]; a[i] = t;
    heapify(i, 0);
  }
}

// Generate a new random array (Int32) for each iteration
function makeRandomArray(prng, size) {
  const a = new Array(size);
  for (let i = 0; i < size; i++) {
    // Spread values to stress comparisons; keep them 32-bit
    a[i] = (prng() ^ (prng() << 1)) | 0;
  }
  return a;
}

// High-resolution timer helpers
function nowNs() { return process.hrtime.bigint(); }
function nsToMs(ns) { return Number(ns) / 1e6; }

if (!isMainThread) {
  const { iters, size, seed } = workerData;
  const baseSeed = seed ?? crypto.randomBytes(4).readUInt32LE(0);
  const prng = makePRNG(baseSeed ^ (process.pid & 0xffff));

  const perIterMs = [];
  let totalElems = 0n;

  for (let k = 0; k < iters; k++) {
    const arr = makeRandomArray(prng, size);
    const t1 = nowNs();
    heapSort(arr);
    const t2 = nowNs();
    perIterMs.push(nsToMs(t2 - t1));
    totalElems += BigInt(size);
  }

  parentPort.postMessage({
    perIterMs,
    totalElems: Number(totalElems),
    seed: baseSeed,
  });
  process.exit(0);
}

// ---------------- Main thread ----------------
function stats(arr) {
  const n = arr.length;
  const sum = arr.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const variance = arr.reduce((a, x) => a + (x - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return { n, mean, min, max, std };
}

(async function main() {
  const { iters, threads, size, seed } = parseArgs();

  console.log(`# Node ${process.version} on ${os.type()} ${os.release()} (${os.arch()})`);
  console.log(`# logical CPUs: ${os.cpus().length}; model: ${os.cpus()[0]?.model || "unknown"}`);
  console.log(`# workload: heap-sort, array size=${size}, iterations per worker=${iters}`);
  console.log(`# threads=${threads}  seed=${seed ?? "(random)"}  start=${new Date().toISOString()}`);

  const tStart = process.hrtime.bigint();
  const workers = [];
  const results = [];

  for (let i = 0; i < threads; i++) {
    workers.push(new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: { iters, size, seed: seed != null ? (seed + i) : null } });
      w.on("message", (m) => resolve(m));
      w.on("error", reject);
      w.on("exit", (code) => { if (code !== 0) reject(new Error("Worker exited " + code)); });
    }));
  }

  for (const p of workers) results.push(await p);
  const tEnd = process.hrtime.bigint();

  // Aggregate
  const allPerIterMs = [];
  let totalElems = 0;
  for (const r of results) {
    allPerIterMs.push(...r.perIterMs);
    totalElems += r.totalElems;
  }

  const s = stats(allPerIterMs);
  const wallMs = nsToMs(tEnd - tStart);
  const elemsPerSec = (totalElems / (wallMs / 1000)).toFixed(2);

  console.log("\n=== Results ===");
  console.log(`Workers           : ${threads}`);
  console.log(`Iterations total  : ${iters * threads}`);
  console.log(`Array size        : ${size}`);
  console.log(`Wall time (ms)    : ${wallMs.toFixed(2)}`);
  console.log(`Throughput        : ${elemsPerSec} elements/s (aggregate)`);
  console.log(`Per-iteration ms  : mean=${s.mean.toFixed(3)}  std=${s.std.toFixed(3)}  min=${s.min.toFixed(3)}  max=${s.max.toFixed(3)}`);
  console.log("Note: per-iteration values are distribution of all worker iterations.");

  // Optional: print a compact timeline per worker (commented out to stay quiet)
  // results.forEach((r, i) => console.log(`# worker ${i}: ${r.perIterMs.map(x=>x.toFixed(2)).join(",")}`));
})();

```

4. Run the script and take notes.

```
## Tests
# 8 threads
--iters=200 --threads=8 --size=1000000

# 4 threads
--iters=400 --threads=4 --size=1000000

# 1 thread
--iters=1600 --threads=1 --size=1000000

## Build
--iters=800 --threads=2 --size=750000
```
