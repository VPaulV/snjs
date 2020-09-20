import { leftVersionGreaterThanOrEqualToRight } from '@Lib/protocol/versions';
import { ProtocolVersion } from '@Protocol/versions';
import { Challenge } from '@Lib/challenges';
import { ChallengeType, ChallengeReason } from './../../challenges';
import { ChallengeService } from './../challenge/challenge_service';
import { JwtSession, TokenSession } from './session';
import { RegistrationResponse, SignInResponse, ChangePasswordResponse, HttpResponse } from './responses';
import { SNProtocolService } from './../protocol_service';
import { SNApiService } from './api_service';
import { SNStorageService } from './../storage_service';
import { SNRootKey } from '@Protocol/root_key';
import { SNRootKeyParams, AnyKeyParamsContent, KeyParamsOrigination, KeyParamsFromApiResponse } from './../../protocol/key_params';
import { PureService } from '@Lib/services/pure_service';
import { isNullOrUndefined } from '@Lib/utils';
import { SNAlertService } from '@Services/alert_service';
import { StorageKey } from '@Lib/storage_keys';
import { Session } from '@Lib/services/api/session';
import * as messages from './messages';

export const MINIMUM_PASSWORD_LENGTH = 8;

type SessionManagerResponse = {
  response: HttpResponse;
  rootKey?: SNRootKey;
  keyParams?: AnyKeyParamsContent
}

type User = {
  uuid: string
  email?: string
}

/**
 * The session manager is responsible for loading initial user state, and any relevant
 * server credentials, such as the session token. It also exposes methods for registering
 * for a new account, signing into an existing one, or changing an account password.
 */
export class SNSessionManager extends PureService {

  private user?: User

  constructor(
    private storageService: SNStorageService,
    private apiService: SNApiService,
    private alertService: SNAlertService,
    private protocolService: SNProtocolService,
    private challengeService: ChallengeService,
  ) {
    super();
    apiService.setInvalidSessionObserver(() => {
      this.reauthenticateInvalidSession();
    });
  }

  deinit() {
    (this.protocolService as any) = undefined;
    (this.storageService as any) = undefined;
    (this.apiService as any) = undefined;
    (this.alertService as any) = undefined;
    this.user = undefined;
    super.deinit();
  }

  public async initializeFromDisk() {
    this.user = await this.storageService!.getValue(StorageKey.User);
    if (!this.user) {
      /** @legacy Check for uuid. */
      const uuid = await this.storageService!.getValue(StorageKey.LegacyUuid);
      if (uuid) {
        this.user = { uuid: uuid };
      }
    }

    const rawSession = await this.storageService!.getValue(StorageKey.Session);
    if (rawSession) {
      await this.setSession(Session.FromRawStorageValue(rawSession), false);
    }
  }

  private async setSession(session: Session, persist: boolean = true) {
    await this.apiService!.setSession(session, persist);
  }

  public online() {
    return !this.offline();
  }

  public offline() {
    return isNullOrUndefined(this.apiService!.getSession());
  }

  public getUser() {
    return this.user;
  }

  public async signOut() {
    this.user = undefined;
    const session = this.apiService!.getSession();
    if (session && session.canExpire()) {
      await this.apiService!.signOut();
    }
  }

  private async reauthenticateInvalidSession() {
    const challenge = new Challenge(
      [ChallengeType.Custom, ChallengeType.Custom],
      ChallengeReason.Custom,
      `Please enter your account email and password.`,
      `Your credentials are needed to refresh your session with the server.`,
      [`Email`, `Password`]
    );
    const response = await this.challengeService
      .promptForChallengeResponseWithCustomValidation(challenge);
    const email = response[0]?.value as string;
    const password = response[1]?.value as string;
    if (!email || !password) {
      return;
    }
    const currentKeyParams = await this.protocolService.getAccountKeyParams();
    await this.signIn(email, password, false, currentKeyParams!.version);
  }

  async promptForMfaValue(): Promise<string | undefined> {
    const challenge = new Challenge(
      [ChallengeType.Custom],
      ChallengeReason.Custom,
      `Please enter your two-factor authentication code.`
    );
    const response = await this.challengeService
      .promptForChallengeResponseWithCustomValidation(challenge);
    return response[0]?.value as string;
  }

  async register(email: string, password: string): Promise<SessionManagerResponse> {
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      return {
        response: this.apiService!.createErrorResponse(
          messages.InsufficientPasswordMessage(MINIMUM_PASSWORD_LENGTH)
        )
      };
    }
    const rootKey = await this.protocolService!.createRootKey(
      email,
      password,
      KeyParamsOrigination.Registration
    );
    const serverPassword = rootKey.serverPassword;
    const keyParams = rootKey.keyParams;

