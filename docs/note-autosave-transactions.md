# Note autosave transactions

HwanNote stores Markdown files and `.hwan-note-index.json` as separate files. A
single filesystem call cannot atomically commit both, so autosave uses two
layers of protection:

1. each note, index, and journal update is staged in a same-directory temporary
   file, written with `write_all`, synchronized with `sync_all`, and published
   with an atomic single-file replacement primitive; and
2. `.hwan-note-autosave.json` records enough durable intent to finish or roll
   back an interrupted multi-file save before the ordinary library scanner can
   assign IDs or reconcile the index.

The index publication is the logical commit point. Before it, the previous
index remains authoritative and a path-changing save retains the previous
Markdown file. After it, the new index and new Markdown path are authoritative.
The autosave API reports success only after the superseded path, transaction
temps, and journal have also been removed successfully.

## Transaction phases

| Journal phase | Durable state | Recovery action |
| --- | --- | --- |
| `prepared` | Intent exists; note/index temps may be absent or incomplete; no final path may have been changed | Remove recorded partial temps and journal, preserving the previous note/index |
| `staged` | Both temp payloads completed `write_all` and `sync_all` | Verify their content, publish the note, then continue forward; if neither staged nor final note exists and the old index is intact, roll back |
| `note_published` | Final Markdown bytes are durable; old path is retained; index may still be old | Verify the final digest and exact old-index identity, publish or recognize the recorded next index, then continue forward |
| `index_published` | New note/index pair is committed | Verify both, delete only the recorded superseded file with its original digest, clean temps, then remove the journal |

Every replay operation is idempotent. If a file operation completed but the
following phase update did not, recovery recognizes the already-published note
by its SHA-256 digest and the already-published index by semantic equality.
Repeated startup, reload, or save retry therefore converges without adding
suffix files, orphan notes, or a path-derived replacement note ID.

The previous file is never deleted merely because its name matches the journal.
Cleanup first verifies that the file is a trusted regular file beneath the
canonical library root and that its SHA-256 digest still matches the recorded
pre-save content. A mismatch indicates an external edit and fails closed.

## Journal names and replacement failures

At most one autosave transaction is active under the process-wide note-index
lock:

- `.hwan-note-autosave.json` is the primary durable journal.
- `.hwan-note-autosave.json.next` is the fixed replacement candidate used for
  journal creation and phase changes.
- transaction note and index temps contain a unique numeric operation ID and
  end in `.tmp`; their exact relative paths are stored in the journal.

Recovery handles every journal-name state before scanning Markdown files:

- Primary only: validate and replay the primary journal.
- Primary plus `.next`: both must describe the same operation. The primary is
  the last known durable phase; the tentative candidate is removed, and replay
  detects any action that already completed after that phase.
- Valid `.next` only: promote it to the primary name and replay it. This state
  can occur when a platform replacement reports a partial failure, so it is not
  treated as disposable debris.
- Invalid `.next` only, corrupt primary, mismatched operation IDs, unsafe paths,
  changed index bytes, or unexpected note content: fail closed. The normal
  scan/index reconciler does not run while recovery is unresolved.

Journal validation also binds the unique operation ID to the exact expected
temp filenames and requires `nextIndex[noteId].relativePath` to equal the
recorded final note path. This prevents a malformed journal from redirecting
transaction cleanup or publication to another library file.

## Startup and mutation ordering

Pending autosave recovery runs while holding the note-index lock:

- before `load_markdown_library` reads the index or scans the library;
- before autosave plans another destination; and
- before folder rename/delete, note resolution/delete/index removal, and note
  migration read or mutate index-dependent paths.

This ordering is essential. The generic reconciler treats an unindexed
Markdown file as a new external note and derives a new ID from its path. It must
never observe a journaled intermediate destination belonging to an existing
note.

When recovery cannot proceed, library loading returns an `incomplete` result
whose issue names `recover_pending_note_save` and the journal path. Writers
return the underlying path-aware error. HwanNote does not guess, delete a
conflicting file, or silently discard a cleanup failure.

## Windows and Unix publication

All publication temps share the destination's parent directory, which keeps
the operation on one filesystem.

- On Unix, HwanNote uses `rename`, whose replace-existing operation is atomic:
  readers see either the old or new directory entry, not a missing/partial
  destination. The containing directory is synchronized after publication and
  deletion.
- On Windows, an existing destination is replaced explicitly with
  `ReplaceFileW` and `REPLACEFILE_WRITE_THROUGH`; a missing destination uses a
  normal rename. The journal accounts for the documented partial failure
  outcomes by re-inspecting both source/destination and both journal names.
  Windows does not expose the same portable directory-`fsync` contract as Unix,
  so HwanNote relies on the synced files, write-through replacement, and
  journal replay.

References:

- [Rust `std::fs::rename`](https://doc.rust-lang.org/std/fs/fn.rename.html)
- [Rust `File::sync_all`](https://doc.rust-lang.org/std/fs/struct.File.html#method.sync_all)
- [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- [Windows `ReplaceFileW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)

## Guarantee boundary

HwanNote guarantees deterministic recovery from process termination, panic,
and filesystem operations that report failure, provided the same library later
becomes accessible and its recorded files have not been externally changed.
Single-file publication is atomic on supported same-volume filesystems; the
note-plus-index operation is a recoverable transaction, not a globally atomic
filesystem transaction.

The implementation also issues file synchronization, Unix directory
synchronization, and Windows write-through replacement to reduce sudden-power
loss exposure. Physical persistence is nevertheless best effort when storage
hardware ignores flushes or the library is hosted by a network, cloud-sync, or
other filesystem with weaker semantics. In an ambiguous post-crash state,
HwanNote fails closed instead of selecting a file by timestamp or scan order.

If a conflict persists, preserve the journal, `.next`, index, and both Markdown
paths before manual intervention. Resolve the external file/index change or
restore a consistent library backup, then restart HwanNote so journal replay
can run before normal reconciliation.
