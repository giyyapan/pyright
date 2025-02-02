/*
* service.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* A persistent service that is able to analyze a collection of
* Python files.
*/

import * as fs from 'fs';
import { CompletionList } from 'vscode-languageserver';

import { CommandLineOptions } from '../common/commandLineOptions';
import { ConfigOptions } from '../common/configOptions';
import { ConsoleInterface, StandardConsole } from '../common/console';
import { DiagnosticTextPosition, DocumentTextRange } from '../common/diagnostic';
import { FileDiagnostics } from '../common/diagnosticSink';
import { combinePaths, FileSpec, forEachAncestorDirectory, getDirectoryPath,
    getFileSpec, getFileSystemEntries, isDirectory, isFile, normalizePath } from '../common/pathUtils';
import { Duration, timingStats } from '../common/timing';
import { HoverResults } from './hoverProvider';
import { MaxAnalysisTime, Program } from './program';
import { PythonPathUtils } from './pythonPathUtils';
import { SignatureHelpResults } from './signatureHelpProvider';

const _defaultConfigFileName = 'pyrightconfig.json';

export { MaxAnalysisTime } from './program';

export interface AnalysisResults {
    diagnostics: FileDiagnostics[];
    filesInProgram: number;
    filesRequiringAnalysis: number;
    fatalErrorOccurred: boolean;
    elapsedTime: number;
}

export type AnalysisCompleteCallback = (results: AnalysisResults) => void;

export class AnalyzerService {
    private _instanceName: string;
    private _program: Program;
    private _configOptions: ConfigOptions;
    private _executionRootPath: string;
    private _console: ConsoleInterface;
    private _sourceFileWatcher: (fs.FSWatcher | undefined)[] | undefined;
    private _reloadConfigTimer: any;
    private _configFilePath: string | undefined;
    private _configFileWatcher: fs.FSWatcher | undefined;
    private _onCompletionCallback: AnalysisCompleteCallback | undefined;
    private _watchForChanges = false;
    private _maxAnalysisTime?: MaxAnalysisTime;
    private _analyzeTimer: any;
    private _requireTrackedFileUpdate = true;

    constructor(instanceName: string, console?: ConsoleInterface) {
        this._instanceName = instanceName;
        this._console = console || new StandardConsole();
        this._program = new Program(this._console);
        this._configOptions = new ConfigOptions(process.cwd());
        this._executionRootPath = '';
    }

    setCompletionCallback(callback: AnalysisCompleteCallback | undefined): void {
        this._onCompletionCallback = callback;
    }

    setMaxAnalysisDuration(maxAnalysisTime?: MaxAnalysisTime) {
        this._maxAnalysisTime = maxAnalysisTime;
    }

    setOptions(commandLineOptions: CommandLineOptions): void {
        this._watchForChanges = !!commandLineOptions.watch;
        this._configOptions = this._getConfigOptions(commandLineOptions);

        this._executionRootPath = normalizePath(combinePaths(
                commandLineOptions.executionRoot, this._configOptions.projectRoot));
        this._applyConfigOptions();
    }

    setFileOpened(path: string, version: number | null, contents: string) {
        this._program.setFileOpened(path, version, contents);
        this._scheduleReanalysis(false);
    }

    updateOpenFileContents(path: string, version: number | null, contents: string) {
        this._program.setFileOpened(path, version, contents);
        this._program.markFilesDirty([path]);
        this._scheduleReanalysis(false);
    }

    setFileClosed(path: string) {
        let fileDiagnostics = this._program.setFileClosed(path);
        this._reportDiagnosticsForRemovedFiles(fileDiagnostics);
        this._scheduleReanalysis(false);
    }

    markFilesChanged(fileList: string[]) {
        this._program.markFilesDirty(fileList);
        this._scheduleReanalysis(false);
    }

    getDefinitionForPosition(filePath: string, position: DiagnosticTextPosition):
            DocumentTextRange[] | undefined {

        return this._program.getDefinitionsForPosition(filePath, position);
    }

