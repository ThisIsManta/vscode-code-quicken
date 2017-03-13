"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
const _ = require("lodash");
const minimatch_1 = require("minimatch");
const Shared = require("./Shared");
const FileInfo_1 = require("./FileInfo");
class FilePattern {
    get insertAt() {
        return this.config.insertAt;
    }
    get omitIndexFile() {
        return this.config.omitIndexFile;
    }
    constructor(config) {
        this.config = config;
        const multiPaths = typeof config.path === 'string' ? [config.path] : config.path;
        this.inclusion = multiPaths.filter(item => item.startsWith('!') === false);
        this.exclusion = _.difference(multiPaths, this.inclusion).map(item => _.trimStart(item, '!'));
        this.interpolate = _.template(_.isArray(config.code) ? config.code.join('\n') : config.code);
    }
    check(document) {
        if (this.config.when) {
            const fileInfo = new FileInfo_1.default(document.fileName);
            try {
                return Boolean(_.template('${' + this.config.when + '}')({
                    rootPath: (vscode.workspace.rootPath || '').replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/'),
                    filePath: fileInfo.unixPath,
                    fileName: fileInfo.fileNameWithoutExtension,
                    fileExtn: fileInfo.fileExtensionWithoutLeadingDot,
                    fileType: document.languageId,
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
        return this.inclusion.some(matcher) && !this.exclusion.some(matcher);
    }
    getRelativeFilePath(fileInfo, currentDirectoryPath) {
        let relativeFilePath = fileInfo.getRelativePath(currentDirectoryPath);
        if (this.config.omitIndexFile && fileInfo.fileNameWithoutExtension === 'index') {
            relativeFilePath = _.trimEnd(relativeFilePath.substring(0, relativeFilePath.length - fileInfo.fileNameWithExtension.length), '/');
        }
        else if (this.config.omitExtensionInFilePath === true || typeof this.config.omitExtensionInFilePath === 'string' && minimatch_1.match([fileInfo.fileExtensionWithoutLeadingDot], this.config.omitExtensionInFilePath).length > 0) {
            relativeFilePath = relativeFilePath.substring(0, relativeFilePath.length - 1 - fileInfo.fileExtensionWithoutLeadingDot.length);
        }
        return relativeFilePath;
    }
}
exports.default = FilePattern;
//# sourceMappingURL=FilePattern.js.map