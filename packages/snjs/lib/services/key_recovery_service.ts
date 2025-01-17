import { SNCredentialService } from './credential_service';
import { PurePayload } from '@Payloads/pure_payload';
import { SNSyncService } from './sync/sync_service';
import { PayloadField } from './../protocol/payloads/fields';
import { CreateItemFromPayload } from '@Models/generator';
import { ApplicationStage } from './../stages';
import { StorageKey } from '@Lib/storage_keys';
import { CreateMaxPayloadFromAnyObject, RawPayload } from '@Payloads/generator';
import { KeyRecoveryStrings } from './api/messages';
import { SNStorageService, StorageValueModes } from './storage_service';
import { SNRootKeyParams } from './../protocol/key_params';
import { PayloadManager } from './payload_manager';
import {
  Challenge,
  ChallengePrompt,
  ChallengeReason,
  ChallengeValidation,
} from './../challenges';
import { SNAlertService } from './alert_service';
import { ChallengeService } from './challenge/challenge_service';
import { SNRootKey } from '@Protocol/root_key';
import { SNProtocolService } from '@Lib/services/protocol_service';
import { SNApiService } from '@Lib/services/api/api_service';
import { SNItemsKey } from './../models/app/items_key';
import { ContentType } from './../models/content_types';
import { ItemManager } from './item_manager';
import { PureService } from '@Services/pure_service';
import { dateSorted, isNullOrUndefined, removeFromArray } from '@Lib/utils';
import { KeyParamsFromApiResponse } from '@Lib/protocol/key_params';
import { leftVersionGreaterThanOrEqualToRight } from '@Lib/protocol/versions';
import { PayloadSource } from '@Lib/protocol/payloads';
import { UuidString } from '@Lib/types';
import { KeyParamsResponse } from './api/responses';

/**
 * The key recovery service listens to items key changes to detect any that cannot be decrypted.
 * If it detects an items key that is not properly decrypted, it will present a key recovery
 * wizard (using existing UI like Challenges and AlertService) that will attempt to recover
 * the root key for those keys.
 *
 * When we encounter an items key we cannot decrypt, this is a sign that the user's password may
 * have recently changed (even though their session is still valid). If the user has been
 * previously signed in, we take this opportunity to reach out to the server to get the
 * user's current key_params. We ensure these key params' version is equal to or greater than our own.

 * - If this key's key params are equal to the retrieved parameters,
    and this keys created date is greater than any existing valid items key,
    or if we do not have any items keys:
       1. Use the decryption of this key as a source of validation
       2. If valid, replace our local root key with this new root key and emit the decrypted items key
 * - Else, if the key params are not equal,
     or its created date is less than an existing valid items key
        1. Attempt to decrypt this key using its attached key paramas
        2. If valid, emit decrypted items key. DO NOT replace local root key.
 * - If by the end we did not find an items key with matching key params to the retrieved
     key params, AND the retrieved key params are newer than what we have locally, we must
     issue a sign in request to the server.

 * If the user is not signed in and we detect an undecryptable items key, we present a detached
 * recovery wizard that doesn't affect our local root key.
 *
 * When an items key is emitted, protocol service will automatically try to decrypt any
 * related items that are in an errored state.
 *
 * In the item observer, `ignored` items represent items who have encrypted overwrite
 * protection enabled (only items keys). This means that if the incoming payload is errored,
 * but our current copy is not, we will ignore the incoming value until we can properly
 * decrypt it.
 */

type UndecryptableItemsStorage = Record<UuidString, RawPayload>;
type DecryptionCallback = (key: SNItemsKey, result: DecryptionResponse) => void;

type DecryptionResponse = {
  success: boolean;
  rootKey?: SNRootKey;
};

type DecryptionQueueItem = {
  key: SNItemsKey;
  keyParams: SNRootKeyParams;
  callback?: DecryptionCallback;
  promise?: Promise<DecryptionResponse>;
  resolve?: (result: DecryptionResponse) => void;
};

export class SNKeyRecoveryService extends PureService {
  private removeItemObserver: any;
  private decryptionQueue: DecryptionQueueItem[] = [];
  private serverParams?: SNRootKeyParams;
  private isProcessingQueue = false;

  constructor(
    private itemManager: ItemManager,
    private payloadManager: PayloadManager,
    private apiService: SNApiService,
    private protocolService: SNProtocolService,
    private challengeService: ChallengeService,
    private alertService: SNAlertService,
    private storageService: SNStorageService,
    private syncService: SNSyncService,
    private credentialService: SNCredentialService
  ) {
    super();
    this.removeItemObserver = this.itemManager.addObserver(
      [ContentType.ItemsKey],
      (changed, inserted, _discarded, ignored, source) => {
        if (source === PayloadSource.LocalChanged) {
          return;
        }
        const changedOrInserted = changed
          .concat(inserted)
          .filter((k) => k.errorDecrypting) as SNItemsKey[];
        if (changedOrInserted.length > 0) {
          this.handleUndecryptableItemsKeys(changedOrInserted);
        }
        if (ignored.length > 0) {
          this.handleIgnoredItemsKeys(ignored as SNItemsKey[]);
        }
      }
    );
  }

