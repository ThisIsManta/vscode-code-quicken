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
function activate(context) {
    const config = vscode.workspace.getConfiguration('haste');
    const filePatterns = config.get('files', []);
    const nodePatterns = config.get('nodes', []);
    const insertAt = config.get('insertAt');
    filePatterns.forEach(pattern => {
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code);
    });
    nodePatterns.forEach(pattern => {
        const matcher = new minimatch_1.Minimatch(pattern.name);
        pattern.exec = matcher.match.bind(matcher);
        pattern.temp = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code);
    });
    let nodeModules = [];
    if (fs.existsSync(path.join(vscode.workspace.rootPath, 'package.json'))) {
        const packageJson = require(path.join(vscode.workspace.rootPath, 'package.json'));
        nodeModules = _.chain([_.keys(packageJson.devDependencies), _.keys(packageJson.dependencies)])
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
            .value();
    }
    let disposable = vscode.commands.registerCommand('haste', () => __awaiter(this, void 0, void 0, function* () {
        const currentDocument = vscode.window.activeTextEditor.document;
        const currentFilePath = currentDocument.fileName;
        const currentFileDirx = path.dirname(currentFilePath);
        let items = [];
        const cache = new Map();
        for (let index = 0; index < filePatterns.length; index++) {
            const pattern = filePatterns[index];
            const files = yield vscode.workspace.findFiles(pattern.path, null, 9000);
            const CURRENT_DIRX = /^\.\//;
            _.chain(files)
                .sortBy(file => getRelativePath(currentFileDirx, file.fsPath).replace(CURRENT_DIRX, '*'))
                .forEach(file => {
                if (file.fsPath !== currentFilePath) {
                    items.push({
                        label: path.basename(file.path),
                        description: file.fsPath.replace(vscode.workspace.rootPath, '').replace(WIN_SLASH, '/'),
                        type: 'file',
                        path: file.fsPath,
                        temp: pattern.temp,
                    });
                }
            })
                .value();
        }
        nodeModules.forEach(nodeModule => {
            items.push({
                label: nodeModule.name,
                description: nodeModule.vers,
                type: 'node',
                name: nodeModule.name,
                temp: nodeModule.temp,
            });
        });
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return null;
        }
        const select = yield vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' });
        if (!select) {
            return null;
        }
        let existingImportItems = [];
        try {
            existingImportItems = espree.parse(currentDocument.getText(), {
                range: true,
                loc: true,
                comment: false,
                sourceType: 'module',
                ecmaVersion: 6,
                ecmaFeatures: {
                    jsx: true,
                    impliedStrict: true,
                    experimentalObjectRestSpread: true,
                }
            }).body.filter((line) => line.type === 'ImportDeclaration' && line.source);
        }
        catch (ex) {
            console.error(ex);
        }
        let code;
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
            code = select.temp({
                _,
                fullPath: select.path,
                filePath: selectRelativePath,
                fileName: selectFileNameWithoutExtension,
                fileExtn: extension.replace(/^\./, ''),
            });
        }
        editor.edit(builder => {
            let position = editor.selection.active;
            if (insertAt === 'beforeFirstImport') {
                if (existingImportItems.length > 0) {
                    position = new vscode.Position(_.first(existingImportItems).loc.start.line, _.first(existingImportItems).loc.start.column);
                }
                else {
                    position = new vscode.Position(0, 0);
                }
            }
            else if (insertAt === 'afterLastImport') {
                if (existingImportItems.length > 0) {
                    position = new vscode.Position(_.last(existingImportItems).loc.start.line, _.last(existingImportItems).loc.start.column);
                }
                else {
                    position = new vscode.Position(0, 0);
                }
            }
            builder.insert(position, code);
        });
    }));
    vscode.workspace.onDidChangeConfiguration(() => {
        vscode.window.showInformationMessage('VS Code must be restarted in order to make changes to Haste extension.');
    });
    context.subscriptions.push(disposable);
}
exports.activate = activate;
function deactivate() {
}
exports.deactivate = deactivate;
function getRelativePath(currentPath, anotherPath) {
    let relativePath = path.relative(currentPath, anotherPath).replace(WIN_SLASH, '/');
    if (relativePath.startsWith('../') === false) {
        relativePath = './' + relativePath;
    }
    return relativePath;
}
//# sourceMappingURL=extension.js.map