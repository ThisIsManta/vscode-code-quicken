"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const _ = require("lodash");
const Shared = require("./Shared");
class FileInfo {
    constructor(localPath) {
        this.localPath = localPath;
        this.unixPath = this.localPath.replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/');
        this.fileExtensionWithoutLeadingDot = path.extname(this.localPath).replace(/^\./, '');
        this.fileNameWithExtension = path.basename(this.localPath);
        this.fileNameWithoutExtension = this.fileNameWithExtension.replace(new RegExp('\\.' + this.fileExtensionWithoutLeadingDot + '$', 'i'), '');
        this.directoryPath = path.dirname(this.localPath).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/');
        this.directoryPath = _.last(path.dirname(this.localPath).split('/'));
    }
    getRelativePath(rootPath) {
        let relativePath = path.relative(rootPath, this.localPath).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/');
        if (relativePath.startsWith('../') === false) {
            relativePath = './' + relativePath;
        }
        return relativePath;
    }
}
exports.default = FileInfo;
//# sourceMappingURL=FileInfo.js.map