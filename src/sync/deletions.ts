/** Session-only evidence: copied snapshots and offline absences never authorize deletion. */
export class DeletionTracker {
    private seen = new Set<string>();
    readonly pending = new Set<string>();

    observe(paths: Iterable<string>) { for (const path of paths) this.seen.add(path); }
    deleted(path: string) {
        for (const seen of this.seen) {
            if (seen === path || seen.startsWith(path + '/')) this.pending.add(seen);
        }
    }
    complete(path: string) { this.pending.delete(path); this.seen.delete(path); }
}