    getReferencesForPosition(filePath: string, position: DiagnosticTextPosition,
            includeDeclaration: boolean): DocumentTextRange[] | undefined {

        return this._program.getReferencesForPosition(filePath, position,
            this._configOptions, includeDeclaration);
    }

    getHoverForPosition(filePath: string, position: DiagnosticTextPosition):
            HoverResults | undefined {

        return this._program.getHoverForPosition(filePath, position);
    }

    getSignatureHelpForPosition(filePath: string, position: DiagnosticTextPosition):
            SignatureHelpResults | undefined {

        return this._program.getSignatureHelpForPosition(filePath, position,
            this._configOptions);
    }

    getCompletionsForPosition(filePath: string, position: DiagnosticTextPosition):
            CompletionList | undefined {

        return this._program.getCompletionsForPosition(filePath, position,
            this._configOptions);
    }

    printStats() {
        this._console.log('');
        this._console.log('Analysis stats');

        const fileCount = this._program.getFileCount();
        this._console.log('Total files analyzed: ' + fileCount.toString());

        let averagePassCount = this._program.getAverageAnalysisPassCount();
        averagePassCount = Math.round(averagePassCount * 10) / 10;
        this._console.log('Average pass count:   ' + averagePassCount.toString());

        const [maxPassCount, sourceFile] = this._program.getMaxAnalysisPassCount();
        const path = sourceFile ? ` (${ sourceFile.getFilePath() })` : '';
        this._console.log('Maximum pass count:   ' + maxPassCount.toString() + path);
    }

    printDependencies() {
        this._program.printDependencies();
    }

    test_getConfigOptions(commandLineOptions: CommandLineOptions): ConfigOptions {
        return this._getConfigOptions(commandLineOptions);
    }

    test_getFileNamesFromFileSpecs(): string[] {
        return this._getFileNamesFromFileSpecs();
    }

