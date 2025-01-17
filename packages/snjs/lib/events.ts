import { SyncEvent } from '@Services/sync/events';
export { SyncEvent };

export enum ApplicationEvent {
  SignedIn = 2,
  SignedOut = 3,

  /** When a full, potentially multi-page sync completes */
  CompletedFullSync = 5,

  FailedSync = 6,
  HighLatencySync = 7,
  EnteredOutOfSync = 8,
  ExitedOutOfSync = 9,

  /**
   * The application has finished it `prepareForLaunch` state and is now ready for unlock
   * Called when the application has initialized and is ready for launch, but before
   * the application has been unlocked, if applicable. Use this to do pre-launch
   * configuration, but do not attempt to access user data like notes or tags.
   */
  Started = 10,

  /**
   * The applicaiton is fully unlocked and ready for i/o
   * Called when the application has been fully decrypted and unlocked. Use this to
   * to begin streaming data like notes and tags.
   */
  Launched = 11,
  LocalDataLoaded = 12,

  /**
   * When the root key or root key wrapper changes. Includes events like account state
   * changes (registering, signing in, changing pw, logging out) and passcode state
   * changes (adding, removing, changing).
   */
  KeyStatusChanged = 13,

  MajorDataChange = 14,
  CompletedRestart = 15,
  LocalDataIncrementalLoad = 16,
  SyncStatusChanged = 17,
  WillSync = 18,
  InvalidSyncSession = 19,
  LocalDatabaseReadError = 20,
  LocalDatabaseWriteError = 21,

  /** When a single roundtrip completes with sync, in a potentially multi-page sync request.
   * If just a single roundtrip, this event will be triggered, along with CompletedFullSync */
  CompletedIncrementalSync = 22,

  /**
   * The application has loaded all pending migrations (but not run any, except for the base one),
   * and consumers may now call `hasPendingMigrations`
   */
  MigrationsLoaded = 23,

  /** When StorageService is ready to start servicing read/write requests */
  StorageReady = 24,

  PreferencesChanged = 25,
  ProtectionSessionExpiryDateChanged = 26,
  UserRolesChanged = 27,
}

export function applicationEventForSyncEvent(syncEvent: SyncEvent) {
  return ({
    [SyncEvent.FullSyncCompleted]: ApplicationEvent.CompletedFullSync,
    [SyncEvent.SingleSyncCompleted]: ApplicationEvent.CompletedIncrementalSync,
    [SyncEvent.SyncError]: ApplicationEvent.FailedSync,
    [SyncEvent.SyncTakingTooLong]: ApplicationEvent.HighLatencySync,
    [SyncEvent.EnterOutOfSync]: ApplicationEvent.EnteredOutOfSync,
    [SyncEvent.ExitOutOfSync]: ApplicationEvent.ExitedOutOfSync,
    [SyncEvent.LocalDataLoaded]: ApplicationEvent.LocalDataLoaded,
    [SyncEvent.MajorDataChange]: ApplicationEvent.MajorDataChange,
    [SyncEvent.LocalDataIncrementalLoad]:
      ApplicationEvent.LocalDataIncrementalLoad,
    [SyncEvent.StatusChanged]: ApplicationEvent.SyncStatusChanged,
    [SyncEvent.SyncWillBegin]: ApplicationEvent.WillSync,
    [SyncEvent.InvalidSession]: ApplicationEvent.InvalidSyncSession,
    [SyncEvent.DatabaseReadError]: ApplicationEvent.LocalDatabaseReadError,
    [SyncEvent.DatabaseWriteError]: ApplicationEvent.LocalDatabaseWriteError,
  } as any)[syncEvent];
}
