// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import {
  filter,
  firstValueFrom,
  merge,
  Observable,
  ReplaySubject,
  scan,
  startWith,
  timer,
} from "rxjs";
import { map, pairwise, share, takeUntil } from "rxjs/operators";

import { EventCollectionService } from "@bitwarden/common/abstractions/event/event-collection.service";
import { AccountInfo, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { getOptionalUserId } from "@bitwarden/common/auth/services/account.service";
import {
  AutofillOverlayVisibility,
  CardExpiryDateDelimiters,
} from "@bitwarden/common/autofill/constants";
import { AutofillSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/autofill-settings.service";
import { DomainSettingsService } from "@bitwarden/common/autofill/services/domain-settings.service";
import { UserNotificationSettingsServiceAbstraction } from "@bitwarden/common/autofill/services/user-notification-settings.service";
import { InlineMenuVisibilitySetting } from "@bitwarden/common/autofill/types";
import { normalizeExpiryYearFormat } from "@bitwarden/common/autofill/utils";
import { BillingAccountProfileStateService } from "@bitwarden/common/billing/abstractions/account/billing-account-profile-state.service";
import { EventType } from "@bitwarden/common/enums";
import { FeatureFlag } from "@bitwarden/common/enums/feature-flag.enum";
import {
  UriMatchStrategySetting,
  UriMatchStrategy,
} from "@bitwarden/common/models/domain/domain-service";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { MessageListener } from "@bitwarden/common/platform/messaging";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { TotpService } from "@bitwarden/common/vault/abstractions/totp.service";
import { FieldType, CipherType } from "@bitwarden/common/vault/enums";
import { CipherRepromptType } from "@bitwarden/common/vault/enums/cipher-reprompt-type";
import { CardView } from "@bitwarden/common/vault/models/view/card.view";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FieldView } from "@bitwarden/common/vault/models/view/field.view";
import { IdentityView } from "@bitwarden/common/vault/models/view/identity.view";

import { BrowserApi } from "../../platform/browser/browser-api";
import { ScriptInjectorService } from "../../platform/services/abstractions/script-injector.service";
// FIXME (PM-22628): Popup imports are forbidden in background
// eslint-disable-next-line no-restricted-imports
import { openVaultItemPasswordRepromptPopout } from "../../vault/popup/utils/vault-popout-window";
import { AutofillMessageCommand, AutofillMessageSender } from "../enums/autofill-message.enums";
import { AutofillPort } from "../enums/autofill-port.enum";
import AutofillField from "../models/autofill-field";
import AutofillPageDetails from "../models/autofill-page-details";
import AutofillScript from "../models/autofill-script";

import {
  AutoFillOptions,
  AutofillService as AutofillServiceInterface,
  COLLECT_PAGE_DETAILS_RESPONSE_COMMAND,
  FormData,
  GenerateFillScriptOptions,
  PageDetail,
} from "./abstractions/autofill.service";
import {
  AutoFillConstants,
  CardExpiryDateFormat,
  CreditCardAutoFillConstants,
  IdentityAutoFillConstants,
} from "./autofill-constants";

export default class AutofillService implements AutofillServiceInterface {
  private openVaultItemPasswordRepromptPopout = openVaultItemPasswordRepromptPopout;
  private openPasswordRepromptPopoutDebounce: number | NodeJS.Timeout;
  private currentlyOpeningPasswordRepromptPopout = false;
  private autofillScriptPortsSet = new Set<chrome.runtime.Port>();
  static searchFieldNamesSet = new Set(AutoFillConstants.SearchFieldNames);

  constructor(
    private cipherService: CipherService,
    private autofillSettingsService: AutofillSettingsServiceAbstraction,
    private totpService: TotpService,
    private eventCollectionService: EventCollectionService,
    private logService: LogService,
    private domainSettingsService: DomainSettingsService,
    private userVerificationService: UserVerificationService,
    private billingAccountProfileStateService: BillingAccountProfileStateService,
    private scriptInjectorService: ScriptInjectorService,
    private accountService: AccountService,
    private authService: AuthService,
    private configService: ConfigService,
    private userNotificationSettingsService: UserNotificationSettingsServiceAbstraction,
    private messageListener: MessageListener,
  ) {}

  /**
   * Collects page details from the specific tab. This method returns an observable that can
   * be subscribed to in order to build the results from all collectPageDetailsResponse
   * messages from the given tab.
   *
   * @param tab The tab to collect page details from
   */
  collectPageDetailsFromTab$(tab: chrome.tabs.Tab): Observable<PageDetail[]> {
    /** Replay Subject that can be utilized when `messages$` may not emit the page details. */
    const pageDetailsFallback$ = new ReplaySubject<[]>(1);

    const pageDetailsFromTab$ = this.messageListener
      .messages$(COLLECT_PAGE_DETAILS_RESPONSE_COMMAND)
      .pipe(
        filter(
          (message) =>
            message.tab.id === tab.id &&
            message.sender === AutofillMessageSender.collectPageDetailsFromTabObservable,
        ),
        scan(
          (acc, message) => [
            ...acc,
            {
              frameId: message.webExtSender.frameId,
              tab: message.tab,
              details: message.details,
            },
          ],
          [] as PageDetail[],
        ),
      );

    void BrowserApi.tabSendMessage(
      tab,
      {
        tab: tab,
        command: AutofillMessageCommand.collectPageDetails,
        sender: AutofillMessageSender.collectPageDetailsFromTabObservable,
      },
      null,
      true,
    ).catch(() => {
      // When `tabSendMessage` throws an error the `pageDetailsFromTab$` will not emit,
      // fallback to an empty array
      pageDetailsFallback$.next([]);
    });

    // Fallback to empty array when:
    // - In Safari, `tabSendMessage` doesn't throw an error for this case.
    // - When opening the extension directly via the URL, `tabSendMessage` doesn't always respond nor throw an error in FireFox.
    //   Adding checks for the major 3 browsers here to be safe.
    const urlHasBrowserProtocol = [
      "moz-extension://",
      "chrome-extension://",
      "safari-web-extension://",
    ].some((protocol) => tab.url.startsWith(protocol));
    if (!tab.url || urlHasBrowserProtocol) {
      pageDetailsFallback$.next([]);
    }

    // Share the pageDetailsFromTab$ observable so that multiple subscribers don't trigger multiple executions.
    const sharedPageDetailsFromTab$ = pageDetailsFromTab$.pipe(share());

    // Create a timeout observable that emits an empty array if pageDetailsFromTab$ hasn't emitted within 1 second.
    const pageDetailsTimeout$ = timer(1000).pipe(
      map(() => [] as PageDetail[]),
      takeUntil(sharedPageDetailsFromTab$),
    );

    // Merge the responses so that if pageDetailsFromTab$ emits, that value is used.
    // Otherwise, if it doesn't emit in time, the timeout observable emits an empty array.
    // Also, pageDetailsFallback$ will emit in error cases.
    return merge(sharedPageDetailsFromTab$, pageDetailsFallback$, pageDetailsTimeout$);
  }

  /**
   * Triggers on installation of the extension Handles injecting
   * content scripts into all tabs that are currently open, and
   * sets up a listener to ensure content scripts can identify
   * if the extension context has been disconnected.
   */
  async loadAutofillScriptsOnInstall() {
    BrowserApi.addListener(chrome.runtime.onConnect, this.handleInjectedScriptPortConnection);
    void this.injectAutofillScriptsInAllTabs();

    this.autofillSettingsService.inlineMenuVisibility$
      .pipe(startWith(undefined), pairwise())
      .subscribe(([previousSetting, currentSetting]) =>
        this.handleInlineMenuVisibilitySettingsChange(previousSetting, currentSetting),
      );

    this.autofillSettingsService.showInlineMenuCards$
      .pipe(startWith(undefined), pairwise())
      .subscribe(([previousSetting, currentSetting]) =>
        this.handleInlineMenuVisibilitySettingsChange(previousSetting, currentSetting),
      );

    this.autofillSettingsService.showInlineMenuIdentities$
      .pipe(startWith(undefined), pairwise())
      .subscribe(([previousSetting, currentSetting]) =>
        this.handleInlineMenuVisibilitySettingsChange(previousSetting, currentSetting),
      );
  }

  /**
   * Triggers a complete reload of all autofill scripts on tabs open within
   * the user's browsing session. This is done by first disconnecting all
   * existing autofill content script ports, which cleans up existing object
   * instances, and then re-injecting the autofill scripts into all tabs.
   */
  async reloadAutofillScripts() {
    this.autofillScriptPortsSet.forEach((port) => {
      port.disconnect();
      this.autofillScriptPortsSet.delete(port);
    });

    void this.injectAutofillScriptsInAllTabs();
  }

  /**
   * Injects the autofill scripts into the current tab and all frames
   * found within the tab. Temporarily, will conditionally inject
   * the refactor of the core autofill script if the feature flag
   * is enabled.
   * @param {chrome.tabs.Tab} tab
   * @param {number} frameId
   * @param {boolean} triggeringOnPageLoad
   */
  async injectAutofillScripts(
    tab: chrome.tabs.Tab,
    frameId = 0,
    triggeringOnPageLoad = true,
  ): Promise<void> {
    // Autofill user settings loaded from state can await the active account state indefinitely
    // if not guarded by an active account check (e.g. the user is logged in)
    const activeAccount = await firstValueFrom(this.accountService.activeAccount$);
    const authStatus = await firstValueFrom(this.authService.activeAccountStatus$);
    const accountIsUnlocked = authStatus === AuthenticationStatus.Unlocked;
    let autoFillOnPageLoadIsEnabled = false;

    const injectedScripts = [await this.getBootstrapAutofillContentScript(activeAccount)];

    if (activeAccount && accountIsUnlocked) {
      autoFillOnPageLoadIsEnabled = await this.getAutofillOnPageLoad();
    }

    if (triggeringOnPageLoad && autoFillOnPageLoadIsEnabled) {
      injectedScripts.push("autofiller.js");
    }

    if (!triggeringOnPageLoad) {
      await this.scriptInjectorService.inject({
        tabId: tab.id,
        injectDetails: { file: "content/content-message-handler.js", runAt: "document_start" },
      });
    }

    injectedScripts.push("contextMenuHandler.js");

    for (const injectedScript of injectedScripts) {
      await this.scriptInjectorService.inject({
        tabId: tab.id,
        injectDetails: {
          file: `content/${injectedScript}`,
          runAt: "document_start",
          frame: frameId,
        },
      });
    }
  }

  /**
   * Identifies the correct autofill script to inject based on whether the
   * inline menu is enabled, and whether the user has the notification bar
   * enabled.
   *
   * @param activeAccount - The active account
   */
  private async getBootstrapAutofillContentScript(
    activeAccount: { id: UserId | undefined } & AccountInfo,
  ): Promise<string> {
    let inlineMenuVisibility: InlineMenuVisibilitySetting = AutofillOverlayVisibility.Off;

    if (activeAccount) {
      inlineMenuVisibility = await this.getInlineMenuVisibility();
    }

    const enableChangedPasswordPrompt = await firstValueFrom(
      this.userNotificationSettingsService.enableChangedPasswordPrompt$,
    );
    const enableAddedLoginPrompt = await firstValueFrom(
      this.userNotificationSettingsService.enableAddedLoginPrompt$,
    );
    const isNotificationBarEnabled = enableChangedPasswordPrompt || enableAddedLoginPrompt;

    if (!inlineMenuVisibility && !isNotificationBarEnabled) {
      return "bootstrap-autofill.js";
    }

    if (!inlineMenuVisibility && isNotificationBarEnabled) {
      return "bootstrap-autofill-overlay-notifications.js";
    }

    if (inlineMenuVisibility && !isNotificationBarEnabled) {
      return "bootstrap-autofill-overlay-menu.js";
    }

    return "bootstrap-autofill-overlay.js";
  }

  /**
   * Gets all forms with password fields and formats the data
   * for both forms and password input elements.
   * @param {AutofillPageDetails} pageDetails
   * @returns {FormData[]}
   */
  getFormsWithPasswordFields(pageDetails: AutofillPageDetails): FormData[] {
    const formData: FormData[] = [];

    const passwordFields = AutofillService.loadPasswordFields(pageDetails, true, true, false, true);

    // TODO: this logic prevents multi-step account creation forms (that just start with email)
    // from being passed on to the notification bar content script - even if autofill-init.js found the form and email field.
    // ex: https://signup.live.com/
    if (passwordFields.length === 0) {
      return formData;
    }

    // Back up check for cases where there are several password fields detected,
    // but they are not all part of the form b/c of bad HTML

    // gather password fields that don't have an enclosing form
    const passwordFieldsWithoutForm = passwordFields.filter((pf) => pf.form === undefined);
    const formKeys = Object.keys(pageDetails.forms);
    const formCount = formKeys.length;

    // if we have 3 password fields and only 1 form, and there are password fields that are not within a form
    // but there is at least one password field within the form, then most likely this is a poorly built password change form
    if (passwordFields.length === 3 && formCount == 1 && passwordFieldsWithoutForm.length > 0) {
      // Only one form so get the singular form key
      const soloFormKey = formKeys[0];

      const atLeastOnePasswordFieldWithinSoloForm =
        passwordFields.filter((pf) => pf.form !== null && pf.form === soloFormKey).length > 0;

      if (atLeastOnePasswordFieldWithinSoloForm) {
        // We have a form with at least one password field,
        // so let's make an assumption that the password fields without a form are actually part of this form
        passwordFieldsWithoutForm.forEach((pf) => {
          pf.form = soloFormKey;
        });
      }
    }

    for (const formKey in pageDetails.forms) {
      // eslint-disable-next-line
      if (!pageDetails.forms.hasOwnProperty(formKey)) {
        continue;
      }

      const formPasswordFields = passwordFields.filter((pf) => formKey === pf.form);
      if (formPasswordFields.length > 0) {
        let uf = this.findUsernameField(pageDetails, formPasswordFields[0], false, false, false);
        if (uf == null) {
          // not able to find any viewable username fields. maybe there are some "hidden" ones?
          uf = this.findUsernameField(pageDetails, formPasswordFields[0], true, true, false);
        }
        formData.push({
          form: pageDetails.forms[formKey],
          password: formPasswordFields[0],
          username: uf,
          passwords: formPasswordFields,
        });
      }
    }

    return formData;
  }

  /**
   * Gets the overlay's visibility setting from the autofill settings service.
   */
  async getInlineMenuVisibility(): Promise<InlineMenuVisibilitySetting> {
    return await firstValueFrom(this.autofillSettingsService.inlineMenuVisibility$);
  }

  /**
   * Gets the setting for automatically copying TOTP upon autofill from the autofill settings service.
   */
  async getShouldAutoCopyTotp(): Promise<boolean> {
    return await firstValueFrom(this.autofillSettingsService.autoCopyTotp$);
  }

  /**
   * Gets the autofill on page load setting from the autofill settings service.
   */
  async getAutofillOnPageLoad(): Promise<boolean> {
    return await firstValueFrom(this.autofillSettingsService.autofillOnPageLoad$);
  }

  /**
   * Gets the default URI match strategy setting from the domain settings service.
   */
  async getDefaultUriMatchStrategy(): Promise<UriMatchStrategySetting> {
    return await firstValueFrom(this.domainSettingsService.defaultUriMatchStrategy$);
  }

  /**
   * Autofill a given tab with a given login item
   * @param {AutoFillOptions} options Instructions about the autofill operation, including tab and login item
   * @returns {Promise<string | null>} The TOTP code of the successfully autofilled login, if any
   */
  async doAutoFill(options: AutoFillOptions): Promise<string | null> {
    const tab = options.tab;
    if (!tab || !options.cipher || !options.pageDetails || !options.pageDetails.length) {
      throw new Error("Nothing to autofill.");
    }

    let totp: string | null = null;

    const activeAccount = await firstValueFrom(this.accountService.activeAccount$);
    const canAccessPremium = await firstValueFrom(
      this.billingAccountProfileStateService.hasPremiumFromAnySource$(activeAccount.id),
    );
    const defaultUriMatch = await this.getDefaultUriMatchStrategy();

    if (!canAccessPremium) {
      options.cipher.login.totp = null;
    }

    let didAutofill = false;
    await Promise.all(
      options.pageDetails.map(async (pd) => {
        // make sure we're still on correct tab
        if (pd.tab.id !== tab.id || pd.tab.url !== tab.url) {
          return;
        }

        const fillScript = await this.generateFillScript(pd.details, {
          skipUsernameOnlyFill: options.skipUsernameOnlyFill || false,
          onlyEmptyFields: options.onlyEmptyFields || false,
          onlyVisibleFields: options.onlyVisibleFields || false,
          fillNewPassword: options.fillNewPassword || false,
          allowTotpAutofill: options.allowTotpAutofill || false,
          autoSubmitLogin: options.autoSubmitLogin || false,
          cipher: options.cipher,
          tabUrl: tab.url,
          defaultUriMatch: defaultUriMatch,
        });

        if (!fillScript || !fillScript.script || !fillScript.script.length) {
          return;
        }

        if (
          fillScript.untrustedIframe &&
          options.allowUntrustedIframe != undefined &&
          !options.allowUntrustedIframe
        ) {
          this.logService.info("Autofill on page load was blocked due to an untrusted iframe.");
          return;
        }

        // Add a small delay between operations
        fillScript.properties.delay_between_operations = 20;

        didAutofill = true;
        if (!options.skipLastUsed) {
          await this.cipherService.updateLastUsedDate(options.cipher.id, activeAccount.id);
        }

        void BrowserApi.tabSendMessage(
          tab,
          {
            command: options.autoSubmitLogin ? "triggerAutoSubmitLogin" : "fillForm",
            fillScript: fillScript,
            url: tab.url,
            pageDetailsUrl: pd.details.url,
          },
          { frameId: pd.frameId },
        );

        // Skip getting the TOTP code for clipboard in these cases
        if (
          options.cipher.type !== CipherType.Login ||
          totp !== null ||
          !options.cipher.login.totp ||
          (!canAccessPremium && !options.cipher.organizationUseTotp)
        ) {
          return;
        }

        const shouldAutoCopyTotp = await this.getShouldAutoCopyTotp();

        totp = shouldAutoCopyTotp
          ? (await firstValueFrom(this.totpService.getCode$(options.cipher.login.totp))).code
          : null;
      }),
    );

    if (didAutofill) {
      await this.eventCollectionService.collect(
        EventType.Cipher_ClientAutofilled,
        options.cipher.id,
      );
      if (totp !== null) {
        return totp;
      } else {
        return null;
      }
    } else {
      throw new Error("Did not autofill.");
    }
  }

  /**
   * Autofill the specified tab with the next login item from the cache
   * @param {PageDetail[]} pageDetails The data scraped from the page
   * @param {chrome.tabs.Tab} tab The tab to be autofilled
   * @param {boolean} fromCommand Whether the autofill is triggered by a keyboard shortcut (`true`) or autofill on page load (`false`)
   * @param {boolean} autoSubmitLogin Whether the autofill is for an auto-submit login
   * @returns {Promise<string | null>} The TOTP code of the successfully autofilled login, if any
   */
  async doAutoFillOnTab(
    pageDetails: PageDetail[],
    tab: chrome.tabs.Tab,
    fromCommand: boolean,
    autoSubmitLogin = false,
  ): Promise<string | null> {
    let cipher: CipherView;

    const activeUserId = await firstValueFrom(
      this.accountService.activeAccount$.pipe(getOptionalUserId),
    );
    if (activeUserId == null) {
      return null;
    }

    if (fromCommand) {
      cipher = await this.cipherService.getNextCipherForUrl(tab.url, activeUserId);
    } else {
      const lastLaunchedCipher = await this.cipherService.getLastLaunchedForUrl(
        tab.url,
        activeUserId,
        true,
      );
      if (
        lastLaunchedCipher &&
        Date.now().valueOf() - lastLaunchedCipher.localData?.lastLaunched?.valueOf() < 30000
      ) {
        cipher = lastLaunchedCipher;
      } else {
        cipher = await this.cipherService.getLastUsedForUrl(tab.url, activeUserId, true);
      }
    }

    if (cipher == null || (cipher.reprompt === CipherRepromptType.Password && !fromCommand)) {
      return null;
    }

    if (await this.isPasswordRepromptRequired(cipher, tab)) {
      if (fromCommand) {
        this.cipherService.updateLastUsedIndexForUrl(tab.url);
      }

      return null;
    }

    const totpCode = await this.doAutoFill({
      tab: tab,
      cipher: cipher,
      pageDetails: pageDetails,
      skipLastUsed: !fromCommand,
      skipUsernameOnlyFill: !fromCommand,
      onlyEmptyFields: !fromCommand,
      onlyVisibleFields: !fromCommand,
      fillNewPassword: fromCommand,
      allowUntrustedIframe: fromCommand,
      allowTotpAutofill: fromCommand,
      autoSubmitLogin,
    });

    // Update last used index as autofill has succeeded
    if (fromCommand) {
      this.cipherService.updateLastUsedIndexForUrl(tab.url);
    }

    return totpCode;
  }

  /**
   * Checks if the cipher requires password reprompt and opens the password reprompt popout if necessary.
   *
   * @param cipher - The cipher to autofill
   * @param tab - The tab to autofill
   * @param action - override for default action once reprompt is completed successfully
   */
  async isPasswordRepromptRequired(
    cipher: CipherView,
    tab: chrome.tabs.Tab,
    action?: string,
  ): Promise<boolean> {
    const userHasMasterPasswordAndKeyHash =
      await this.userVerificationService.hasMasterPasswordAndMasterKeyHash();
    if (cipher.reprompt === CipherRepromptType.Password && userHasMasterPasswordAndKeyHash) {
      if (!this.isDebouncingPasswordRepromptPopout()) {
        await this.openVaultItemPasswordRepromptPopout(tab, {
          cipherId: cipher.id,
          action: action ?? "autofill",
        });
      }

      return true;
    }

    return false;
  }

  /**
   * Autofill the active tab with the next cipher from the cache
   * @param {PageDetail[]} pageDetails The data scraped from the page
   * @param {boolean} fromCommand Whether the autofill is triggered by a keyboard shortcut (`true`) or autofill on page load (`false`)
   * @returns {Promise<string | null>} The TOTP code of the successfully autofilled login, if any
   */
  async doAutoFillActiveTab(
    pageDetails: PageDetail[],
    fromCommand: boolean,
    cipherType?: CipherType,
  ): Promise<string | null> {
    if (!pageDetails[0]?.details?.fields?.length) {
      return null;
    }

    const tab = await this.getActiveTab();

    if (!tab || !tab.url) {
      return null;
    }

    if (!cipherType || cipherType === CipherType.Login) {
      return await this.doAutoFillOnTab(pageDetails, tab, fromCommand);
    }

    let cipher: CipherView;
    let cacheKey = "";

    const activeUserId = await firstValueFrom(
      this.accountService.activeAccount$.pipe(getOptionalUserId),
    );
    if (activeUserId == null) {
      return null;
    }

    if (cipherType === CipherType.Card) {
      cacheKey = "cardCiphers";
      cipher = await this.cipherService.getNextCardCipher(activeUserId);
    } else {
      cacheKey = "identityCiphers";
      cipher = await this.cipherService.getNextIdentityCipher(activeUserId);
    }

    if (!cipher || !cacheKey || (cipher.reprompt === CipherRepromptType.Password && !fromCommand)) {
      return null;
    }

    if (await this.isPasswordRepromptRequired(cipher, tab)) {
      if (fromCommand) {
        this.cipherService.updateLastUsedIndexForUrl(cacheKey);
      }

      return null;
    }

    const totpCode = await this.doAutoFill({
      tab: tab,
      cipher: cipher,
      pageDetails: pageDetails,
      skipLastUsed: !fromCommand,
      skipUsernameOnlyFill: !fromCommand,
      onlyEmptyFields: !fromCommand,
      onlyVisibleFields: !fromCommand,
      fillNewPassword: false,
      allowUntrustedIframe: fromCommand,
      allowTotpAutofill: false,
    });

    if (fromCommand) {
      this.cipherService.updateLastUsedIndexForUrl(cacheKey);
    }

    return totpCode;
  }

  /**
   * Activates the autofill on page load org policy.
   */
  async setAutoFillOnPageLoadOrgPolicy(): Promise<void> {
    const autofillOnPageLoadOrgPolicy = await firstValueFrom(
      this.autofillSettingsService.activateAutofillOnPageLoadFromPolicy$,
    );

    if (autofillOnPageLoadOrgPolicy) {
      await this.autofillSettingsService.setAutofillOnPageLoad(true);
    }
  }

  /**
   * Gets the active tab from the current window.
   * Throws an error if no tab is found.
   * @returns {Promise<chrome.tabs.Tab>}
   * @private
   */
  private async getActiveTab(): Promise<chrome.tabs.Tab> {
    const tab = await BrowserApi.getTabFromCurrentWindow();
    if (!tab) {
      throw new Error("No tab found.");
    }

    return tab;
  }

  /**
   * 生成用于页面自动填充的脚本（fillScript）。
   *
   * 该方法会根据当前页面解析结果（`pageDetails`）以及待填充的密文项（`options.cipher`）
   * 计算出一组可在内容脚本中执行的动作（click/focus/fill），并以 `AutofillScript` 形式返回。
   *
   * 核心流程：
   * 1) 兜底校验：无页面数据或无密文则直接返回 null。
   * 2) 处理“自定义字段”：若密文包含自定义字段（`cipher.fields`），按字段名模糊匹配页面可见字段并先行填充。
   *    - 使用 `findMatchingFieldIndex` 在字段各属性（id/name/label/placeholder）上做前缀/模糊匹配。
   *    - 若为 `FieldType.Linked` 则取关联字段值；若为 `Boolean` 但值为空，则使用字符串 "false"。
   *    - 使用 `filledFields` 去重，避免对同一 `opid` 重复下发动作。
   * 3) 分类型分发：根据 `cipher.type`
   *    - Login：调用 `generateLoginFillScript`，处理用户名/密码/TOTP 等逻辑与可见性/只读/是否仅填空字段等开关。
   *    - Card：调用 `generateCardFillScript`，处理持卡人/卡号/有效期/安全码/品牌等，并支持单字段“合并有效期”。
   *    - Identity：调用 `generateIdentityFillScript`，基于关键字匹配映射姓名/地址/邮箱/电话/公司等字段。
   * 4) 返回构造完成的 `fillScript`；若类型不支持返回 null。
   *
   * 参数说明（部分来自 `GenerateFillScriptOptions`）：
   * - `skipUsernameOnlyFill`：当页面无密码字段时，是否跳过仅填用户名/邮箱。
   * - `onlyEmptyFields`：仅填充空字段，避免覆盖用户已有输入。
   * - `onlyVisibleFields`：仅填充当前可见字段。
   * - `fillNewPassword`：是否允许填充 `autocomplete="new-password"` 的新密码字段。
   * - `allowTotpAutofill`：是否尝试在登录流程中填充 TOTP。
   * - `autoSubmitLogin`：是否在登录表单填充完毕后自动提交。
   * - `cipher`：待填充的密文视图（Login/Card/Identity）。
   * - `tabUrl`：当前标签页 URL，用于 iframe 安全校验（与 `pageUrl` 比对）。
   * - `defaultUriMatch`：默认 URI 匹配策略，参与 iframe 信任判断。
   *
   * 返回值：
   * - `AutofillScript`：包含脚本动作数组 `script`、其他辅助属性（如 `untrustedIframe`、`autosubmit`）。
   * - `null`：输入不完整或不支持的密文类型。
   *
   * 注意：
   * - `filledFields` 用于记录已加入脚本的页面字段，防止重复生成动作。
   * - 仅添加注释，不改变原有逻辑与行为。
   *
   * @param {AutofillPageDetails} pageDetails 页面解析得到的字段/表单/URL 等信息
   * @param {GenerateFillScriptOptions} options 生成脚本的控制开关与密文数据
   * @returns {Promise<AutofillScript | null>}
   * @private
   */
  private async generateFillScript(
    pageDetails: AutofillPageDetails,
    options: GenerateFillScriptOptions,
  ): Promise<AutofillScript | null> {
    // ===== 兜底校验：确保必要数据存在 =====
    // pageDetails: 包含页面所有可填充字段的详细信息（由内容脚本收集）
    // options.cipher: 用户选择的密码库项目（包含要填充的数据）
    if (!pageDetails || !options.cipher) {
      return null;
    }

    // ===== 初始化核心数据结构 =====
    // fillScript: 最终生成的自动填充脚本，包含一系列要执行的动作
    let fillScript = new AutofillScript();

    // filledFields: 记录已处理的字段，防止重复填充
    // key: opid（页面字段的唯一标识符，由内容脚本生成）
    // value: AutofillField对象（包含字段的所有属性）
    const filledFields: { [id: string]: AutofillField } = {};

    // fields: 密文的自定义字段列表
    // 用户可以为特定网站添加额外的填充字段（如安全问题、员工ID等）
    const fields = options.cipher.fields;

    // ===== 第一步：处理自定义字段 =====
    // 自定义字段允许用户为特定网站添加非标准的填充字段
    // 例如：安全问题答案、PIN码、员工ID、会员号等
    if (fields && fields.length) {
      // 收集所有自定义字段的名称，转换为小写以便不区分大小写匹配
      const fieldNames: string[] = [];

      fields.forEach((f) => {
        if (AutofillService.hasValue(f.name)) {
          fieldNames.push(f.name.toLowerCase());
        }
      });

      // 遍历页面上的所有字段，寻找与自定义字段匹配的目标
      pageDetails.fields.forEach((field) => {
        // 跳过已填充的字段，避免重复处理
        // eslint-disable-next-line
        if (filledFields.hasOwnProperty(field.opid)) {
          return;
        }

        // 可见性检查：不填充不可见的普通字段
        // 特殊例外：span元素用于显示只读的自定义字段值，即使不可见也要处理
        if (!field.viewable && field.tagName !== "span") {
          return;
        }

        // 搜索框过滤：排除搜索类输入框，避免误填
        // 搜索框通常包含"search"、"query"等关键词
        // 填充搜索框会影响用户体验，可能导致意外的搜索操作
        if (AutofillService.isSearchField(field)) {
          return;
        }

        // 字段匹配：使用模糊匹配算法寻找对应的自定义字段
        // findMatchingFieldIndex会检查字段的多个属性：
        // - htmlID: 元素的id属性
        // - htmlName: 元素的name属性
        // - label相关: label-left、label-right、label-tag、label-aria
        // - placeholder: 占位符文本
        const matchingIndex = this.findMatchingFieldIndex(field, fieldNames);
        if (matchingIndex > -1) {
          const matchingField: FieldView = fields[matchingIndex];
          let val: string;

          // 处理链接字段类型
          // 链接字段不存储值，而是引用其他字段的值
          if (matchingField.type === FieldType.Linked) {
            // 注意：假设链接字段不会链接到布尔类型的字段
            val = options.cipher.linkedFieldValue(matchingField.linkedId) as string;
          } else {
            // 普通字段：直接使用存储的值
            val = matchingField.value;
            // 布尔字段特殊处理：null值转换为"false"字符串
            if (val == null && matchingField.type === FieldType.Boolean) {
              val = "false";
            }
          }

          // 记录字段已被处理并生成填充动作
          // filledFields用于防止同一字段被多次填充
          filledFields[field.opid] = field;
          // fillByOpid生成三个动作：click（激活）、focus（聚焦）、fill（填充）
          AutofillService.fillByOpid(fillScript, field, val);
        }
      });
    }

    // ===== 第二步：根据密文类型生成特定的填充脚本 =====
    // Bitwarden支持三种主要的密文类型，每种都有专门的填充逻辑
    switch (options.cipher.type) {
      case CipherType.Login:
        // 登录类型密文处理
        // 主要功能：
        // - 查找并填充用户名字段（通常在密码字段之前）
        // - 处理密码字段（支持多密码场景，如修改密码页面）
        // - 可选的TOTP（双因素认证码）自动填充
        // - iframe安全检查，防止钓鱼攻击
        // - 支持自动提交登录表单（如果启用）
        fillScript = await this.generateLoginFillScript(
          fillScript,
          pageDetails,
          filledFields,
          options,
        );
        break;

      case CipherType.Card:
        // 信用卡类型密文处理
        // 主要功能：
        // - 持卡人姓名填充
        // - 卡号填充（支持格式化）
        // - 有效期处理：
        //   * 分离的月/年字段
        //   * 合并的有效期字段（MM/YY、MM/YYYY、MMYY等格式）
        //   * 智能格式转换
        // - CVV/安全码填充
        // - 卡片品牌选择（如果页面有相应字段）
        fillScript = await this.generateCardFillScript(
          fillScript,
          pageDetails,
          filledFields,
          options,
        );
        break;

      case CipherType.Identity:
        // 身份信息类型密文处理
        // 主要功能：
        // - 姓名处理：
        //   * 分离的名/中间名/姓字段
        //   * 合并的全名字段（自动拼接）
        // - 地址处理：
        //   * 分离的地址行（address1、address2、address3）
        //   * 合并的完整地址字段
        // - 地区信息：
        //   * 城市、州/省、邮编
        //   * 国家（支持全名到ISO代码转换）
        // - 联系信息：电话、邮箱
        // - 其他：用户名、公司等
        fillScript = await this.generateIdentityFillScript(
          fillScript,
          pageDetails,
          filledFields,
          options,
        );
        break;

      default:
        // 不支持的密文类型，返回null
        // 未来可能支持的类型：SecureNote等
        return null;
    }

    // ===== 返回构建完成的填充脚本 =====
    // fillScript包含以下关键信息：
    // - script: 动作数组，每个动作格式为[command, ...args]
    //   * "click_on_opid": 点击指定字段
    //   * "focus_by_opid": 聚焦指定字段
    //   * "fill_by_opid": 填充指定字段的值
    // - properties: 脚本属性
    //   * delay_between_operations: 操作间延迟（毫秒）
    // - savedUrls: 保存的URL列表（用于验证当前页面）
    // - untrustedIframe: 布尔值，标识是否在不受信任的iframe中
    // - autosubmit: 自动提交的表单ID列表
    return fillScript;
  }

  /**
   * 生成登录类型密文的自动填充脚本
   *
   * 该方法负责处理用户名、密码和TOTP（双因素认证）字段的填充逻辑。
   * 会智能识别页面上的登录表单，并根据不同的页面结构采用不同的填充策略。
   *
   * @param {AutofillScript} fillScript - 正在构建的填充脚本对象
   * @param {AutofillPageDetails} pageDetails - 页面详情，包含所有可填充字段
   * @param {{[p: string]: AutofillField}} filledFields - 已填充字段的记录
   * @param {GenerateFillScriptOptions} options - 填充选项和配置
   * @returns {Promise<AutofillScript | null>}
   * @private
   */
  private async generateLoginFillScript(
    fillScript: AutofillScript,
    pageDetails: AutofillPageDetails,
    filledFields: { [id: string]: AutofillField },
    options: GenerateFillScriptOptions,
  ): Promise<AutofillScript | null> {
    // 验证密文是否包含登录信息
    if (!options.cipher.login) {
      return null;
    }

    // ===== 初始化字段收集容器 =====
    // passwords: 页面上找到的所有密码字段
    // usernames: 页面上找到的所有用户名字段
    // totps: 页面上找到的所有TOTP/验证码字段
    const passwords: AutofillField[] = [];
    const usernames: AutofillField[] = [];
    const totps: AutofillField[] = [];

    // 临时变量：用于处理过程中的字段引用
    let pf: AutofillField = null; // 当前处理的密码字段
    let username: AutofillField = null; // 当前找到的用户名字段
    let totp: AutofillField = null; // 当前找到的TOTP字段

    const login = options.cipher.login;

    // 设置保存的URL列表（排除"从不匹配"的URL）
    // 这些URL用于验证当前页面是否匹配保存的登录项
    fillScript.savedUrls =
      login?.uris?.filter((u) => u.match != UriMatchStrategy.Never).map((u) => u.uri) ?? [];

    // 检查是否在不受信任的iframe中
    // 如果页面URL与标签页URL不匹配，可能是钓鱼攻击
    fillScript.untrustedIframe = await this.inUntrustedIframe(pageDetails.url, options);

    // ===== 第一步：查找页面上的密码字段 =====
    // 首先尝试查找可见的、非只读的密码字段
    // loadPasswordFields参数说明：
    // - canBeHidden: false - 只查找可见字段
    // - canBeReadOnly: false - 排除只读字段
    // - onlyEmptyFields: 根据选项决定是否只填充空字段
    // - fillNewPassword: 是否填充new-password类型字段（用于注册/修改密码）
    let passwordFields = AutofillService.loadPasswordFields(
      pageDetails,
      false, // canBeHidden
      false, // canBeReadOnly
      options.onlyEmptyFields,
      options.fillNewPassword,
    );

    // 如果没找到可见的密码字段，且不限制只填充可见字段
    // 则尝试查找隐藏的密码字段（某些网站使用CSS隐藏密码字段）
    if (!passwordFields.length && !options.onlyVisibleFields) {
      passwordFields = AutofillService.loadPasswordFields(
        pageDetails,
        true, // canBeHidden - 包括隐藏字段
        true, // canBeReadOnly - 包括只读字段
        options.onlyEmptyFields,
        options.fillNewPassword,
      );
    }

    // ===== 第二步：在表单中查找相关字段 =====
    // 遍历页面上的所有表单，为每个密码字段查找对应的用户名和TOTP字段
    for (const formKey in pageDetails.forms) {
      // eslint-disable-next-line
      if (!pageDetails.forms.hasOwnProperty(formKey)) {
        continue;
      }

      // 处理每个密码字段
      passwordFields.forEach((passField) => {
        pf = passField;
        passwords.push(pf);

        // 查找用户名字段（如果密文包含用户名）
        if (login.username) {
          // 首先在同一表单中查找可见的用户名字段
          // findUsernameField会查找密码字段之前的输入字段
          username = this.findUsernameField(pageDetails, pf, false, false, false);

          // 如果没找到可见的用户名字段，尝试查找隐藏的
          if (!username && !options.onlyVisibleFields) {
            username = this.findUsernameField(pageDetails, pf, true, true, false);
          }

          if (username) {
            usernames.push(username);
          }
        }

        // 查找TOTP字段（如果允许自动填充TOTP且密文包含TOTP）
        if (options.allowTotpAutofill && login.totp) {
          // 首先查找可见的TOTP字段
          totp = this.findTotpField(pageDetails, pf, false, false, false);

          // 如果没找到可见的TOTP字段，尝试查找隐藏的
          if (!totp && !options.onlyVisibleFields) {
            totp = this.findTotpField(pageDetails, pf, true, true, false);
          }

          if (totp) {
            totps.push(totp);
          }
        }
      });
    }

    // ===== 第三步：处理无表单的密码字段 =====
    // 某些页面的密码字段不在表单中（如动态生成的登录框）
    // 这种情况下，使用第一个密码字段，并查找它之前的输入字段作为用户名
    if (passwordFields.length && !passwords.length) {
      // 使用页面上第一个密码字段
      pf = passwordFields[0];
      passwords.push(pf);

      // 查找用户名字段：在密码字段之前的输入字段
      // elementNumber > 0 确保密码字段不是页面上第一个字段
      if (login.username && pf.elementNumber > 0) {
        // withoutForm: true - 不限制在同一表单中查找
        username = this.findUsernameField(pageDetails, pf, false, false, true);

        if (!username && !options.onlyVisibleFields) {
          username = this.findUsernameField(pageDetails, pf, true, true, true);
        }

        if (username) {
          usernames.push(username);
        }
      }

      // 查找TOTP字段（同样不限制在表单中）
      if (options.allowTotpAutofill && login.totp && pf.elementNumber > 0) {
        totp = this.findTotpField(pageDetails, pf, false, false, true);

        if (!totp && !options.onlyVisibleFields) {
          totp = this.findTotpField(pageDetails, pf, true, true, true);
        }

        if (totp) {
          totps.push(totp);
        }
      }
    }

    // ===== 第四步：处理没有密码字段的页面 =====
    // 某些页面可能只有用户名或TOTP字段（如多步骤登录）
    // 注意：用户名和TOTP字段是互斥的，不会同时填充
    if (!passwordFields.length) {
      pageDetails.fields.forEach((field) => {
        // 只处理可见字段
        if (!field.viewable) {
          return;
        }

        // 判断是否为TOTP字段
        // TOTP字段特征：
        // - 类型为number、tel或text
        // - 字段名包含TOTP相关关键词
        // - 或者autocomplete属性为"one-time-code"
        const isFillableTotpField =
          options.allowTotpAutofill &&
          ["number", "tel", "text"].some((t) => t === field.type) &&
          (AutofillService.fieldIsFuzzyMatch(field, [
            ...AutoFillConstants.TotpFieldNames, // 明确的TOTP字段名
            ...AutoFillConstants.AmbiguousTotpFieldNames, // 模糊的TOTP字段名
          ]) ||
            field.autoCompleteType === "one-time-code");

        // 判断是否为用户名字段
        // 用户名字段特征：
        // - 类型为email、tel或text
        // - 字段名包含用户名相关关键词
        const isFillableUsernameField =
          !options.skipUsernameOnlyFill &&
          ["email", "tel", "text"].some((t) => t === field.type) &&
          AutofillService.fieldIsFuzzyMatch(field, AutoFillConstants.UsernameFieldNames);

        // 优先填充更明确的字段类型
        switch (true) {
          case isFillableTotpField:
            totps.push(field);
            return;
          case isFillableUsernameField:
            usernames.push(field);
            return;
          default:
            return;
        }
      });
    }

    // ===== 第五步：生成填充动作 =====
    // 记录所有需要填充的表单ID（用于自动提交）
    const formElementsSet = new Set<string>();

    // 填充用户名字段
    usernames.forEach((u) => {
      // 跳过已填充的字段
      // eslint-disable-next-line
      if (filledFields.hasOwnProperty(u.opid)) {
        return;
      }

      // 记录字段已填充，生成填充动作
      filledFields[u.opid] = u;
      AutofillService.fillByOpid(fillScript, u, login.username);
      // 记录该字段所属的表单ID
      formElementsSet.add(u.form);
    });

    // 填充密码字段
    passwords.forEach((p) => {
      // 跳过已填充的字段
      // eslint-disable-next-line
      if (filledFields.hasOwnProperty(p.opid)) {
        return;
      }

      // 记录字段已填充，生成填充动作
      filledFields[p.opid] = p;
      AutofillService.fillByOpid(fillScript, p, login.password);
      // 记录该字段所属的表单ID
      formElementsSet.add(p.form);
    });

    // 如果启用了自动提交，记录需要提交的表单
    // autoSubmitLogin: 填充完成后自动提交登录表单
    if (options.autoSubmitLogin && formElementsSet.size) {
      fillScript.autosubmit = Array.from(formElementsSet);
    }

    // ===== 第六步：处理TOTP字段（双因素认证） =====
    if (options.allowTotpAutofill) {
      // 并行处理所有TOTP字段
      await Promise.all(
        totps.map(async (t, i) => {
          // 跳过已填充的字段
          if (Object.prototype.hasOwnProperty.call(filledFields, t.opid)) {
            return;
          }

          filledFields[t.opid] = t;

          // 生成TOTP验证码
          // totpService.getCode$会根据密钥实时生成6位验证码
          const totpResponse = await firstValueFrom(
            this.totpService.getCode$(options.cipher.login.totp),
          );

          let totpValue = totpResponse.code;

          // 特殊处理：如果TOTP码长度等于TOTP字段数量
          // 则每个字段填充一个数字（用于分离的验证码输入框）
          // 例如：6位验证码"123456"，6个输入框，每个填充一位
          if (totpValue.length == totps.length) {
            totpValue = totpValue.charAt(i);
          }

          AutofillService.fillByOpid(fillScript, t, totpValue);
        }),
      );
    }

    // ===== 第七步：设置焦点 =====
    // 将焦点设置到最后一个填充的字段（优先密码字段）
    // 这样用户可以直接按回车提交表单
    fillScript = AutofillService.setFillScriptForFocus(filledFields, fillScript);

    return fillScript;
  }

  /**
   * Generates the autofill script for the specified page details and credit card cipher item.
   * @param {AutofillScript} fillScript
   * @param {AutofillPageDetails} pageDetails
   * @param {{[p: string]: AutofillField}} filledFields
   * @param {GenerateFillScriptOptions} options
   * @returns {AutofillScript|null}
   * @private
   */
  private async generateCardFillScript(
    fillScript: AutofillScript,
    pageDetails: AutofillPageDetails,
    filledFields: { [id: string]: AutofillField },
    options: GenerateFillScriptOptions,
  ): Promise<AutofillScript | null> {
    if (!options.cipher.card) {
      return null;
    }

    const fillFields: { [id: string]: AutofillField } = {};

    pageDetails.fields.forEach((f) => {
      if (AutofillService.isExcludedFieldType(f, AutoFillConstants.ExcludedAutofillTypes)) {
        return;
      }

      for (let i = 0; i < CreditCardAutoFillConstants.CardAttributes.length; i++) {
        const attr = CreditCardAutoFillConstants.CardAttributes[i];
        // eslint-disable-next-line
        if (!f.hasOwnProperty(attr) || !f[attr] || !f.viewable) {
          continue;
        }

        // ref https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
        // ref https://developers.google.com/web/fundamentals/design-and-ux/input/forms/
        if (
          !fillFields.cardholderName &&
          AutofillService.isFieldMatch(
            f[attr],
            CreditCardAutoFillConstants.CardHolderFieldNames,
            CreditCardAutoFillConstants.CardHolderFieldNameValues,
          )
        ) {
          fillFields.cardholderName = f;
          break;
        } else if (
          !fillFields.number &&
          AutofillService.isFieldMatch(
            f[attr],
            CreditCardAutoFillConstants.CardNumberFieldNames,
            CreditCardAutoFillConstants.CardNumberFieldNameValues,
          )
        ) {
          fillFields.number = f;
          break;
        } else if (
          !fillFields.exp &&
          AutofillService.isFieldMatch(
            f[attr],
            CreditCardAutoFillConstants.CardExpiryFieldNames,
            CreditCardAutoFillConstants.CardExpiryFieldNameValues,
          )
        ) {
          fillFields.exp = f;
          break;
        } else if (
          !fillFields.expMonth &&
          AutofillService.isFieldMatch(f[attr], CreditCardAutoFillConstants.ExpiryMonthFieldNames)
        ) {
          fillFields.expMonth = f;
          break;
        } else if (
          !fillFields.expYear &&
          AutofillService.isFieldMatch(f[attr], CreditCardAutoFillConstants.ExpiryYearFieldNames)
        ) {
          fillFields.expYear = f;
          break;
        } else if (
          !fillFields.code &&
          AutofillService.isFieldMatch(f[attr], CreditCardAutoFillConstants.CVVFieldNames)
        ) {
          fillFields.code = f;
          break;
        } else if (
          !fillFields.brand &&
          AutofillService.isFieldMatch(f[attr], CreditCardAutoFillConstants.CardBrandFieldNames)
        ) {
          fillFields.brand = f;
          break;
        }
      }
    });

    const card = options.cipher.card;
    this.makeScriptAction(fillScript, card, fillFields, filledFields, "cardholderName");
    this.makeScriptAction(fillScript, card, fillFields, filledFields, "number");
    this.makeScriptAction(fillScript, card, fillFields, filledFields, "code");
    this.makeScriptAction(fillScript, card, fillFields, filledFields, "brand");

    // There is an expiration month field and the cipher has an expiration month value
    if (fillFields.expMonth && AutofillService.hasValue(card.expMonth)) {
      let expMonth: string = card.expMonth;

      if (fillFields.expMonth.selectInfo && fillFields.expMonth.selectInfo.options) {
        let index: number = null;
        const siOptions = fillFields.expMonth.selectInfo.options;
        if (siOptions.length === 12) {
          index = parseInt(card.expMonth, null) - 1;
        } else if (siOptions.length === 13) {
          if (
            siOptions[0][0] != null &&
            siOptions[0][0] !== "" &&
            (siOptions[12][0] == null || siOptions[12][0] === "")
          ) {
            index = parseInt(card.expMonth, null) - 1;
          } else {
            index = parseInt(card.expMonth, null);
          }
        }

        if (index != null) {
          const option = siOptions[index];
          if (option.length > 1) {
            expMonth = option[1];
          }
        }
      } else if (
        (this.fieldAttrsContain(fillFields.expMonth, "mm") ||
          fillFields.expMonth.maxLength === 2) &&
        expMonth.length === 1
      ) {
        expMonth = "0" + expMonth;
      }

      filledFields[fillFields.expMonth.opid] = fillFields.expMonth;
      AutofillService.fillByOpid(fillScript, fillFields.expMonth, expMonth);
    }

    // There is an expiration year field and the cipher has an expiration year value
    if (fillFields.expYear && AutofillService.hasValue(card.expYear)) {
      let expYear: string = card.expYear;
      if (fillFields.expYear.selectInfo && fillFields.expYear.selectInfo.options) {
        for (let i = 0; i < fillFields.expYear.selectInfo.options.length; i++) {
          const o: [string, string] = fillFields.expYear.selectInfo.options[i];
          if (o[0] === card.expYear || o[1] === card.expYear) {
            expYear = o[1];
            break;
          }
          if (
            o[1].length === 2 &&
            card.expYear.length === 4 &&
            o[1] === card.expYear.substring(2)
          ) {
            expYear = o[1];
            break;
          }
          const colonIndex = o[1].indexOf(":");
          if (colonIndex > -1 && o[1].length > colonIndex + 1) {
            const val = o[1].substring(colonIndex + 2);
            if (val != null && val.trim() !== "" && val === card.expYear) {
              expYear = o[1];
              break;
            }
          }
        }
      } else if (
        this.fieldAttrsContain(fillFields.expYear, "yyyy") ||
        fillFields.expYear.maxLength === 4
      ) {
        if (expYear.length === 2) {
          expYear = normalizeExpiryYearFormat(expYear);
        }
      } else if (
        this.fieldAttrsContain(fillFields.expYear, "yy") ||
        fillFields.expYear.maxLength === 2
      ) {
        if (expYear.length === 4) {
          expYear = expYear.substr(2);
        }
      }

      filledFields[fillFields.expYear.opid] = fillFields.expYear;
      AutofillService.fillByOpid(fillScript, fillFields.expYear, expYear);
    }

    // There is a single expiry date field (combined values) and the cipher has both expiration month and year
    if (
      fillFields.exp &&
      AutofillService.hasValue(card.expMonth) &&
      AutofillService.hasValue(card.expYear)
    ) {
      let combinedExpiryFillValue = null;

      const enableNewCardCombinedExpiryAutofill = await this.configService.getFeatureFlag(
        FeatureFlag.EnableNewCardCombinedExpiryAutofill,
      );

      if (enableNewCardCombinedExpiryAutofill) {
        combinedExpiryFillValue = this.generateCombinedExpiryValue(card, fillFields.exp);
      } else {
        const fullMonth = ("0" + card.expMonth).slice(-2);

        let fullYear: string = card.expYear;
        let partYear: string = null;
        if (fullYear.length === 2) {
          partYear = fullYear;
          fullYear = normalizeExpiryYearFormat(fullYear);
        } else if (fullYear.length === 4) {
          partYear = fullYear.substr(2, 2);
        }

        for (let i = 0; i < CreditCardAutoFillConstants.MonthAbbr.length; i++) {
          if (
            // mm/yyyy
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.MonthAbbr[i] +
                "/" +
                CreditCardAutoFillConstants.YearAbbrLong[i],
            )
          ) {
            combinedExpiryFillValue = fullMonth + "/" + fullYear;
          } else if (
            // mm/yy
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.MonthAbbr[i] +
                "/" +
                CreditCardAutoFillConstants.YearAbbrShort[i],
            ) &&
            partYear != null
          ) {
            combinedExpiryFillValue = fullMonth + "/" + partYear;
          } else if (
            // yyyy/mm
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.YearAbbrLong[i] +
                "/" +
                CreditCardAutoFillConstants.MonthAbbr[i],
            )
          ) {
            combinedExpiryFillValue = fullYear + "/" + fullMonth;
          } else if (
            // yy/mm
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.YearAbbrShort[i] +
                "/" +
                CreditCardAutoFillConstants.MonthAbbr[i],
            ) &&
            partYear != null
          ) {
            combinedExpiryFillValue = partYear + "/" + fullMonth;
          } else if (
            // mm-yyyy
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.MonthAbbr[i] +
                "-" +
                CreditCardAutoFillConstants.YearAbbrLong[i],
            )
          ) {
            combinedExpiryFillValue = fullMonth + "-" + fullYear;
          } else if (
            // mm-yy
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.MonthAbbr[i] +
                "-" +
                CreditCardAutoFillConstants.YearAbbrShort[i],
            ) &&
            partYear != null
          ) {
            combinedExpiryFillValue = fullMonth + "-" + partYear;
          } else if (
            // yyyy-mm
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.YearAbbrLong[i] +
                "-" +
                CreditCardAutoFillConstants.MonthAbbr[i],
            )
          ) {
            combinedExpiryFillValue = fullYear + "-" + fullMonth;
          } else if (
            // yy-mm
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.YearAbbrShort[i] +
                "-" +
                CreditCardAutoFillConstants.MonthAbbr[i],
            ) &&
            partYear != null
          ) {
            combinedExpiryFillValue = partYear + "-" + fullMonth;
          } else if (
            // yyyymm
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.YearAbbrLong[i] +
                CreditCardAutoFillConstants.MonthAbbr[i],
            )
          ) {
            combinedExpiryFillValue = fullYear + fullMonth;
          } else if (
            // yymm
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.YearAbbrShort[i] +
                CreditCardAutoFillConstants.MonthAbbr[i],
            ) &&
            partYear != null
          ) {
            combinedExpiryFillValue = partYear + fullMonth;
          } else if (
            // mmyyyy
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.MonthAbbr[i] +
                CreditCardAutoFillConstants.YearAbbrLong[i],
            )
          ) {
            combinedExpiryFillValue = fullMonth + fullYear;
          } else if (
            // mmyy
            this.fieldAttrsContain(
              fillFields.exp,
              CreditCardAutoFillConstants.MonthAbbr[i] +
                CreditCardAutoFillConstants.YearAbbrShort[i],
            ) &&
            partYear != null
          ) {
            combinedExpiryFillValue = fullMonth + partYear;
          }

          if (combinedExpiryFillValue != null) {
            break;
          }
        }

        // If none of the previous cases applied, set as default
        if (combinedExpiryFillValue == null) {
          combinedExpiryFillValue = fullYear + "-" + fullMonth;
        }
      }

      this.makeScriptActionWithValue(
        fillScript,
        combinedExpiryFillValue,
        fillFields.exp,
        filledFields,
      );
    }

    return fillScript;
  }

  /**
   * 判断当前iframe是否"不受信任"（可能存在安全风险）
   *
   * 这是一个重要的安全机制，用于防止钓鱼攻击。攻击者可能在合法网站中嵌入恶意iframe，
   * 试图窃取用户在iframe中输入的凭据。
   *
   * @param {string} pageUrl - 当前页面/iframe的URL（由内容脚本获取）
   * @param {GenerateFillScriptOptions} options - 包含tabUrl和其他配置
   * @returns {boolean} `true` 表示iframe不受信任，应该警告用户；`false` 表示安全
   * @private
   */
  private async inUntrustedIframe(
    pageUrl: string,
    options: GenerateFillScriptOptions,
  ): Promise<boolean> {
    // ===== 第一步：快速判断 - 是否在iframe中 =====
    // pageUrl: 内容脚本运行所在的实际URL（可能是iframe的URL）
    // tabUrl: 浏览器标签页的主URL
    // 如果两者相同，说明内容脚本运行在主页面而非iframe中，直接返回安全
    if (pageUrl === options.tabUrl) {
      return false; // 不在iframe中，安全
    }

    // ===== 第二步：深度检查 - iframe URL是否匹配保存的登录项 =====
    // 到这里说明我们在iframe中，需要验证这个iframe是否可信
    //
    // 背景知识：
    // - 用户触发自动填充时，tabUrl已经匹配了保存的登录项
    // - 但iframe的URL（pageUrl）可能不同
    // - 例如：在example.com页面中嵌入了evil.com的iframe

    // 获取等效域名列表
    // 等效域名是用户配置的一组相互信任的域名
    // 例如：google.com、accounts.google.com、youtube.com可能被配置为等效域名
    const equivalentDomains = await firstValueFrom(
      this.domainSettingsService.getUrlEquivalentDomains(pageUrl),
    );

    // 检查iframe的URL是否匹配密文中保存的任何URI
    // matchesUri会根据用户配置的匹配策略进行检查：
    // - Domain: 域名匹配（默认）
    // - Host: 主机名完全匹配
    // - StartsWith: URL前缀匹配
    // - Exact: URL完全匹配
    // - RegEx: 正则表达式匹配
    const matchesUri = options.cipher.login.matchesUri(
      pageUrl, // iframe的URL
      equivalentDomains, // 等效域名列表
      options.defaultUriMatch, // 默认匹配策略
    );

    // ===== 返回判断结果 =====
    // matchesUri为true表示iframe URL匹配保存的登录项，是可信的
    // 返回值取反：
    // - 匹配（matchesUri=true） -> 可信（返回false）
    // - 不匹配（matchesUri=false） -> 不可信（返回true）
    return !matchesUri;
  }

  // 安全场景示例：
  // 1. 主页面：https://example.com/login
  //    iframe：https://example.com/auth-widget
  //    结果：可信（同域iframe）
  //
  // 2. 主页面：https://microsoft.com
  //    iframe：https://login.microsoftonline.com
  //    结果：可信（如果配置了等效域名）
  //
  // 危险场景示例：
  // 1. 主页面：https://legitimate-site.com
  //    iframe：https://phishing-site.com/fake-login
  //    结果：不可信（域名不匹配）
  //
  // 2. 主页面：https://blog.example.com
  //    iframe：https://evil.com/steal-password
  //    结果：不可信（恶意iframe）

  /**
   * Used when handling autofill on credit card fields. Determines whether
   * the field has an attribute that matches the given value.
   * @param {AutofillField} field
   * @param {string} containsValue
   * @returns {boolean}
   * @private
   */
  private fieldAttrsContain(field: AutofillField, containsValue: string): boolean {
    if (!field) {
      return false;
    }

    let doesContainValue = false;
    CreditCardAutoFillConstants.CardAttributesExtended.forEach((attributeName) => {
      if (doesContainValue || !field[attributeName]) {
        return;
      }

      let fieldValue = field[attributeName];
      fieldValue = fieldValue.replace(/ /g, "").toLowerCase();
      doesContainValue = fieldValue.indexOf(containsValue) > -1;
    });

    return doesContainValue;
  }

  /**
   * Returns a string value representation of the combined card expiration month and year values
   * in a format matching discovered guidance within the field attributes (typically provided for users).
   *
   * @param {CardView} cardCipher
   * @param {AutofillField} field
   */
  private generateCombinedExpiryValue(cardCipher: CardView, field: AutofillField): string {
    /*
      Some expectations of the passed stored card cipher view:

      - At the time of writing, the stored card expiry year value (`expYear`)
        can be any arbitrary string (no format validation). We may attempt some format
        normalization here, but expect the user to have entered a string of integers
        with a length of 2 or 4

      - the `expiration` property cannot be used for autofill as it is an opinionated
        format

      - `expMonth` a stringified integer stored with no zero-padding and is not
        zero-indexed (e.g. January is "1", not "01" or 0)
    */

    // Expiry format options
    let useMonthPadding = true;
    let useYearFull = false;
    let delimiter = "/";
    let orderByYear = false;

    // Because users are allowed to store truncated years, we need to make assumptions
    // about the full year format when called for
    const currentCentury = `${new Date().getFullYear()}`.slice(0, 2);

    // Note, we construct the output rather than doing string replacement against the
    // format guidance pattern to avoid edge cases that would output invalid values
    const [
      // The guidance parsed from the field properties regarding expiry format
      expectedExpiryDateFormat,
      // The (localized) date pattern set that was used to parse the expiry format guidance
      expiryDateFormatPatterns,
    ] = this.getExpectedExpiryDateFormat(field);

    if (expectedExpiryDateFormat) {
      const { Month, MonthShort, Year } = expiryDateFormatPatterns;

      const expiryDateDelimitersPattern = "\\" + CardExpiryDateDelimiters.join("\\");

      // assign the delimiter from the expected format string
      delimiter =
        expectedExpiryDateFormat.match(new RegExp(`[${expiryDateDelimitersPattern}]`, "g"))?.[0] ||
        "";

      // check if the expected format starts with a month form
      // order matters here; check long form first, since short form will match against long
      if (expectedExpiryDateFormat.indexOf(Month + delimiter) === 0) {
        useMonthPadding = true;
        orderByYear = false;
      } else if (expectedExpiryDateFormat.indexOf(MonthShort + delimiter) === 0) {
        useMonthPadding = false;
        orderByYear = false;
      } else {
        orderByYear = true;

        // short form can match against long form, but long won't match against short
        const containsLongMonthPattern = new RegExp(`${Month}`, "i");
        useMonthPadding = containsLongMonthPattern.test(expectedExpiryDateFormat);
      }

      const containsLongYearPattern = new RegExp(`${Year}`, "i");

      useYearFull = containsLongYearPattern.test(expectedExpiryDateFormat);
    }

    const month = useMonthPadding
      ? // Ensure zero-padding
        ("0" + cardCipher.expMonth).slice(-2)
      : // Handle zero-padded stored month values, even though they are not _expected_ to be as such
        cardCipher.expMonth.replaceAll("0", "");
    // Note: assumes the user entered an `expYear` value with a length of either 2 or 4
    const year = (currentCentury + cardCipher.expYear).slice(useYearFull ? -4 : -2);

    const combinedExpiryFillValue = (orderByYear ? [year, month] : [month, year]).join(delimiter);

    return combinedExpiryFillValue;
  }

  /**
   * Returns a string value representation of discovered guidance for a combined month and year expiration value from the field attributes
   *
   * @param {AutofillField} field
   */
  private getExpectedExpiryDateFormat(
    field: AutofillField,
  ): [string | null, CardExpiryDateFormat | null] {
    let expectedDateFormat = null;
    let dateFormatPatterns = null;

    const expiryDateDelimitersPattern = "\\" + CardExpiryDateDelimiters.join("\\");

    CreditCardAutoFillConstants.CardExpiryDateFormats.find((dateFormat) => {
      dateFormatPatterns = dateFormat;

      const { Month, MonthShort, YearShort, Year } = dateFormat;

      // Non-exhaustive coverage of field guidances. Some uncovered edge cases: ". " delimiter, space-delimited delimiters ("mm / yyyy").
      // We should consider if added whitespace is for improved readability of user-guidance or actually desired in the filled value.
      // e.g. "/((mm|m)[\/\-\.\ ]{0,1}(yyyy|yy))|((yyyy|yy)[\/\-\.\ ]{0,1}(mm|m))/gi"
      const dateFormatPattern = new RegExp(
        `((${Month}|${MonthShort})[${expiryDateDelimitersPattern}]{0,1}(${Year}|${YearShort}))|((${Year}|${YearShort})[${expiryDateDelimitersPattern}]{0,1}(${Month}|${MonthShort}))`,
        "gi",
      );

      return CreditCardAutoFillConstants.CardAttributesExtended.find((attributeName) => {
        const fieldAttributeValue = field[attributeName]?.toLocaleLowerCase();

        const fieldAttributeMatch = fieldAttributeValue?.match(dateFormatPattern);
        // break find as soon as a match is found

        if (fieldAttributeMatch?.length) {
          expectedDateFormat = fieldAttributeMatch[0];

          // remove any irrelevant characters
          const irrelevantExpiryCharactersPattern = new RegExp(
            // "or digits" to ensure numbers are removed from guidance pattern, which aren't covered by ^\w
            `[^\\w${expiryDateDelimitersPattern}]|[\\d]`,
            "gi",
          );
          expectedDateFormat.replaceAll(irrelevantExpiryCharactersPattern, "");

          return true;
        }

        return false;
      });
    });
    // @TODO if expectedDateFormat is still null, and there is a `pattern` attribute, cycle
    // through generated formatted values, checking against the provided regex pattern

    return [expectedDateFormat, dateFormatPatterns];
  }

  /**
   * Generates the autofill script for the specified page details and identity cipher item.
   *
   * @param fillScript - Object to store autofill script, passed between method references
   * @param pageDetails - The details of the page to autofill
   * @param filledFields - The fields that have already been filled, passed between method references
   * @param options - Contains data used to fill cipher items
   */
  private generateIdentityFillScript(
    fillScript: AutofillScript,
    pageDetails: AutofillPageDetails,
    filledFields: { [id: string]: AutofillField },
    options: GenerateFillScriptOptions,
  ): AutofillScript {
    const identity = options.cipher.identity;
    if (!identity) {
      return null;
    }

    for (let fieldsIndex = 0; fieldsIndex < pageDetails.fields.length; fieldsIndex++) {
      const field = pageDetails.fields[fieldsIndex];
      if (this.excludeFieldFromIdentityFill(field)) {
        continue;
      }

      const keywordsList = this.getIdentityAutofillFieldKeywords(field);
      const keywordsCombined = keywordsList.join(",");
      if (this.shouldMakeIdentityTitleFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.title, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityNameFillScript(filledFields, keywordsList)) {
        this.makeIdentityNameFillScript(fillScript, filledFields, field, identity);
        continue;
      }

      if (this.shouldMakeIdentityFirstNameFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.firstName, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityMiddleNameFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.middleName, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityLastNameFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.lastName, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityEmailFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.email, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityAddress1FillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.address1, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityAddress2FillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.address2, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityAddress3FillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.address3, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityAddressFillScript(filledFields, keywordsList)) {
        this.makeIdentityAddressFillScript(fillScript, filledFields, field, identity);
        continue;
      }

      if (this.shouldMakeIdentityPostalCodeFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.postalCode, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityCityFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.city, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityStateFillScript(filledFields, keywordsCombined)) {
        this.makeIdentityStateFillScript(fillScript, filledFields, field, identity);
        continue;
      }

      if (this.shouldMakeIdentityCountryFillScript(filledFields, keywordsCombined)) {
        this.makeIdentityCountryFillScript(fillScript, filledFields, field, identity);
        continue;
      }

      if (this.shouldMakeIdentityPhoneFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.phone, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityUserNameFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.username, field, filledFields);
        continue;
      }

      if (this.shouldMakeIdentityCompanyFillScript(filledFields, keywordsCombined)) {
        this.makeScriptActionWithValue(fillScript, identity.company, field, filledFields);
      }
    }

    return fillScript;
  }

  /**
   * Identifies if the current field should be excluded from triggering autofill of the identity cipher.
   *
   * @param field - The field to check
   */
  private excludeFieldFromIdentityFill(field: AutofillField): boolean {
    return (
      AutofillService.isExcludedFieldType(field, [
        "password",
        ...AutoFillConstants.ExcludedAutofillTypes,
      ]) ||
      AutoFillConstants.ExcludedIdentityAutocompleteTypes.has(field.autoCompleteType) ||
      !field.viewable
    );
  }

  /**
   * Gathers all unique keyword identifiers from a field that can be used to determine what
   * identity value should be filled.
   *
   * @param field - The field to gather keywords from
   */
  private getIdentityAutofillFieldKeywords(field: AutofillField): string[] {
    const keywords: Set<string> = new Set();
    for (let index = 0; index < IdentityAutoFillConstants.IdentityAttributes.length; index++) {
      const attribute = IdentityAutoFillConstants.IdentityAttributes[index];
      if (field[attribute]) {
        keywords.add(
          field[attribute]
            .trim()
            .toLowerCase()
            .replace(/[^a-zA-Z0-9]+/g, ""),
        );
      }
    }

    return Array.from(keywords);
  }

  /**
   * Identifies if a fill script action for the identity title
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityTitleFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.title &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.TitleFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity name
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityNameFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string[],
  ): boolean {
    return (
      !filledFields.name &&
      keywords.some((keyword) =>
        AutofillService.isFieldMatch(
          keyword,
          IdentityAutoFillConstants.FullNameFieldNames,
          IdentityAutoFillConstants.FullNameFieldNameValues,
        ),
      )
    );
  }

  /**
   * Identifies if a fill script action for the identity first name
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityFirstNameFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.firstName &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.FirstnameFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity middle name
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityMiddleNameFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.middleName &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.MiddlenameFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity last name
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityLastNameFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.lastName &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.LastnameFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity email
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityEmailFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.email &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.EmailFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity address
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityAddressFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string[],
  ): boolean {
    return (
      !filledFields.address &&
      keywords.some((keyword) =>
        AutofillService.isFieldMatch(
          keyword,
          IdentityAutoFillConstants.AddressFieldNames,
          IdentityAutoFillConstants.AddressFieldNameValues,
        ),
      )
    );
  }

  /**
   * Identifies if a fill script action for the identity address1
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityAddress1FillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.address1 &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.Address1FieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity address2
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityAddress2FillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.address2 &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.Address2FieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity address3
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityAddress3FillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.address3 &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.Address3FieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity postal code
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityPostalCodeFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.postalCode &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.PostalCodeFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity city
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityCityFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.city &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.CityFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity state
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityStateFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.state &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.StateFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity country
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityCountryFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.country &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.CountryFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity phone
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityPhoneFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.phone &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.PhoneFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity username
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityUserNameFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.username &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.UserNameFieldNames)
    );
  }

  /**
   * Identifies if a fill script action for the identity company
   * field should be created for the provided field.
   *
   * @param filledFields - The fields that have already been filled
   * @param keywords - The keywords from the field
   */
  private shouldMakeIdentityCompanyFillScript(
    filledFields: Record<string, AutofillField>,
    keywords: string,
  ): boolean {
    return (
      !filledFields.company &&
      AutofillService.isFieldMatch(keywords, IdentityAutoFillConstants.CompanyFieldNames)
    );
  }

  /**
   * Creates an identity name fill script action for the provided field. This is used
   * when filling a `full name` field, using the first, middle, and last name from the
   * identity cipher item.
   *
   * @param fillScript - The autofill script to add the action to
   * @param filledFields - The fields that have already been filled
   * @param field - The field to fill
   * @param identity - The identity cipher item
   */
  private makeIdentityNameFillScript(
    fillScript: AutofillScript,
    filledFields: Record<string, AutofillField>,
    field: AutofillField,
    identity: IdentityView,
  ) {
    let name = "";
    if (identity.firstName) {
      name += identity.firstName;
    }

    if (identity.middleName) {
      name += !name ? identity.middleName : ` ${identity.middleName}`;
    }

    if (identity.lastName) {
      name += !name ? identity.lastName : ` ${identity.lastName}`;
    }

    this.makeScriptActionWithValue(fillScript, name, field, filledFields);
  }

  /**
   * Creates an identity address fill script action for the provided field. This is used
   * when filling a generic `address` field, using the address1, address2, and address3
   * from the identity cipher item.
   *
   * @param fillScript - The autofill script to add the action to
   * @param filledFields - The fields that have already been filled
   * @param field - The field to fill
   * @param identity - The identity cipher item
   */
  private makeIdentityAddressFillScript(
    fillScript: AutofillScript,
    filledFields: Record<string, AutofillField>,
    field: AutofillField,
    identity: IdentityView,
  ) {
    if (!identity.address1) {
      return;
    }

    let address = identity.address1;

    if (identity.address2) {
      address += `, ${identity.address2}`;
    }

    if (identity.address3) {
      address += `, ${identity.address3}`;
    }

    this.makeScriptActionWithValue(fillScript, address, field, filledFields);
  }

  /**
   * Creates an identity state fill script action for the provided field. This is used
   * when filling a `state` field, using the state value from the identity cipher item.
   * If the state value is a full name, it will be converted to an ISO code.
   *
   * @param fillScript - The autofill script to add the action to
   * @param filledFields - The fields that have already been filled
   * @param field - The field to fill
   * @param identity - The identity cipher item
   */
  private makeIdentityStateFillScript(
    fillScript: AutofillScript,
    filledFields: Record<string, AutofillField>,
    field: AutofillField,
    identity: IdentityView,
  ) {
    if (!identity.state) {
      return;
    }

    if (identity.state.length <= 2) {
      this.makeScriptActionWithValue(fillScript, identity.state, field, filledFields);
      return;
    }

    const stateLower = identity.state.toLowerCase();
    const isoState =
      IdentityAutoFillConstants.IsoStates[stateLower] ||
      IdentityAutoFillConstants.IsoProvinces[stateLower];
    if (isoState) {
      this.makeScriptActionWithValue(fillScript, isoState, field, filledFields);
    }
  }

  /**
   * Creates an identity country fill script action for the provided field. This is used
   * when filling a `country` field, using the country value from the identity cipher item.
   * If the country value is a full name, it will be converted to an ISO code.
   *
   * @param fillScript - The autofill script to add the action to
   * @param filledFields - The fields that have already been filled
   * @param field - The field to fill
   * @param identity - The identity cipher item
   */
  private makeIdentityCountryFillScript(
    fillScript: AutofillScript,
    filledFields: Record<string, AutofillField>,
    field: AutofillField,
    identity: IdentityView,
  ) {
    if (!identity.country) {
      return;
    }

    if (identity.country.length <= 2) {
      this.makeScriptActionWithValue(fillScript, identity.country, field, filledFields);
      return;
    }

    const countryLower = identity.country.toLowerCase();
    const isoCountry = IdentityAutoFillConstants.IsoCountries[countryLower];
    if (isoCountry) {
      this.makeScriptActionWithValue(fillScript, isoCountry, field, filledFields);
    }
  }

  /**
   * Accepts an HTMLInputElement type value and a list of
   * excluded types and returns true if the type is excluded.
   * @param {string} type
   * @param {string[]} excludedTypes
   * @returns {boolean}
   * @private
   */
  private static isExcludedType(type: string, excludedTypes: string[]) {
    return excludedTypes.indexOf(type) > -1;
  }

  /**
   * Identifies if a passed field contains text artifacts that identify it as a search field.
   *
   * @param field - The autofill field that we are validating as a search field
   */
  private static isSearchField(field: AutofillField) {
    const matchFieldAttributeValues = [field.type, field.htmlName, field.htmlID, field.placeholder];
    for (let attrIndex = 0; attrIndex < matchFieldAttributeValues.length; attrIndex++) {
      if (!matchFieldAttributeValues[attrIndex]) {
        continue;
      }

      // Separate camel case words and case them to lower case values
      const camelCaseSeparatedFieldAttribute = matchFieldAttributeValues[attrIndex]
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase();
      // Split the attribute by non-alphabetical characters to get the keywords
      const attributeKeywords = camelCaseSeparatedFieldAttribute.split(/[^a-z]/gi);

      for (let keywordIndex = 0; keywordIndex < attributeKeywords.length; keywordIndex++) {
        if (AutofillService.searchFieldNamesSet.has(attributeKeywords[keywordIndex])) {
          return true;
        }
      }
    }

    return false;
  }

  static isExcludedFieldType(field: AutofillField, excludedTypes: string[]) {
    if (AutofillService.forCustomFieldsOnly(field)) {
      return true;
    }

    if (this.isExcludedType(field.type, excludedTypes)) {
      return true;
    }

    // Check if the input is an untyped/mistyped search input
    return this.isSearchField(field);
  }

  /**
   * Accepts the value of a field, a list of possible options that define if
   * a field can be matched to a vault cipher, and a secondary optional list
   * of options that define if a field can be matched to a vault cipher. Returns
   * true if the field value matches one of the options.
   * @param {string} value
   * @param {string[]} options
   * @param {string[]} containsOptions
   * @returns {boolean}
   * @private
   */
  private static isFieldMatch(
    value: string,
    options: string[],
    containsOptions?: string[],
  ): boolean {
    value = value
      .trim()
      .toLowerCase()
      .replace(/[^a-zA-Z0-9]+/g, "");
    for (let i = 0; i < options.length; i++) {
      let option = options[i];
      const checkValueContains = containsOptions == null || containsOptions.indexOf(option) > -1;
      option = option.toLowerCase().replace(/-/g, "");
      if (value === option || (checkValueContains && value.indexOf(option) > -1)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Helper method used to create a script action for a field. Conditionally
   * accepts a fieldProp value that will be used in place of the dataProp value.
   * @param {AutofillScript} fillScript
   * @param cipherData
   * @param {{[p: string]: AutofillField}} fillFields
   * @param {{[p: string]: AutofillField}} filledFields
   * @param {string} dataProp
   * @param {string} fieldProp
   * @private
   */
  private makeScriptAction(
    fillScript: AutofillScript,
    cipherData: any,
    fillFields: { [id: string]: AutofillField },
    filledFields: { [id: string]: AutofillField },
    dataProp: string,
    fieldProp?: string,
  ) {
    fieldProp = fieldProp || dataProp;
    this.makeScriptActionWithValue(
      fillScript,
      cipherData[dataProp],
      fillFields[fieldProp],
      filledFields,
    );
  }

  /**
   * Handles updating the list of filled fields and adding a script action
   * to the fill script. If a select field is passed as part of the fill options,
   * we iterate over the options to check if the passed value matches one of the
   * options. If it does, we add a script action to select the option.
   * @param {AutofillScript} fillScript
   * @param dataValue
   * @param {AutofillField} field
   * @param {{[p: string]: AutofillField}} filledFields
   * @private
   */
  private makeScriptActionWithValue(
    fillScript: AutofillScript,
    dataValue: any,
    field: AutofillField,
    filledFields: { [id: string]: AutofillField },
  ) {
    let doFill = false;
    if (AutofillService.hasValue(dataValue) && field) {
      if (field.type === "select-one" && field.selectInfo && field.selectInfo.options) {
        for (let i = 0; i < field.selectInfo.options.length; i++) {
          const option = field.selectInfo.options[i];
          for (let j = 0; j < option.length; j++) {
            if (
              AutofillService.hasValue(option[j]) &&
              option[j].toLowerCase() === dataValue.toLowerCase()
            ) {
              doFill = true;
              if (option.length > 1) {
                dataValue = option[1];
              }
              break;
            }
          }

          if (doFill) {
            break;
          }
        }
      } else {
        doFill = true;
      }
    }

    if (doFill) {
      filledFields[field.opid] = field;
      AutofillService.fillByOpid(fillScript, field, dataValue);
    }
  }

  static valueIsLikePassword(value: string) {
    if (value == null) {
      return false;
    }
    // Removes all whitespace, _ and - characters
    const cleanedValue = value.toLowerCase().replace(/[\s_-]/g, "");

    if (cleanedValue.indexOf("password") < 0) {
      return false;
    }

    return !AutoFillConstants.PasswordFieldExcludeList.some((i) => cleanedValue.indexOf(i) > -1);
  }

  static fieldHasDisqualifyingAttributeValue(field: AutofillField) {
    const checkedAttributeValues = [field.htmlID, field.htmlName, field.placeholder];
    let valueIsOnExclusionList = false;

    for (let i = 0; i < checkedAttributeValues.length; i++) {
      const checkedAttributeValue = checkedAttributeValues[i];
      const cleanedValue = checkedAttributeValue?.toLowerCase().replace(/[\s_-]/g, "");

      valueIsOnExclusionList = Boolean(
        cleanedValue && AutoFillConstants.FieldIgnoreList.some((i) => cleanedValue.indexOf(i) > -1),
      );

      if (valueIsOnExclusionList) {
        break;
      }
    }

    return valueIsOnExclusionList;
  }

  /**
   * Accepts a pageDetails object with a list of fields and returns a list of
   * fields that are likely to be password fields.
   * @param {AutofillPageDetails} pageDetails
   * @param {boolean} canBeHidden
   * @param {boolean} canBeReadOnly
   * @param {boolean} mustBeEmpty
   * @param {boolean} fillNewPassword
   * @returns {AutofillField[]}
   */
  static loadPasswordFields(
    pageDetails: AutofillPageDetails,
    canBeHidden: boolean,
    canBeReadOnly: boolean,
    mustBeEmpty: boolean,
    fillNewPassword: boolean,
  ) {
    const arr: AutofillField[] = [];

    pageDetails.fields.forEach((f) => {
      const isPassword = f.type === "password";
      if (
        !isPassword &&
        AutofillService.isExcludedFieldType(f, AutoFillConstants.ExcludedAutofillLoginTypes)
      ) {
        return;
      }

      // If any attribute values match disqualifying values, the entire field should not be used
      if (AutofillService.fieldHasDisqualifyingAttributeValue(f)) {
        return;
      }

      // We want to avoid treating TOTP fields as password fields
      if (AutofillService.fieldIsFuzzyMatch(f, AutoFillConstants.TotpFieldNames)) {
        return;
      }

      const isLikePassword = () => {
        if (f.type !== "text") {
          return false;
        }

        const testedValues = [f.htmlID, f.htmlName, f.placeholder];
        for (let i = 0; i < testedValues.length; i++) {
          if (AutofillService.valueIsLikePassword(testedValues[i])) {
            return true;
          }
        }

        return false;
      };

      if (
        !f.disabled &&
        (canBeReadOnly || !f.readonly) &&
        (isPassword || isLikePassword()) &&
        (canBeHidden || f.viewable) &&
        (!mustBeEmpty || f.value == null || f.value.trim() === "") &&
        (fillNewPassword || f.autoCompleteType !== "new-password")
      ) {
        arr.push(f);
      }
    });

    return arr;
  }

  /**
   * 查找与密码字段关联的用户名字段
   *
   * 该方法使用智能算法在页面上查找最可能的用户名输入字段。
   * 核心策略：在密码字段之前查找合适的输入字段，优先选择明确标记为用户名的字段。
   *
   * @param {AutofillPageDetails} pageDetails - 页面详情，包含所有字段信息
   * @param {AutofillField} passwordField - 参考的密码字段
   * @param {boolean} canBeHidden - 是否可以选择隐藏的字段
   * @param {boolean} canBeReadOnly - 是否可以选择只读字段
   * @param {boolean} withoutForm - 是否可以跨表单查找（true表示不限制同一表单）
   * @returns {AutofillField | null} 找到的用户名字段，或null
   * @private
   */
  private findUsernameField(
    pageDetails: AutofillPageDetails,
    passwordField: AutofillField,
    canBeHidden: boolean,
    canBeReadOnly: boolean,
    withoutForm: boolean,
  ): AutofillField | null {
    // 初始化：保存找到的候选用户名字段
    // 采用"最后一个合适的字段"策略，因为用户名通常紧邻密码字段
    let usernameField: AutofillField = null;

    // 遍历页面上的所有字段
    for (let i = 0; i < pageDetails.fields.length; i++) {
      const f = pageDetails.fields[i];

      // ===== 排除条件1：跳过自定义字段 =====
      // forCustomFieldsOnly检查是否为span元素（用于显示只读自定义字段）
      if (AutofillService.forCustomFieldsOnly(f)) {
        continue;
      }

      // ===== 排除条件2：位置检查 =====
      // 用户名字段必须在密码字段之前（基于DOM顺序）
      // elementNumber是字段在页面上的顺序编号
      if (f.elementNumber >= passwordField.elementNumber) {
        break; // 已经到达或超过密码字段位置，停止搜索
      }

      // ===== 综合条件判断 =====
      // 检查字段是否满足所有要求
      if (
        // 1. 状态检查：字段必须启用（非disabled）
        !f.disabled &&
        // 2. 只读检查：根据参数决定是否接受只读字段
        // canBeReadOnly=true: 接受只读字段
        // canBeReadOnly=false: 字段必须可编辑（!f.readonly）
        (canBeReadOnly || !f.readonly) &&
        // 3. 表单检查：根据参数决定是否限制在同一表单
        // withoutForm=true: 不限制表单（跨表单查找）
        // withoutForm=false: 必须在同一表单中（f.form === passwordField.form）
        (withoutForm || f.form === passwordField.form) &&
        // 4. 可见性检查：根据参数决定是否接受隐藏字段
        // canBeHidden=true: 接受隐藏字段
        // canBeHidden=false: 字段必须可见（f.viewable）
        (canBeHidden || f.viewable) &&
        // 5. 类型检查：用户名字段的常见类型
        // - text: 普通文本输入
        // - email: 邮箱输入（很多网站使用邮箱作为用户名）
        // - tel: 电话输入（某些网站使用手机号作为用户名）
        (f.type === "text" || f.type === "email" || f.type === "tel")
      ) {
        // ===== 候选字段更新 =====
        // 符合条件的字段成为新的候选用户名字段
        // 这里使用"最后一个符合条件"的策略，因为：
        // 1. 用户名字段通常紧邻密码字段
        // 2. 页面可能有多个符合条件的字段（如搜索框）
        usernameField = f;

        // ===== 精确匹配优化 =====
        // 检查字段是否明确标记为用户名字段
        // UsernameFieldNames包含常见的用户名字段标识符：
        // - "username", "user", "login", "email", "account", etc.
        if (this.findMatchingFieldIndex(f, AutoFillConstants.UsernameFieldNames) > -1) {
          // 找到精确匹配！这几乎肯定是用户名字段
          // 立即返回，不再继续查找
          break;
        }
        // 如果不是精确匹配，继续循环
        // 可能会找到更接近密码字段的候选项
      }
    }

    // 返回找到的用户名字段
    // 可能是：
    // 1. 精确匹配的用户名字段（最佳）
    // 2. 最后一个符合条件的字段（次佳）
    // 3. null（没有找到合适的字段）
    return usernameField;
  }

  /**
   * Accepts a pageDetails object with a list of fields and returns a list of
   * fields that are likely to be TOTP fields.
   * @param {AutofillPageDetails} pageDetails
   * @param {AutofillField} passwordField
   * @param {boolean} canBeHidden
   * @param {boolean} canBeReadOnly
   * @param {boolean} withoutForm
   * @returns {AutofillField}
   * @private
   */
  private findTotpField(
    pageDetails: AutofillPageDetails,
    passwordField: AutofillField,
    canBeHidden: boolean,
    canBeReadOnly: boolean,
    withoutForm: boolean,
  ): AutofillField | null {
    let totpField: AutofillField = null;
    for (let i = 0; i < pageDetails.fields.length; i++) {
      const f = pageDetails.fields[i];
      if (AutofillService.forCustomFieldsOnly(f)) {
        continue;
      }

      const fieldIsDisqualified = AutofillService.fieldHasDisqualifyingAttributeValue(f);

      if (
        !fieldIsDisqualified &&
        !f.disabled &&
        (canBeReadOnly || !f.readonly) &&
        (withoutForm || f.form === passwordField.form) &&
        (canBeHidden || f.viewable) &&
        (f.type === "text" || f.type === "number") &&
        AutofillService.fieldIsFuzzyMatch(f, [
          ...AutoFillConstants.TotpFieldNames,
          ...AutoFillConstants.AmbiguousTotpFieldNames,
        ])
      ) {
        totpField = f;

        if (
          this.findMatchingFieldIndex(f, [
            ...AutoFillConstants.TotpFieldNames,
            ...AutoFillConstants.AmbiguousTotpFieldNames,
          ]) > -1 ||
          f.autoCompleteType === "one-time-code"
        ) {
          // We found an exact match. No need to keep looking.
          break;
        }
      }
    }

    return totpField;
  }

  /**
   * Accepts a field and returns the index of the first matching property
   * present in a list of attribute names.
   * @param {AutofillField} field
   * @param {string[]} names
   * @returns {number}
   * @private
   */
  private findMatchingFieldIndex(field: AutofillField, names: string[]): number {
    for (let i = 0; i < names.length; i++) {
      if (names[i].indexOf("=") > -1) {
        if (this.fieldPropertyIsPrefixMatch(field, "htmlID", names[i], "id")) {
          return i;
        }
        if (this.fieldPropertyIsPrefixMatch(field, "htmlName", names[i], "name")) {
          return i;
        }
        if (this.fieldPropertyIsPrefixMatch(field, "label-left", names[i], "label")) {
          return i;
        }
        if (this.fieldPropertyIsPrefixMatch(field, "label-right", names[i], "label")) {
          return i;
        }
        if (this.fieldPropertyIsPrefixMatch(field, "label-tag", names[i], "label")) {
          return i;
        }
        if (this.fieldPropertyIsPrefixMatch(field, "label-aria", names[i], "label")) {
          return i;
        }
        if (this.fieldPropertyIsPrefixMatch(field, "placeholder", names[i], "placeholder")) {
          return i;
        }
      }

      if (this.fieldPropertyIsMatch(field, "htmlID", names[i])) {
        return i;
      }
      if (this.fieldPropertyIsMatch(field, "htmlName", names[i])) {
        return i;
      }
      if (this.fieldPropertyIsMatch(field, "label-left", names[i])) {
        return i;
      }
      if (this.fieldPropertyIsMatch(field, "label-right", names[i])) {
        return i;
      }
      if (this.fieldPropertyIsMatch(field, "label-tag", names[i])) {
        return i;
      }
      if (this.fieldPropertyIsMatch(field, "label-aria", names[i])) {
        return i;
      }
      if (this.fieldPropertyIsMatch(field, "placeholder", names[i])) {
        return i;
      }
    }

    return -1;
  }

  /**
   * Accepts a field, property, name, and prefix and returns true if the field
   * contains a value that matches the given prefixed property.
   * @param field
   * @param {string} property
   * @param {string} name
   * @param {string} prefix
   * @param {string} separator
   * @returns {boolean}
   * @private
   */
  private fieldPropertyIsPrefixMatch(
    field: any,
    property: string,
    name: string,
    prefix: string,
    separator = "=",
  ): boolean {
    if (name.indexOf(prefix + separator) === 0) {
      const sepIndex = name.indexOf(separator);
      const val = name.substring(sepIndex + 1);
      return val != null && this.fieldPropertyIsMatch(field, property, val);
    }
    return false;
  }

  /**
   * Identifies if a given property within a field matches the value
   * of the passed "name" parameter. If the name starts with "regex=",
   * the value is tested against a case-insensitive regular expression.
   * If the name starts with "csv=", the value is treated as a
   * comma-separated list of values to match.
   * @param field
   * @param {string} property
   * @param {string} name
   * @returns {boolean}
   * @private
   */
  private fieldPropertyIsMatch(field: any, property: string, name: string): boolean {
    let fieldVal = field[property] as string;
    if (!AutofillService.hasValue(fieldVal)) {
      return false;
    }

    fieldVal = fieldVal.trim().replace(/(?:\r\n|\r|\n)/g, "");
    if (name.startsWith("regex=")) {
      try {
        const regexParts = name.split("=", 2);
        if (regexParts.length === 2) {
          const regex = new RegExp(regexParts[1], "i");
          return regex.test(fieldVal);
        }
      } catch (e) {
        this.logService.error(e);
      }
    } else if (name.startsWith("csv=")) {
      const csvParts = name.split("=", 2);
      if (csvParts.length === 2) {
        const csvVals = csvParts[1].split(",");
        for (let i = 0; i < csvVals.length; i++) {
          const val = csvVals[i];
          if (val != null && val.trim().toLowerCase() === fieldVal.toLowerCase()) {
            return true;
          }
        }
        return false;
      }
    }

    return fieldVal.toLowerCase() === name;
  }

  /**
   * Accepts a field and returns true if the field contains a
   * value that matches any of the names in the provided list.
   *
   * Returns boolean and attr of value that was matched as a tuple if showMatch is set to true.
   *
   * @param {AutofillField} field
   * @param {string[]} names
   * @param {boolean} showMatch
   * @returns {boolean | [boolean, { attr: string; value: string }?]}
   */
  static fieldIsFuzzyMatch(
    field: AutofillField,
    names: string[],
    showMatch: true,
  ): [boolean, { attr: string; value: string }?];
  static fieldIsFuzzyMatch(field: AutofillField, names: string[]): boolean;
  static fieldIsFuzzyMatch(
    field: AutofillField,
    names: string[],
    showMatch: boolean = false,
  ): boolean | [boolean, { attr: string; value: string }?] {
    const attrs = [
      "htmlID",
      "htmlName",
      "label-tag",
      "placeholder",
      "label-left",
      "label-top",
      "label-aria",
      "dataSetValues",
    ];

    for (const attr of attrs) {
      const value = field[attr];
      if (!AutofillService.hasValue(value)) {
        continue;
      }
      if (this.fuzzyMatch(names, value)) {
        return showMatch ? [true, { attr, value }] : true;
      }
    }
    return showMatch ? [false] : false;
  }

  /**
   * Accepts a list of options and a value and returns
   * true if the value matches any of the options.
   * @param {string[]} options
   * @param {string} value
   * @returns {boolean}
   * @private
   */
  private static fuzzyMatch(options: string[], value: string): boolean {
    if (options == null || options.length === 0 || value == null || value === "") {
      return false;
    }

    value = value
      .replace(/(?:\r\n|\r|\n)/g, "")
      .trim()
      .toLowerCase();

    for (let i = 0; i < options.length; i++) {
      if (value.indexOf(options[i]) > -1) {
        return true;
      }
    }

    return false;
  }

  /**
   * Accepts a string and returns true if the
   * string is not falsy and not empty.
   * @param {string} str
   * @returns {boolean}
   */
  static hasValue(str: string): boolean {
    return Boolean(str && str !== "");
  }

  /**
   * Sets the `focus_by_opid` autofill script
   * action to the last field that was filled.
   * @param {{[p: string]: AutofillField}} filledFields
   * @param {AutofillScript} fillScript
   * @returns {AutofillScript}
   */
  static setFillScriptForFocus(
    filledFields: { [id: string]: AutofillField },
    fillScript: AutofillScript,
  ): AutofillScript {
    let lastField: AutofillField = null;
    let lastPasswordField: AutofillField = null;

    for (const opid in filledFields) {
      // eslint-disable-next-line
      if (filledFields.hasOwnProperty(opid) && filledFields[opid].viewable) {
        lastField = filledFields[opid];

        if (filledFields[opid].type === "password") {
          lastPasswordField = filledFields[opid];
        }
      }
    }

    // Prioritize password field over others.
    if (lastPasswordField) {
      fillScript.script.push(["focus_by_opid", lastPasswordField.opid]);
    } else if (lastField) {
      fillScript.script.push(["focus_by_opid", lastField.opid]);
    }

    return fillScript;
  }

  /**
   * Updates a fill script to place the `cilck_on_opid`, `focus_on_opid`, and `fill_by_opid`
   * fill script actions associated with the provided field.
   * @param {AutofillScript} fillScript
   * @param {AutofillField} field
   * @param {string} value
   */
  static fillByOpid(fillScript: AutofillScript, field: AutofillField, value: string): void {
    if (field.maxLength && value && value.length > field.maxLength) {
      value = value.substr(0, value.length);
    }
    if (field.tagName !== "span") {
      fillScript.script.push(["click_on_opid", field.opid]);
      fillScript.script.push(["focus_by_opid", field.opid]);
    }
    fillScript.script.push(["fill_by_opid", field.opid, value]);
  }

  /**
   * Identifies if the field is a custom field, a custom
   * field is defined as a field that is a `span` element.
   * @param {AutofillField} field
   * @returns {boolean}
   */
  static forCustomFieldsOnly(field: AutofillField): boolean {
    return field.tagName === "span";
  }

  /**
   * Handles debouncing the opening of the master password reprompt popout.
   */
  private isDebouncingPasswordRepromptPopout() {
    if (this.currentlyOpeningPasswordRepromptPopout) {
      return true;
    }

    this.currentlyOpeningPasswordRepromptPopout = true;
    clearTimeout(this.openPasswordRepromptPopoutDebounce);

    this.openPasswordRepromptPopoutDebounce = setTimeout(() => {
      this.currentlyOpeningPasswordRepromptPopout = false;
    }, 100);

    return false;
  }

  /**
   * Handles incoming long-lived connections from injected autofill scripts.
   * Stores the port in a set to facilitate disconnecting ports if the extension
   * needs to re-inject the autofill scripts.
   *
   * @param port - The port that was connected
   */
  private handleInjectedScriptPortConnection = (port: chrome.runtime.Port) => {
    if (port.name !== AutofillPort.InjectedScript) {
      return;
    }

    this.autofillScriptPortsSet.add(port);
    port.onDisconnect.addListener(this.handleInjectScriptPortOnDisconnect);
  };

  /**
   * Handles disconnecting ports that relate to injected autofill scripts.

   * @param port - The port that was disconnected
   */
  private handleInjectScriptPortOnDisconnect = (port: chrome.runtime.Port) => {
    if (port.name !== AutofillPort.InjectedScript) {
      return;
    }

    this.autofillScriptPortsSet.delete(port);
  };

  /**
   * Queries all open tabs in the user's browsing session
   * and injects the autofill scripts into the page.
   */
  private async injectAutofillScriptsInAllTabs() {
    const tabs = await BrowserApi.tabsQuery({});
    for (let index = 0; index < tabs.length; index++) {
      const tab = tabs[index];
      if (tab?.id && tab.url?.startsWith("http")) {
        const frames = await BrowserApi.getAllFrameDetails(tab.id);
        if (frames) {
          frames.forEach((frame) => this.injectAutofillScripts(tab, frame.frameId, false));
        }
      }
    }
  }

  /**
   * Updates the autofill inline menu visibility settings in all active tabs
   * when the inlineMenuVisibility, showInlineMenuCards, or showInlineMenuIdentities
   * observables are updated.
   *
   * @param oldSettingValue - The previous setting value
   * @param newSettingValue - The current setting value
   */
  private async handleInlineMenuVisibilitySettingsChange(
    oldSettingValue: InlineMenuVisibilitySetting | boolean,
    newSettingValue: InlineMenuVisibilitySetting | boolean,
  ) {
    if (oldSettingValue == null || oldSettingValue === newSettingValue) {
      return;
    }

    const isInlineMenuVisibilitySubSetting =
      typeof oldSettingValue === "boolean" || typeof newSettingValue === "boolean";
    const inlineMenuPreviouslyDisabled = oldSettingValue === AutofillOverlayVisibility.Off;
    const inlineMenuCurrentlyDisabled = newSettingValue === AutofillOverlayVisibility.Off;
    if (
      !isInlineMenuVisibilitySubSetting &&
      !inlineMenuPreviouslyDisabled &&
      !inlineMenuCurrentlyDisabled
    ) {
      return;
    }

    await this.reloadAutofillScripts();
  }
}
