import pull from 'lodash/pull';
import { SNItem } from '@Models/core/item';
import { ContentTypes } from '@Models/content_types';
import { SNPredicate } from '@Models/core/predicate';

/**
 * Privileges are a singleton object that store the preferences a user
 * may have configured for protecting certain actions.
 */
export class SNPrivileges extends SNItem {

  static contentType() {
    return ContentTypes.Privileges;
  }

  constructor(payload) {
    super(payload);
    if(!this.errorDecrypting && !this.content.desktopPrivileges) {
      this.content.desktopPrivileges = {};
    }
  }

  get isSingleton() {
    return true;
  }

  get singletonPredicate() {
    return new SNPredicate('content_type', '=', this.content_type);
  }

  setCredentialsForAction(action, credentials) {
    this.content.desktopPrivileges[action] = credentials;
  }

  getCredentialsForAction(action) {
    return this.content.desktopPrivileges[action] || [];
  }

  toggleCredentialForAction(action, credential) {
    if(this.isCredentialRequiredForAction(action, credential)) {
      this.removeCredentialForAction(action, credential);
    } else {
      this.addCredentialForAction(action, credential);
    }
  }

  removeCredentialForAction(action, credential) {
    pull(this.content.desktopPrivileges[action], credential);
  }

  addCredentialForAction(action, credential) {
    const credentials = this.getCredentialsForAction(action);
    credentials.push(credential);
    this.setCredentialsForAction(action, credentials);
  }

  isCredentialRequiredForAction(action, credential) {
    const credentialsRequired = this.getCredentialsForAction(action);
    return credentialsRequired.includes(credential);
  }
}