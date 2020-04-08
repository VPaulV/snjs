import { TagMutator } from './../models/app/tag';
import { ItemsKeyMutator } from './../models/app/items_key';
import { SNTag } from '@Models/app/tag';
import { SNNote, NoteMutator } from './../models/app/note';
import { SNItemsKey } from '@Models/index';
import { SNActionsExtension, ActionsExtensionMutator } from './../models/app/extension';
import { SNSmartTag } from './../models/app/smartTag';
import { SNPredicate } from './../models/core/predicate';
import { Uuid } from './../uuid';
import { PayloadsByDuplicating } from '@Payloads/functions';
import { UuidString } from './../types';
import { MutableCollection } from './../protocol/payloads/mutable_collection';
import { CreateItemFromPayload, BuildItemContent, Uuids } from '@Models/generator';
import { PureService } from '@Lib/services/pure_service';
import { ComponentMutator } from './../models/app/component';
import { SNComponent } from '@Models/app/component';
import { isString, removeFromArray, searchArray } from '@Lib/utils';
import { CreateMaxPayloadFromAnyObject } from '@Payloads/generator';
import { PayloadOverride, PayloadContent } from './../protocol/payloads/generator';
import { SNItem, ItemMutator, MutationType } from './../models/core/item';
import { PayloadSource } from './../protocol/payloads/sources';
import { PurePayload } from './../protocol/payloads/pure_payload';
import { PayloadManager } from './model_manager';
import { ContentType } from '../models/content_types';

type ObserverCallback = (
  /** The items are pre-existing but have been changed */
  changed: SNItem[],
  /** The items have been newly inserted */
  inserted: SNItem[],
  /** The items have been deleted from local state (and remote state if applicable) */
  discarded: SNItem[],
  source?: PayloadSource,
  sourceKey?: string
) => Promise<void>

const nondeleted = (items: SNItem[]) => {
  return items.filter((item) => !item.deleted);
}

type Observer = {
  contentType: ContentType[]
  callback: ObserverCallback
}

/**
 * The item manager is backed by the Payload Manager. Think of the item manager as a 
 * more user-friendly or item-specific interface to creating and updating data. 
 * The item manager listens for change events from the global payload manager, and 
 * converts any payloads to SNItems, then propagates those items to listeners on the 
 * item  manager. When the item manager makes a change to an item, it will modify items 
 * using a  mutator, then emit those payloads to the payload manager. The payload manager 
 * will then notify  its observers (which is us), we'll convert the payloads to items, 
 * and then  we'll propagate them to our listeners.
 */
export class ItemManager extends PureService {

  private modelManager?: PayloadManager
  private unsubChangeObserver: any
  private observers: Observer[] = []
  private collection: MutableCollection<SNItem>
  private systemSmartTags: SNSmartTag[]

  /** Maintains an index for each item id where the value is an array of item ids that the 
   * item references. This is essentially equivalent to item.content.references, 
   * but keeps state even when the item is deleted. So if tag A references Note B, 
   * referenceMap[A.uuid] == [B.uuid]. */
  private referenceMap: Partial<Record<UuidString, UuidString[]>> = {}
  /** Maintains an index for each item id where the value is an array of item ids where 
   * the items reference the key item. So if tag A references Note B, 
   * inverseReferenceMap[B.uuid] == [A.uuid]. This allows callers to determine for a given item,
   * who references it? It would be prohibitive to look this up on demand */
  private inverseReferenceMap: Partial<Record<UuidString, UuidString[]>> = {}

  constructor(modelManager: PayloadManager) {
    super();
    this.modelManager = modelManager;
    this.collection = new MutableCollection();
    this.unsubChangeObserver = this.modelManager
      .addChangeObserver(ContentType.Any, this.onPayloadChange.bind(this));
    this.systemSmartTags = SNSmartTag.systemSmartTags();
  }

  public deinit() {
    this.unsubChangeObserver();
    this.unsubChangeObserver = undefined;
    this.modelManager = undefined;
    this.resetState();
  }

