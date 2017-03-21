"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
const path = require("path");
const _ = require("lodash");
const minimatch_1 = require("minimatch");
const FileInfo_1 = require("./FileInfo");
class FilePattern {
    get insertAt() {
        return this.config.insertAt;
    }
    constructor(config) {
        this.config = config;
        const multiPaths = typeof config.path === 'string' ? [config.path] : config.path;
        this.inclusionList = multiPaths.filter(item => item.startsWith('!') === false);
        this.exclusionList = _.difference(multiPaths, this.inclusionList).map(item => _.trimStart(item, '!'));
        const endOfLine = vscode.workspace.getConfiguration('files').get('eol');
        this.interpolate = _.template(_.isArray(config.code) ? config.code.join(endOfLine) : config.code);
    }
    check(document) {
        if (this.config.when) {
            try {
                return Boolean(_.template('${' + this.config.when + '}')({
                    _,
                    minimatch: // Lodash
                    minimatch_1.match,
                    path,
                    activeDocument: document,
                    activeFile: new FileInfo_1.default(document.fileName),
                }));
            }
            catch (ex) {
                console.error(ex);
                return false;
            }
        }
        return true;
    }
    match(givenPath) {
        const matcher = (glob) => minimatch_1.match([givenPath], glob).length > 0;
        return this.inclusionList.some(matcher) && !this.exclusionList.some(matcher);
    }
    getRelativeFilePath(fileInfo, currentDirectoryPath) {
        let relativeFilePath = fileInfo.getRelativePath(currentDirectoryPath);
        if (this.config.omitIndexInSelectFilePath && fileInfo.fileNameWithoutExtension === 'index') {
            relativeFilePath = _.trimEnd(relativeFilePath.substring(0, relativeFilePath.length - fileInfo.fileNameWithExtension.length), '/');
        }
        else if (this.config.omitExtensionInSelectFilePath === true || typeof this.config.omitExtensionInSelectFilePath === 'string' && minimatch_1.match([fileInfo.fileExtensionWithoutLeadingDot], this.config.omitExtensionInSelectFilePath).length > 0) {
            relativeFilePath = relativeFilePath.substring(0, relativeFilePath.length - 1 - fileInfo.fileExtensionWithoutLeadingDot.length);
        }
        return relativeFilePath;
    }
}
exports.default = FilePattern;
//# sourceMappingURL=FilePattern.js.map