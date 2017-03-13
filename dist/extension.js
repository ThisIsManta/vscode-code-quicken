"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const _ = require("lodash");
const minimatch_1 = require("minimatch");
const Shared = require("./Shared");
const FileInfo_1 = require("./FileInfo");
const FilePattern_1 = require("./FilePattern");
const NodePattern_1 = require("./NodePattern");
const FileItem_1 = require("./FileItem");
const NodeItem_1 = require("./NodeItem");
const fileCache = new Map();
const nodeCache = new Map();
function activate(context) {
    const config = vscode.workspace.getConfiguration('haste');
    const filePatterns = config.get('files', []).map(stub => new FilePattern_1.default(stub));
    const nodePatterns = config.get('nodes', []).map(stub => new NodePattern_1.default(stub));
    const parserPlugins = config.get('javascript.parser.plugins');
    const exclusionFiles = _.chain(vscode.workspace.getConfiguration('files').get('exclude')).toPairs().filter('1').map('0').value();
    let disposable = vscode.commands.registerCommand('haste', () => __awaiter(this, void 0, void 0, function* () {
        // Stop processing if the VS Code is not working with folder, or the current document is untitled
        if (vscode.workspace.rootPath === undefined || vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.isUntitled) {
            return null;
        }
        const currentDocument = vscode.window.activeTextEditor.document;
        const currentFileInfo = new FileInfo_1.default(currentDocument.fileName);
        let items = [];
        // Add files which will be shown in VS Code picker
        const applicableFilePatterns = filePatterns.filter(pattern => pattern.check(currentDocument));
        for (let index = 0; index < applicableFilePatterns.length; index++) {
            const pattern = applicableFilePatterns[index];
            const inclusionList = pattern.inclusion;
            let inclusionPath;
            if (inclusionList.length === 1) {
                inclusionPath = inclusionList[0];
            }
            else {
                inclusionPath = '{' + inclusionList.join(',') + '}';
            }
            const exclusionList = [...pattern.exclusion, ...exclusionFiles];
            let exclusionPath = null;
            if (exclusionList.length === 1) {
                exclusionPath = exclusionList[0];
            }
            else if (exclusionList.length > 1) {
                exclusionPath = '{' + exclusionList.join(',') + '}';
            }
            const stamp = Date.now();
            const fileList = yield vscode.workspace.findFiles(inclusionPath, exclusionPath, 9000);
            fileList.map(fileLink => {
                if (fileCache.has(fileLink.fsPath) === false) {
                    fileCache.set(fileLink.fsPath, new FileItem_1.default(fileLink));
                }
                return fileCache.get(fileLink.fsPath);
            }).forEach(item => {
                item.updateSortablePath(currentFileInfo.directoryPath);
                if (item.fileInfo.localPath !== currentFileInfo.localPath) {
                    items.push(item);
                }
            });
            console.log(Date.now() - stamp);
        }
        // Remove duplicate files and sort files
        if (items.length > 0) {
            items = _.uniq(items);
            items = _.sortBy(items, [
                (item) => item.sortablePath,
                (item) => item.sortableName,
            ]);
        }
        // Add node modules which will be shown in VS Code picker
        if (fs.existsSync(path.join(vscode.workspace.rootPath, 'package.json'))) {
            const packageJson = require(path.join(vscode.workspace.rootPath, 'package.json'));
            items = items.concat(_.chain([_.keys(packageJson.devDependencies), _.keys(packageJson.dependencies)])
                .flatten()
                .map(nodeName => {
                if (nodeCache.has(nodeName) === false) {
                    const pattern = nodePatterns.find(pattern => pattern.match(nodeName));
                    if (pattern) {
                        nodeCache.set(nodeName, new NodeItem_1.default(nodeName));
                    }
                    else {
                        return null;
                    }
                }
                return nodeCache.get(nodeName);
            })
                .compact()
                .sortBy((item) => item.name)
                .value());
        }
        // Stop processing if the current editor is not active
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return null;
        }
        // Show VS Code picker and await user for the selection
        const select = yield vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' });
        // Stop processing if there is no selection
        if (!select) {
            return null;
        }
        // Read all `import` statements of the current viewing document (JavaScript only)
        const currentCodeTree = Shared.getCodeTree(currentDocument.getText(), currentDocument.languageId, parserPlugins);
        let existingImportStatements = [];
        if (currentCodeTree && currentCodeTree.program && currentCodeTree.program.body) {
            existingImportStatements = currentCodeTree.program.body.filter((line) => line.type === 'ImportDeclaration' && line.source);
        }
        // Create a snippet
        let snippet = '';
        let insertAt;
        if (select instanceof NodeItem_1.default) {
            const pattern = nodePatterns.find(pattern => pattern.match(select.name));
            insertAt = pattern.insertAt;
            // Stop processing if the select file does exist in the current viewing document
            if (existingImportStatements.find((line) => line.source.type === 'StringLiteral' && line.source.value === select.name)) {
                vscode.window.showInformationMessage(`The module '${select.name}' has been already imported.`);
                return null;
            }
            snippet = pattern.interpolate(Object.assign({ _,
                minimatch: // Lodash
                minimatch_1.match, moduleName: select.name, moduleVersion: select.version }, Shared));
        }
        else if (select instanceof FileItem_1.default) {
            const selectPathInUnixStyleThatIsRelativeToRootPath = _.trimStart(select.fileInfo.localPath.substring(vscode.workspace.rootPath.length).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/'), '/');
            const pattern = filePatterns.find(pattern => pattern.match(selectPathInUnixStyleThatIsRelativeToRootPath) && pattern.check(currentDocument));
            insertAt = pattern.insertAt;
            const selectCodeText = fs.readFileSync(select.fileInfo.localPath, 'utf-8');
            const selectCodeTree = Shared.getCodeTree(selectCodeText, select.fileInfo.fileExtensionWithoutLeadingDot, parserPlugins);
            const selectRelativeFilePath = pattern.getRelativeFilePath(select.fileInfo, currentFileInfo.directoryPath);
            if (existingImportStatements.find((line) => line.source.type === 'StringLiteral' && line.source.value === selectRelativeFilePath)) {
                vscode.window.showErrorMessage(`The file '${selectRelativeFilePath}' has been already imported.`);
                return null;
            }
            snippet = pattern.interpolate(Object.assign({ _,
                minimatch: // Lodash
                minimatch_1.match, fullPath: select.fileInfo.unixPath, filePath: selectRelativeFilePath, fileName: select.fileInfo.fileNameWithoutExtension, fileExtn: select.fileInfo.fileNameWithExtension, codeText: selectCodeText, codeTree: selectCodeTree, hasDefaultExport: selectCodeTree === null || Shared.findInCodeTree(selectCodeTree, Shared.EXPORT_DEFAULT) !== undefined || Shared.findInCodeTree(selectCodeTree, Shared.MODULE_EXPORTS) }, Shared, { findInCodeTree: (target) => Shared.findInCodeTree(selectCodeTree, target) }));
        }
        // Write a snippet to the current viewing document
        editor.edit(worker => {
            let position;
            if (insertAt === 'beforeFirstImport' && existingImportStatements.length > 0) {
                position = new vscode.Position(_.first(existingImportStatements).loc.start.line - 1, _.first(existingImportStatements).loc.start.column);
            }
            else if (insertAt === 'beforeFirstImport' && existingImportStatements.length === 0 || insertAt === 'top') {
                position = new vscode.Position(0, 0);
            }
            else if (insertAt === 'afterLastImport' && existingImportStatements.length > 0) {
                position = new vscode.Position(_.last(existingImportStatements).loc.end.line, 0);
            }
            else if (insertAt === 'afterLastImport' && existingImportStatements.length === 0 || insertAt === 'bottom') {
                position = new vscode.Position(currentDocument.lineCount, 0);
            }
            else {
                position = editor.selection.active;
            }
            worker.insert(position, snippet);
        });
    }));
    vscode.workspace.onDidChangeConfiguration(() => {
        vscode.window.showInformationMessage('VS Code must be restarted in order to make changes to Haste extension.');
    });
    context.subscriptions.push(disposable);
}
exports.activate = activate;
function deactivate() {
    fileCache.clear();
    nodeCache.clear();
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map