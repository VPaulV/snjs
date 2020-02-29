/* eslint-disable no-unused-expressions */
/* eslint-disable no-undef */
import '../dist/snjs.js';
import '../node_modules/chai/chai.js';
import './vendor/chai-as-promised-built.js';
import Factory from './lib/factory.js';
import { EncryptionIntents } from '../lib/protocol/intents.js';
chai.use(chaiAsPromised);
const expect = chai.expect;

describe('protocol', () => {
  const application = Factory.createApplication();
  before(async () => {
    localStorage.clear();
    await Factory.initializeApplication(application);
  });

  after(() => {
    application.deinit();
    localStorage.clear();
  });

  beforeEach(async function () {
    // this.application = await Factory.createInitAppWithRandNamespace();
  });

  it('checks version to make sure its 004', () => {
    expect(application.protocolService.getLatestVersion()).to.equal("004");
  });

  it('checks supported versions to make sure it includes 001, 002, 003, 004', () => {
    expect(application.protocolService.supportedVersions()).to.eql(["001", "002", "003", "004"]);
  });

  it('cryptoweb should support costs greater than 5000', () => {
    expect(application.protocolService.supportsPasswordDerivationCost(5001)).to.equal(true);
  });

  it('version comparison of 002 should be older than library version', () => {
    expect(application.protocolService.isVersionNewerThanLibraryVersion("002")).to.equal(false);
  });

  it('version comparison of 005 should be newer than library version', () => {
    expect(application.protocolService.isVersionNewerThanLibraryVersion("005")).to.equal(true);
  });

  it('library version should not be outdated', () => {
    var currentVersion = application.protocolService.getLatestVersion();
    expect(application.protocolService.isProtocolVersionOutdated(currentVersion)).to.equal(false);
  });

  it('decrypting already decrypted payload should return same payload', async function() {
    const payload = Factory.createNotePayload();
    const result = await application.protocolService.payloadByDecryptingPayload({ payload });
    expect(payload).to.equal(result);
    expect(result.errorDecrypting).to.not.be.ok;
  });

  it('decrypting 000 payload should succeed', async function () {
    const payload = CreateMaxPayloadFromAnyObject({
      object: {
        uuid: await Uuid.GenerateUuid(),
        content_type: ContentTypes.Mfa,
        content: {
          secret: '123'
        }
      }
    });
    const encrypted = await application.protocolService.payloadByEncryptingPayload({
      payload,
      intent: EncryptionIntents.SyncDecrypted
    });
    expect(encrypted.content.startsWith('000')).to.equal(true);
    const decrypted = await application.protocolService.payloadByDecryptingPayload({ 
      payload: encrypted
    });
    expect(decrypted.errorDecrypting).to.not.be.ok;
    expect(decrypted.content.secret).to.equal(payload.content.secret);
  });
});