    // Calculates the effective options based on the command-line options,
    // an optional config file, and default values.
    private _getConfigOptions(commandLineOptions: CommandLineOptions): ConfigOptions {
        let projectRoot = commandLineOptions.executionRoot;
        let configFilePath: string | undefined;

        if (commandLineOptions.fileSpecs && commandLineOptions.fileSpecs.length > 0) {
            // If file specs were passed in to the command line, no config file
            // will be used. In this case, all file specs are assumed to be
            // relative to the current working directory.
            if (commandLineOptions.configFilePath) {
                this._console.log('Project cannot be mixed with source files on a command line.');
            }
        } else if (commandLineOptions.configFilePath) {
            // If the config file path was specified, determine whether it's
            // a directory (in which case the default config file name is assumed)
            // or a file.
            configFilePath = combinePaths(commandLineOptions.executionRoot,
                normalizePath(commandLineOptions.configFilePath));
            if (!fs.existsSync(configFilePath)) {
                this._console.log(`Configuration file not found at ${ configFilePath }.`);
                configFilePath = commandLineOptions.executionRoot;
            } else {
                if (configFilePath.toLowerCase().endsWith('.json')) {
                    projectRoot = getDirectoryPath(configFilePath);
                } else {
                    projectRoot = configFilePath;
                    configFilePath = combinePaths(configFilePath, _defaultConfigFileName);
                    if (!fs.existsSync(configFilePath)) {
                        this._console.log(`Configuration file not found at ${ configFilePath }.`);
                        configFilePath = undefined;
                    }
                }
            }
        } else if (projectRoot) {
            configFilePath = this._findConfigFile(projectRoot);
            if (configFilePath) {
                projectRoot = getDirectoryPath(configFilePath);
            } else {
                this._console.log(`No configuration file found.`);
                configFilePath = undefined;
            }
        }

        let configOptions = new ConfigOptions(projectRoot);

        if (commandLineOptions.fileSpecs.length > 0) {
            commandLineOptions.fileSpecs.forEach(fileSpec => {
                configOptions.include.push(getFileSpec(projectRoot, fileSpec));
            });
        } else if (!configFilePath) {
            // If no config file was found and there are no explicit include
            // paths specified and this is the command-line version of the tool
            // (versus the VS Code extension), assume the caller wants to analyze
            // everything under the execution root path.
            if (commandLineOptions.executionRoot && !commandLineOptions.fromVsCodeExtension) {
                configOptions.include.push(getFileSpec('', commandLineOptions.executionRoot));
            }
        }

        this._configFilePath = configFilePath;

        // If we found a config file, parse it to compute the effective options.
        if (configFilePath) {
            this._console.log(`Loading configuration file at ${ configFilePath }`);
            let configJsonObj = this._parseConfigFile(configFilePath);
            if (configJsonObj) {
                configOptions.initializeFromJson(configJsonObj, this._console);

                // If no include paths were provided, assume that all files within
                // the project should be included.
                if (configOptions.include.length === 0) {
                    this._console.log(`No include entries specified; assuming ${ configFilePath }`);
                    configOptions.include.push(getFileSpec('', getDirectoryPath(configFilePath)));
                }
            }
            this._updateConfigFileWatcher();
        }

        const reportDuplicateSetting = (settingName: string) => {
            const settingSource = commandLineOptions.fromVsCodeExtension ?
                'the VS Code settings' : 'a command-line option';
            this._console.log(
                `The ${ settingName } has been specified in both the config file and ` +
                `${ settingSource }. The value in the config file (${ configOptions.venvPath }) ` +
                `will take precedence`);
        };

        // Apply the command-line options if the corresponding
        // item wasn't already set in the config file. Report any
        // duplicates.
        if (commandLineOptions.venvPath) {
            if (!configOptions.venvPath) {
                configOptions.venvPath = commandLineOptions.venvPath;
            } else {
                reportDuplicateSetting('venvPath');
            }
        }

        if (commandLineOptions.pythonPath) {
            this._console.log(`Setting pythonPath for service "${ this._instanceName }": ` +
                `"${ commandLineOptions.pythonPath }"`);
            configOptions.pythonPath = commandLineOptions.pythonPath;
        }

        if (commandLineOptions.typeshedPath) {
            if (!configOptions.typeshedPath) {
                configOptions.typeshedPath = commandLineOptions.typeshedPath;
            } else {
                reportDuplicateSetting('typeshedPath');
            }
        }

        if (commandLineOptions.verboseOutput) {
           configOptions.verboseOutput = true;
        }

        // Do some sanity checks on the specified settings and report missing
        // or inconsistent information.
        if (configOptions.venvPath) {
            if (!fs.existsSync(configOptions.venvPath) || !isDirectory(configOptions.venvPath)) {
                this._console.log(
                    `venvPath ${ configOptions.venvPath } is not a valid directory.`);
            }

            if (configOptions.defaultVenv) {
                const fullVenvPath = combinePaths(configOptions.venvPath, configOptions.defaultVenv);

                if (!fs.existsSync(fullVenvPath) || !isDirectory(fullVenvPath)) {
                    this._console.log(
                        `venv ${ configOptions.defaultVenv } subdirectory not found ` +
                        `in venv path ${ configOptions.venvPath }.`);
                } else {
                    const importFailureInfo: string[] = [];
                    if (PythonPathUtils.findPythonSearchPaths(configOptions, undefined,
                            importFailureInfo) === undefined) {

                        this._console.log(
                            `site-packages directory cannot be located for venvPath ` +
                            `${ configOptions.venvPath } and venv ${ configOptions.defaultVenv }.`);

                        if (configOptions.verboseOutput) {
                            importFailureInfo.forEach(diag => {
                                this._console.log(`  ${ diag }`);
                            });
                        }
                    }
                }
            }
        } else {
            const importFailureInfo: string[] = [];
            const pythonPaths = PythonPathUtils.getPythonPathFromPythonInterpreter(
                configOptions.pythonPath, importFailureInfo);
            if (pythonPaths.length === 0) {
                if (configOptions.verboseOutput) {
                    this._console.log(
                        `No search paths found for configured python interpreter.`);
                }
            } else {
                if (configOptions.verboseOutput) {
                    this._console.log(
                        `Search paths found for configured python interpreter:`);
                    pythonPaths.forEach(path => {
                        this._console.log(`  ${ path }`);
                    });
                }
            }

            if (configOptions.verboseOutput) {
                if (importFailureInfo.length > 0) {
                    this._console.log(
                        `When attempting to get search paths from python interpreter:`);
                    importFailureInfo.forEach(diag => {
                        this._console.log(`  ${ diag }`);
                    });
                }
            }
        }

        // Is there a reference to a venv? If so, there needs to be a valid venvPath.
        if (configOptions.defaultVenv || configOptions.executionEnvironments.find(e => !!e.venv)) {
            if (!configOptions.venvPath) {
                this._console.log(
                    `venvPath not specified, so venv settings will be ignored.`);
            }
        }

        if (configOptions.typeshedPath) {
            if (!fs.existsSync(configOptions.typeshedPath) || !isDirectory(configOptions.typeshedPath)) {
                this._console.log(
                    `typeshedPath ${ configOptions.typeshedPath } is not a valid directory.`);
            }
        }

        if (configOptions.typingsPath) {
            if (!fs.existsSync(configOptions.typingsPath) || !isDirectory(configOptions.typingsPath)) {
                this._console.log(
                    `typingsPath ${ configOptions.typingsPath } is not a valid directory.`);
            }
        }

        return configOptions;
    }