  public deinit(): void {
    (this.itemManager as unknown) = undefined;
    (this.payloadManager as unknown) = undefined;
    (this.apiService as unknown) = undefined;
    (this.protocolService as unknown) = undefined;
    (this.challengeService as unknown) = undefined;
    (this.alertService as unknown) = undefined;
    (this.credentialService as unknown) = undefined;
    (this.syncService as unknown) = undefined;
    (this.storageService as unknown) = undefined;
    this.removeItemObserver();
    this.removeItemObserver = undefined;
    super.deinit();
  }

  async handleApplicationStage(stage: ApplicationStage) {
    super.handleApplicationStage(stage);
    if (stage === ApplicationStage.LoadedDatabase_12) {
      this.processPersistedUndecryptables();
    }
  }

  /**
   * Ignored items keys are items keys which arrived from a remote source, which we were
   * not able to decrypt, and for which we already had an existing items key that was
   * properly decrypted. Since items keys key contents are immutable, if we already have a
   * successfully decrypted version, yet we can't decrypt the new version, we should should
   * temporarily ignore the new version until we can properly decrypt it (through the recovery flow),
   * and not overwrite the local copy.
   *
   * Ignored items are persisted to disk in isolated storage so that they may be decrypted
   * whenever. When they are finally decryptable, we will emit them and update our database
   * with the new decrypted value.
   *
   * When the app first launches, we will query the isolated storage to see if there are any
   * keys we need to decrypt.
   */
  private async handleIgnoredItemsKeys(
    keys: SNItemsKey[],
    persistIncoming = true
  ) {
    /**
     * Persist the keys locally in isolated storage, so that if we don't properly decrypt
     * them in this app session, the user has a chance to later. If there already exists
     * the same items key in this storage, replace it with this latest incoming value.
     */
    if (persistIncoming) {
      await this.saveToUndecryptables(keys);
    }

    await this.addKeysToQueue(keys, (key, result) => {
      if (result.success) {
        /** If it succeeds, remove the key from isolated storage. */
        this.removeFromUndecryptables(key);
      }
    });

    await this.beginProcessingQueue();
  }

  private async handleUndecryptableItemsKeys(keys: SNItemsKey[]) {
    await this.addKeysToQueue(keys);
    await this.beginProcessingQueue();
  }

  public async processPersistedUndecryptables() {
    const record = await this.getUndecryptables();
    const rawPayloads = Object.values(record);
    if (rawPayloads.length === 0) {
      return;
    }
    const keys = rawPayloads
      .map((raw) => CreateMaxPayloadFromAnyObject(raw))
      .map((p) => CreateItemFromPayload(p)) as SNItemsKey[];
    return this.handleIgnoredItemsKeys(keys, false);
  }

  private async getUndecryptables() {
    return this.storageService.getValue(
      StorageKey.KeyRecoveryUndecryptableItems,
      StorageValueModes.Default,
      {}
    ) as Promise<UndecryptableItemsStorage>;
  }

  private async persistUndecryptables(record: UndecryptableItemsStorage) {
    await this.storageService.setValue(
      StorageKey.KeyRecoveryUndecryptableItems,
      record
    );
  }

  private async saveToUndecryptables(keys: SNItemsKey[]) {
    /** Get the current persisted value */
    const record = await this.getUndecryptables();
    /** Persist incoming keys */
    for (const key of keys) {
      record[key.uuid] = key.payload.ejected();
    }
    await this.persistUndecryptables(record);
  }

  private async removeFromUndecryptables(key: SNItemsKey) {
    /** Get the current persisted value */
    const record = await this.getUndecryptables();
    delete record[key.uuid];
    await this.persistUndecryptables(record);
  }

  private get queuePromise() {
    return Promise.all(this.decryptionQueue.map((q) => q.promise));
  }

  private async getClientKeyParams() {
    return this.protocolService.getAccountKeyParams();
  }

  private serverKeyParamsAreSafe(clientParams: SNRootKeyParams) {
    return leftVersionGreaterThanOrEqualToRight(
      this.serverParams!.version,
      clientParams.version
    );
  }

