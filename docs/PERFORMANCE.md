# Performance

META Mover favors bounded memory and recoverable work over speculative speed.

- Inventory and metadata work use a configured worker count from 1 through 10.
- File copies stream through the native helper and SHA-256 state. Whole media files are not loaded into JavaScript memory.
- Preview summary accounting stays separate from row rendering so large collections do not need duplicate in-memory summaries.
- Job history is append-only JSONL, not a single rewritten database blob.
- The transaction journal caches its validated end and detects external growth before appending.
- Native mutations use held roots and capability-relative components, avoiding repeated ambient path walks.

Do not disable integrity checks for throughput. Byte counts, hashes, file sync, directory sync where supported, and journal records are part of completion.

Benchmark on representative filesystems. Local SSD, spinning disk, network mount, cross-device move, antivirus, and filesystem durability behavior differ. Report file count, total bytes, media size distribution, operation mode, filesystem, and package build with any result.