    private _findConfigFile(searchPath: string): string | undefined {
        return forEachAncestorDirectory(searchPath, ancestor => {
            const fileName = combinePaths(ancestor, _defaultConfigFileName);
            return fs.existsSync(fileName) ? fileName : undefined;
        });
    }

    private _parseConfigFile(configPath: string): any | undefined {
        let configContents = '';
        let parseAttemptCount = 0;

        while (true) {
            // Attempt to read the config file contents.
            try {
                configContents = fs.readFileSync(configPath, { encoding: 'utf8' });
            } catch {
                this._console.log(`Config file "${ configPath }" could not be read.`);
                return undefined;
            }

            // Attempt to parse the config file.
            let configObj: any;
            let parseFailed = false;
            try {
                configObj = JSON.parse(configContents);
                return configObj;
            } catch {
                parseFailed = true;
            }

            if (!parseFailed) {
                break;
            }

            // If we attempt to read the config file immediately after it
            // was saved, it may have been partially written when we read it,
            // resulting in parse errors. We'll give it a little more time and
            // try again.
            if (parseAttemptCount++ >= 5) {
                this._console.log(`Config file "${ configPath }" could not be parsed.`);
                return undefined;
            }
        }
    }

    private _getFileNamesFromFileSpecs(): string[] {
        // Use a map to generate a list of unique files.
        const fileMap: { [key: string]: string } = {};

        timingStats.findFilesTime.timeOperation(() => {
            let matchedFiles = this._matchFiles(this._configOptions.include,
                this._configOptions.exclude);

            for (const file of matchedFiles) {
                fileMap[file] = file;
            }
        });

        return Object.keys(fileMap);
    }

    // If markFilesDirtyUnconditionally is true, we need to reparse
    // and reanalyze all files in the program. If false, we will
    // reparse and reanalyze only those files whose on-disk contents
    // have changed. Unconditional dirtying is needed in the case where
    // configuration options have changed.
    private _updateTrackedFileList(markFilesDirtyUnconditionally: boolean) {
        this._console.log(`Searching for source files`);
        let fileList = this._getFileNamesFromFileSpecs();

        let fileDiagnostics = this._program.setTrackedFiles(fileList);
        this._reportDiagnosticsForRemovedFiles(fileDiagnostics);
        this._program.markAllFilesDirty(markFilesDirtyUnconditionally);
        if (fileList.length === 0) {
            this._console.log(`No source files found.`);
        } else {
            this._console.log(`Found ${ fileList.length } ` +
                `source ${ fileList.length === 1 ? 'file' : 'files' }`);
        }

        this._requireTrackedFileUpdate = false;
    }