  private async performServerSignIn(
    keyParams: SNRootKeyParams
  ): Promise<SNRootKey | undefined> {
    /** Get the user's account password */
    const challenge = new Challenge(
      [
        new ChallengePrompt(
          ChallengeValidation.None,
          undefined,
          undefined,
          true
        ),
      ],
      ChallengeReason.Custom,
      true,
      KeyRecoveryStrings.KeyRecoveryLoginFlowPrompt(keyParams),
      KeyRecoveryStrings.KeyRecoveryLoginFlowReason
    );
    const challengeResponse = await this.challengeService.promptForChallengeResponse(
      challenge
    );
    if (!challengeResponse) {
      return undefined;
    }
    this.challengeService.completeChallenge(challenge);
    const password = challengeResponse.values[0].value as string;
    /** Generate a root key using the input */
    const rootKey = await this.protocolService.computeRootKey(
      password,
      keyParams
    );
    const signInResponse = await this.credentialService.correctiveSignIn(
      rootKey
    );
    if (!signInResponse.error) {
      this.alertService.alert(KeyRecoveryStrings.KeyRecoveryRootKeyReplaced);
      return rootKey;
    } else {
      await this.alertService.alert(
        KeyRecoveryStrings.KeyRecoveryLoginFlowInvalidPassword
      );
      return this.performServerSignIn(keyParams);
    }
  }

  private async getWrappingKeyIfApplicable(): Promise<SNRootKey | undefined> {
    if (!this.protocolService.hasPasscode()) {
      return undefined;
    }
    const {
      wrappingKey,
      canceled,
    } = await this.challengeService.getWrappingKeyIfApplicable();
    if (canceled) {
      /** Show an alert saying they must enter the correct passcode to update
       * their root key, and try again */
      await this.alertService.alert(
        KeyRecoveryStrings.KeyRecoveryPasscodeRequiredText,
        KeyRecoveryStrings.KeyRecoveryPasscodeRequiredTitle
      );
      return this.getWrappingKeyIfApplicable();
    }
    return wrappingKey;
  }

  private async addKeysToQueue(
    keys: SNItemsKey[],
    callback?: DecryptionCallback
  ) {
    for (const key of keys) {
      const keyParams = await this.protocolService.getKeyEmbeddedKeyParams(key);
      if (!keyParams) {
        continue;
      }
      const queueItem: DecryptionQueueItem = {
        key,
        keyParams,
        callback,
      };
      const promise: Promise<DecryptionResponse> = new Promise((resolve) => {
        queueItem.resolve = resolve;
      });
      queueItem.promise = promise;
      this.decryptionQueue.push(queueItem);
    }
  }

  private readdQueueItem(queueItem: DecryptionQueueItem) {
    const promise: Promise<DecryptionResponse> = new Promise((resolve) => {
      queueItem.resolve = resolve;
    });
    queueItem.promise = promise;
    this.decryptionQueue.unshift(queueItem);
  }

  private async beginProcessingQueue() {
    if (this.isProcessingQueue) {
      return;
    }
    this.isProcessingQueue = true;

    const clientParams = await this.getClientKeyParams();
    if (!this.serverParams && clientParams) {
      /** Get the user's latest key params from the server */
      const paramsResponse = await this.apiService.getAccountKeyParams(
        clientParams.identifier
      );
      if (!paramsResponse.error && paramsResponse.data) {
        this.serverParams = KeyParamsFromApiResponse(
          paramsResponse as KeyParamsResponse
        );
      }
    }

    const hasAccount = this.protocolService.hasAccount();
    const hasPasscode = this.protocolService.hasPasscode();
    const credentialsMissing = !hasAccount && !hasPasscode;
    let queueItem = this.decryptionQueue[0];
    if (credentialsMissing) {
      const rootKey = await this.performServerSignIn(queueItem.keyParams);
      if (rootKey) {
        await this.handleDecryptionOfAllKeysMatchingCorrectRootKey(
          rootKey,
          true
        );
        removeFromArray(this.decryptionQueue, queueItem);
        queueItem = this.decryptionQueue[0];
      }
    }
    while (queueItem) {
      this.popQueueItem(queueItem);
      await queueItem.promise!;
      /** Always start from the beginning */
      queueItem = this.decryptionQueue[0];
    }

    this.queuePromise.then(async () => {
      this.isProcessingQueue = false;
      if (this.serverParams) {
        const latestClientParams = (await this.getClientKeyParams())!;
        const serverParamsDifferFromClients =
          latestClientParams && !this.serverParams.compare(latestClientParams);
        if (
          this.serverKeyParamsAreSafe(latestClientParams) &&
          serverParamsDifferFromClients
        ) {
          /**
           * The only way left to validate our password is to sign in with the server,
           * creating an all new session.
           */
          await this.performServerSignIn(this.serverParams);
        }
      }
      if (this.syncService.isOutOfSync()) {
        this.syncService.sync({ checkIntegrity: true });
      }
    });
  }

