import { MysqlDatabase } from '@codegraph/shared';

export class VersionCleaner {
  constructor(private db: MysqlDatabase) {}

  /**
   * Triggers the cleanup process for a given repo and branch.
   * Runs asynchronously and does not block the main request handler.
   */
  async cleanupOldVersions(repo: string, branch: string): Promise<void> {
    try {
      // 1. Get all versions for the repo and branch, sorted by created_at DESC
      const versions = await this.db.query(
        'SELECT version_id, status FROM version_history WHERE repo = ? AND branch = ? AND status != ? ORDER BY created_at DESC',
        [repo, branch, 'deleting']
      );

      // Keep only the most recent 7 versions
      if (versions.length <= 7) {
        return;
      }

      const toDelete = versions.slice(7);
      for (const ver of toDelete) {
        const versionId = ver.version_id;
        console.log(`[Cleaner] Starting cleanup of version: ${repo}@${branch}:${versionId}`);

        // 2. Mark status as 'deleting' in a quick transaction to hide it from queries immediately
        await this.db.execute(
          'UPDATE version_history SET status = ? WHERE repo = ? AND branch = ? AND version_id = ?',
          ['deleting', repo, branch, versionId]
        );

        // 3. Delete related data table by table
        // We can do this in separate transactions or queries. We will delete in separate statements.
        await this.db.execute(
          'DELETE FROM nodes WHERE repo = ? AND branch = ? AND version_id = ?',
          [repo, branch, versionId]
        );
        await this.db.execute(
          'DELETE FROM edges WHERE repo = ? AND branch = ? AND version_id = ?',
          [repo, branch, versionId]
        );
        await this.db.execute(
          'DELETE FROM files WHERE repo = ? AND branch = ? AND version_id = ?',
          [repo, branch, versionId]
        );
        await this.db.execute(
          'DELETE FROM unresolved_refs WHERE repo = ? AND branch = ? AND version_id = ?',
          [repo, branch, versionId]
        );
        await this.db.execute(
          'DELETE FROM project_metadata WHERE repo = ? AND branch = ? AND version_id = ?',
          [repo, branch, versionId]
        );

        // 4. Finally delete the history row
        await this.db.execute(
          'DELETE FROM version_history WHERE repo = ? AND branch = ? AND version_id = ?',
          [repo, branch, versionId]
        );

        console.log(`[Cleaner] Successfully cleaned up version: ${repo}@${branch}:${versionId}`);
      }
    } catch (err) {
      console.error(`[Cleaner] Error cleaning up versions for ${repo}@${branch}:`, err);
    }
  }

  /**
   * Manually deletes a specific version.
   */
  async deleteSpecificVersion(repo: string, branch: string, versionId: string): Promise<void> {
    console.log(`[Cleaner] Manually deleting version: ${repo}@${branch}:${versionId}`);
    await this.db.execute(
      'UPDATE version_history SET status = ? WHERE repo = ? AND branch = ? AND version_id = ?',
      ['deleting', repo, branch, versionId]
    );

    await this.db.execute(
      'DELETE FROM nodes WHERE repo = ? AND branch = ? AND version_id = ?',
      [repo, branch, versionId]
    );
    await this.db.execute(
      'DELETE FROM edges WHERE repo = ? AND branch = ? AND version_id = ?',
      [repo, branch, versionId]
    );
    await this.db.execute(
      'DELETE FROM files WHERE repo = ? AND branch = ? AND version_id = ?',
      [repo, branch, versionId]
    );
    await this.db.execute(
      'DELETE FROM unresolved_refs WHERE repo = ? AND branch = ? AND version_id = ?',
      [repo, branch, versionId]
    );
    await this.db.execute(
      'DELETE FROM project_metadata WHERE repo = ? AND branch = ? AND version_id = ?',
      [repo, branch, versionId]
    );
    await this.db.execute(
      'DELETE FROM version_history WHERE repo = ? AND branch = ? AND version_id = ?',
      [repo, branch, versionId]
    );

    console.log(`[Cleaner] Manually deleted version: ${repo}@${branch}:${versionId}`);
  }
}
