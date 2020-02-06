import { Migration } from '@Lib/migration/migrations/migration';
import { RAW_STORAGE_KEY_LAST_MIGRATION_TIMESTAMP } from '@Lib/storage_keys';
import { ApplicationStages } from '@Lib/stages';
import { isNullOrUndefined } from '@Lib/utils';

export class BaseMigration extends Migration {

  /** @public */
  static timestamp() {
    return (new Date('2020-01-01').getTime());
  }

  /** @protected */
  registerStageHandlers() {
    this.registerStageHandler(ApplicationStages.PreparingForLaunch_0, async () => {
      return this.migrateMigrationTimestampAllPlatforms();
    });
  }

  /**
  * @private
   * Establish last_migration_date.
   * We need to determine if this is a new application download,
   * or if we're coming from an older, non-current client.

   * If new application download, we expect last_migration_date
   * to be null. However, last_migration_date can also be null if you
   * haven't yet migration to using this system.

   * So in addition to this date being null, we check if deviceInterface
   * has pre-existing storage values for old migration system.
   * If so, this means this is a legacy client making its first jump to
   * this new migration system.
   */
  async migrateMigrationTimestampAllPlatforms() {
     const legacyKey = 'migrations';
     const legacyMigrationsValue = await this.application.deviceInterface.getRawStorageValue(
       legacyKey
     );
     const newKey = `${this.application.namespace}-${RAW_STORAGE_KEY_LAST_MIGRATION_TIMESTAMP}`;
     const lastDate = await this.application.deviceInterface.getRawStorageValue(newKey);
     const hasLegacyValue = !isNullOrUndefined(legacyMigrationsValue);
     const hasNewStructure = !isNullOrUndefined(lastDate);
     if(!hasNewStructure && hasLegacyValue) {
       /**
        * Old client updating for the first time. We need to run all migrations.
        * Set last migration date as epoch.
        */
        const newLastMigrationDate = new Date(0).getTime();
        await this.application.deviceInterface.setRawStorageValue(newKey, newLastMigrationDate);
     }
     else if(!hasNewStructure && !hasLegacyValue) {
       /** New application, dont run any migrations. Set last migration date as now. */
       const newLastMigrationDate = new Date().getTime();
       await this.application.deviceInterface.setRawStorageValue(newKey, newLastMigrationDate);
     }
      else if(hasNewStructure) {
       /** Application which has already performed base migration. Keep date as is. */
     }
  }
}