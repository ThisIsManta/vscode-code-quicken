"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
const path = require("path");
const _ = require("lodash");
const FileInfo_1 = require("./FileInfo");
class FileItem {
    constructor(fileLink) {
        this.fileInfo = new FileInfo_1.default(fileLink.fsPath);
        this.label = this.fileInfo.fileNameWithoutExtension === 'index' && this.fileInfo.directoryName || this.fileInfo.fileNameWithExtension;
        this.description = _.trim(path.dirname(fileLink.fsPath.substring(vscode.workspace.rootPath.length)), path.sep);
        this.sortableName = this.fileInfo.fileNameWithoutExtension === 'index' ? '!' : this.fileInfo.fileNameWithExtension.toLowerCase();
    }
    updateSortablePath(currentDirectoryPath) {
        if (vscode.workspace.textDocuments.find(document => document.fileName === this.fileInfo.localPath) !== undefined) {
            this.sortablePath = 'a';
        }
        else if (this.fileInfo.directoryPath === currentDirectoryPath) {
            this.sortablePath = 'b';
        }
        else {
            this.sortablePath = this.fileInfo.getRelativePath(currentDirectoryPath).split('/').map((chunk, index, array) => {
                if (chunk === '.')
                    return 'c';
                else if (chunk === '..')
                    return 'f';
                else if (index === array.length - 1 && index > 0 && array[index - 1] === '..')
                    return 'd';
                else if (index === array.length - 1)
                    return 'z';
                return 'e';
            }).join('');
        }
    }
}
exports.default = FileItem;
//# sourceMappingURL=FileItem.js.map