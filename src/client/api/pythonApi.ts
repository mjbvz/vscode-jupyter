// eslint-disable-next-line
/* eslint-disable comma-dangle */
// eslint-disable-next-line
/* eslint-disable max-classes-per-file */
// eslint-disable-next-line
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
// eslint-disable-next-line
/* eslint-disable class-methods-use-this */
// eslint-disable-next-line
/* eslint-disable consistent-return */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { CancellationToken, Disposable, Event, EventEmitter, Uri } from 'vscode';
import { IApplicationShell, ICommandManager } from '../common/application/types';
import { ProductNames } from '../common/installer/productNames';
import { InterpreterUri } from '../common/installer/types';
import {
    IDisposableRegistry,
    IExtensions,
    InstallerResponse,
    IPersistentStateFactory,
    Product,
    Resource
} from '../common/types';
import { createDeferred } from '../common/utils/async';
import * as localize from '../common/utils/localize';
import { noop } from '../common/utils/misc';
import { PythonExtension, Telemetry } from '../datascience/constants';
import { IEnvironmentActivationService } from '../interpreter/activation/types';
import { IInterpreterQuickPickItem, IInterpreterSelector } from '../interpreter/configuration/types';
import { IInterpreterService } from '../interpreter/contracts';
import { IWindowsStoreInterpreter } from '../interpreter/locators/types';
import { PythonEnvironment } from '../pythonEnvironments/info';
import { sendTelemetryEvent } from '../telemetry';
import {
    ILanguageServer,
    ILanguageServerProvider,
    IPythonApiProvider,
    IPythonDebuggerPathProvider,
    IPythonExtensionChecker,
    IPythonInstaller,
    JupyterProductToInstall,
    PythonApi
} from './types';

/* eslint-disable max-classes-per-file */
@injectable()
export class PythonApiProvider implements IPythonApiProvider {
    private readonly api = createDeferred<PythonApi>();

    private initialized?: boolean;

    constructor(
        @inject(IExtensions) private readonly extensions: IExtensions,
        @inject(IPythonExtensionChecker) private extensionChecker: IPythonExtensionChecker
    ) {}

    public async getApi(): Promise<PythonApi | undefined> {
        if (await this.init().catch(noop)) {
            return this.api.promise;
        }
        return;
    }

    public setApi(api: PythonApi): void {
        if (this.api.resolved) {
            return;
        }
        this.api.resolve(api);
    }

    private async init(): Promise<boolean> {
        if (this.initialized) {
            return true;
        }
        this.initialized = true;
        const pythonExtension = this.extensions.getExtension<{ jupyter: { registerHooks(): void } }>(PythonExtension);
        if (!pythonExtension) {
            const installed = await this.extensionChecker.showPythonExtensionInstallRequiredPrompt();
            if (installed === InstallerResponse.Installed) {
                return true;
            }
            this.initialized = false;
            return false;
        } else {
            if (!pythonExtension.isActive) {
                await pythonExtension.activate();
            }
            pythonExtension.exports.jupyter.registerHooks();
            return true;
        }
    }
}

@injectable()
export class PythonExtensionChecker implements IPythonExtensionChecker {
    private extensionChangeHandler: Disposable | undefined;
    private pythonExtensionId = PythonExtension;
    private waitingOnInstallPrompt?: Promise<InstallerResponse>;
    constructor(
        @inject(IExtensions) private readonly extensions: IExtensions,
        @inject(IPersistentStateFactory) private readonly persistentStateFactory: IPersistentStateFactory,
        @inject(IApplicationShell) private readonly appShell: IApplicationShell,
        @inject(ICommandManager) private readonly commandManager: ICommandManager
    ) {
        // If the python extension is not installed listen to see if anything does install it
        if (!this.isPythonExtensionInstalled) {
            this.extensionChangeHandler = this.extensions.onDidChange(this.extensionsChangeHandler.bind(this));
        }
    }