    private _isInExcludePath(path: string, excludePaths: FileSpec[]) {
        return !!excludePaths.find(excl => excl.regExp.test(path));
    }

    private _matchFiles(include: FileSpec[], exclude: FileSpec[]): string[] {
        const results: string[] = [];

        const visitDirectory = (absolutePath: string, includeRegExp: RegExp) => {
            const includeFileRegex = /\.pyi?$/;
            const { files, directories } = getFileSystemEntries(absolutePath);

            for (const file of files) {
                const filePath = combinePaths(absolutePath, file);

                if (includeRegExp.test(filePath)) {
                    if (!this._isInExcludePath(filePath, exclude) && includeFileRegex.test(filePath)) {
                        results.push(filePath);
                    }
                }
            }

            for (const directory of directories) {
                const dirPath = combinePaths(absolutePath, directory);
                if (includeRegExp.test(dirPath)) {
                    if (!this._isInExcludePath(dirPath, exclude)) {
                        visitDirectory(dirPath, includeRegExp);
                    }
                }
            }
        };

        include.forEach(includeSpec => {
            let foundFileSpec = false;

            if (!this._isInExcludePath(includeSpec.wildcardRoot, exclude) &&
                    fs.existsSync(includeSpec.wildcardRoot)) {
                try {
                    let stat = fs.statSync(includeSpec.wildcardRoot);
                    if (stat.isFile()) {
                        results.push(includeSpec.wildcardRoot);
                        foundFileSpec = true;
                    } else if (stat.isDirectory()) {
                        visitDirectory(includeSpec.wildcardRoot, includeSpec.regExp);
                        foundFileSpec = true;
                    }
                } catch {
                    // Ignore the exception.
                }
            }

            if (!foundFileSpec) {
                this._console.log(`File or directory "${ includeSpec.wildcardRoot }" does not exist.`);
            }
        });

        return results;
    }

    private _updateSourceFileWatchers() {
        if (this._sourceFileWatcher) {
            this._sourceFileWatcher.forEach(watcher => {
                if (watcher) {
                    watcher.close();
                }
            });
            this._sourceFileWatcher = undefined;
        }

        if (!this._watchForChanges) {
            return;
        }

        if (this._configOptions.include.length > 0) {
            let fileList = this._configOptions.include.map(spec => {
                return combinePaths(this._executionRootPath, spec.wildcardRoot);
            });

            this._sourceFileWatcher = fileList.map(fileSpec => {
                try {
                    return fs.watch(fileSpec, { recursive: true }, (event, fileName) => {
                        if (event === 'change') {
                            let filePath = fileSpec;
                            if (!isFile(filePath)) {
                                filePath = combinePaths(fileSpec, fileName);
                            }
                            this._console.log(`Received change fs event for path '${ filePath }'`);
                            this._program.markFilesDirty([filePath]);
                            this._scheduleReanalysis(false);
                        } else {
                            this._console.log(`Received other fs event'`);
                            this._scheduleReanalysis(true);
                        }
                    });
                } catch {
                    return undefined;
                }
            });
        }
    }

    private _updateConfigFileWatcher() {
        if (this._configFileWatcher) {
            this._configFileWatcher.close();
            this._configFileWatcher = undefined;
        }

        if (this._watchForChanges && this._configFilePath) {
            this._configFileWatcher = fs.watch(this._configFilePath, {}, (event, fileName) => {
                this._scheduleReloadConfigFile();
            });
        }
    }

