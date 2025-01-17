import { CreateSourcedPayloadFromObject } from '@Payloads/generator';
import { PayloadsDelta } from '@Payloads/deltas/delta';
import { PayloadSource } from '@Payloads/sources';
import { ImmutablePayloadCollection } from '@Protocol/collection/payload_collection';

export class DeltaRemoteRejected extends PayloadsDelta {
  // eslint-disable-next-line @typescript-eslint/require-await
  public async resultingCollection(): Promise<ImmutablePayloadCollection> {
    const results = [];
    for (const payload of this.applyCollection.all()) {
      const decrypted = this.findRelatedPayload(
        payload.uuid!,
        PayloadSource.DecryptedTransient
      );
      if (!decrypted) {
        throw 'Unable to find decrypted counterpart for rejected payload.';
      }
      const result = CreateSourcedPayloadFromObject(
        decrypted,
        PayloadSource.RemoteRejected,
        {
          lastSyncEnd: new Date(),
          dirty: false,
        }
      );
      results.push(result);
    }
    return ImmutablePayloadCollection.WithPayloads(
      results,
      PayloadSource.RemoteRejected
    );
  }
}