    public get isPythonExtensionInstalled() {
        return this.extensions.getExtension(this.pythonExtensionId) !== undefined;
    }

    public async showPythonExtensionInstallRequiredPrompt(): Promise<InstallerResponse> {
        if (this.waitingOnInstallPrompt) {
            return this.waitingOnInstallPrompt;
        }
        // Ask user if they want to install and then wait for them to actually install it.
        const yes = localize.Common.bannerLabelYes();
        const no = localize.Common.bannerLabelNo();
        const answer = await this.appShell.showErrorMessage(localize.DataScience.pythonExtensionRequired(), yes, no);
        if (answer === yes) {
            await this.installPythonExtension();
            return InstallerResponse.Installed;
        }
        return InstallerResponse.Ignore;
    }

    public async showPythonExtensionInstallRecommendedPrompt() {
        const key = 'ShouldShowPythonExtensionInstallRecommendedPrompt';
        const surveyPrompt = this.persistentStateFactory.createGlobalPersistentState(key, true);
        if (surveyPrompt.value) {
            const yes = localize.Common.bannerLabelYes();
            const no = localize.Common.bannerLabelNo();
            const doNotShowAgain = localize.Common.doNotShowAgain();

            const promise = (this.waitingOnInstallPrompt = new Promise<InstallerResponse>(async (resolve) => {
                const answer = await this.appShell.showWarningMessage(
                    localize.DataScience.pythonExtensionRecommended(),
                    yes,
                    no,
                    doNotShowAgain
                );
                let resolveValue: InstallerResponse;
                switch (answer) {
                    case yes:
                        await this.installPythonExtension();
                        resolveValue = InstallerResponse.Installed;
                        break;
                    case doNotShowAgain:
                        await surveyPrompt.updateValue(false);
                        resolveValue = InstallerResponse.Disabled;
                        break;
                    case no:
                    default:
                        resolveValue = InstallerResponse.Ignore;
                        break;
                }
                resolve(resolveValue);
            }));
            await promise;
            this.waitingOnInstallPrompt = undefined;
        }
    }

    private async installPythonExtension() {
        // Have the user install python
        void this.commandManager.executeCommand('extension.open', PythonExtension);
    }

    private async extensionsChangeHandler(): Promise<void> {
        // On extension change see if python was installed, if so unhook our extension change watcher and
        // notify the user that they might need to restart notebooks or interactive windows
        if (this.isPythonExtensionInstalled && this.extensionChangeHandler) {
            this.extensionChangeHandler.dispose();
            this.extensionChangeHandler = undefined;

            this.appShell
                .showInformationMessage(localize.DataScience.pythonExtensionInstalled(), localize.Common.ok())
                .then(noop, noop);
        }
    }
}

@injectable()
export class LanguageServerProvider implements ILanguageServerProvider {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public getLanguageServer(resource?: InterpreterUri): Promise<ILanguageServer | undefined> {
        return this.apiProvider.getApi().then((api) => api?.getLanguageServer(resource));
    }
}

@injectable()
export class WindowsStoreInterpreter implements IWindowsStoreInterpreter {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public isWindowsStoreInterpreter(pythonPath: string): Promise<boolean> {
        return this.apiProvider.getApi().then((api) => (api ? api.isWindowsStoreInterpreter(pythonPath) : false));
    }
}

@injectable()
export class PythonDebuggerPathProvider implements IPythonDebuggerPathProvider {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public getDebuggerPath(): Promise<string | undefined> {
        return this.apiProvider.getApi().then((api) => api?.getDebuggerPath());
    }
}

const ProductMapping: { [key in Product]: JupyterProductToInstall } = {
    [Product.ipykernel]: JupyterProductToInstall.ipykernel,
    [Product.jupyter]: JupyterProductToInstall.jupyter,
    [Product.kernelspec]: JupyterProductToInstall.kernelspec,
    [Product.nbconvert]: JupyterProductToInstall.nbconvert,
    [Product.notebook]: JupyterProductToInstall.notebook,
    [Product.pandas]: JupyterProductToInstall.pandas
};

