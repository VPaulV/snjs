import { PayloadContent } from './../../protocol/payloads/generator';
import { PayloadOverride, CopyPayload } from '@Payloads/generator';
import { PurePayload } from './../../protocol/payloads/pure_payload';
import { deepFreeze, Copy } from '@Lib/utils';
import { SNPredicate } from '@Models/core/predicate';
import { ItemContentsEqual, ItemContentsDiffer } from '@Models/core/functions';
import { ConflictStrategies, } from '@Payloads/index';

export enum MutationType {
  /**
   * The item was changed as part of a user interaction. This means that the item's 
   * user modified date will be updated
   */
  UserInteraction = 1,
  /**
   * The item was changed as part of an internal operation, such as a migration.
   * This change will not updated the item's user modified date
   */
  Internal = 1,
}

const UserModifiedDateKey = 'client_updated_at';

export enum AppDataField {
  Pinned = 'pinned',
  Archived = 'archived',
  Locked = 'locked',
  UserModifiedDate = 'client_updated_at',
  DefaultEditor = 'defaultEditor',
  MobileRules = 'mobileRules',
  NotAvailableOnMobile = 'notAvailableOnMobile',
  MobileActive = 'mobileActive',
  LastSize = 'lastSize',
  PrefersPlainEditor = 'prefersPlainEditor'
}

type AppData = {
  [key in AppDataField]?: any
}

export enum SingletonStrategies {
  KeepEarliest = 1
};

/**
 * The most abstract item that any syncable item needs to extend from.
 */
export class SNItem {

  public readonly payload: PurePayload
  private static sharedDateFormatter: Intl.DateTimeFormat

  constructor(payload: PurePayload) {
    if(!payload.uuid || !payload.content_type) {
      throw Error('Cannot create item without both uuid and content_type');
    }
    this.payload = payload;
    /** Allow the subclass constructor to complete initialization before deep freezing */
    setImmediate(() => {
      deepFreeze(this);
    })
  }

  public static DefaultAppDomain() {
    return 'org.standardnotes.sn';
  }

  get uuid() {
    return this.payload.uuid!;
  }

  get content() {
    return this.payload.content;
  }

  get references() {
    return this.payload.safeContent.references || [];
  }

  get deleted() {
    return this.payload.deleted;
  }

  get content_type() {
    return this.payload.content_type!;
  }

  get items_key_id() {
    return this.payload.items_key_id;
  }

  get enc_item_key() {
    return this.payload.enc_item_key;
  }

  get created_at() {
    return this.payload.created_at!;
  }

  get updated_at() {
    return this.payload.updated_at!;
  }

  get user_modified_at() {
    const value = this.getAppDomainValue(AppDataField.UserModifiedDate);
    return new Date(value || this.updated_at);
  }

  get dirtiedDate() {
    return this.payload.dirtiedDate;
  }

  get dirty() {
    return this.payload.dirty;
  }

  get dummy() {
    return this.payload.dummy;
  }

  get errorDecrypting() {
    return this.payload.errorDecrypting;
  }

  get waitingForKey() {
    return this.payload.waitingForKey;
  }

  get errorDecryptingValueChanged() {
    return this.payload.errorDecryptingValueChanged;
  }

  get lastSyncBegan() {
    return this.payload.lastSyncBegan;
  }

  get lastSyncEnd() {
    return this.payload.lastSyncEnd;
  }

  /** @deprecated */
  get auth_hash() {
    return this.payload.auth_hash;
  }

  /** @deprecated */
  get auth_params() {
    return this.payload.auth_params;
  }

  public payloadRepresentation(override?: PayloadOverride) {
    return CopyPayload(this.payload, override);
  }

  public hasRelationshipWithItem(item: SNItem) {
    const target = this.payload.safeContent.references?.find((r) => {
      return r.uuid === item.uuid;
    });
    return !!target;
  }

