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
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const _ = require("lodash");
const minimatch_1 = require("minimatch");
const espree = require("espree");
const WIN_SLASH = /\\/g;
const fileCache = new Map();
let nodeCache = [];
function activate(context) {
    const config = vscode.workspace.getConfiguration('haste');
    const filePatterns = config.get('files', []);
    const nodePatterns = config.get('nodes', []);
    const insertAt = config.get('insertAt');
    const parsingOptions = config.get('javascriptParsingOptions');
    filePatterns.forEach(pattern => {
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code);
    });
    nodePatterns.forEach(pattern => {
        const matcher = new minimatch_1.Minimatch(pattern.name);
        pattern.exec = matcher.match.bind(matcher);
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code);
    });
    if (fs.existsSync(path.join(vscode.workspace.rootPath, 'package.json'))) {
        const packageJson = require(path.join(vscode.workspace.rootPath, 'package.json'));
        nodeCache = _.chain([_.keys(packageJson.devDependencies), _.keys(packageJson.dependencies)])
            .flatten()
            .sortBy()
            .map(nodeName => {
            try {
                const packageJson = require(path.join(vscode.workspace.rootPath, 'node_modules', nodeName, 'package.json'));
                if (packageJson.version) {
                    return { name: nodeName, vers: packageJson.version };
                }
                else {
                    return null;
                }
            }
            catch (ex) {
                return null;
            }
        })
            .compact()
            .map(nodeModule => {
            const pattern = nodePatterns.find(pattern => pattern.exec(nodeModule.name));
            if (pattern) {
                return Object.assign({}, nodeModule, { temp: pattern.temp });
            }
            else {
                return null;
            }
        })
            .compact()
            .map(nodeModule => ({
            label: nodeModule.name,
            description: nodeModule.vers,
            type: 'node',
            name: nodeModule.name,
            temp: nodeModule.temp,
        }))
            .value();
    }
    let disposable = vscode.commands.registerCommand('haste', () => __awaiter(this, void 0, void 0, function* () {
        const currentDocument = vscode.window.activeTextEditor.document;
        const currentFilePath = currentDocument.fileName;
        const currentFileDirx = path.dirname(currentFilePath);
        let items = [];
        for (let index = 0; index < filePatterns.length; index++) {
            const pattern = filePatterns[index];
            const files = yield vscode.workspace.findFiles(pattern.path, null, 9000);
            const CURRENT_DIRX = /^\.\//;
            _.chain(files)
                .map(file => {
                if (fileCache.has(file.fsPath) === false) {
                    fileCache.set(file.fsPath, {
                        label: path.basename(file.path),
                        description: _.trimStart(file.fsPath.replace(vscode.workspace.rootPath, '').replace(WIN_SLASH, '/'), '/'),
                        type: 'file',
                        path: file.fsPath,
                        temp: pattern.temp,
                    });
                }
                return fileCache.get(file.fsPath);
            })
                .sortBy((item) => getRelativePath(currentFileDirx, item.path).replace(CURRENT_DIRX, '*'))
                .forEach((item) => {
                if (item.path !== currentFilePath) {
                    items.push(item);
                }
            })
                .value();
        }
        items = items.concat(nodeCache);
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return null;
        }
        const select = yield vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' });
        if (!select) {
            return null;
        }
        const currentCodeTree = getCodeTree(currentDocument.getText(), parsingOptions);
        let existingImportItems = [];
        if (currentCodeTree && currentCodeTree.body) {
            existingImportItems = currentCodeTree.body.filter((line) => line.type === 'ImportDeclaration' && line.source);
        }
        let code = '';
        if (select.type === 'node') {
            if (existingImportItems.find((line) => line.source.value === select.name)) {
                vscode.window.showErrorMessage(`Importing '${select.name}' already exists.`);
                return null;
            }
            code = select.temp({
                _,
                nodeName: select.name,
            });
        }
        else if (select.type === 'file') {
            const selectRelativePath = getRelativePath(currentFileDirx, select.path);
            if (existingImportItems.find((line) => line.source.value === selectRelativePath)) {
                vscode.window.showErrorMessage(`Importing '${selectRelativePath}' already exists.`);
                return null;
            }
            const extension = path.extname(select.path);
            const selectFileNameWithoutExtension = _.camelCase(path.basename(select.path).replace(new RegExp(_.escapeRegExp(extension) + '$'), ''));
            const selectCodeText = fs.readFileSync(select.path, 'utf-8');
            const selectCodeTree = getCodeTree(selectCodeText, parsingOptions);
            code = select.temp({
                _,
                fullPath: select.path,
                filePath: selectRelativePath,
                fileName: selectFileNameWithoutExtension,
                fileExtn: extension.replace(/^\./, ''),
                codeText: selectCodeText,
                codeTree: selectCodeTree,
                hasExportDefault: /*selectCodeTree === null ||*/ findInCodeTree(selectCodeTree, { type: 'ExportDefaultDeclaration' }) !== undefined,
                findInCodeTree,
            });
        }
        editor.edit(worker => {
            let position = editor.selection.active;
            if (insertAt === 'beforeFirstImport') {
                if (existingImportItems.length > 0) {
                    position = new vscode.Position(_.first(existingImportItems).loc.start.line - 1, _.first(existingImportItems).loc.start.column);
                }
                else {
                    position = new vscode.Position(0, 0);
                }
            }
            else if (insertAt === 'afterLastImport') {
                if (existingImportItems.length > 0) {
                    position = new vscode.Position(_.last(existingImportItems).loc.end.line, 0);
                }
                else {
                    position = new vscode.Position(0, 0);
                }
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
    nodeCache = [];
}
exports.deactivate = deactivate;
function getRelativePath(currentPath, anotherPath) {
    let relativePath = path.relative(currentPath, anotherPath).replace(WIN_SLASH, '/');
    if (relativePath.startsWith('../') === false) {
        relativePath = './' + relativePath;
    }
    return relativePath;
}
function getCodeTree(text, options = {}) {
    try {
        return espree.parse(text, Object.assign({}, options, { sourceType: 'module', range: true, loc: true, comment: false }));
    }
    catch (ex) {
        console.error(ex);
        return null;
    }
}
function findInCodeTree(branch, target) {
    if (branch === null) {
        return undefined;
    }
    else if (_.isMatch(branch, target)) {
        return target;
    }
    else if (_.isArrayLike(branch['body'])) {
        for (let index = 0; index < branch['body'].length; index++) {
            const result = findInCodeTree(branch['body'][index], target);
            if (result !== undefined) {
                return result;
            }
        }
        return undefined;
    }
    else if (_.isObject(branch['body'])) {
        return findInCodeTree(branch['body'], target);
    }
    else {
        return undefined;
    }
}
//# sourceMappingURL=extension.js.map