  private async popQueueItem(queueItem: DecryptionQueueItem): Promise<void> {
    if (!queueItem.resolve) {
      throw Error('Attempting to pop queue element with no resolve function');
    }
    removeFromArray(this.decryptionQueue, queueItem);
    const keyParams = queueItem.keyParams;
    const key = queueItem.key;
    const resolve = queueItem.resolve!;

    /**
     * We replace our current root key if the server params differ from our own params,
     * and if we can validate the params based on this items key's params.
     * */
    let replacesRootKey = false;
    const clientParams = await this.getClientKeyParams();
    if (
      this.serverParams &&
      clientParams &&
      !clientParams.compare(this.serverParams) &&
      keyParams.compare(this.serverParams) &&
      this.serverKeyParamsAreSafe(this.serverParams)
    ) {
      /** Get the latest items key we _can_ decrypt */
      const latest = dateSorted(
        this.itemManager.nonErroredItemsForContentType(
          ContentType.ItemsKey
        ) as SNItemsKey[],
        PayloadField.CreatedAt,
        false
      )[0];
      const hasLocalItemsKey = !isNullOrUndefined(latest);
      const isNewerThanLatest = key.created_at > latest?.created_at;
      replacesRootKey = !hasLocalItemsKey || isNewerThanLatest;
    }
    const challenge = new Challenge(
      [
        new ChallengePrompt(
          ChallengeValidation.None,
          undefined,
          undefined,
          true
        ),
      ],
      ChallengeReason.Custom,
      true,
      KeyRecoveryStrings.KeyRecoveryLoginFlowPrompt(keyParams),
      KeyRecoveryStrings.KeyRecoveryPasswordRequired
    );
    const response = await this.challengeService.promptForChallengeResponse(
      challenge
    );
    if (!response) {
      const result = { success: false };
      resolve(result);
      queueItem.callback?.(key, result);
      return;
    }

    const password = response!.values[0].value as string;
    /** Generate a root key using the input */
    const rootKey = await this.protocolService.computeRootKey(
      password,
      keyParams
    );
    /** Attempt to decrypt this items key using the root key */
    const decryptedPayload = await this.protocolService.payloadByDecryptingPayload(
      key.payload,
      rootKey
    );
    /** Dismiss challenge */
    this.challengeService.completeChallenge(challenge);

    /** If it succeeds, re-emit this items key */
    if (!decryptedPayload.errorDecrypting) {
      /** Decrypt and remove from queue any other items keys who share these key params */
      const matching = await this.handleDecryptionOfAllKeysMatchingCorrectRootKey(
        rootKey,
        replacesRootKey,
        [decryptedPayload]
      );
      const result = { success: true };
      resolve(result);
      queueItem.callback?.(key, result);
      for (const match of matching) {
        match.resolve!(result);
        match.callback?.(match.key, result);
      }
    } else {
      await this.alertService.alert(
        KeyRecoveryStrings.KeyRecoveryUnableToRecover
      );
      /** If it fails, add back to queue */
      this.readdQueueItem(queueItem);
      resolve({ success: false });
    }
  }

  private async handleDecryptionOfAllKeysMatchingCorrectRootKey(
    rootKey: SNRootKey,
    replacesRootKey: boolean,
    additionalKeys: PurePayload[] = []
  ) {
    if (replacesRootKey) {
      /** Replace our root key with the generated root key */
      const wrappingKey = await this.getWrappingKeyIfApplicable();
      await this.protocolService.setRootKey(rootKey, wrappingKey);
    }
    const matching = this.popQueueForKeyParams(rootKey.keyParams);
    const decryptedMatching = await this.protocolService.payloadsByDecryptingPayloads(
      matching.map((m) => m.key.payload),
      rootKey
    );
    const allRelevantKeyPayloads = additionalKeys.concat(decryptedMatching);
    this.payloadManager.emitPayloads(
      allRelevantKeyPayloads,
      PayloadSource.DecryptedTransient
    );
    await this.storageService.savePayloads(allRelevantKeyPayloads);
    if (replacesRootKey) {
      this.alertService.alert(KeyRecoveryStrings.KeyRecoveryRootKeyReplaced);
    } else {
      this.alertService.alert(KeyRecoveryStrings.KeyRecoveryKeyRecovered);
    }
    return matching;
  }

  private popQueueForKeyParams(keyParams: SNRootKeyParams) {
    const matching = [];
    const nonmatching = [];
    for (const queueItem of this.decryptionQueue) {
      if (queueItem.keyParams.compare(keyParams)) {
        matching.push(queueItem);
      } else {
        nonmatching.push(queueItem);
      }
    }
    this.decryptionQueue = nonmatching;
    return matching;
  }
}
