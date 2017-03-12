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
const Shared_1 = require("./Shared");
const FileInfo_1 = require("./FileInfo");
const FileItem_1 = require("./FileItem");
const NodeItem_1 = require("./NodeItem");
const fileCache = new Map();
const nodeCache = new Map();
function activate(context) {
    const config = vscode.workspace.getConfiguration('haste');
    const filePatterns = config.get('files', []);
    const nodePatterns = config.get('nodes', []);
    const insertAt = config.get('insertAt');
    const parsingPlugins = config.get('javascript.parser.plugins');
    let disposable = vscode.commands.registerCommand('haste', () => __awaiter(this, void 0, void 0, function* () {
        // Stop processing if the VS Code is not working with folder, or the current document is untitled
        if (vscode.workspace.rootPath === undefined || vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.isUntitled) {
            // TODO: show error message
            return null;
        }
        const currentDocument = vscode.window.activeTextEditor.document;
        const currentFileInfo = new FileInfo_1.default(currentDocument.fileName);
        let items = [];
        const applicableFilePatterns = filePatterns.filter(pattern => (console.log(pattern), pattern.check(currentDocument)));
        for (let index = 0; index < applicableFilePatterns.length; index++) {
            const pattern = applicableFilePatterns[index];
            const files = yield vscode.workspace.findFiles(pattern.inclusionPath, pattern.exclusionPath, 9000);
            files.map(fileInfo => {
                if (fileCache.has(fileInfo.fsPath) === false) {
                    fileCache.set(fileInfo.fsPath, new FileItem_1.default(pattern, fileInfo));
                }
                return fileCache.get(fileInfo.fsPath);
            }).forEach(item => {
                item.updateRank(currentFileInfo.directoryPath);
                if (item.path !== currentFileInfo.localPath) {
                    items.push(item);
                }
            });
        }
        // Remove duplicates and sort files
        if (items.length > 0) {
            items = _.uniq(items);
            items = _.sortBy(items, [
                (item) => item.rank,
                (item) => item.iden,
            ]);
        }
        // Add node modules
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
        // Stop processing if there is no selection
        const select = yield vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' });
        if (!select) {
            return null;
        }
        const currentCodeTree = Shared_1.getCodeTree(currentDocument.getText(), currentDocument.languageId, parsingPlugins);
        let existingImportItems = [];
        if (currentCodeTree && currentCodeTree.program && currentCodeTree.program.body) {
            existingImportItems = currentCodeTree.program.body.filter((line) => line.type === 'ImportDeclaration' && line.source);
        }
        let code = '';
        let insertAt;
        if (select instanceof NodeItem_1.default) {
            const pattern = nodePatterns.find(pattern => pattern.match(select.name));
            insertAt = pattern.insertAt;
            if (existingImportItems.find((line) => line.source.type === 'StringLiteral' && line.source.value === select.name)) {
                vscode.window.showInformationMessage(`The module '${select.name}' has been already imported.`);
                return null;
            }
            code = pattern.interpolate({
                _,
                minimatch: // Lodash
                minimatch_1.match,
                nodeName: select.name,
                getProperVariableName: Shared_1.getProperVariableName,
            });
        }
        else if (select instanceof FileItem_1.default) {
            const selectFileExtension = path.extname(select.path).replace(/^\./, '');
            const selectFileNameWithExtension = path.basename(select.path);
            const selectFileNameWithoutExtension = selectFileNameWithExtension.replace(new RegExp('\\.' + selectFileExtension + '$', 'i'), '');
            const selectCodeText = fs.readFileSync(select.path, 'utf-8');
            const selectCodeTree = Shared_1.getCodeTree(selectCodeText, selectFileExtension, parsingPlugins);
            const pattern = filePatterns.find(pattern => pattern.match(_.trimStart(select.path.substring(vscode.workspace.rootPath.length).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/'), '/')) &&
                pattern.check(currentDocument));
            insertAt = pattern.insertAt;
            let selectRelativeFilePath = FileInfo_1.default.getRelativePath(select.path, currentFileInfo.directoryPath);
            if (pattern.omitIndexFile && Shared.INDEX_FILE.test(selectFileNameWithExtension)) {
                selectRelativeFilePath = _.trimEnd(selectRelativeFilePath.substring(0, selectRelativeFilePath.length - selectFileNameWithExtension.length), '/');
            }
            else if (pattern.omitExtensionInFilePath === true || typeof pattern.omitExtensionInFilePath === 'string' && pattern.omitExtensionInFilePath.toString().length > 0 && new RegExp(pattern.omitExtensionInFilePath, 'i').test(selectFileExtension)) {
                selectRelativeFilePath = selectRelativeFilePath.replace(new RegExp('\\.' + selectFileExtension + '$', 'i'), '');
            }
            if (existingImportItems.find((line) => line.source.type === 'StringLiteral' && line.source.value === selectRelativeFilePath)) {
                vscode.window.showErrorMessage(`The file '${selectRelativeFilePath}' has been already imported.`);
                return null;
            }
            code = pattern.interpolate({
                _,
                minimatch: // Lodash
                minimatch_1.match,
                fullPath: select.unix,
                filePath: selectRelativeFilePath,
                fileName: selectFileNameWithoutExtension,
                fileExtn: selectFileExtension,
                getProperVariableName: Shared_1.getProperVariableName,
                codeText: selectCodeText,
                codeTree: selectCodeTree,
                hasDefaultExport: selectCodeTree === null || Shared_1.findInCodeTree(selectCodeTree, Shared.EXPORT_DEFAULT) !== undefined || Shared_1.findInCodeTree(selectCodeTree, Shared.MODULE_EXPORTS),
                findInCodeTree: (target) => Shared_1.findInCodeTree(selectCodeTree, target),
            });
        }
        editor.edit(worker => {
            let position;
            if (insertAt === 'beforeFirstImport' && existingImportItems.length > 0) {
                position = new vscode.Position(_.first(existingImportItems).loc.start.line - 1, _.first(existingImportItems).loc.start.column);
            }
            else if (insertAt === 'beforeFirstImport' && existingImportItems.length === 0 || insertAt === 'top') {
                position = new vscode.Position(0, 0);
            }
            else if (insertAt === 'afterLastImport' && existingImportItems.length > 0) {
                position = new vscode.Position(_.last(existingImportItems).loc.end.line, 0);
            }
            else if (insertAt === 'afterLastImport' && existingImportItems.length === 0 || insertAt === 'bottom') {
                position = new vscode.Position(currentDocument.lineCount, 0);
            }
            else {
                position = editor.selection.active;
            }
            worker.insert(position, code);
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