  private resetState() {
    this.collection = new MutableCollection();
    this.referenceMap = {};
    this.inverseReferenceMap = {};
  }

  /**
   * Returns an item for a given id
   */
  findItem(uuid: UuidString) {
    return this.collection.find(uuid) as SNItem | undefined;
  }

  /**
   * Returns all items matching given ids
   * @param includeBlanks If true and an item is not found, an `undefined` element
   * will be inserted into the array.
   */
  findItems(uuids: UuidString[], includeBlanks = false) {
    return this.collection.findAll(uuids, includeBlanks);
  }

  /**
   * Returns all non-deleted items keys
   */
  get itemsKeys() {
    return nondeleted(this.collection.all(ContentType.ItemsKey)) as SNItemsKey[];
  }

  /**
  * Returns all non-deleted notes
  */
  get notes() {
    return nondeleted(this.collection.all(ContentType.Note)) as SNNote[];
  }

  /**
  * Returns all non-deleted tags
  */
  get tags() {
    return nondeleted(this.collection.all(ContentType.Tag)) as SNTag[];
  }

  /**
  * Returns all non-deleted components
  */
  get components() {
    return nondeleted(this.collection.all(ContentType.Component)) as SNComponent[];
  }

  public addObserver(
    contentType: ContentType | ContentType[],
    callback: ObserverCallback,
  ) {
    if (!Array.isArray(contentType)) {
      contentType = [contentType];
    }
    const observer: Observer = {
      contentType,
      callback
    }
    this.observers.push(observer);
    return () => {
      removeFromArray(this.observers, observer);
    }
  }

  /**
   * Returns the items that reference the given item, or an empty array if no results.
   */
  private itemsReferencingItem(uuid: UuidString) {
    if (!isString(uuid)) {
      throw Error('Must use uuid string');
    }
    const uuids = this.uuidsThatReferenceUuid(uuid);
    return this.findItems(uuids);
  }

  /**
   * Returns all items that an item directly references
   */
  private referencesForItem(uuid: UuidString) {
    if (!isString(uuid)) {
      throw Error('Must use uuid string');
    }
    const item = this.findItem(uuid)!;
    const uuids = item.references.map((ref) => ref.uuid);
    return this.findItems(uuids);
  }

  private uuidsThatReferenceUuid(uuid: UuidString) {
    if (!isString(uuid)) {
      throw Error('Must use uuid string');
    }
    return this.inverseReferenceMap[uuid] || [];
  }

  private updateReferenceIndex(item: SNItem) {
    if (isString(item)) {
      throw Error('Must use item reference');
    }
    const previousDirect = this.referenceMap[item.uuid] || [];
    /** Direct index */
    this.referenceMap[item.uuid] = item.references.map((r) => r.uuid);

    /** Inverse index */
    /** First remove any old values in case references have changed */
    for (const previousDirectReference of previousDirect) {
      const inverseIndex = this.inverseReferenceMap[previousDirectReference];
      if (inverseIndex) {
        removeFromArray(inverseIndex, item.uuid);
      }
    }

    /** Now map current references */
    for (const reference of item.references) {
      const inverseIndex = this.inverseReferenceMap[reference.uuid] || [];
      inverseIndex.push(item.uuid);
      this.inverseReferenceMap[reference.uuid] = inverseIndex;
    }
  }

  private deestablishReferenceIndexForDeletedItem(uuid: UuidString) {
    /** Items that we reference */
    const directReferences = this.referenceMap[uuid] || []
    for (const directReference of directReferences) {
      removeFromArray(
        this.inverseReferenceMap[directReference] || [],
        uuid
      );
    }
    delete this.referenceMap[uuid];

    /** Items that are referencing us */
    const inverseReferences = this.inverseReferenceMap[uuid] || []
    for (const inverseReference of inverseReferences) {
      removeFromArray(
        this.referenceMap[inverseReference] || [],
        uuid
      );
    }
    delete this.inverseReferenceMap[uuid];
  }