    const registerResponse = await this.apiService!.register(
      email,
      serverPassword,
      keyParams
    );
    if (!registerResponse.error) {
      await this.handleSuccessAuthResponse(registerResponse);
    }
    return {
      response: registerResponse,
      rootKey: rootKey
    };
  }

  public async signIn(
    email: string,
    password: string,
    strict = false,
    minAllowedVersion?: ProtocolVersion
  ): Promise<SessionManagerResponse> {
    const paramsResponse = await this.apiService!.getAccountKeyParams(
      email
    );
    if (paramsResponse.error) {
      return {
        response: paramsResponse
      };
    }
    const keyParams = KeyParamsFromApiResponse(paramsResponse);
    if (!keyParams || !keyParams.version) {
      return {
        response: this.apiService!.createErrorResponse(messages.API_MESSAGE_FALLBACK_LOGIN_FAIL)
      };
    }
    if (!this.protocolService!.supportedVersions().includes(keyParams.version)) {
      if (this.protocolService!.isVersionNewerThanLibraryVersion(keyParams.version)) {
        return {
          response: this.apiService!.createErrorResponse(messages.UNSUPPORTED_PROTOCOL_VERSION)
        };
      } else {
        return {
          response: this.apiService!.createErrorResponse(messages.EXPIRED_PROTOCOL_VERSION)
        };
      }
    }
    if (this.protocolService!.isProtocolVersionOutdated(keyParams.version)) {
      /* Cost minimums only apply to now outdated versions (001 and 002) */
      const minimum = this.protocolService!.costMinimumForVersion(keyParams.version);
      if (keyParams.content002.pw_cost < minimum) {
        return {
          response: this.apiService!.createErrorResponse(messages.INVALID_PASSWORD_COST)
        };
      };
      const message = messages.OUTDATED_PROTOCOL_VERSION;
      const confirmed = await this.alertService!.confirm(
        message,
        messages.OUTDATED_PROTOCOL_ALERT_TITLE,
        messages.OUTDATED_PROTOCOL_ALERT_IGNORE,
      );
      if (!confirmed) {
        return {
          response: this.apiService!.createErrorResponse(messages.API_MESSAGE_FALLBACK_LOGIN_FAIL)
        };
      }
    }
    if (!this.protocolService!.platformSupportsKeyDerivation(keyParams)) {
      return {
        response: this.apiService!.createErrorResponse(messages.UNSUPPORTED_KEY_DERIVATION)
      };
    }
    if (strict) {
      minAllowedVersion = this.protocolService!.getLatestVersion();
    }
    if (!isNullOrUndefined(minAllowedVersion)) {
      if (!leftVersionGreaterThanOrEqualToRight(keyParams.version, minAllowedVersion)) {
        return {
          response: this.apiService!.createErrorResponse(
            messages.StrictSignInFailed(keyParams.version, minAllowedVersion)
          )
        };
      }
    }
    const { rootKey, serverPassword } = await this.protocolService!.computeRootKey(
      password,
      keyParams
    ).then((rootKey) => {
      return {
        rootKey: rootKey,
        serverPassword: rootKey.serverPassword
      };
    });
    const signInResponse = await this.bypassChecksAndSignInWithServerPassword(
      email,
      serverPassword,
    )
    return {
      response: signInResponse,
      rootKey: await SNRootKey.ExpandedCopy(rootKey, signInResponse.key_params),
    };
  }

  public async bypassChecksAndSignInWithServerPassword(
    email: string,
    serverPassword: string,
    mfaKeyPath?: string,
    mfaCode?: string,
  ): Promise<SignInResponse> {
    const signInResponse = await this.apiService!.signIn(
      email,
      serverPassword,
      mfaKeyPath,
      mfaCode
    )
    if (!signInResponse.error) {
      await this.handleSuccessAuthResponse(signInResponse);
      return signInResponse;
    } else {
      if (signInResponse.error.payload?.mfa_key) {
        /** Prompt for MFA code and try again */
        const mfaCode = await this.promptForMfaValue();
        if (!mfaCode) {
          /** User dismissed window without input */
          return signInResponse;
        }
        return this.bypassChecksAndSignInWithServerPassword(
          email,
          serverPassword,
          signInResponse.error.payload.mfa_key,
          mfaCode
        )
      } else {
        /** Some other error, return to caller */
        return signInResponse;
      }
    }
  }

  public async changePassword(
    currentServerPassword: string,
    newServerPassword: string,
    newKeyParams: SNRootKeyParams
  ): Promise<SessionManagerResponse> {
    const response = await this.apiService!.changePassword(
      currentServerPassword,
      newServerPassword,
      newKeyParams
    );
    if (!response.error) {
      await this.handleSuccessAuthResponse(response);
    }
    return {
      response: response,
      keyParams: response.key_params
    };
  }

  private async handleSuccessAuthResponse(
    response: RegistrationResponse | SignInResponse | ChangePasswordResponse
    ) {
    const user = response.user;
    this.user = user;
    await this.storageService!.setValue(StorageKey.User, user);

    if (response.token) {
      /** Legacy JWT response */
      const session = new JwtSession(response.token);
      await this.setSession(session);
    } else {
      /** Non-legacy expirable sessions */
      const session = TokenSession.FromApiResponse(response);
      await this.setSession(session);
    }
  }
}
