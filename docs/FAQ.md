# FAQ

## Does META Mover determine the true creation date?

It ranks available evidence. Embedded capture fields with usable timezone and precision can be strong evidence. Filenames and filesystem times are weaker. Conflicts and weak results are labeled instead of presented as fact.

## What happens when the date is uncertain?

The preview targets `_Needs Review` and shows the evidence, confidence, and warnings.

## Does it change EXIF or file timestamps?

No. Metadata writeback is disabled and rejected. Decisions live in evidence and history records.

## Is copy or move the default?

Copy. Move is explicit and needs a destructive-operation acknowledgement after preview.

## Can files overwrite one another?

No. Targets use exclusive reservations. Conflict policy is Skip or Rename. Overwrite is not supported.

## What if the app stops during a move?

The journal, conservation copy, delete intent, and receipt let startup reconcile the known state. Ambiguous state preserves objects and stays visible.

## Does it detect corrupt media?

No. It rejects unreadable, changed, unsupported, or hash-mismatched files, but it does not claim to diagnose media corruption.

## Does it require Python, SQLite, FFmpeg, or system ExifTool?

No. Packages carry ExifTool, Perl where needed, the filesystem helper, and the launch broker. There is no runtime installer or host fallback.

## Which packages are verified?

Current local proof covers Linux x64 `deb` and `rpm`. macOS and Windows need signed native package and attestor proof. AppImage and portable formats are unsupported.

## Where are job records stored?

Under Electron's application data directory as strict JSON and append-only JSONL files. These records can contain full local paths and metadata.