  /**
   * Inside of content is a record called `appData` (which should have been called `domainData`).
   * It was named `appData` as a way to indicate that it can house data for multiple apps.
   * Each key of appData is a domain string, which was originally designed
   * to allow for multiple 3rd party apps who share access to the same data to store data
   * in an isolated location. This design premise is antiquited and no longer pursued,
   * however we continue to use it as not to uncesesarily create a large data migration
   * that would require users to sync all their data.
   * 
   * domainData[DomainKey] will give you another Record<string, any>.
   * 
   * Currently appData['org.standardnotes.sn'] returns an object of type AppData.
   * And appData['org.standardnotes.sn.components] returns an object of type ComponentData
   */
  public getDomainData(domain: string) {
    const domainData = this.payload.safeContent.appData;
    if (!domainData) {
      return undefined;
    }
    const data = domainData[domain];
    return data;
  }

  public getAppDomainValue(key: AppDataField) {
    const appData = this.getDomainData(SNItem.DefaultAppDomain());
    return appData[key];
  }

  public get protected() {
    return this.payload.safeContent.protected;
  }

  public get trashed() {
    return this.payload.safeContent.trashed;
  }

  public get pinned() {
    return this.getAppDomainValue(AppDataField.Pinned);
  }

  public get archived() {
    return this.getAppDomainValue(AppDataField.Archived);
  }

  public get locked() {
    return this.getAppDomainValue(AppDataField.Locked);
  }

  /**
   * During sync conflicts, when determing whether to create a duplicate for an item, 
   * we can omit keys that have no meaningful weight and can be ignored. For example, 
   * if one component has active = true and another component has active = false, 
   * it would be needless to duplicate them, so instead we ignore that value.
   */
  public contentKeysToIgnoreWhenCheckingEquality() {
    return ['conflict_of'];
  }

  /** Same as `contentKeysToIgnoreWhenCheckingEquality`, but keys inside appData[Item.AppDomain] */
  public appDataContentKeysToIgnoreWhenCheckingEquality() {
    return [AppDataField.UserModifiedDate];
  }

  public getContentCopy() {
    const contentCopy = JSON.parse(JSON.stringify(this.content));
    return contentCopy;
  }

  /** Whether the item has never been synced to a server */
  public get neverSynced() {
    return !this.updated_at || this.updated_at.getTime() === 0;
  }

  /**
   * Subclasses can override this getter to return true if they want only
   * one of this item to exist, depending on custom criteria.
   */
  public get isSingleton() {
    return false;
  }

  /** The predicate by which singleton items should be unique */
  public get singletonPredicate(): SNPredicate {
    throw 'Must override SNItem.singletonPredicate';
  }

  public get singletonStrategy() {
    return SingletonStrategies.KeepEarliest;
  }

  /**
   * Subclasses can override this method and provide their own opinion on whether
   * they want to be duplicated. For example, if this.content.x = 12 and
   * item.content.x = 13, this function can be overriden to always return
   * ConflictStrategies.KeepLeft to say 'don't create a duplicate at all, the
   * change is not important.'
   *
   * In the default implementation, we create a duplicate if content differs.
   * However, if they only differ by references, we KEEP_LEFT_MERGE_REFS.
   */
  public strategyWhenConflictingWithItem(item: SNItem) {
    if (this.errorDecrypting) {
      return ConflictStrategies.KeepLeftDuplicateRight;
    }
    if (this.isSingleton) {
      return ConflictStrategies.KeepLeft;
    }
    if (this.deleted || item.deleted) {
      return ConflictStrategies.KeepRight;
    }
    const contentDiffers = ItemContentsDiffer(this, item);
    if (!contentDiffers) {
      return ConflictStrategies.KeepRight;
    }
    const differsExclRefs = ItemContentsDiffer(
      this,
      item,
      ['references']
    );
    if (differsExclRefs) {
      return ConflictStrategies.KeepLeftDuplicateRight;
    } else {
      /** Is only references change */
      return ConflictStrategies.KeepLeftMergeRefs;
    }
  }

  public isItemContentEqualWith(otherItem: SNItem) {
    return ItemContentsEqual(
      this.payload.contentObject,
      otherItem.payload.contentObject,
      this.contentKeysToIgnoreWhenCheckingEquality(),
      this.appDataContentKeysToIgnoreWhenCheckingEquality()
    );
  }

  public satisfiesPredicate(predicate: SNPredicate) {
    return SNPredicate.ItemSatisfiesPredicate(this, predicate);
  }

  public createdAtString() {
    if (this.created_at) {
      return this.dateToLocalizedString(this.created_at);
    }
  }

  public updatedAtString() {
    return this.dateToLocalizedString(this.user_modified_at);
  }