  private async onPayloadChange(
    changed: PurePayload[],
    inserted: PurePayload[],
    discarded: PurePayload[],
    source?: PayloadSource,
    sourceKey?: string
  ) {
    return this.setPayloads(
      changed,
      inserted,
      discarded,
      source,
      sourceKey
    );
  }

  private async setPayloads(
    changed: PurePayload[],
    inserted: PurePayload[],
    discarded: PurePayload[],
    source?: PayloadSource,
    sourceKey?: string,
  ) {

    const changedItems = changed.map((p) => CreateItemFromPayload(p));
    const insertedItems = inserted.map((p) => CreateItemFromPayload(p));
    const changedOrInserted = changedItems.concat(insertedItems);
    for (const item of changedOrInserted) {
      if (item.deleted) {
        this.deestablishReferenceIndexForDeletedItem(item.uuid);
      } else {
        this.updateReferenceIndex(item);
      }
    }
    this.collection.set(changedOrInserted)

    const discardedItems = discarded.map((p) => CreateItemFromPayload(p));
    for (const item of discardedItems) {
      this.deestablishReferenceIndexForDeletedItem(item.uuid);
      this.collection.delete(item);
    }

    await this.notifyObservers(changedItems, insertedItems, discardedItems, source, sourceKey);
  }

  private async notifyObservers(
    changed: SNItem[],
    inserted: SNItem[],
    discarded: SNItem[],
    source?: PayloadSource,
    sourceKey?: string
  ) {
    for (const observer of this.observers) {
      const filter = (items: SNItem[], types: ContentType[]) => {
        return items.filter((item) => {
          return (
            types.includes(ContentType.Any) ||
            types.includes(item.content_type)
          )
        });
      }
      await observer.callback(
        filter(changed, observer.contentType),
        filter(inserted, observer.contentType),
        filter(discarded, observer.contentType),
        source,
        sourceKey
      );
    }
  }

