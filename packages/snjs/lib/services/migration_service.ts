import { compareSemVersions } from '@Lib/version';
import { SNLog } from '@Lib/log';
import { SnjsVersion, isRightVersionGreaterThanLeft } from './../version';
import { ApplicationEvent } from './../events';
import { ApplicationStage } from '@Lib/stages';
import { MigrationServices } from './../migrations/types';
import { Migration } from '@Lib/migrations/migration';
import * as migrationImports from '@Lib/migrations';
import { BaseMigration } from '@Lib/migrations/base';
import { PureService } from '@Services/pure_service';
import { RawStorageKey, namespacedKey } from '@Lib/storage_keys';
import { lastElement } from '@Lib/utils';

/**
 * The migration service orchestrates the execution of multi-stage migrations.
 * Migrations are registered during initial application launch, and listen for application
 * life-cycle events, and act accordingly. Migrations operate on the app-level, and not global level.
 * For example, a single migration may perform a unique set of steps when the application
 * first launches, and also other steps after the application is unlocked, or after the
 * first sync completes. Migrations live under /migrations and inherit from the base Migration class.
 */
export class SNMigrationService extends PureService {
  private activeMigrations?: Migration[];
  private baseMigration!: BaseMigration;

  constructor(private services: MigrationServices) {
    super();
  }

  public deinit() {
    (this.services as any) = undefined;
    if (this.activeMigrations) {
      this.activeMigrations.length = 0;
    }
    super.deinit();
  }

  public async initialize() {
    await this.runBaseMigrationPreRun();

    const requiredMigrations = await SNMigrationService.getRequiredMigrations(
      await this.getStoredSnjsVersion()
    );
    this.activeMigrations = this.instantiateMigrationClasses(
      requiredMigrations
    );
    if (this.activeMigrations.length > 0) {
      const lastMigration = lastElement(this.activeMigrations) as Migration;
      lastMigration.onDone(async () => {
        await this.markMigrationsAsDone();
      });
    } else {
      await this.services.deviceInterface.setRawStorageValue(
        namespacedKey(this.services.identifier, RawStorageKey.SnjsVersion),
        SnjsVersion
      );
    }
  }

  private async markMigrationsAsDone() {
    await this.services.deviceInterface.setRawStorageValue(
      namespacedKey(this.services.identifier, RawStorageKey.SnjsVersion),
      SnjsVersion
    );
  }

  private async runBaseMigrationPreRun() {
    this.baseMigration = new BaseMigration(this.services);
    await this.baseMigration.preRun();
  }

  /**
   * Application instances will call this function directly when they arrive
   * at a certain migratory state.
   */
  public async handleApplicationStage(stage: ApplicationStage) {
    await super.handleApplicationStage(stage);
    await this.handleStage(stage);
  }

  /**
   * Called by application
   */
  public async handleApplicationEvent(event: ApplicationEvent) {
    if (event === ApplicationEvent.SignedIn) {
      await this.handleStage(ApplicationStage.SignedIn_30);
    }
  }

  public async hasPendingMigrations() {
    const requiredMigrations = await SNMigrationService.getRequiredMigrations(
      await this.getStoredSnjsVersion()
    );
    return (
      requiredMigrations.length > 0 ||
      (await this.baseMigration.needsKeychainRepair())
    );
  }

  public async getStoredSnjsVersion() {
    const version = await this.services.deviceInterface.getRawStorageValue(
      namespacedKey(this.services.identifier, RawStorageKey.SnjsVersion)
    );
    if (!version) {
      throw SNLog.error(
        Error('Snjs version missing from storage, run base migration.')
      );
    }
    return version;
  }

  private static async getRequiredMigrations(storedVersion: string) {
    const resultingClasses = [];
    const migrationClasses = Object.keys(migrationImports)
      .map((key) => {
        return (migrationImports as any)[key];
      })
      .sort((a, b) => {
        return compareSemVersions(a.version(), b.version());
      });
    for (const migrationClass of migrationClasses) {
      const migrationVersion = migrationClass.version();
      if (migrationVersion === storedVersion) {
        continue;
      }
      if (isRightVersionGreaterThanLeft(storedVersion, migrationVersion)) {
        resultingClasses.push(migrationClass);
      }
    }
    return resultingClasses;
  }

  private instantiateMigrationClasses(classes: any[]) {
    return classes.map((migrationClass) => {
      return new migrationClass(this.services);
    });
  }

  private async handleStage(stage: ApplicationStage) {
    await this.baseMigration.handleStage(stage);
    for (const migration of this.activeMigrations!) {
      await migration.handleStage(stage);
    }
  }
}
