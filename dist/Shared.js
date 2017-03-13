"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const _ = require("lodash");
const babylon = require("babylon");
exports.PATH_SEPARATOR_FOR_WINDOWS = /\\/g;
exports.CURRENT_DIRECTORY_SEMANTIC = /^\.\//;
exports.UPPER_DIRECTORY_SEMANTIC = /\.\.\//g;
exports.INDEX_FILE = /^index\.\w+$/i;
exports.EXPORT_DEFAULT = { type: 'ExportDefaultDeclaration' };
exports.MODULE_EXPORTS = {
    type: 'ExpressionStatement',
    expression: {
        type: 'AssignmentExpression',
        left: {
            type: 'MemberExpression',
            object: { type: 'Identifier', name: 'module' },
            property: { type: 'Identifier', name: 'exports' }
        }
    }
};
function getProperVariableName(fileName) {
    const words = _.words(fileName);
    let pivot = 0;
    let parts = [];
    words.forEach(word => {
        const index = fileName.indexOf(word, pivot);
        parts.push((fileName.substring(pivot, index).match(/[_\$]+/g) || []).join(''));
        parts.push(_.upperFirst(word));
    });
    parts = _.compact(parts);
    if (/^\d+/.test(parts[0])) {
        const digit = parts[0].match(/^\d+/)[0];
        parts[0] = parts[0].substring(digit.length);
        parts.push(digit);
    }
    return parts.join('');
}
exports.getProperVariableName = getProperVariableName;
function getCodeTree(text, fileExtensionOrLanguageId, plugins = []) {
    if (/^(javascript|javascriptreact|js|jsx|typescript|typescriptreact|ts|tsx)$/.test(fileExtensionOrLanguageId) === false) {
        return null;
    }
    try {
        return babylon.parse(text, { sourceType: 'module', plugins: [...plugins] });
    }
    catch (ex) {
        console.error(ex);
        return null;
    }
}
exports.getCodeTree = getCodeTree;
function findInCodeTree(source, target) {
    if (source === null) {
        return undefined;
    }
    else if (source['type'] === 'File' && source['program']) {
        return findInCodeTree(source['program'], target);
    }
    else if (_.isMatch(source, target)) {
        return source;
    }
    else if (_.isArrayLike(source['body'])) {
        for (let index = 0; index < source['body'].length; index++) {
            const result = findInCodeTree(source['body'][index], target);
            if (result !== undefined) {
                return result;
            }
        }
        return undefined;
    }
    else if (_.isObject(source['body'])) {
        return findInCodeTree(source['body'], target);
    }
    else {
        return undefined;
    }
}
exports.findInCodeTree = findInCodeTree;
//# sourceMappingURL=Shared.js.map