  /**
   * Consumers wanting to modify an item should run it through this block,
   * so that data is properly mapped through our function, and latest state
   * is properly reconciled.
   * @param itemOrUuid If an item is passed, the values of that item will be directly used,
   * and the mutation will be applied on that item and propagated. This means that if you pass
   * an old item reference and mutate that, the new value will be outdated. In this case, always
   * pass the uuid of the item if you want to mutate the latest version of the item.
   */
  async changeItem(
    uuid: UuidString,
    mutate?: (mutator: ItemMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    if(!isString(uuid)) {
      throw Error('Invalid uuid for changeItem');
    }
    const results = await this.changeItems(
      [uuid],
      mutate,
      mutationType,
      payloadSource,
      payloadSourceKey
    );
    return results[0];
  }

  private createMutatorForItem(item: SNItem, type: MutationType) {
    if(item.content_type === ContentType.Note) {
      return new NoteMutator(item, type);
    } else if (item.content_type === ContentType.Tag) {
      return new TagMutator(item, type);
    } else if(item.content_type === ContentType.Component) {
      return new ComponentMutator(item, type);
    } else if (item.content_type === ContentType.ActionsExtension) {
      return new ActionsExtensionMutator(item, type);
    } else if (item.content_type === ContentType.ItemsKey) {
      return new ItemsKeyMutator(item, type);
    } else {
      return new ItemMutator(item, type);
    }
  }

  /**
   * @param mutate If not supplied, the intention would simply be to mark the item as dirty.
   */
  public async changeItems(
    uuids: UuidString[],
    mutate?: (mutator: ItemMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const items = this.findItems(uuids as UuidString[], true);
    const payloads = [];
    for (const item of items) {
      if (!item) {
        throw Error('Attempting to change non-existant item');
      }
      const mutator = this.createMutatorForItem(item, mutationType);
      if (mutate) {
        mutate(mutator);
      }
      const payload = mutator.getResult();
      payloads.push(payload);
    }
    await this.modelManager!.emitPayloads(
      payloads,
      payloadSource || PayloadSource.LocalChanged,
      payloadSourceKey
    );
    const results = this.findItems(payloads.map((p) => p.uuid!));
    return results;
  }

  async changeNote(
    uuid: UuidString,
    mutate: (mutator: NoteMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const note = this.findItem(uuid);
    if (!note) {
      throw Error('Attempting to change non-existant note');
    }
    const mutator = new NoteMutator(note, mutationType);
    return this.applyTransform(
      mutator,
      mutate,
      payloadSource,
      payloadSourceKey
    )
  }

  async changeComponent(
    uuid: UuidString,
    mutate: (mutator: ComponentMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const component = this.findItem(uuid);
    if (!component) {
      throw Error('Attempting to change non-existant component');
    }
    const mutator = new ComponentMutator(component, mutationType);
    return this.applyTransform(
      mutator,
      mutate,
      payloadSource,
      payloadSourceKey
    )
  }

  async changeActionsExtension(
    uuid: UuidString,
    mutate: (mutator: ActionsExtensionMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const extension = this.findItem(uuid);
    if (!extension) {
      throw Error('Attempting to change non-existant extension');
    }
    const mutator = new ActionsExtensionMutator(extension, mutationType);
    return this.applyTransform(
      mutator,
      mutate,
      payloadSource,
      payloadSourceKey
    )
  }

  async changeItemsKey(
    uuid: UuidString,
    mutate: (mutator: ItemsKeyMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const itemsKey = this.findItem(uuid);
    if (!itemsKey) {
      throw Error('Attempting to change non-existant itemsKey');
    }
    const mutator = new ItemsKeyMutator(itemsKey, mutationType);
    return this.applyTransform(
      mutator,
      mutate,
      payloadSource,
      payloadSourceKey
    )
  }

  private async applyTransform<T extends ItemMutator>(
    mutator: T,
    mutate: (mutator: T) => void,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    mutate(mutator);
    const payload = mutator.getResult();
    return this.modelManager!.emitPayload(
      payload,
      payloadSource || PayloadSource.LocalChanged,
      payloadSourceKey
    );
  }

  /**
    * Sets the item as needing sync. The item is then run through the mapping function,
    * and propagated to mapping observers.
    * @param updateClientDate - Whether to update the item's "user modified date"
    */
  public async setItemDirty(
    uuid: UuidString,
    isUserModified = false,
    source?: PayloadSource,
    sourceKey?: string
  ) {
    if (!isString(uuid)) {
      throw Error('Must use uuid when setting item dirty');
    }
    const result = await this.setItemsDirty(
      [uuid],
      isUserModified,
      source,
      sourceKey
    );
    return result[0];
  }

  /**
   * Similar to `setItemDirty`, but acts on an array of items as the first param.
   */
  public async setItemsDirty(
    uuids: UuidString[],
    isUserModified = false,
    source?: PayloadSource,
    sourceKey?: string
  ) {
    if (!isString(uuids[0])) {
      throw Error('Must use uuid when setting item dirty');
    }
    return this.changeItems(
      uuids,
      undefined,
      isUserModified ? MutationType.UserInteraction : MutationType.Internal,
      source,
      sourceKey
    );
  }

  /**
   * Returns an array of items that need to be synced.
   */
  public getDirtyItems() {
    return this.items.filter((item) => {
      /* An item that has an error decrypting can be synced only if it is being deleted.
        Otherwise, we don't want to send corrupt content up to the server. */
      return item.dirty && !item.dummy && (!item.errorDecrypting || item.deleted);
    });
  }

  /**
   * Inserts the item as-is by reading its payload value. This function will not 
   * modify item in any way (such as marking it as dirty). It is up to the caller
   * to pass in a dirtied item if that is their intention.
   */
  public async insertItem(item: SNItem) {
    const payload = item.payload;
    const insertedItem = await this.emitItemFromPayload(payload);
    return insertedItem;
  }

  /**
   * Duplicates an item and maps it, thus propagating the item to observers.
   * @param isConflict - Whether to mark the duplicate as a conflict of the original.
   */
  public async duplicateItem(uuid: UuidString, isConflict = false) {
    const item = this.findItem(uuid)!;
    const payload = CreateMaxPayloadFromAnyObject(item);
    const resultingPayloads = await PayloadsByDuplicating(
      payload,
      this.modelManager!.getMasterCollection(),
      isConflict,
    );
    await this.modelManager!.emitPayloads(
      resultingPayloads,
      PayloadSource.LocalChanged
    );
    const duplicate = this.findItem(resultingPayloads[0].uuid!);
    return duplicate!;
  }

  /**
   * Creates an item and conditionally maps it and marks it as dirty.
   * @param needsSync - Whether to mark the item as needing sync
   */
  public async createItem(
    contentType: ContentType,
    content?: PayloadContent,
    needsSync = false,
    override?: PayloadOverride
  ) {
    if (!contentType) {
      throw 'Attempting to create item with no contentType';
    }
    const payload = CreateMaxPayloadFromAnyObject(
      {
        uuid: await Uuid.GenerateUuid(),
        content_type: contentType,
        content: BuildItemContent(content),
        dirty: needsSync
      },
      undefined,
      undefined,
      override
    );
    await this.modelManager!.emitPayload(payload, PayloadSource.Constructor);
    return this.findItem(payload.uuid!)!;
  }

  public async createTemplateItem(
    contentType: ContentType,
    content?: PayloadContent,
  ) {
    const payload = CreateMaxPayloadFromAnyObject(
      {
        uuid: await Uuid.GenerateUuid(),
        content_type: contentType,
        content: BuildItemContent(content)
      }
    );
    return CreateItemFromPayload(payload);
  }

  public async emitItemFromPayload(
    payload: PurePayload,
    source = PayloadSource.Constructor
  ) {
    await this.modelManager!.emitPayload(payload, source);
    return this.findItem(payload.uuid!)!;
  }

  public async emitItemsFromPayloads(
    payloads: PurePayload[],
    source = PayloadSource.Constructor
  ) {
    await this.modelManager!.emitPayloads(payloads, source);
    const uuids = Uuids(payloads);
    return this.findItems(uuids);
  }

  /**
   * Marks the item as deleted and needing sync.
   */
  public async setItemToBeDeleted(uuid: UuidString) {
    /** Capture referencing ids before we delete the item below, otherwise
     * the index may be updated before we get a chance to act on it */
    const referencingIds = this.uuidsThatReferenceUuid(uuid);

    const item = this.findItem(uuid);
    const changedItem = await this.changeItem(uuid, (mutator) => {
      mutator.setDeleted();
    });

    /** Handle indirect relationships. 
     * (Direct relationships are cleared by clearing content above) */
    for (const referencingId of referencingIds) {
      const referencingItem = this.findItem(referencingId);
      if (referencingItem) {
        await this.changeItem(referencingItem.uuid, (mutator) => {
          mutator.removeItemAsRelationship(item!);
        });
      }
    }
    this.deestablishReferenceIndexForDeletedItem(uuid);
    return changedItem;
  }

  /**
   * Like `setItemToBeDeleted`, but acts on an array of items.
   */
  public async setItemsToBeDeleted(uuids: UuidString[]) {
    const changedItems = [];
    for (const uuid of uuids) {
      const changedItem = await this.setItemToBeDeleted(uuid);
      changedItems.push(changedItem);
    }
    return changedItems;
  }

  /** 
   * Returns a detached array of all items
   */
  public get items() {
    return this.collection.all();
  }

  /**
   * Returns a detached array of all items which are not dummys
   */
  public get allNondummyItems() {
    return this.items.filter((item) => {
      return !item.dummy;
    });
  }

  /**
   * Returns a detached array of all items which are not deleted
   */
  public get nonDeletedItems() {
    return this.items.filter((item) => {
      return !item.dummy && !item.deleted;
    });
  }

  /**
   * Returns all items of a certain type
   * @param contentType - A string or array of strings representing
   *    content types.
   */
  public getItems(contentType: ContentType | ContentType[]): SNItem[] {
    if (Array.isArray(contentType)) {
      return this.items.filter((item) => {
        return !item.dummy && contentType.includes(item.content_type!);
      });
    } else {
      return this.collection.all(contentType);
    }
  }

  /** 
   * Returns all items that have not been able to decrypt.
   */
  public invalidItems() {
    return this.items.filter((item) => {
      return item.errorDecrypting;
    });
  }

  /**
   * Returns all items which are properly decrypted
   */
  validItemsForContentType(contentType: ContentType) {
    const items = this.collection.all(contentType);
    return items.filter((item) => !item.errorDecrypting);
  }

  /**
   * Returns all items matching a given predicate
   */
  public itemsMatchingPredicate(predicate: SNPredicate) {
    return this.itemsMatchingPredicates([predicate]);
  }

  /**
  * Returns all items matching an array of predicates
  */
  public itemsMatchingPredicates(predicates: SNPredicate[]) {
    return this.filterItemsWithPredicates(this.items, predicates);
  }

  /**
   * Performs actual predicate filtering for public methods above.
   * Does not return deleted items.
   */
  private filterItemsWithPredicates(items: SNItem[], predicates: SNPredicate[]) {
    const results = items.filter((item) => {
      if (item.deleted) {
        return false;
      }
      for (const predicate of predicates) {
        if (!item.satisfiesPredicate(predicate)) {
          return false;
        }
      }
      return true;
    });
    return results;
  }

  /**
   * Finds the first tag matching a given title
   */
  public findTagByTitle(title: string) {
    return searchArray(this.tags, { title: title });
  }

  /**
  * Finds or creates a tag with a given title
  */
  public async findOrCreateTagByTitle(title: string) {
    const tag = this.findTagByTitle(title);
    return tag || await this.createItem(
      ContentType.Tag,
      BuildItemContent({ title }),
      true
    ) as SNTag;
  }

  /**
   * Returns all notes matching the smart tag
   */
  public notesMatchingSmartTag(smartTag: SNSmartTag) {
    const contentTypePredicate = new SNPredicate('content_type', '=', ContentType.Note);
    const predicates = [contentTypePredicate, smartTag.predicate];
    if (!smartTag.isTrashTag) {
      const notTrashedPredicate = new SNPredicate('content.trashed', '=', false);
      predicates.push(notTrashedPredicate);
    }
    const results = this.itemsMatchingPredicates(predicates);
    return results;
  }

  /**
   * Returns the smart tag corresponding to the "Trash" tag.
   */
  public get trashSmartTag() {
    return this.systemSmartTags.find((tag) => tag.isTrashTag)!;
  }

  /**
   * Returns all items currently in the trash
   */
  public get trashedItems() {
    return this.notesMatchingSmartTag(this.trashSmartTag);
  }

  /**
   * Permanently deletes any items currently in the trash. Consumer must manually call sync.
   */
  public async emptyTrash() {
    const notes = this.trashedItems;
    return this.setItemsToBeDeleted(Uuids(notes));
  }

  /**
   * Returns all smart tags, sorted by title.
   */
  public getSmartTags() {
    const userTags = this.validItemsForContentType(ContentType.SmartTag) as SNSmartTag[];
    const sortedUserTags = userTags.sort((a, b) => {
      return a.title < b.title ? -1 : 1;
    }) as SNSmartTag[];
    return this.systemSmartTags.concat(sortedUserTags);
  }

  /**
   * The number of notes currently managed
   */
  public get noteCount() {
    return this.notes.filter((n) => !n.dummy).length;
  }

  /**
   * Immediately removes all items from mapping state and notifies observers
   * Used primarily when signing into an account and wanting to discard any current
   * local data.
   */
  public async removeAllItemsFromMemory() {
    const uuids = Uuids(this.items);
    await this.changeItems(uuids, (mutator) => {
      mutator.setDeleted();
    });
    this.resetState();
    this.modelManager!.resetState();
  }

  public removeItemLocally(item: SNItem) {
    this.collection.delete(item);
    this.modelManager!.removePayloadLocally(item.payload);
  }
}