// Rebuild the FTS index from the RecordsStore — needed at startup so meetings
// recorded before the assistant feature existed are searchable too.
export async function rebuildMeetingIndexFromRecords(records, index) {
  const sessions = await records.listSessions();
  const packages = [];
  for (const session of sessions) {
    try {
      const record = await records.readSession(session.id);
      packages.push({
        metadata: record.metadata,
        entries: record.entries,
        summary: record.summary?.structured,
      });
    } catch {
      // An unreadable package must not block indexing the rest.
    }
  }
  index.rebuild(packages);
  return packages.length;
}
