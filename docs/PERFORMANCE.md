# Performance

META Mover favors bounded memory and recoverable work over speculative speed.

- Preview snapshot, SHA-256, and bundled ExifTool work runs through an adaptive pool. The default reserves 25 percent of logical processors, never exceeds 16 analysis workers, and pauses new admission while sampled host CPU is 80 percent or higher.
- In-flight snapshot bytes may use at most the smaller of 32 GiB or half of currently available temporary storage. This keeps small-media throughput high without multiplying large-video temporary-space demand by the worker count.
- Date resolution and destination collision allocation remain in canonical path order. Parallel completion order cannot change evidence ranking or target filenames.
- File transactions use the configured worker count from 1 through 10.
- File copies stream through the native helper and SHA-256 state. Whole media files are not loaded into JavaScript memory.
- Preview summary accounting stays separate from row rendering so large collections do not need duplicate in-memory summaries.
- Job history is append-only JSONL, not a single rewritten database blob.
- The transaction journal caches its validated end and detects external growth before appending.
- Native mutations use held roots and capability-relative components, avoiding repeated ambient path walks.

Do not disable integrity checks for throughput. Byte counts, hashes, file sync, directory sync where supported, and journal records are part of completion.

Benchmark on representative filesystems. Local SSD, spinning disk, network mount, cross-device move, antivirus, and filesystem durability behavior differ. Report file count, total bytes, media size distribution, operation mode, filesystem, and package build with any result.

The 2026-09-02 Linux x64 cache-order challenge used 45 real PNG files and the packaged ExifTool, snapshot, hash, planner, and cleanup path. The adaptive pool ran first on a separate source tree and took 721 ms. One worker then took 7095 ms, a 9.8x speedup. Peak sampled host CPU was 71.7 percent. This is not a universal throughput claim; file size, storage latency, CPU contention, and media format change the result.