/* eslint-disable max-classes-per-file */
@injectable()
export class PythonInstaller implements IPythonInstaller {
    private readonly _onInstalled = new EventEmitter<{ product: Product; resource?: InterpreterUri }>();
    public get onInstalled(): Event<{ product: Product; resource?: InterpreterUri }> {
        return this._onInstalled.event;
    }
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public async install(
        product: Product,
        resource?: InterpreterUri,
        cancel?: CancellationToken
    ): Promise<InstallerResponse> {
        let action: 'installed' | 'failed' | 'disabled' | 'ignored' = 'installed';
        try {
            const api = await this.apiProvider.getApi();
            const result = await api?.install(ProductMapping[product], resource, cancel);
            if (result === InstallerResponse.Installed) {
                this._onInstalled.fire({ product, resource });
            }
            switch (result) {
                case InstallerResponse.Installed:
                    action = 'installed';
                    break;
                case InstallerResponse.Ignore:
                case undefined:
                    action = 'ignored';
                    break;
                case InstallerResponse.Disabled:
                    action = 'disabled';
                    break;
                default:
                    break;
            }
            return result || InstallerResponse.Ignore;
        } catch (ex) {
            action = 'failed';
            throw ex;
        } finally {
            product;
            sendTelemetryEvent(Telemetry.PythonModuleInstal, undefined, {
                action,
                moduleName: ProductNames.get(product)!
            });
        }
    }
}

// eslint-disable-next-line max-classes-per-file
@injectable()
export class EnvironmentActivationService implements IEnvironmentActivationService {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public async getActivatedEnvironmentVariables(
        resource: Resource,
        interpreter?: PythonEnvironment
    ): Promise<NodeJS.ProcessEnv | undefined> {
        return this.apiProvider
            .getApi()
            .then((api) => api?.getActivatedEnvironmentVariables(resource, interpreter, false));
    }
}

// eslint-disable-next-line max-classes-per-file
@injectable()
export class InterpreterSelector implements IInterpreterSelector {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public async getSuggestions(resource: Resource): Promise<IInterpreterQuickPickItem[]> {
        return this.apiProvider.getApi().then((api) => (api ? api.getSuggestions(resource) : []));
    }
}
// eslint-disable-next-line max-classes-per-file
@injectable()
export class InterpreterService implements IInterpreterService {
    private readonly didChangeInterpreter = new EventEmitter<void>();
    private eventHandlerAdded?: boolean;
    constructor(
        @inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider,
        @inject(IPythonExtensionChecker) private extensionChecker: IPythonExtensionChecker,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public get onDidChangeInterpreter(): Event<void> {
        if (this.extensionChecker.isPythonExtensionInstalled && !this.eventHandlerAdded) {
            this.apiProvider
                .getApi()
                .then((api) => {
                    if (!this.eventHandlerAdded) {
                        this.eventHandlerAdded = true;
                        api?.onDidChangeInterpreter(() => this.didChangeInterpreter.fire(), this, this.disposables);
                    }
                })
                .catch(noop);
        }
        return this.didChangeInterpreter.event;
    }

    public getInterpreters(resource?: Uri): Promise<PythonEnvironment[]> {
        return this.apiProvider.getApi().then((api) => (api ? api.getInterpreters(resource) : []));
    }

    public getActiveInterpreter(resource?: Uri): Promise<PythonEnvironment | undefined> {
        return this.apiProvider.getApi().then((api) => api?.getActiveInterpreter(resource));
    }

    public async getInterpreterDetails(pythonPath: string, resource?: Uri): Promise<undefined | PythonEnvironment> {
        try {
            return await this.apiProvider.getApi().then((api) => api?.getInterpreterDetails(pythonPath, resource));
        } catch {
            // If the python extension cannot get the details here, don't fail. Just don't use them.
            return undefined;
        }
    }
}