    private _clearReloadConfigTimer() {
        if (this._reloadConfigTimer) {
            clearTimeout(this._reloadConfigTimer);
            this._reloadConfigTimer = undefined;
        }
    }

    private _scheduleReloadConfigFile() {
        this._clearReloadConfigTimer();

        // Wait for a little while after we receive the
        // change update event because it may take a while
        // for the file to be written out. Plus, there may
        // be multiple changes.
        this._reloadConfigTimer = setTimeout(() => {
            this._clearReloadConfigTimer();
            this._reloadConfigFile();
        }, 100);
    }

    private _reloadConfigFile() {
        if (this._configFilePath) {
            this._updateConfigFileWatcher();

            this._console.log(`Reloading configuration file at ${ this._configFilePath }`);
            let configJsonObj = this._parseConfigFile(this._configFilePath);
            if (configJsonObj) {
                this._configOptions.initializeFromJson(configJsonObj, this._console);
            }

            this._applyConfigOptions();
        }
    }

    private _applyConfigOptions() {
        this._updateSourceFileWatchers();
        this._updateTrackedFileList(true);
        this._scheduleReanalysis(false);
    }

    private _clearReanalysisTimer() {
        if (this._analyzeTimer) {
            clearTimeout(this._analyzeTimer);
            this._analyzeTimer = undefined;
        }
    }

    private _scheduleReanalysis(requireTrackedFileUpdate: boolean) {
        if (requireTrackedFileUpdate) {
            this._requireTrackedFileUpdate = true;
        }

        // Remove any existing analysis timer.
        this._clearReanalysisTimer();

        // We choose a small non-zero value here. If this value
        // is too small (like zero), the VS Code extension becomes
        // unresponsive during heavy analysis. If this number is too
        // large, analysis takes longer.
        const timeToNextAnalysisInMs = 5;

        // Schedule a new timer.
        this._analyzeTimer = setTimeout(() => {
            this._analyzeTimer = undefined;

            if (this._requireTrackedFileUpdate) {
                this._updateTrackedFileList(false);
            }

            const moreToAnalyze = this._reanalyze();

            if (moreToAnalyze) {
                this._scheduleReanalysis(false);
            }
        }, timeToNextAnalysisInMs);
    }

    // Performs analysis for a while (up to this._maxAnalysisTimeInMs) before
    // returning some results. Return value indicates whether more analysis is
    // required to finish the entire program.
    private _reanalyze(): boolean {
        let moreToAnalyze = false;

        try {
            let duration = new Duration();
            moreToAnalyze = this._program.analyze(this._configOptions, this._maxAnalysisTime);

            let results: AnalysisResults = {
                diagnostics: this._program.getDiagnostics(this._configOptions),
                filesInProgram: this._program.getFileCount(),
                filesRequiringAnalysis: this._program.getFilesToAnalyzeCount(),
                fatalErrorOccurred: false,
                elapsedTime: duration.getDurationInSeconds()
            };

            let fileCount = results.diagnostics.length;
            if (fileCount > 0) {
                if (this._onCompletionCallback) {
                    this._onCompletionCallback(results);
                }
            }
        } catch (err) {
            this._console.log('Error performing analysis: ' + JSON.stringify(err));

            if (this._onCompletionCallback) {
                this._onCompletionCallback({
                    diagnostics: [],
                    filesInProgram: 0,
                    filesRequiringAnalysis: 0,
                    fatalErrorOccurred: true,
                    elapsedTime: 0
                });
            }
        }

        return moreToAnalyze;
    }

    private _reportDiagnosticsForRemovedFiles(fileDiags: FileDiagnostics[]) {
        if (fileDiags.length > 0) {
            if (this._onCompletionCallback) {
                this._onCompletionCallback({
                    diagnostics: fileDiags,
                    filesInProgram: this._program.getFileCount(),
                    filesRequiringAnalysis: this._program.getFilesToAnalyzeCount(),
                    fatalErrorOccurred: false,
                    elapsedTime: 0
                });
            }
        }
    }
}
