/* eslint-disable no-unused-expressions */
/* eslint-disable no-undef */
import * as Factory from './lib/factory.js';
chai.use(chaiAsPromised);
const expect = chai.expect;

/**
 * Simple empty test page to create and deinit empty application
 * Then check browser Memory tool to make sure there are no leaks.
 */
describe('memory', () => {
  before(async function () {
    localStorage.clear();
  });

  after(async function () {
    localStorage.clear();
  });

  beforeEach(async function () {
    this.application = await Factory.createInitAppWithRandNamespace();
  });

  afterEach(function () {
    this.application.deinit();
    this.application = null;
  });

  it('passes', async function () {
    expect(true).to.equal(true);
  });
});