  public updatedAtTimestamp() {
    return this.updated_at?.getTime();
  }

  private dateToLocalizedString(date: Date) {
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      if (!SNItem.sharedDateFormatter) {
        const locale = (
          (navigator.languages && navigator.languages.length)
            ? navigator.languages[0]
            : navigator.language
        );
        SNItem.sharedDateFormatter = new Intl.DateTimeFormat(locale, {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          weekday: 'long',
          hour: '2-digit',
          minute: '2-digit',
        });
      }
      return SNItem.sharedDateFormatter.format(date);
    } else {
      // IE < 11, Safari <= 9.0.
      // In English, this generates the string most similar to
      // the toLocaleDateString() result above.
      return date.toDateString() + ' ' + date.toLocaleTimeString();
    }
  }
}

/**
 * An item mutator takes in an item, and an operation, and returns the resulting payload.
 * Subclasses of mutators can modify the content field directly, but cannot modify the payload directly.
 * All changes to the payload must occur by copying the payload and reassigning its value.
 */
export class ItemMutator {
  protected readonly item: SNItem
  protected readonly source: MutationType
  protected payload: PurePayload
  protected content?: PayloadContent

  constructor(item: SNItem, source: MutationType) {
    this.item = item;
    this.source = source;
    this.payload = item.payload;
    this.content = Copy(this.payload.content);
  }

  public getResult() {
    if (!this.payload.deleted) {
      if (this.source === MutationType.UserInteraction) {
        // Set the user modified date to now if marking the item as dirty
        this.setAppDataItem(UserModifiedDateKey, new Date());
      } else {
        const currentValue = this.item.getAppDomainValue(AppDataField.UserModifiedDate);
        if (!currentValue) {
          // if we don't have an explcit raw value, we initialize client_updated_at.
          this.setAppDataItem(UserModifiedDateKey, new Date(this.item.updated_at!));
        }
      }
    }
    return CopyPayload(
      this.payload,
      {
        content: this.content,
        dirty: true,
        dirtiedDate: new Date(),
      }
    )
  }

  public setDeleted() {
    this.content = undefined;
    this.payload = CopyPayload(
      this.payload,
      {
        content: this.content,
        deleted: true
      }
    )
  }

  public set lastSyncBegan(began: Date) {
    this.payload = CopyPayload(
      this.payload,
      {
        content: this.content,
        lastSyncBegan: began
      }
    )
  }

  public set protected(isProtected: boolean) {
    this.content!.protected = isProtected;
  }

  public set trashed(trashed: boolean) {
    this.content!.trashed = trashed;
  }

  public set pinned(pinned: boolean) {
    this.setAppDataItem(AppDataField.Pinned, pinned);
  }

  public set archived(archived: boolean) {
    this.setAppDataItem(AppDataField.Archived, archived);
  }

  public set locked(locked: boolean) {
    this.setAppDataItem(AppDataField.Locked, locked);
  }

  /**
   * Overwrites the entirety of this domain's data with the data arg.
   */
  public setDomainData(data: any, domain: string) {
    if (this.payload.errorDecrypting) {
      return undefined;
    }
    const content = this.content!.appData || {};
    content.appData[domain] || data;
  }

  /**
   * First gets the domain data for the input domain.
   * Then sets data[key] = value
   */
  public setDomainDataKey(key: string, value: any, domain: string) {
    if (this.payload.errorDecrypting) {
      return undefined;
    }
    if (!this.content!.appData) {
      this.content!.appData = {};
    }
    const globalData = this.content!.appData;
    if (!globalData[domain]) {
      globalData[domain] = {};
    }
    const domainData = globalData[domain];
    domainData[key] = value;
  }

  public setAppDataItem(key: string, value: any) {
    this.setDomainDataKey(key, value, SNItem.DefaultAppDomain());
  }

  public addItemAsRelationship(item: SNItem) {
    const references = this.content!.references || [];
    if (!references.find((r) => r.uuid === item.uuid)) {
      references.push({
        uuid: item.uuid,
        content_type: item.content_type!
      });
    }
    this.content!.references = references;
  }

  public removeItemAsRelationship(item: SNItem) {
    let references = this.content!.references || [];
    references = references.filter((r) => r.uuid !== item.uuid);
    this.content!.references = references;
  }
}